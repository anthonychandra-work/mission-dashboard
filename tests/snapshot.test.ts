/**
 * FEAT-DASH-006 — snapshot assembly (spec §3.4; VAL-001, VAL-002, VAL-004).
 *
 * buildSnapshot contract under test:
 *   - PURE function of read results: injected `now` and `revision`, no I/O, no
 *     clock, no input mutation — the golden snapshot is deterministic forever;
 *   - exact spec §3.4 shape: revision/generatedAt/vaultPath/warnings,
 *     projects[].missions[] with claim (ageMinutes, stale via the 005
 *     deriveClaimTiming rule), hasFeaturesFile, featureCounts, currentFeature
 *     (claimed feature, else first in-progress, else first non-terminal),
 *     per-feature escalation counters joined from the registry maps,
 *     nextAction from prompt-queue, blockedFeatures, attention, activity,
 *     inbox summary;
 *   - VAL-002: a mission without features.json → hasFeaturesFile:false,
 *     featureCounts null, rendered from the registry summary;
 *   - VAL-004: malformed JSON → last-good value + parse_warning, and the whole
 *     collect+build pipeline NEVER throws.
 *
 * All reads run against temp copies of the committed fixture vault — never the
 * committed fixture in mutating cases, never the real vault (INV-A).
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { cp, mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import type { Mission, Snapshot } from '../shared/types.js';
import { createSafeReader, type SafeReader } from '../server/aggregate/safeRead.js';
import {
  buildSnapshot,
  collectSnapshotReads,
  missionKey,
  type SnapshotReads,
} from '../server/aggregate/snapshot.js';

const FIXTURE_VAULT = fileURLToPath(new URL('./fixtures/vault-basic', import.meta.url));

// Fixture constants (tests/fixtures/vault-basic/README.md — FIXED, tests inject now).
const CLAIM_STARTED_AT = '2026-01-15T10:00:00'; // alpha-app/mission-one, executor on FEAT-ONE-003
const FRESH_NOW = new Date('2026-01-15T10:10:00Z'); // +10 min < 45 → fresh
const STALE_NOW = new Date('2026-01-15T11:30:00Z'); // +90 min > 45 → stale

let root: string;

beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), 'mission-dashboard-snapshot-'));
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

function newReader(): SafeReader {
  return createSafeReader({ sleep: async () => {} });
}

/** Copy the committed fixture into the temp root (INV-A: mutate copies only). */
async function copyFixture(): Promise<string> {
  const vault = path.join(root, 'vault-basic');
  await cp(FIXTURE_VAULT, vault, { recursive: true });
  return vault;
}

async function fixtureReads(vault: string, reader = newReader()): Promise<SnapshotReads> {
  return collectSnapshotReads(reader, vault);
}

function fixtureSnapshot(vault: string, reads: SnapshotReads, now = FRESH_NOW): Snapshot {
  return buildSnapshot({ revision: 1, now, vaultPath: vault, reads });
}

function mission(snapshot: Snapshot, project: string, mission: string): Mission {
  const p = snapshot.projects.find((entry) => entry.slug === project);
  expect(p, `project ${project}`).toBeDefined();
  const m = p!.missions.find((entry) => entry.slug === mission);
  expect(m, `mission ${project}/${mission}`).toBeDefined();
  return m!;
}

/** Replace the machine-specific temp vault path so the golden file is portable. */
function normalize(snapshot: Snapshot, vault: string): unknown {
  return JSON.parse(JSON.stringify(snapshot).split(vault).join('<vault>'));
}

// ── VAL-001: golden snapshot over the fixture vault ──────────────────────────

