/**
 * FEAT-DASH-002 — safeRead last-good fallback (spec §3.3) + fixture vault (spec §7).
 *
 * safeRead contract under test:
 *   - every JSON/YAML read retries ONCE after 250 ms (injectable) on failure,
 *   - then falls back to the last-good parsed value per path,
 *   - reports `{file, error}` warnings, and NEVER throws (VAL-004 groundwork).
 *
 * INV-A: no test reads or writes the real vault. Fixture mutations (malformed
 * JSON) happen ONLY in temp copies created under os.tmpdir(); the committed
 * fixture stays pristine.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { cp, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  createSafeReader,
  DEFAULT_RETRY_DELAY_MS,
  type SafeReadResult,
} from '../server/aggregate/safeRead.js';

const FIXTURE_VAULT = fileURLToPath(new URL('./fixtures/vault-basic', import.meta.url));
const REAL_VAULT = '/Users/Work/Documents/_obsidian';

/** The canonical fixture claim start — tests inject `now` relative to this. */
const FIXTURE_CLAIM_STARTED_AT = '2026-01-15T10:00:00';

let root: string;

beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), 'mission-dashboard-safe-read-'));
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

/** A reader whose retry delay resolves immediately, recording each requested delay. */
function fastReader(delays: number[] = []) {
  return createSafeReader({
    sleep: async (ms) => {
      delays.push(ms);
    },
  });
}

async function writeJson(name: string, content: unknown): Promise<string> {
  const p = path.join(root, name);
  await writeFile(p, JSON.stringify(content, null, 2));
  return p;
}

describe('safeRead — happy path', () => {
  it('parses a valid JSON file', async () => {
    const p = await writeJson('good.json', { hello: 'vault' });
    const reader = fastReader();
    const result = await reader.readJson<{ hello: string }>(p);
    expect(result.value).toEqual({ hello: 'vault' });
    expect(result.stale).toBe(false);
    expect(result.missing).toBe(false);
    expect(result.warning).toBeNull();
  });

  it('supports a custom parser (YAML-ish reads go through the same funnel)', async () => {
    const p = path.join(root, 'custom.txt');
    await writeFile(p, 'k=v');
    const reader = fastReader();
    const result = await reader.read(p, (raw) => raw.trim().split('='));
    expect(result.value).toEqual(['k', 'v']);
    expect(result.warning).toBeNull();
  });
});

describe('safeRead — retry semantics', () => {
  it('retries once after the delay and succeeds when the file was fixed mid-write', async () => {
    const p = path.join(root, 'mid-write.json');
    await writeFile(p, '{ "half": ');
    const delays: number[] = [];
    // The injected sleep "repairs" the file, simulating an atomic rename landing
    // between the first failed parse and the retry.
    const reader = createSafeReader({
      sleep: async (ms) => {
        delays.push(ms);
        await writeFile(p, JSON.stringify({ half: 'done' }));
      },
    });
    const result = await reader.readJson<{ half: string }>(p);
    expect(result.value).toEqual({ half: 'done' });
    expect(result.stale).toBe(false);
    expect(result.warning).toBeNull();
    expect(delays).toEqual([DEFAULT_RETRY_DELAY_MS]);
  });

  it('defaults the retry delay to 250 ms', async () => {
    expect(DEFAULT_RETRY_DELAY_MS).toBe(250);
    const p = path.join(root, 'bad.json');
    await writeFile(p, '{ nope');
    const delays: number[] = [];
    const reader = fastReader(delays);
    await reader.readJson(p);
    expect(delays).toEqual([250]);
  });

  it('honors a custom retryDelayMs', async () => {
    const p = path.join(root, 'bad.json');
    await writeFile(p, '{ nope');
    const delays: number[] = [];
    const reader = createSafeReader({
      retryDelayMs: 7,
      sleep: async (ms) => {
        delays.push(ms);
      },
    });
    await reader.readJson(p);
    expect(delays).toEqual([7]);
  });

  it('retries exactly once — two parse attempts total on persistent failure', async () => {
    const p = path.join(root, 'persistent.txt');
    await writeFile(p, 'garbage');
    let attempts = 0;
    const reader = fastReader();
    const result = await reader.read(p, () => {
      attempts++;
      throw new Error('always broken');
    });
    expect(attempts).toBe(2);
    expect(result.value).toBeNull();
    expect(result.warning).not.toBeNull();
  });
});

