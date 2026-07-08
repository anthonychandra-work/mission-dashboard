/**
 * FEAT-DASH-007 -- vault watcher (spec 3.3; VAL-101 store-level, watcher half).
 *
 * Two layers of proof:
 *   1. PURE predicate tests over {@link isWatchedRelativePath} and
 *      {@link isWatchedOrAncestorPath} -- fast, exhaustive over the spec 3.3
 *      watched set and its near-miss negatives (inbox/.processed, mission note,
 *      registry subdir, per-project wiki), so the glob->filter translation is
 *      pinned without waiting on the filesystem; and
 *   2. INTEGRATION tests driving real atomic tmp+rename writes against a TEMP
 *      copy of the fixture vault (never the real vault, never the committed
 *      fixture -- INV-A), asserting a burst collapses to exactly one
 *      `vault-changed`, that separated bursts each emit once, that non-watched
 *      changes emit nothing, and that close() is quiet.
 *
 * Timing: one headline test runs the REAL defaults (awaitWriteFinish 200/50 +
 * 300 ms debounce) so the evidence reflects production behaviour; the rest
 * inject smaller thresholds to stay fast (the defaults are asserted directly).
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { cp, mkdtemp, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  createVaultWatcher,
  isWatchedOrAncestorPath,
  isWatchedRelativePath,
  DEFAULT_AWAIT_WRITE_FINISH,
  DEFAULT_DEBOUNCE_MS,
  VAULT_CHANGED_EVENT,
  type VaultWatcher,
} from '../server/watcher.js';

const FIXTURE_VAULT = fileURLToPath(new URL('./fixtures/vault-basic', import.meta.url));

// Fast injected timings for the bulk of the integration tests.
const FAST_AWF = { stabilityThreshold: 40, pollInterval: 10 };
const FAST_DEBOUNCE = 120;

// macOS delivers FSEvents about a freshly-`cp`-ed tree with latency, and those
// late notifications can land AFTER the watcher's `ready` (ignoreInitial only
// suppresses the initial readdir scan, not in-flight OS events) -- a watched
// file like log.md would then fire a spurious event. Production never sees this
// (the vault exists long before the server starts), so we drain the copy's
// events by waiting BEFORE the watcher is created, when no watcher is listening.
const FSEVENTS_DRAIN_MS = 500;

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

let root: string;
const openWatchers: VaultWatcher[] = [];

beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), 'mission-dashboard-watcher-'));
});

afterEach(async () => {
  // Close any watcher a test forgot, then drop the temp vault.
  await Promise.all(openWatchers.splice(0).map((w) => w.close().catch(() => {})));
  await rm(root, { recursive: true, force: true });
});

/**
 * Copy the committed fixture into the temp root (INV-A: only ever mutate
 * copies), then drain the copy's FSEvents before any watcher is created.
 */
async function copyFixture(): Promise<string> {
  const vault = path.join(root, 'vault-basic');
  await cp(FIXTURE_VAULT, vault, { recursive: true });
  await sleep(FSEVENTS_DRAIN_MS);
  return vault;
}

/** Atomic write: write a sibling tmp file, then rename over the target. */
async function atomicWrite(file: string, content: string): Promise<void> {
  const tmp = path.join(path.dirname(file), `.tmp-${randomUUID()}`);
  await writeFile(tmp, content, 'utf8');
  await rename(tmp, file);
}

interface StartedWatcher {
  watcher: VaultWatcher;
  events: string[];
}

/** Create + track + await-ready a watcher, recording every vault-changed event. */
async function startWatcher(
  vault: string,
  opts: {
    debounceMs?: number;
    awaitWriteFinish?: { stabilityThreshold: number; pollInterval: number };
  } = {},
): Promise<StartedWatcher> {
  const watcher = createVaultWatcher({
    vaultPath: vault,
    debounceMs: opts.debounceMs ?? FAST_DEBOUNCE,
    awaitWriteFinish: opts.awaitWriteFinish ?? FAST_AWF,
  });
  openWatchers.push(watcher);
  const events: string[] = [];
  watcher.on(VAULT_CHANGED_EVENT, () => events.push('changed'));
  await watcher.ready;
  return { watcher, events };
}