describe('buildSnapshot — golden snapshot (VAL-001)', () => {
  it('matches the golden snapshot of the fixture vault (deterministic: injected now)', async () => {
    const vault = await copyFixture();
    const snapshot = fixtureSnapshot(vault, await fixtureReads(vault));
    expect(normalize(snapshot, vault)).toMatchSnapshot();
  });

  it('produces the spec §3.4 top-level shape with passthrough revision/vaultPath', async () => {
    const vault = await copyFixture();
    const reads = await fixtureReads(vault);
    const snapshot = buildSnapshot({ revision: 42, now: FRESH_NOW, vaultPath: vault, reads });

    expect(snapshot.revision).toBe(42);
    expect(snapshot.generatedAt).toBe('2026-01-15T10:10:00.000Z');
    expect(snapshot.vaultPath).toBe(vault);
    expect(snapshot.warnings).toEqual([]);
    expect(snapshot.projects.map((p) => p.slug)).toEqual(['alpha-app', 'legacy-tool']);
  });

  it('assembles mission-one: status, claim timing, counts, currentFeature, nextAction', async () => {
    const vault = await copyFixture();
    const snapshot = fixtureSnapshot(vault, await fixtureReads(vault));
    const m = mission(snapshot, 'alpha-app', 'mission-one');

    expect(m.status).toBe('active');
    expect(m.branch).toBe('mission/mission-one');
    expect(m.claim).toEqual({
      worker: 'executor',
      feature: 'FEAT-ONE-003',
      startedAt: CLAIM_STARTED_AT,
      session: 'fixture-session-1',
      ageMinutes: 10, // FRESH_NOW − started_at, via deriveClaimTiming (005)
      stale: false,
    });
    expect(m.hasFeaturesFile).toBe(true);
    expect(m.featureCounts).toEqual({
      total: 7,
      ready: 1,
      planned: 1,
      inProgress: 1,
      implemented: 1,
      implementedWithFindings: 1,
      validatedPassed: 1,
      validatedFailed: 1,
    });
    // Claimed feature wins (it is also the in-progress one in the fixture).
    expect(m.currentFeature).toEqual({
      name: 'FEAT-ONE-003',
      status: 'in-progress',
      fixPasses: 0,
      failedAttempts: 0,
      crashRetries: 1,
      blockedReason: null,
    });
    expect(m.nextAction).toBe('validate FEAT-ONE-004 once the executor report lands');
    expect(m.blockedFeatures).toEqual({ 'FEAT-ONE-005': 'waiting on upstream API decision' });
  });

  it('joins the registry escalation maps into every feature row', async () => {
    const vault = await copyFixture();
    const snapshot = fixtureSnapshot(vault, await fixtureReads(vault));
    const rows = mission(snapshot, 'alpha-app', 'mission-one').features;

    expect(rows.map((f) => f.name)).toEqual([
      'FEAT-ONE-001',
      'FEAT-ONE-002',
      'FEAT-ONE-003',
      'FEAT-ONE-004',
      'FEAT-ONE-005',
      'FEAT-ONE-006',
      'FEAT-ONE-007',
    ]);
    const byName = Object.fromEntries(rows.map((f) => [f.name, f]));
    expect(byName['FEAT-ONE-002']).toMatchObject({ fixPasses: 1, failedAttempts: 1, crashRetries: 0 });
    expect(byName['FEAT-ONE-003']).toMatchObject({ fixPasses: 0, failedAttempts: 0, crashRetries: 1 });
    expect(byName['FEAT-ONE-005']).toMatchObject({
      blockedReason: 'waiting on upstream API decision',
    });
    // Untouched features carry zeroed counters, never undefined.
    expect(byName['FEAT-ONE-001']).toMatchObject({
      fixPasses: 0,
      failedAttempts: 0,
      crashRetries: 0,
      blockedReason: null,
    });
  });

  it('carries project metadata and the normalized autonomy policy', async () => {
    const vault = await copyFixture();
    const snapshot = fixtureSnapshot(vault, await fixtureReads(vault));
    const alpha = snapshot.projects.find((p) => p.slug === 'alpha-app')!;
    const legacy = snapshot.projects.find((p) => p.slug === 'legacy-tool')!;

    expect(alpha).toMatchObject({
      repoPath: '/tmp/fixture-repos/alpha-app',
      defaultBranch: 'main',
      registryUpdated: '2026-01-15T10:05:00',
      autonomy: { mode: 'auto', maxFixPasses: 2, maxCrashRetries: 1, diagnoseOnFailed: true },
    });
    // legacy-tool has no autonomy block → SCHEMA §4 defaults (003 normalization).
    expect(legacy.autonomy).toEqual({
      mode: 'confirm',
      maxFixPasses: 2,
      maxCrashRetries: 1,
      diagnoseOnFailed: true,
    });
  });

  it('wires attention, activity and the inbox summary into the snapshot', async () => {
    const vault = await copyFixture();
    const snapshot = fixtureSnapshot(vault, await fixtureReads(vault));

    // FRESH_NOW: claim fresh → no orphaned_claim; the other fixture rules fire.
    expect(snapshot.attention.map((a) => a.type)).toEqual([
      'blocked_feature',
      'unprocessed_inbox',
      'failed_inbox',
      'mission_blocked',
    ]);
    expect(snapshot.inbox).toEqual({
      unprocessedCount: 1,
      failedCount: 1,
      unprocessed: [
        {
          file: '20260115-093000-alpha-app-mission-one-FEAT-ONE-002-executor.md',
          project: 'alpha-app',
          mission: 'mission-one',
          feature: 'FEAT-ONE-002',
          role: 'executor',
          result: 'implemented_with_findings',
          timestamp: '2026-01-15T09:30:00.000Z',
        },
      ],
    });
    expect(snapshot.activity.length).toBeGreaterThan(0);
    const stamps = snapshot.activity.map((e) => e.timestamp);
    expect([...stamps].sort().reverse()).toEqual(stamps); // merged newest-first
  });

  it('derives claim staleness through the 005 rule: stale now → stale claim + orphaned_claim', async () => {
    const vault = await copyFixture();
    const snapshot = fixtureSnapshot(vault, await fixtureReads(vault), STALE_NOW);
    const m = mission(snapshot, 'alpha-app', 'mission-one');

    expect(m.claim).toMatchObject({ ageMinutes: 90, stale: true });
    expect(snapshot.attention[0]).toMatchObject({
      type: 'orphaned_claim',
      severity: 'warn',
      project: 'alpha-app',
      mission: 'mission-one',
      feature: 'FEAT-ONE-003',
    });
  });

  it('an unparseable started_at surfaces the claim with null timing, never invented values', async () => {
    const vault = await copyFixture();
    const reads = await fixtureReads(vault);
    const alpha = reads.registry.projects.find((p) => p.slug === 'alpha-app')!;
    alpha.missions[0]!.claim!.startedAt = 'not-a-timestamp';

    const snapshot = fixtureSnapshot(vault, reads, STALE_NOW);
    const m = mission(snapshot, 'alpha-app', 'mission-one');
    expect(m.claim).toMatchObject({ worker: 'executor', ageMinutes: null, stale: null });
    // Staleness unknowable → no orphaned_claim (005 rule).
    expect(snapshot.attention.map((a) => a.type)).not.toContain('orphaned_claim');
  });
});