describe('safeRead — failure, warnings, never throws', () => {
  it('returns null + {file, error} warning for malformed JSON with no last-good', async () => {
    const p = path.join(root, 'broken.json');
    await writeFile(p, '{ "unclosed": ');
    const reader = fastReader();
    let result: SafeReadResult<unknown> | undefined;
    // The literal never-throws assertion (VAL-004).
    await expect(
      (async () => {
        result = await reader.readJson(p);
      })(),
    ).resolves.toBeUndefined();
    expect(result!.value).toBeNull();
    expect(result!.stale).toBe(false);
    expect(result!.warning).toMatchObject({ file: p });
    expect(result!.warning!.error.length).toBeGreaterThan(0);
  });

  it('reports a warning for a missing required file', async () => {
    const p = path.join(root, 'no-such.json');
    const reader = fastReader();
    const result = await reader.readJson(p);
    expect(result.value).toBeNull();
    expect(result.missing).toBe(false);
    expect(result.warning).toMatchObject({ file: p });
  });

  it('never throws even when the parser throws a non-Error value', async () => {
    const p = path.join(root, 'weird.txt');
    await writeFile(p, 'x');
    const reader = fastReader();
    const result = await reader.read(p, () => {
      // eslint-disable-next-line no-throw-literal
      throw 'string failure';
    });
    expect(result.value).toBeNull();
    expect(result.warning!.error).toContain('string failure');
  });
});

describe('safeRead — optional files (absent features.json is real state)', () => {
  it('returns missing:true with no warning and no retry for an absent optional file', async () => {
    const p = path.join(root, 'absent-features.json');
    const delays: number[] = [];
    const reader = fastReader(delays);
    const result = await reader.readJson(p, { optional: true });
    expect(result.value).toBeNull();
    expect(result.missing).toBe(true);
    expect(result.warning).toBeNull();
    expect(delays).toEqual([]); // no 250 ms penalty per absent file per rebuild
  });

  it('still warns (after retry) when an optional file exists but is malformed', async () => {
    const p = await writeJson('opt.json', { ok: 1 });
    await writeFile(p, '{ bad');
    const reader = fastReader();
    const result = await reader.readJson(p, { optional: true });
    expect(result.missing).toBe(false);
    expect(result.warning).toMatchObject({ file: p });
  });

  it('a legitimately deleted optional file drops its last-good value (no resurrection)', async () => {
    const p = await writeJson('deleted.json', { alive: true });
    const reader = fastReader();
    expect((await reader.readJson(p, { optional: true })).value).toEqual({ alive: true });
    await rm(p);
    const gone = await reader.readJson(p, { optional: true });
    expect(gone.value).toBeNull();
    expect(gone.missing).toBe(true);
    // Recreated malformed later: no ancient value must come back.
    await writeFile(p, '{ zombie');
    const after = await reader.readJson(p, { optional: true });
    expect(after.value).toBeNull();
    expect(after.stale).toBe(false);
    expect(after.warning).not.toBeNull();
  });
});

