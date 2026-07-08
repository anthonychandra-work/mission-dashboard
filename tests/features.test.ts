/**
 * FEAT-DASH-003 — features reader (spec §3.1 module list, §3.4 assembly rules).
 *
 * readFeatures contract under test:
 *   - reads projects/<p>/missions/<slug>/features.json via SafeReader,
 *   - ABSENCE is real state (imported/legacy missions, spec §1):
 *     hasFeaturesFile:false, no warning,
 *   - a present-but-unreadable file keeps hasFeaturesFile:true and reports a
 *     warning; last-good features survive corruption (stale:true),
 *   - tolerates shape garbage: never throws, drops entries without a string id.
 *
 * INV-A: mutation only in temp copies of tests/fixtures/vault-basic.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { cp, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { createSafeReader } from '../server/aggregate/safeRead.js';
import { readFeatures, type FeaturesReadResult } from '../server/aggregate/features.js';

const FIXTURE_VAULT = fileURLToPath(new URL('./fixtures/vault-basic', import.meta.url));

let root: string;

beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), 'mission-dashboard-features-'));
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

function fastReader() {
  return createSafeReader({ sleep: async () => {} });
}

async function tempVaultCopy(): Promise<string> {
  const dest = path.join(root, 'vault-basic');
  await cp(FIXTURE_VAULT, dest, { recursive: true });
  return dest;
}

function missionOnePath(vault: string): string {
  return path.join(vault, 'projects', 'alpha-app', 'missions', 'mission-one', 'features.json');
}

describe('readFeatures — fixture vault happy path', () => {
  it('reads all seven mission-one features in file order', async () => {
    const vault = await tempVaultCopy();
    const result = await readFeatures(fastReader(), vault, 'alpha-app', 'mission-one');

    expect(result.hasFeaturesFile).toBe(true);
    expect(result.warning).toBeNull();
    expect(result.stale).toBe(false);
    expect(result.features.map((f) => f.id)).toEqual([
      'FEAT-ONE-001',
      'FEAT-ONE-002',
      'FEAT-ONE-003',
      'FEAT-ONE-004',
      'FEAT-ONE-005',
      'FEAT-ONE-006',
      'FEAT-ONE-007',
    ]);
    expect(result.features.map((f) => f.status)).toEqual([
      'validated_passed',
      'validated_failed',
      'in-progress',
      'implemented',
      'implemented_with_findings',
      'ready',
      'planned',
    ]);
  });

  it('normalizes per-feature fields: title, milestone, dependsOn', async () => {
    const vault = await tempVaultCopy();
    const result = await readFeatures(fastReader(), vault, 'alpha-app', 'mission-one');
    const bootstrap = result.features[0]!;
    expect(bootstrap).toEqual({
      id: 'FEAT-ONE-001',
      title: 'Bootstrap',
      milestone: 'M1',
      status: 'validated_passed',
      dependsOn: [],
    });
    expect(result.features[6]!.dependsOn).toEqual(['FEAT-ONE-006']);
  });
});

describe('readFeatures — absence is real state (spec §1)', () => {
  it('a mission without features.json → hasFeaturesFile:false, no warning', async () => {
    const vault = await tempVaultCopy();
    const result = await readFeatures(fastReader(), vault, 'legacy-tool', 'imported-mission');

    expect(result.hasFeaturesFile).toBe(false);
    expect(result.features).toEqual([]);
    expect(result.warning).toBeNull();
    expect(result.stale).toBe(false);
  });

  it('a mission folder that does not exist at all behaves the same as an absent file', async () => {
    const vault = await tempVaultCopy();
    const result = await readFeatures(fastReader(), vault, 'no-such-project', 'no-such-mission');
    expect(result.hasFeaturesFile).toBe(false);
    expect(result.warning).toBeNull();
  });
});

describe('readFeatures — tolerance (never throws, warnings instead)', () => {
  it('a malformed features.json (no last-good) keeps hasFeaturesFile:true + warning, empty features', async () => {
    const vault = await tempVaultCopy();
    const featuresPath = missionOnePath(vault);
    await writeFile(featuresPath, '{ "features": ['); // temp copy only

    let result: FeaturesReadResult | undefined;
    await expect(
      (async () => {
        result = await readFeatures(fastReader(), vault, 'alpha-app', 'mission-one');
      })(),
    ).resolves.toBeUndefined();

    expect(result!.hasFeaturesFile).toBe(true); // the file EXISTS, it is just unreadable
    expect(result!.features).toEqual([]);
    expect(result!.stale).toBe(false);
    expect(result!.warning).toMatchObject({ file: featuresPath });
  });

  it('last-good: corruption after a good read serves stale features + warning', async () => {
    const vault = await tempVaultCopy();
    const reader = fastReader();

    const before = await readFeatures(reader, vault, 'alpha-app', 'mission-one');
    expect(before.features).toHaveLength(7);

    await writeFile(missionOnePath(vault), 'garbage'); // temp copy only
    const after = await readFeatures(reader, vault, 'alpha-app', 'mission-one');

    expect(after.hasFeaturesFile).toBe(true);
    expect(after.stale).toBe(true);
    expect(after.features.map((f) => f.id)).toEqual(before.features.map((f) => f.id));
    expect(after.warning).toMatchObject({ file: missionOnePath(vault) });
  });

  it('tolerates features not being an array', async () => {
    const vault = await tempVaultCopy();
    await writeFile(missionOnePath(vault), JSON.stringify({ features: { a: 1 } }));
    const result = await readFeatures(fastReader(), vault, 'alpha-app', 'mission-one');
    expect(result.hasFeaturesFile).toBe(true);
    expect(result.features).toEqual([]);
    expect(result.warning).toBeNull(); // the read PARSED fine; shape garbage is not a read warning
  });

  it('drops entries without a string id and coerces missing fields', async () => {
    const vault = await tempVaultCopy();
    await writeFile(
      missionOnePath(vault),
      JSON.stringify({
        features: [
          { id: 7, status: 'ready' }, // non-string id → dropped
          'not-an-object', // → dropped
          { id: 'FEAT-OK-001' }, // no status/title/milestone → tolerated
          { id: 'FEAT-OK-002', status: 'ready', dependsOn: 'nope' }, // bad dependsOn → []
        ],
      }),
    );
    const result = await readFeatures(fastReader(), vault, 'alpha-app', 'mission-one');
    expect(result.features).toEqual([
      { id: 'FEAT-OK-001', title: null, milestone: null, status: 'unknown', dependsOn: [] },
      { id: 'FEAT-OK-002', title: null, milestone: null, status: 'ready', dependsOn: [] },
    ]);
  });
});