// ── VAL-002: mission without features.json ───────────────────────────────────

describe('buildSnapshot — missing features.json (VAL-002)', () => {
  it('renders the imported mission from the registry summary alone', async () => {
    const vault = await copyFixture();
    const snapshot = fixtureSnapshot(vault, await fixtureReads(vault));
    const m = mission(snapshot, 'legacy-tool', 'imported-mission');

    expect(m.hasFeaturesFile).toBe(false);
    expect(m.featureCounts).toBeNull();
    expect(m.features).toEqual([]);
    expect(m.currentFeature).toBeNull();
    expect(m.nextAction).toBeNull();
    expect(m.claim).toBeNull();
    expect(m.summary).toBe(
      'Imported legacy mission — no features.json; rendered from this summary alone.',
    );
    expect(m.status).toBe('complete');
    expect(m.prUrl).toBe('https://github.com/example/legacy-tool/pull/7');
    // Legitimate absence is real state, never a warning (spec §1).
    expect(snapshot.warnings).toEqual([]);
  });
});

// ── currentFeature fallback ladder (spec §3.4 assembly rules) ────────────────

describe('buildSnapshot — currentFeature ladder', () => {
  it('the claimed feature wins over the first in-progress feature', async () => {
    const vault = await copyFixture();
    const reads = await fixtureReads(vault);
    const alpha = reads.registry.projects.find((p) => p.slug === 'alpha-app')!;
    alpha.missions[0]!.claim!.feature = 'FEAT-ONE-004'; // 003 stays in-progress

    const m = mission(fixtureSnapshot(vault, reads), 'alpha-app', 'mission-one');
    expect(m.currentFeature).toMatchObject({ name: 'FEAT-ONE-004', status: 'implemented' });
  });

  it('without a claim, the first in-progress feature is current', async () => {
    const vault = await copyFixture();
    const reads = await fixtureReads(vault);
    const alpha = reads.registry.projects.find((p) => p.slug === 'alpha-app')!;
    alpha.missions[0]!.claim = null;

    const m = mission(fixtureSnapshot(vault, reads), 'alpha-app', 'mission-one');
    expect(m.currentFeature).toMatchObject({ name: 'FEAT-ONE-003', status: 'in-progress' });
  });

  it('without a claim or in-progress feature, the first non-terminal feature is current', async () => {
    const vault = await copyFixture();
    const reads = await fixtureReads(vault);
    const alpha = reads.registry.projects.find((p) => p.slug === 'alpha-app')!;
    alpha.missions[0]!.claim = null;
    const bundle = reads.missions.get(missionKey('alpha-app', 'mission-one'))!;
    const renderer = bundle.features.features.find((f) => f.id === 'FEAT-ONE-003')!;
    renderer.status = 'implemented';

    // FEAT-ONE-001 is validated_passed (terminal); FEAT-ONE-002 validated_failed
    // still needs a fix pass → it is the first non-terminal feature.
    const m = mission(fixtureSnapshot(vault, reads), 'alpha-app', 'mission-one');
    expect(m.currentFeature).toMatchObject({ name: 'FEAT-ONE-002', status: 'validated_failed' });
  });

  it('is null when every feature is terminal', async () => {
    const vault = await copyFixture();
    const reads = await fixtureReads(vault);
    const alpha = reads.registry.projects.find((p) => p.slug === 'alpha-app')!;
    alpha.missions[0]!.claim = null;
    const bundle = reads.missions.get(missionKey('alpha-app', 'mission-one'))!;
    for (const f of bundle.features.features) f.status = 'validated_passed';

    const m = mission(fixtureSnapshot(vault, reads), 'alpha-app', 'mission-one');
    expect(m.currentFeature).toBeNull();
  });

  it('a claim on a feature id absent from features.json synthesizes an unknown-status row', async () => {
    const vault = await copyFixture();
    const reads = await fixtureReads(vault);
    const alpha = reads.registry.projects.find((p) => p.slug === 'alpha-app')!;
    alpha.missions[0]!.claim!.feature = 'FEAT-ONE-099';
    alpha.missions[0]!.crashRetries = { 'FEAT-ONE-099': 2 };

    const m = mission(fixtureSnapshot(vault, reads), 'alpha-app', 'mission-one');
    expect(m.currentFeature).toEqual({
      name: 'FEAT-ONE-099',
      status: 'unknown',
      fixPasses: 0,
      failedAttempts: 0,
      crashRetries: 2,
      blockedReason: null,
    });
    // The synthesized current feature never leaks into the feature table.
    expect(m.features.map((f) => f.name)).not.toContain('FEAT-ONE-099');
  });
});