describe('safeRead — last-good fallback per path', () => {
  it('serves the last-good value with stale:true + warning after corruption', async () => {
    const p = await writeJson('registry.json', { revision: 1 });
    const reader = fastReader();
    expect((await reader.readJson(p)).value).toEqual({ revision: 1 });

    await writeFile(p, '{ "revision": '); // corrupt (temp copy only)
    const result = await reader.readJson<{ revision: number }>(p);
    expect(result.value).toEqual({ revision: 1 }); // last-good
    expect(result.stale).toBe(true);
    expect(result.warning).toMatchObject({ file: p });
  });

  it('keeps last-good values isolated per path', async () => {
    const a = await writeJson('a.json', { name: 'a' });
    const b = await writeJson('b.json', { name: 'b' });
    const reader = fastReader();
    await reader.readJson(a);
    await reader.readJson(b);

    await writeFile(a, 'garbage');
    const ra = await reader.readJson(a);
    const rb = await reader.readJson(b);
    expect(ra.value).toEqual({ name: 'a' });
    expect(ra.stale).toBe(true);
    expect(rb.value).toEqual({ name: 'b' });
    expect(rb.stale).toBe(false);
    expect(rb.warning).toBeNull();
  });

  it('recovers cleanly once the file parses again', async () => {
    const p = await writeJson('recover.json', { v: 1 });
    const reader = fastReader();
    await reader.readJson(p);
    await writeFile(p, '{ bad');
    await reader.readJson(p);
    await writeJson('recover.json', { v: 2 });
    const result = await reader.readJson<{ v: number }>(p);
    expect(result.value).toEqual({ v: 2 });
    expect(result.stale).toBe(false);
    expect(result.warning).toBeNull();
    // And the new value becomes the last-good.
    await writeFile(p, '{ bad again');
    expect((await reader.readJson<{ v: number }>(p)).value).toEqual({ v: 2 });
  });

  it('falls back to last-good when a required file disappears mid-run', async () => {
    const p = await writeJson('vanishing.json', { keep: 'me' });
    const reader = fastReader();
    await reader.readJson(p);
    await rm(p);
    const result = await reader.readJson(p);
    expect(result.value).toEqual({ keep: 'me' });
    expect(result.stale).toBe(true);
    expect(result.warning).toMatchObject({ file: p });
  });
});

