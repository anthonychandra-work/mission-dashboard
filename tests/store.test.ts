/**
 * FEAT-DASH-007 -- snapshot store (spec 3.3; VAL-101 store-level).
 *
 * The store is the M1 aggregation core plus the two stateful concerns the pure
 * layer omits: a monotonic revision counter and ONE long-lived SafeReader whose
 * last-good cache survives across rebuilds. These tests prove:
 *   - revision starts at 0, bumps by exactly one per rebuild, and each snapshot
 *     carries its revision (FEAT-DASH-008 relies on strictly increasing revs);
 *   - rebuild() does a FULL re-read -- a features.json edit between rebuilds is
 *     reflected in the next snapshot (no diffing, no stale cache of the built
 *     snapshot; spec 3.3 SETTLED);
 *   - the SINGLE reader keeps last-good across rebuilds: a file that goes
 *     malformed after a clean rebuild degrades to its cached value + a warning,
 *     never an empty flash (VAL-004 at store level);
 *   - injected clock + staleClaimMinutes flow through to the snapshot; and
 *   - VAL-101: wiring the watcher's debounced `vault-changed` to rebuild(), an
 *     atomic tmp+rename write burst yields exactly ONE rebuild / ONE revision
 *     bump, and that rebuild reflects the new data.
 *
 * Every test runs against a TEMP copy of the fixture vault -- never the real
 * vault, never the committed fixture in mutating cases (INV-A).
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { cp, mkdir, mkdtemp, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import type { Mission, Snapshot } from '../shared/types.js';
import { createSafeReader } from '../server/aggregate/safeRead.js';
import { createStore } from '../server/store.js';
import {
  createVaultWatcher,
  DEFAULT_AWAIT_WRITE_FINISH,
  DEFAULT_DEBOUNCE_MS,
  VAULT_CHANGED_EVENT,
} from '../server/watcher.js';

const FIXTURE_VAULT = fileURLToPath(new URL('./fixtures/vault-basic', import.meta.url));
const NOW = new Date('2026-01-15T10:10:00Z');

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

let root: string;

beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), 'mission-dashboard-store-'));
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

async function copyFixture(): Promise<string> {
  const vault = path.join(root, 'vault-basic');
  await cp(FIXTURE_VAULT, vault, { recursive: true });
  return vault;
}

async function atomicWrite(file: string, content: string): Promise<void> {
  const tmp = path.join(path.dirname(file), `.tmp-${randomUUID()}`);
  await writeFile(tmp, content, 'utf8');
  await rename(tmp, file);
}

function mission(snapshot: Snapshot, project: string, slug: string): Mission {
  const p = snapshot.projects.find((entry) => entry.slug === project);
  expect(p, `project ${project}`).toBeDefined();
  const m = p!.missions.find((entry) => entry.slug === slug);
  expect(m, `mission ${project}/${slug}`).toBeDefined();
  return m!;
}

function missionOneFeaturesPath(vault: string): string {
  return path.join(vault, 'projects', 'alpha-app', 'missions', 'mission-one', 'features.json');
}

/** Rewrite mission-one/features.json with one extra feature (valid JSON). */
async function appendFeature(vault: string): Promise<void> {
  const file = missionOneFeaturesPath(vault);
  const parsed = JSON.parse(await readFile(file, 'utf8')) as { features: unknown[] };
  parsed.features.push({
    id: 'FEAT-ONE-008',
    milestone: 'M1',
    title: 'Added',
    status: 'planned',
    ownerFiles: ['src/added.ts'],
    dependsOn: [],
  });
  await atomicWrite(file, JSON.stringify(parsed, null, 2));
}

// -- revision counter --

describe('SnapshotStore -- revision counter', () => {
  it('starts at revision 0 with no snapshot, then bumps by one per rebuild', async () => {
    const vault = await copyFixture();
    const store = createStore({ vaultPath: vault, now: () => NOW });

    expect(store.revision).toBe(0);
    expect(store.getSnapshot()).toBeNull();

    const first = await store.rebuild();
    expect(store.revision).toBe(1);
    expect(first.revision).toBe(1);
    expect(store.getSnapshot()).toBe(first); // holds the exact built snapshot

    const second = await store.rebuild();
    expect(store.revision).toBe(2);
    expect(second.revision).toBe(2);

    const third = await store.rebuild();
    expect(third.revision).toBe(3);
    // Monotonic and gap-free across the run.
  });

  it('stamps generatedAt from the injected clock', async () => {
    const vault = await copyFixture();
    const store = createStore({ vaultPath: vault, now: () => NOW });
    const snapshot = await store.rebuild();
    expect(snapshot.generatedAt).toBe('2026-01-15T10:10:00.000Z');
    expect(snapshot.vaultPath).toBe(vault);
  });
});

// -- full re-read on every rebuild --

describe('SnapshotStore -- full re-read (no diffing, spec 3.3)', () => {
  it('reflects a features.json edit in the next rebuild', async () => {
    const vault = await copyFixture();
    const store = createStore({ vaultPath: vault, now: () => NOW });

    const before = await store.rebuild();
    expect(mission(before, 'alpha-app', 'mission-one').featureCounts?.total).toBe(7);

    await appendFeature(vault);

    const after = await store.rebuild();
    expect(mission(after, 'alpha-app', 'mission-one').featureCounts?.total).toBe(8);
    expect(after.revision).toBe(2);
  });
});

// -- one long-lived SafeReader: last-good survives rebuilds (VAL-004) --