// ── featureCounts tolerance ──────────────────────────────────────────────────

describe('buildSnapshot — featureCounts', () => {
  it('unknown/extra statuses count into total only, never crash (vault-sourced strings)', async () => {
    const vault = await copyFixture();
    const reads = await fixtureReads(vault);
    const bundle = reads.missions.get(missionKey('alpha-app', 'mission-one'))!;
    bundle.features.features.push({
      id: 'FEAT-ONE-008',
      title: 'Drifted',
      milestone: 'M1',
      status: 'blocked', // not one of the 7 counted statuses
      dependsOn: [],
    });

    const m = mission(fixtureSnapshot(vault, reads), 'alpha-app', 'mission-one');
    expect(m.featureCounts).toEqual({
      total: 8,
      ready: 1,
      planned: 1,
      inProgress: 1,
      implemented: 1,
      implementedWithFindings: 1,
      validatedPassed: 1,
      validatedFailed: 1,
    });
    expect(m.features.find((f) => f.name === 'FEAT-ONE-008')).toMatchObject({ status: 'blocked' });
  });
});

// ── VAL-004: malformed JSON → last-good + parse_warning, never throws ────────

describe('buildSnapshot — malformed JSON (VAL-004)', () => {
  it('keeps the last-good registry data and carries a parse_warning', async () => {
    const vault = await copyFixture();
    const reader = newReader();

    // First rebuild: clean — populates the reader's last-good cache.
    const clean = fixtureSnapshot(vault, await fixtureReads(vault, reader));
    expect(clean.warnings).toEqual([]);

    // The registry goes malformed mid-run (temp copy only — INV-A).
    const registryFile = path.join(vault, 'registry', 'alpha-app.json');
    await writeFile(registryFile, '{ this is not JSON', 'utf8');

    // Second rebuild through the SAME reader: last-good keeps the data flowing.
    const snapshot = fixtureSnapshot(vault, await fixtureReads(vault, reader));
    const m = mission(snapshot, 'alpha-app', 'mission-one');
    expect(m.status).toBe('active');
    expect(m.claim).toMatchObject({ feature: 'FEAT-ONE-003' });

    expect(snapshot.warnings).toHaveLength(1);
    expect(snapshot.warnings[0]!.file).toBe(registryFile);
    // parse_warning mirrors snapshot.warnings (spec §3.5 rule 7).
    const mirrored = snapshot.attention.filter((a) => a.type === 'parse_warning');
    expect(mirrored).toHaveLength(1);
    expect(mirrored[0]!.message).toContain(registryFile);
  });

  it('a present-but-corrupt features.json stays hasFeaturesFile:true with a warning (fresh reader)', async () => {
    const vault = await copyFixture();
    const featuresFile = path.join(
      vault,
      'projects',
      'alpha-app',
      'missions',
      'mission-one',
      'features.json',
    );
    await writeFile(featuresFile, '{ broken', 'utf8');

    // Fresh reader: no last-good to fall back on — degrade, do not lie.
    const snapshot = fixtureSnapshot(vault, await fixtureReads(vault));
    const m = mission(snapshot, 'alpha-app', 'mission-one');
    expect(m.hasFeaturesFile).toBe(true); // the file EXISTS — absence is a different state
    expect(m.features).toEqual([]);
    expect(m.featureCounts).toEqual({
      total: 0,
      ready: 0,
      planned: 0,
      inProgress: 0,
      implemented: 0,
      implementedWithFindings: 0,
      validatedPassed: 0,
      validatedFailed: 0,
    });
    expect(snapshot.warnings.map((w) => w.file)).toContain(featuresFile);
    expect(snapshot.attention.map((a) => a.type)).toContain('parse_warning');
  });

  it('never throws, even with a malformed projects.json and no last-good', async () => {
    const vault = path.join(root, 'broken-vault');
    await mkdir(path.join(vault, 'registry'), { recursive: true });
    await writeFile(path.join(vault, 'registry', 'projects.json'), 'not json at all', 'utf8');

    const snapshot = fixtureSnapshot(vault, await fixtureReads(vault));
    expect(snapshot.projects).toEqual([]);
    expect(snapshot.warnings).toHaveLength(1);
    expect(snapshot.attention.map((a) => a.type)).toEqual(['parse_warning']);
    expect(snapshot.inbox).toEqual({ unprocessedCount: 0, failedCount: 0, unprocessed: [] });
    expect(snapshot.activity).toEqual([]);
  });
});