// -- pure predicates --

describe('isWatchedRelativePath (spec 3.3 watched set)', () => {
  it.each([
    'registry/projects.json',
    'registry/alpha-app.json',
    'projects/alpha-app/missions/mission-one/features.json',
    'projects/alpha-app/missions/mission-one/prompt-queue.md',
    'inbox/20260115-093000-alpha-app-mission-one-FEAT-ONE-002-executor.md',
    'log.md',
    'projects/alpha-app/log.md',
  ])('matches watched file %s', (rel) => {
    expect(isWatchedRelativePath(rel)).toBe(true);
  });

  it.each([
    '', // the vault root is not itself a watched file
    'registry/notes.md', // wrong extension under registry
    'registry/sub/config.json', // registry is one level deep only
    'inbox/.processed/20260114-120000-alpha-app-mission-one-FEAT-ONE-001-validator.md',
    'inbox/.failed/20260113-110000-legacy-tool-imported-mission-none-executor.md',
    'inbox/note.txt', // not markdown
    'projects/alpha-app/missions/mission-one/mission-one.md', // mission note: on-demand, unwatched
    'projects/alpha-app/missions/mission-one/issues-log.md',
    'projects/alpha-app/missions/mission-one/evidence/out.txt',
    'projects/alpha-app/wiki/architecture.md',
    'SCHEMA.md',
    'DASHBOARD.md',
    'ROADMAP.md',
    'projects/alpha-app/features.json', // features.json only under missions/<m>/
  ])('rejects non-watched path %s', (rel) => {
    expect(isWatchedRelativePath(rel)).toBe(false);
  });

  it('normalizes Windows-style separators and leading ./', () => {
    expect(isWatchedRelativePath('.\\registry\\alpha-app.json')).toBe(true);
    expect(isWatchedRelativePath('./log.md')).toBe(true);
  });
});

describe('isWatchedOrAncestorPath (chokidar ignore filter)', () => {
  it.each([
    '', // vault root -- must always be traversed
    'registry',
    'inbox',
    'projects',
    'projects/alpha-app',
    'projects/alpha-app/missions',
    'projects/alpha-app/missions/mission-one',
    'registry/alpha-app.json', // watched files are kept too
    'projects/alpha-app/missions/mission-one/features.json',
  ])('keeps watched-file or ancestor directory %s', (rel) => {
    expect(isWatchedOrAncestorPath(rel)).toBe(true);
  });

  it.each([
    'inbox/.processed', // counted at rebuild, never watched -> pruned
    'inbox/.failed',
    'projects/alpha-app/wiki', // per-project wiki subtree -> pruned
    'projects/alpha-app/missions/mission-one/evidence', // evidence dir -> pruned
    'registry/sub', // registry has no subdirs to descend into
    '.git',
    '.obsidian',
    'handoff',
    'raw',
    'templates',
  ])('prunes irrelevant directory %s', (rel) => {
    expect(isWatchedOrAncestorPath(rel)).toBe(false);
  });
});

describe('exported defaults (spec 3.3)', () => {
  it('debounce defaults to 300 ms', () => {
    expect(DEFAULT_DEBOUNCE_MS).toBe(300);
  });
  it('awaitWriteFinish defaults to stabilityThreshold 200 / pollInterval 50', () => {
    expect(DEFAULT_AWAIT_WRITE_FINISH).toEqual({ stabilityThreshold: 200, pollInterval: 50 });
  });
});

// -- integration: real fs, debounced bursts --