describe('SnapshotStore -- shared last-good cache across rebuilds (VAL-004)', () => {
  it('keeps last-good data + a warning when a file goes malformed after a clean rebuild', async () => {
    const vault = await copyFixture();
    const store = createStore({ vaultPath: vault, now: () => NOW });

    // Clean rebuild populates the store's single reader's per-path cache.
    const clean = await store.rebuild();
    expect(clean.warnings).toEqual([]);
    expect(mission(clean, 'alpha-app', 'mission-one').claim).toMatchObject({
      feature: 'FEAT-ONE-003',
    });

    // The per-project registry goes malformed (temp copy only -- INV-A).
    const registryFile = path.join(vault, 'registry', 'alpha-app.json');
    await atomicWrite(registryFile, '{ not valid json');

    // Second rebuild through the SAME store -> SAME reader -> last-good flows.
    const degraded = await store.rebuild();
    const m = mission(degraded, 'alpha-app', 'mission-one');
    expect(m.status).toBe('active');
    expect(m.claim).toMatchObject({ feature: 'FEAT-ONE-003' }); // not lost
    expect(degraded.warnings.map((w) => w.file)).toContain(registryFile);
    expect(degraded.attention.map((a) => a.type)).toContain('parse_warning');
  });

  it('accepts an injected reader (shared cache is observable from outside)', async () => {
    const vault = await copyFixture();
    const reader = createSafeReader({ sleep: async () => {} }); // no real retry wait
    const store = createStore({ vaultPath: vault, now: () => NOW, reader });

    await store.rebuild();
    await atomicWrite(path.join(vault, 'registry', 'alpha-app.json'), '{ broken');
    const degraded = await store.rebuild();

    // The injected reader is the one that carried the last-good value forward.
    expect(mission(degraded, 'alpha-app', 'mission-one').status).toBe('active');
    expect(degraded.warnings.length).toBeGreaterThan(0);
  });
});

// -- injected staleness threshold + never-throws --

describe('SnapshotStore -- config passthrough and robustness', () => {
  it('forwards staleClaimMinutes to the snapshot (a 10-min claim is stale at threshold 5)', async () => {
    const vault = await copyFixture();
    const store = createStore({ vaultPath: vault, now: () => NOW, staleClaimMinutes: 5 });
    const snapshot = await store.rebuild();

    expect(mission(snapshot, 'alpha-app', 'mission-one').claim).toMatchObject({
      ageMinutes: 10,
      stale: true,
    });
    expect(snapshot.attention[0]?.type).toBe('orphaned_claim');
  });

  it('never throws on a malformed vault with no last-good', async () => {
    const vault = path.join(root, 'broken-vault');
    await mkdir(path.join(vault, 'registry'), { recursive: true });
    await writeFile(path.join(vault, 'registry', 'projects.json'), 'not json', 'utf8');

    const store = createStore({ vaultPath: vault, now: () => NOW });
    const snapshot = await store.rebuild();
    expect(snapshot.projects).toEqual([]);
    expect(snapshot.warnings).toHaveLength(1);
    expect(store.revision).toBe(1); // still counted a rebuild
  });
});

// -- VAL-101: watcher burst -> exactly one rebuild / one revision bump --

describe('SnapshotStore + VaultWatcher -- VAL-101 (atomic burst -> one rebuild)', () => {
  it('collapses an atomic tmp+rename burst into a single rebuild with one revision bump', async () => {
    const vault = await copyFixture();
    const store = createStore({ vaultPath: vault, now: () => NOW });
    await store.rebuild(); // revision 1 (the server boots with an initial snapshot)
    expect(store.revision).toBe(1);

    // Drain the fixture copy's late FSEvents before watching, so only the
    // burst below can bump the revision (see watcher.test.ts for the rationale;
    // production never hits this because the vault predates the server).
    await sleep(600);

    const watcher = createVaultWatcher({
      vaultPath: vault,
      debounceMs: DEFAULT_DEBOUNCE_MS,
      awaitWriteFinish: { ...DEFAULT_AWAIT_WRITE_FINISH },
    });
    let rebuilds = 0;
    const done: Array<Promise<unknown>> = [];
    watcher.on(VAULT_CHANGED_EVENT, () => {
      rebuilds += 1;
      done.push(store.rebuild());
    });

    try {
      await watcher.ready;

      const missionDir = path.join(vault, 'projects', 'alpha-app', 'missions', 'mission-one');
      // Commander-cycle-shaped burst: several watched files, atomic, near-simultaneous.
      await appendFeature(vault); // features.json (atomic inside)
      await Promise.all([
        atomicWrite(
          path.join(missionDir, 'prompt-queue.md'),
          '# Prompt Queue\n\n## NEXT\n\nvalidate\n',
        ),
        atomicWrite(path.join(vault, 'log.md'), '## [2026-01-15 12:00] cycle | burst\n'),
        atomicWrite(
          path.join(
            vault,
            'inbox',
            '20260115-120000-alpha-app-mission-one-FEAT-ONE-003-validator.md',
          ),
          '---\nreport: worker\n---\n',
        ),
      ]);

      await sleep(DEFAULT_AWAIT_WRITE_FINISH.stabilityThreshold + DEFAULT_DEBOUNCE_MS + 700);
      await Promise.all(done);

      expect(rebuilds).toBe(1);
      expect(store.revision).toBe(2); // exactly one bump

      // The single rebuild did a full re-read: the appended feature is present.
      expect(mission(store.getSnapshot()!, 'alpha-app', 'mission-one').featureCounts?.total).toBe(8);
    } finally {
      await watcher.close();
    }
  }, 20000);
});