// ── empty vault, purity, determinism ─────────────────────────────────────────

describe('buildSnapshot — empty vault and purity', () => {
  it('an empty vault (zero projects) yields a valid idle snapshot (spec §5)', async () => {
    const vault = path.join(root, 'empty-vault');
    await mkdir(path.join(vault, 'registry'), { recursive: true });
    await writeFile(
      path.join(vault, 'registry', 'projects.json'),
      JSON.stringify({ schema_version: 1, projects: {} }),
      'utf8',
    );

    const snapshot = fixtureSnapshot(vault, await fixtureReads(vault));
    expect(snapshot).toMatchObject({
      revision: 1,
      generatedAt: '2026-01-15T10:10:00.000Z',
      vaultPath: vault,
      warnings: [],
      projects: [],
      attention: [],
      activity: [],
      inbox: { unprocessedCount: 0, failedCount: 0, unprocessed: [] },
    });
  });

  it('is pure: same reads twice → deep-equal snapshots, inputs not mutated', async () => {
    const vault = await copyFixture();
    const reads = await fixtureReads(vault);
    const fingerprint = () =>
      JSON.stringify(reads.registry) +
      JSON.stringify([...reads.missions.entries()]) +
      JSON.stringify(reads.inbox) +
      JSON.stringify(reads.activity);

    const before = fingerprint();
    const first = fixtureSnapshot(vault, reads);
    const second = fixtureSnapshot(vault, reads);
    expect(second).toEqual(first);
    expect(fingerprint()).toBe(before);
  });

  it('honors a configurable staleClaimMinutes threshold', async () => {
    const vault = await copyFixture();
    const reads = await fixtureReads(vault);
    const snapshot = buildSnapshot({
      revision: 1,
      now: FRESH_NOW, // 10-min-old claim
      vaultPath: vault,
      reads,
      staleClaimMinutes: 5,
    });
    expect(mission(snapshot, 'alpha-app', 'mission-one').claim).toMatchObject({
      ageMinutes: 10,
      stale: true,
    });
    expect(snapshot.attention[0]!.type).toBe('orphaned_claim');
  });
});
