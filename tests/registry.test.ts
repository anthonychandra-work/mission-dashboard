/**
 * FEAT-DASH-003 — registry reader (vault SCHEMA §3/§4, spec §3.1 + §3.4).
 *
 * readRegistry contract under test:
 *   - reads registry/projects.json then every per-project registry/<p>.json,
 *   - normalizes autonomy (SCHEMA defaults for missing block/fields), claim,
 *     escalation maps (fix_passes / failed_attempts / crash_retries) and
 *     blocked_features into camelCase intermediate shapes,
 *   - funnels every read through SafeReader (retry → last-good → warning),
 *     collecting warnings instead of ever throwing,
 *   - tolerates arbitrary shape garbage (vault-sourced values, spec §5).
 *
 * INV-A: all mutation happens in temp copies of tests/fixtures/vault-basic;
 * the committed fixture and the real vault are never touched.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { cp, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { createSafeReader } from '../server/aggregate/safeRead.js';
import {
  AUTONOMY_DEFAULTS,
  readRegistry,
  type RegistryReadResult,
} from '../server/aggregate/registry.js';

const FIXTURE_VAULT = fileURLToPath(new URL('./fixtures/vault-basic', import.meta.url));

let root: string;

beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), 'mission-dashboard-registry-'));
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

/** Reader whose retry delay resolves immediately — tests never wait real time. */
function fastReader() {
  return createSafeReader({ sleep: async () => {} });
}

/** Copy the committed fixture into the temp root; all mutation happens there. */
async function tempVaultCopy(): Promise<string> {
  const dest = path.join(root, 'vault-basic');
  await cp(FIXTURE_VAULT, dest, { recursive: true });
  return dest;
}

function project(result: RegistryReadResult, slug: string) {
  const found = result.projects.find((p) => p.slug === slug);
  expect(found, `project ${slug} present`).toBeDefined();
  return found!;
}

describe('readRegistry — fixture vault happy path', () => {
  it('reads both projects in projects.json order with repo metadata', async () => {
    const vault = await tempVaultCopy();
    const result = await readRegistry(fastReader(), vault);

    expect(result.warnings).toEqual([]);
    expect(result.projects.map((p) => p.slug)).toEqual(['alpha-app', 'legacy-tool']);

    const alpha = project(result, 'alpha-app');
    expect(alpha.repoPath).toBe('/tmp/fixture-repos/alpha-app');
    expect(alpha.defaultBranch).toBe('main');
    expect(alpha.vaultDir).toBe('projects/alpha-app');
    expect(alpha.registryUpdated).toBe('2026-01-15T10:05:00');

    const legacy = project(result, 'legacy-tool');
    expect(legacy.repoPath).toBe('/tmp/fixture-repos/legacy-tool');
    expect(legacy.registryUpdated).toBe('2026-01-14T09:00:00');
  });

  it('normalizes the autonomy block; a missing block gets SCHEMA §4 defaults', async () => {
    const vault = await tempVaultCopy();
    const result = await readRegistry(fastReader(), vault);

    expect(project(result, 'alpha-app').autonomy).toEqual({
      mode: 'auto',
      maxFixPasses: 2,
      maxCrashRetries: 1,
      diagnoseOnFailed: true,
    });
    // legacy-tool.json has no autonomy block at all → full defaults.
    expect(project(result, 'legacy-tool').autonomy).toEqual(AUTONOMY_DEFAULTS);
    expect(AUTONOMY_DEFAULTS.mode).toBe('confirm');
  });

  it('normalizes mission-one: claim, escalation maps, blocked_features', async () => {
    const vault = await tempVaultCopy();
    const result = await readRegistry(fastReader(), vault);
    const alpha = project(result, 'alpha-app');

    expect(alpha.missions.map((m) => m.slug)).toEqual(['mission-one', 'mission-two']);
    const missionOne = alpha.missions[0]!;
    expect(missionOne).toMatchObject({
      title: 'Mission One — engine core',
      status: 'active',
      dependsOn: [],
      blockedReason: null,
      branch: 'mission/mission-one',
      prUrl: null,
      added: '2026-01-10',
      activated: '2026-01-12',
      concluded: null,
      planSource: 'repo:docs/specs/mission-one/plan.md',
      summary: null,
    });
    // The claim is normalized but NOT derived — ageMinutes/stale are snapshot-time
    // concerns (spec §3.4); the reader reports the raw started_at as startedAt.
    expect(missionOne.claim).toEqual({
      worker: 'executor',
      feature: 'FEAT-ONE-003',
      startedAt: '2026-01-15T10:00:00',
      session: 'fixture-session-1',
    });
    expect(missionOne.fixPasses).toEqual({ 'FEAT-ONE-002': 1 });
    expect(missionOne.failedAttempts).toEqual({ 'FEAT-ONE-002': 1 });
    expect(missionOne.crashRetries).toEqual({ 'FEAT-ONE-003': 1 });
    expect(missionOne.blockedFeatures).toEqual({
      'FEAT-ONE-005': 'waiting on upstream API decision',
    });
  });

  it('normalizes mission-two: queued, blocked_reason, null claim, empty maps', async () => {
    const vault = await tempVaultCopy();
    const result = await readRegistry(fastReader(), vault);
    const missionTwo = project(result, 'alpha-app').missions[1]!;

    expect(missionTwo.status).toBe('queued');
    expect(missionTwo.blockedReason).toBe('depends on mission-one');
    expect(missionTwo.dependsOn).toEqual(['mission-one']);
    expect(missionTwo.claim).toBeNull();
    expect(missionTwo.branch).toBeNull();
    expect(missionTwo.fixPasses).toEqual({});
    expect(missionTwo.failedAttempts).toEqual({});
    expect(missionTwo.crashRetries).toEqual({});
    expect(missionTwo.blockedFeatures).toEqual({});
  });

  it('carries summary and pr_url for the imported legacy mission', async () => {
    const vault = await tempVaultCopy();
    const result = await readRegistry(fastReader(), vault);
    const imported = project(result, 'legacy-tool').missions[0]!;

    expect(imported.slug).toBe('imported-mission');
    expect(imported.status).toBe('complete');
    expect(imported.prUrl).toBe('https://github.com/example/legacy-tool/pull/7');
    expect(imported.summary).toContain('rendered from this summary alone');
    expect(imported.claim).toBeNull();
    expect(imported.concluded).toBe('2025-12-20');
  });
});