describe('fixture vault — tests/fixtures/vault-basic', () => {
  /** Copy the committed fixture into the temp root; all mutation happens there. */
  async function tempVaultCopy(): Promise<string> {
    const dest = path.join(root, 'vault-basic');
    await cp(FIXTURE_VAULT, dest, { recursive: true });
    return dest;
  }

  it('never points at the real vault (INV-A)', () => {
    expect(FIXTURE_VAULT.startsWith(REAL_VAULT)).toBe(false);
    expect(FIXTURE_VAULT).toContain(`${path.sep}tests${path.sep}fixtures${path.sep}`);
  });

  it('has >= 2 projects in registry/projects.json, each with a per-project registry', async () => {
    const vault = await tempVaultCopy();
    const reader = fastReader();
    const result = await reader.readJson<{
      projects: Record<string, { registry: string }>;
    }>(path.join(vault, 'registry', 'projects.json'));
    expect(result.warning).toBeNull();
    const projects = result.value!.projects;
    expect(Object.keys(projects).length).toBeGreaterThanOrEqual(2);
    for (const entry of Object.values(projects)) {
      const registry = await reader.readJson(path.join(vault, entry.registry));
      expect(registry.warning).toBeNull();
      expect(registry.value).not.toBeNull();
    }
  });

  it('mission-one has a claim (parameterizable timestamp), escalation maps, and blocked_features', async () => {
    const vault = await tempVaultCopy();
    const reader = fastReader();
    const result = await reader.readJson<{
      autonomy: { mode: string };
      missions: Record<
        string,
        {
          status: string;
          blocked_reason: string | null;
          claim: { worker: string; feature: string; started_at: string } | null;
          fix_passes?: Record<string, number>;
          failed_attempts?: Record<string, number>;
          crash_retries?: Record<string, number>;
          blocked_features?: Record<string, string>;
        }
      >;
    }>(path.join(vault, 'registry', 'alpha-app.json'));
    const registry = result.value!;
    expect(registry.autonomy.mode).toBe('auto');

    const missionOne = registry.missions['mission-one']!;
    expect(missionOne.claim).toMatchObject({
      worker: 'executor',
      feature: 'FEAT-ONE-003',
      started_at: FIXTURE_CLAIM_STARTED_AT,
    });
    // Tests inject "now" relative to the fixed claim timestamp (VAL-003 pattern):
    const startedAt = new Date(missionOne.claim!.started_at).getTime();
    const freshNow = startedAt + 10 * 60_000;
    const staleNow = startedAt + 90 * 60_000;
    expect((freshNow - startedAt) / 60_000).toBeLessThan(45);
    expect((staleNow - startedAt) / 60_000).toBeGreaterThan(45);

    expect(missionOne.fix_passes).toEqual({ 'FEAT-ONE-002': 1 });
    expect(missionOne.failed_attempts).toEqual({ 'FEAT-ONE-002': 1 });
    expect(missionOne.crash_retries).toEqual({ 'FEAT-ONE-003': 1 });
    expect(missionOne.blocked_features).toEqual({
      'FEAT-ONE-005': 'waiting on upstream API decision',
    });

    const missionTwo = registry.missions['mission-two']!;
    expect(missionTwo.status).toBe('queued');
    expect(missionTwo.blocked_reason).toBe('depends on mission-one');
  });

  it('mission-one features.json covers all seven known feature statuses', async () => {
    const vault = await tempVaultCopy();
    const reader = fastReader();
    const result = await reader.readJson<{ features: { status: string }[] }>(
      path.join(vault, 'projects', 'alpha-app', 'missions', 'mission-one', 'features.json'),
    );
    expect(result.warning).toBeNull();
    const statuses = new Set(result.value!.features.map((f) => f.status));
    for (const s of [
      'planned',
      'ready',
      'in-progress',
      'implemented',
      'implemented_with_findings',
      'validated_passed',
      'validated_failed',
    ]) {
      expect(statuses).toContain(s);
    }
  });

  it('the imported mission has NO features.json (missing, not a warning)', async () => {
    const vault = await tempVaultCopy();
    const reader = fastReader();
    const result = await reader.readJson(
      path.join(vault, 'projects', 'legacy-tool', 'missions', 'imported-mission', 'features.json'),
      { optional: true },
    );
    expect(result.missing).toBe(true);
    expect(result.warning).toBeNull();
  });

  it('has an unprocessed inbox report plus .processed/ and .failed/ entries', async () => {
    const vault = await tempVaultCopy();
    const inbox = path.join(vault, 'inbox');
    const topLevel = (await readdir(inbox)).filter((f) => f.endsWith('.md'));
    const processed = (await readdir(path.join(inbox, '.processed'))).filter((f) =>
      f.endsWith('.md'),
    );
    const failed = (await readdir(path.join(inbox, '.failed'))).filter((f) => f.endsWith('.md'));
    expect(topLevel).toHaveLength(1);
    expect(processed).toHaveLength(1);
    expect(failed).toHaveLength(1);
    // The unprocessed report carries frontmatter (gray-matter input for FEAT-DASH-004).
    const raw = await readFile(path.join(inbox, topLevel[0]!), 'utf8');
    expect(raw.startsWith('---\n')).toBe(true);
    expect(raw).toContain('feature: FEAT-ONE-002');
  });

  it('has global and per-project logs in the "## [ts] type | title" format, plus a prompt queue', async () => {
    const vault = await tempVaultCopy();
    const header = /^## \[\d{4}-\d{2}-\d{2} \d{2}:\d{2}\] \w+ \| .+$/m;
    for (const logPath of [
      path.join(vault, 'log.md'),
      path.join(vault, 'projects', 'alpha-app', 'log.md'),
      path.join(vault, 'projects', 'legacy-tool', 'log.md'),
    ]) {
      expect(await readFile(logPath, 'utf8')).toMatch(header);
    }
    const queue = await readFile(
      path.join(vault, 'projects', 'alpha-app', 'missions', 'mission-one', 'prompt-queue.md'),
      'utf8',
    );
    expect(queue).toContain('validate FEAT-ONE-004');
  });

  it('VAL-004 groundwork: corrupting a registry IN THE TEMP COPY keeps last-good + parse warning', async () => {
    const vault = await tempVaultCopy();
    const registryPath = path.join(vault, 'registry', 'alpha-app.json');
    const reader = fastReader();

    const good = await reader.readJson<{ project: string }>(registryPath);
    expect(good.value!.project).toBe('alpha-app');

    await writeFile(registryPath, '{ "project": "alpha-a'); // malformed, temp copy only
    const corrupted = await reader.readJson<{ project: string }>(registryPath);
    expect(corrupted.value!.project).toBe('alpha-app'); // last-good survives
    expect(corrupted.stale).toBe(true);
    expect(corrupted.warning).toMatchObject({ file: registryPath });

    // The committed fixture itself is still pristine.
    const committed = JSON.parse(
      await readFile(path.join(FIXTURE_VAULT, 'registry', 'alpha-app.json'), 'utf8'),
    ) as { project: string };
    expect(committed.project).toBe('alpha-app');
  });
});