describe('VaultWatcher -- burst debounce over a temp vault copy (VAL-101 watcher half)', () => {
  it('collapses an atomic tmp+rename write burst to exactly one vault-changed', async () => {
    const vault = await copyFixture();
    const { events } = await startWatcher(vault);

    const missionDir = path.join(vault, 'projects', 'alpha-app', 'missions', 'mission-one');
    const registryFile = path.join(vault, 'registry', 'alpha-app.json');
    // A commander-cycle-shaped burst across five watched files, atomic each.
    await Promise.all([
      atomicWrite(path.join(missionDir, 'features.json'), await touchedFeaturesJson(missionDir)),
      atomicWrite(path.join(missionDir, 'prompt-queue.md'), '# Prompt Queue\n\n## NEXT\n\nvalidate\n'),
      atomicWrite(registryFile, await readFile(registryFile, 'utf8')),
      atomicWrite(path.join(vault, 'log.md'), '## [2026-01-15 12:00] cycle | burst\n\nbody\n'),
      atomicWrite(
        path.join(vault, 'inbox', '20260115-120000-alpha-app-mission-one-FEAT-ONE-003-validator.md'),
        '---\nreport: worker\n---\nhi\n',
      ),
    ]);

    // awf stabilityThreshold + debounce + margin.
    await sleep(FAST_AWF.stabilityThreshold + FAST_DEBOUNCE + 250);
    expect(events).toHaveLength(1);
  }, 15000);

  it('emits once PER burst when bursts are separated by more than the debounce', async () => {
    const vault = await copyFixture();
    const { events } = await startWatcher(vault);
    const logFile = path.join(vault, 'log.md');

    await atomicWrite(logFile, '## [2026-01-15 12:01] a | first\n');
    await sleep(FAST_AWF.stabilityThreshold + FAST_DEBOUNCE + 250);
    await atomicWrite(logFile, '## [2026-01-15 12:02] b | second\n');
    await sleep(FAST_AWF.stabilityThreshold + FAST_DEBOUNCE + 250);

    expect(events).toHaveLength(2);
  }, 15000);

  it('ignores changes to non-watched files (mission note + inbox/.processed)', async () => {
    const vault = await copyFixture();
    const { events } = await startWatcher(vault);

    const missionDir = path.join(vault, 'projects', 'alpha-app', 'missions', 'mission-one');
    await atomicWrite(path.join(missionDir, 'mission-one.md'), '# note changed\n');
    await atomicWrite(
      path.join(
        vault,
        'inbox',
        '.processed',
        '20260114-120000-alpha-app-mission-one-FEAT-ONE-001-validator.md',
      ),
      '# processed edit\n',
    );
    await writeFile(path.join(vault, 'SCHEMA.md'), '# unrelated root file\n', 'utf8');

    await sleep(FAST_AWF.stabilityThreshold + FAST_DEBOUNCE + 300);
    expect(events).toHaveLength(0);
  }, 15000);

  it('stops emitting after close()', async () => {
    const vault = await copyFixture();
    const { watcher, events } = await startWatcher(vault);
    await watcher.close();

    await atomicWrite(path.join(vault, 'log.md'), '## [2026-01-15 12:03] c | after close\n');
    await sleep(FAST_AWF.stabilityThreshold + FAST_DEBOUNCE + 250);
    expect(events).toHaveLength(0);
  }, 15000);

  it('collapses a burst under the REAL production defaults (200/50 + 300 ms)', async () => {
    const vault = await copyFixture();
    const { events } = await startWatcher(vault, {
      debounceMs: DEFAULT_DEBOUNCE_MS,
      awaitWriteFinish: { ...DEFAULT_AWAIT_WRITE_FINISH },
    });

    const missionDir = path.join(vault, 'projects', 'alpha-app', 'missions', 'mission-one');
    await Promise.all([
      atomicWrite(path.join(missionDir, 'features.json'), await touchedFeaturesJson(missionDir)),
      atomicWrite(path.join(vault, 'log.md'), '## [2026-01-15 12:04] cycle | real-defaults\n'),
    ]);

    await sleep(DEFAULT_AWAIT_WRITE_FINISH.stabilityThreshold + DEFAULT_DEBOUNCE_MS + 600);
    expect(events).toHaveLength(1);
  }, 20000);
});

// -- helpers that rewrite fixture files --

/** Return the mission's features.json JSON text with one appended feature. */
async function touchedFeaturesJson(missionDir: string): Promise<string> {
  const raw = await readFile(path.join(missionDir, 'features.json'), 'utf8');
  const parsed = JSON.parse(raw) as { features: unknown[] };
  parsed.features.push({
    id: 'FEAT-ONE-008',
    milestone: 'M1',
    title: 'Added by burst',
    status: 'planned',
    ownerFiles: ['src/added.ts'],
    dependsOn: [],
  });
  return JSON.stringify(parsed, null, 2);
}