describe('readRegistry — tolerance (never throws, warnings instead)', () => {
  it('a corrupt per-project registry (no last-good) yields the project with zero missions + warning', async () => {
    const vault = await tempVaultCopy();
    const registryPath = path.join(vault, 'registry', 'alpha-app.json');
    await writeFile(registryPath, '{ "project": "alpha-a'); // temp copy only

    let result: RegistryReadResult | undefined;
    await expect(
      (async () => {
        result = await readRegistry(fastReader(), vault);
      })(),
    ).resolves.toBeUndefined();

    const alpha = project(result!, 'alpha-app');
    expect(alpha.missions).toEqual([]);
    expect(alpha.autonomy).toEqual(AUTONOMY_DEFAULTS);
    expect(result!.warnings).toHaveLength(1);
    expect(result!.warnings[0]!.file).toBe(registryPath);
    // The other project is unaffected.
    expect(project(result!, 'legacy-tool').missions).toHaveLength(1);
  });

  it('a corrupt projects.json (no last-good) yields zero projects + one warning', async () => {
    const vault = await tempVaultCopy();
    const projectsPath = path.join(vault, 'registry', 'projects.json');
    await writeFile(projectsPath, 'not json at all');

    const result = await readRegistry(fastReader(), vault);
    expect(result.projects).toEqual([]);
    expect(result.warnings).toHaveLength(1);
    expect(result.warnings[0]!.file).toBe(projectsPath);
  });

  it('last-good: a reader that saw the registry once survives its corruption (stale data + warning)', async () => {
    const vault = await tempVaultCopy();
    const reader = fastReader();

    const before = await readRegistry(reader, vault);
    expect(before.warnings).toEqual([]);

    const registryPath = path.join(vault, 'registry', 'alpha-app.json');
    await writeFile(registryPath, '{ broken'); // temp copy only

    const after = await readRegistry(reader, vault);
    const alpha = project(after, 'alpha-app');
    expect(alpha.missions.map((m) => m.slug)).toEqual(['mission-one', 'mission-two']);
    expect(alpha.missions[0]!.claim?.feature).toBe('FEAT-ONE-003');
    expect(after.warnings.some((w) => w.file === registryPath)).toBe(true);
  });

  it('tolerates arbitrary shape garbage in a per-project registry', async () => {
    const vault = await tempVaultCopy();
    await writeFile(
      path.join(vault, 'registry', 'alpha-app.json'),
      JSON.stringify({
        autonomy: { mode: 'auto', max_fix_passes: 'lots' }, // bad field type → default
        missions: {
          'weird-one': {
            title: 42, // non-string → null
            claim: 'not-an-object', // → null
            depends_on: 'nope', // non-array → []
            fix_passes: { F1: 'two', F2: 2 }, // non-number entries dropped
            blocked_features: { F3: 7, F4: 'real reason' }, // non-string entries dropped
          },
        },
      }),
    );

    const result = await readRegistry(fastReader(), vault);
    const weird = project(result, 'alpha-app').missions[0]!;
    expect(weird.slug).toBe('weird-one');
    expect(weird.title).toBeNull();
    expect(weird.status).toBe('unknown'); // missing status is tolerated, never fatal
    expect(weird.claim).toBeNull();
    expect(weird.dependsOn).toEqual([]);
    expect(weird.fixPasses).toEqual({ F2: 2 });
    expect(weird.blockedFeatures).toEqual({ F4: 'real reason' });
    expect(project(result, 'alpha-app').autonomy).toEqual({
      ...AUTONOMY_DEFAULTS,
      mode: 'auto',
    });
  });

  it('tolerates missions being a non-object', async () => {
    const vault = await tempVaultCopy();
    await writeFile(
      path.join(vault, 'registry', 'alpha-app.json'),
      JSON.stringify({ project: 'alpha-app', missions: 'nope' }),
    );
    const result = await readRegistry(fastReader(), vault);
    expect(project(result, 'alpha-app').missions).toEqual([]);
    // Shape garbage in a file that PARSES is not a read warning (the read succeeded).
    expect(result.warnings).toEqual([]);
  });
});
