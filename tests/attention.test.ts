/**
 * FEAT-DASH-005 — attention derivation (spec §3.5, VAL-003).
 *
 * deriveAttention contract under test — EXACTLY the seven rules:
 *   orphaned_claim    claim non-null AND stale AND no inbox report (top-level
 *                     or .processed/) matching project+mission+feature+role
 *                     with timestamp >= started_at                      (warn)
 *   awaiting_merge    mission active AND pr_url set                     (info)
 *   blocked_feature   one item per registry blocked_features entry      (warn)
 *   unprocessed_inbox top-level inbox/*.md older than 10 min            (info)
 *   failed_inbox      any file in inbox/.failed/                        (warn)
 *   mission_blocked   queued/paused with non-null blocked_reason        (info)
 *   parse_warning     mirror of snapshot.warnings                       (info)
 *
 * Pure function: `now` is injected (VAL-003 — the fixture's FIXED claim
 * timestamp never rots), staleClaimMinutes configurable (default 45, SETTLED).
 * One targeted describe per rule covering BOTH the firing and the non-firing
 * branch. Inputs come from the real readers over a temp copy of the committed
 * fixture vault (INV-A: the committed fixture and the real vault are never
 * mutated); branch variations tweak the plain reader-output objects in memory.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { cp, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import type { AttentionItem, InboxReportSummary } from '../shared/types.js';
import { createSafeReader } from '../server/aggregate/safeRead.js';
import { readInbox } from '../server/aggregate/inbox.js';
import { readRegistry, type RegistryProject } from '../server/aggregate/registry.js';
import {
  DEFAULT_STALE_CLAIM_MINUTES,
  UNPROCESSED_INBOX_GRACE_MINUTES,
  deriveAttention,
  deriveClaimTiming,
  parseVaultTimestamp,
  type AttentionInput,
} from '../server/aggregate/attention.js';

const FIXTURE_VAULT = fileURLToPath(new URL('./fixtures/vault-basic', import.meta.url));

// Fixture constants (tests/fixtures/vault-basic/README.md — FIXED, tests inject now).
const CLAIM_STARTED_AT = '2026-01-15T10:00:00'; // alpha-app/mission-one, executor on FEAT-ONE-003
const FRESH_NOW = new Date('2026-01-15T10:10:00Z'); // +10 min < 45 → fresh
const STALE_NOW = new Date('2026-01-15T11:30:00Z'); // +90 min > 45 → stale
const UNPROCESSED_REPORT_FILE = '20260115-093000-alpha-app-mission-one-FEAT-ONE-002-executor.md';
const FAILED_REPORT_FILE = '20260113-110000-legacy-tool-imported-mission-none-executor.md';

let root: string;

beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), 'mission-dashboard-attention-'));
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

/** Read the fixture vault (temp copy) through the real 003/004 readers. */
async function fixtureInput(now: Date, staleClaimMinutes?: number): Promise<AttentionInput> {
  const vault = path.join(root, 'vault-basic');
  await cp(FIXTURE_VAULT, vault, { recursive: true });
  const reader = createSafeReader({ sleep: async () => {} });
  const registry = await readRegistry(reader, vault);
  const inbox = await readInbox(reader, vault);
  expect(registry.warnings).toEqual([]);
  expect(inbox.warnings).toEqual([]);
  return {
    projects: registry.projects,
    inbox,
    warnings: [],
    now,
    ...(staleClaimMinutes === undefined ? {} : { staleClaimMinutes }),
  };
}

function ofType(items: AttentionItem[], type: AttentionItem['type']): AttentionItem[] {
  return items.filter((i) => i.type === type);
}

function report(overrides: Partial<InboxReportSummary>): InboxReportSummary {
  return {
    file: 'synthetic.md',
    project: null,
    mission: null,
    feature: null,
    role: null,
    result: null,
    timestamp: null,
    ...overrides,
  };
}

/** A report matching the fixture claim (project+mission+feature+role), ts >= started_at. */
function matchingClaimReport(timestamp: string | null): InboxReportSummary {
  return report({
    file: '20260115-103000-alpha-app-mission-one-FEAT-ONE-003-executor.md',
    project: 'alpha-app',
    mission: 'mission-one',
    feature: 'FEAT-ONE-003',
    role: 'executor',
    result: 'implemented',
    timestamp,
  });
}

// ── rule 1: orphaned_claim (VAL-003) ─────────────────────────────────────────

describe('orphaned_claim', () => {
  it('fires for a stale claim with no matching inbox report', async () => {
    const input = await fixtureInput(STALE_NOW);
    const items = ofType(deriveAttention(input), 'orphaned_claim');

    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({
      severity: 'warn',
      project: 'alpha-app',
      mission: 'mission-one',
      feature: 'FEAT-ONE-003',
      since: CLAIM_STARTED_AT,
    });
    // Copy contract: "possibly dead", NEVER a bare "dead".
    expect(items[0]!.message).toContain('possibly dead');
    expect(items[0]!.message.split('possibly dead').join('')).not.toContain('dead');
    expect(items[0]!.message).toContain('executor');
    expect(items[0]!.message).toContain('FEAT-ONE-003');
    expect(items[0]!.message).toContain('1h'); // 90 min → whole hours
  });

  it('does not fire for a fresh claim (VAL-003 non-firing branch)', async () => {
    const input = await fixtureInput(FRESH_NOW);
    expect(ofType(deriveAttention(input), 'orphaned_claim')).toEqual([]);
  });

  it('staleClaimMinutes is configurable: a 10-min-old claim goes stale at threshold 5', async () => {
    const input = await fixtureInput(FRESH_NOW, 5);
    const items = ofType(deriveAttention(input), 'orphaned_claim');
    expect(items).toHaveLength(1);
    expect(items[0]!.message).toContain('10m');
  });

  it('is suppressed by a matching TOP-LEVEL report with timestamp >= started_at', async () => {
    const input = await fixtureInput(STALE_NOW);
    input.inbox.unprocessed.push(matchingClaimReport('2026-01-15T10:30:00.000Z'));
    expect(ofType(deriveAttention(input), 'orphaned_claim')).toEqual([]);
  });

  it('is suppressed by a matching .processed/ report with timestamp >= started_at', async () => {
    const input = await fixtureInput(STALE_NOW);
    input.inbox.processed.push(matchingClaimReport('2026-01-15T10:30:00.000Z'));
    expect(ofType(deriveAttention(input), 'orphaned_claim')).toEqual([]);
  });

  it('a report timestamped exactly at started_at counts (>=, ISO-UTC vs raw vault string)', async () => {
    const input = await fixtureInput(STALE_NOW);
    // Raw claim string "2026-01-15T10:00:00" vs normalized "…T10:00:00.000Z":
    // never string equality — parsed comparison (knowledge-base timestamp rule).
    input.inbox.processed.push(matchingClaimReport('2026-01-15T10:00:00.000Z'));
    expect(ofType(deriveAttention(input), 'orphaned_claim')).toEqual([]);
  });

  it('still fires when the only reports mismatch or predate the claim', async () => {
    const input = await fixtureInput(STALE_NOW);
    input.inbox.unprocessed.push(
      { ...matchingClaimReport('2026-01-15T10:30:00.000Z'), role: 'validator' }, // wrong role
      { ...matchingClaimReport('2026-01-15T10:30:00.000Z'), feature: 'FEAT-ONE-002' }, // wrong feature
      { ...matchingClaimReport('2026-01-15T10:30:00.000Z'), mission: 'mission-two' }, // wrong mission
      { ...matchingClaimReport('2026-01-15T10:30:00.000Z'), project: 'legacy-tool' }, // wrong project
      matchingClaimReport('2026-01-15T09:59:00.000Z'), // predates started_at
      matchingClaimReport(null), // unverifiable timestamp never matches
    );
    // The fixture's own FEAT-ONE-002 executor report must not suppress either.
    expect(ofType(deriveAttention(input), 'orphaned_claim')).toHaveLength(1);
  });

  it('does not fire without a claim or with an unparseable started_at', async () => {
    const input = await fixtureInput(STALE_NOW);
    const alpha = input.projects.find((p) => p.slug === 'alpha-app')!;
    alpha.missions[0]!.claim!.startedAt = 'not-a-timestamp'; // staleness unknowable
    expect(ofType(deriveAttention(input), 'orphaned_claim')).toEqual([]);
    alpha.missions[0]!.claim = null; // and mission-two/imported-mission have none
    expect(ofType(deriveAttention(input), 'orphaned_claim')).toEqual([]);
  });
});

// ── rule 2: awaiting_merge ───────────────────────────────────────────────────

describe('awaiting_merge', () => {
  it('fires for an active mission with pr_url set', async () => {
    const input = await fixtureInput(FRESH_NOW);
    const alpha = input.projects.find((p) => p.slug === 'alpha-app')!;
    alpha.missions[0]!.prUrl = 'https://github.com/example/alpha-app/pull/12';

    const items = ofType(deriveAttention(input), 'awaiting_merge');
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({
      severity: 'info',
      project: 'alpha-app',
      mission: 'mission-one',
      feature: null,
    });
    expect(items[0]!.message).toContain('https://github.com/example/alpha-app/pull/12');
  });

  it('does not fire on the fixture as-is: active without pr_url, complete with pr_url', async () => {
    const input = await fixtureInput(FRESH_NOW);
    // mission-one is active but prUrl null; imported-mission has a pr_url but is
    // "complete", not "active" — both non-firing branches in one pass.
    expect(ofType(deriveAttention(input), 'awaiting_merge')).toEqual([]);
  });
});

// ── rule 3: blocked_feature ──────────────────────────────────────────────────

describe('blocked_feature', () => {
  it('fires one warn item per registry blocked_features entry, with its reason', async () => {
    const input = await fixtureInput(FRESH_NOW);
    const items = ofType(deriveAttention(input), 'blocked_feature');

    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({
      severity: 'warn',
      project: 'alpha-app',
      mission: 'mission-one',
      feature: 'FEAT-ONE-005',
    });
    expect(items[0]!.message).toContain('waiting on upstream API decision');
  });

  it('emits one item per entry and none for empty maps', async () => {
    const input = await fixtureInput(FRESH_NOW);
    const alpha = input.projects.find((p) => p.slug === 'alpha-app')!;
    alpha.missions[0]!.blockedFeatures = {
      'FEAT-ONE-005': 'waiting on upstream API decision',
      'FEAT-ONE-007': 'needs design sign-off',
    };
    expect(ofType(deriveAttention(input), 'blocked_feature')).toHaveLength(2);

    alpha.missions[0]!.blockedFeatures = {};
    expect(ofType(deriveAttention(input), 'blocked_feature')).toEqual([]);
  });
});

// ── rule 4: unprocessed_inbox ────────────────────────────────────────────────

describe('unprocessed_inbox', () => {
  it('fires info per top-level report older than 10 min', async () => {
    const input = await fixtureInput(FRESH_NOW); // report 09:30, now 10:10 → 40 min
    const items = ofType(deriveAttention(input), 'unprocessed_inbox');

    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({
      severity: 'info',
      project: 'alpha-app',
      mission: 'mission-one',
      feature: 'FEAT-ONE-002',
      since: '2026-01-15T09:30:00.000Z',
    });
    expect(items[0]!.message).toContain(UNPROCESSED_REPORT_FILE);
    expect(items[0]!.message).toContain('inbox not drained; run memory-sync');
  });

  it('does not fire within the 10-minute grace period', async () => {
    const input = await fixtureInput(new Date('2026-01-15T09:35:00Z')); // 5 min old
    expect(ofType(deriveAttention(input), 'unprocessed_inbox')).toEqual([]);
    expect(UNPROCESSED_INBOX_GRACE_MINUTES).toBe(10);
  });

  it('a report with no parseable timestamp counts as undrained (fires)', async () => {
    const input = await fixtureInput(new Date('2026-01-15T09:35:00Z'));
    input.inbox.unprocessed = [report({ file: 'broken-frontmatter.md' })];
    const items = ofType(deriveAttention(input), 'unprocessed_inbox');
    expect(items).toHaveLength(1);
    expect(items[0]!.since).toBeNull();
  });
});

// ── rule 5: failed_inbox ─────────────────────────────────────────────────────

describe('failed_inbox', () => {
  it('fires warn per file in inbox/.failed/', async () => {
    const input = await fixtureInput(FRESH_NOW);
    const items = ofType(deriveAttention(input), 'failed_inbox');

    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({ severity: 'warn', project: null, mission: null });
    expect(items[0]!.message).toContain(FAILED_REPORT_FILE);
  });

  it('does not fire when .failed/ is empty', async () => {
    const input = await fixtureInput(FRESH_NOW);
    input.inbox.failedFiles = [];
    expect(ofType(deriveAttention(input), 'failed_inbox')).toEqual([]);
  });
});

// ── rule 6: mission_blocked ──────────────────────────────────────────────────

describe('mission_blocked', () => {
  it('fires info for a queued mission with a blocked_reason', async () => {
    const input = await fixtureInput(FRESH_NOW);
    const items = ofType(deriveAttention(input), 'mission_blocked');

    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({
      severity: 'info',
      project: 'alpha-app',
      mission: 'mission-two',
      feature: null,
    });
    expect(items[0]!.message).toContain('depends on mission-one');
  });

  it('fires for paused missions too; never without a reason or for active missions', async () => {
    const input = await fixtureInput(FRESH_NOW);
    const alpha = input.projects.find((p) => p.slug === 'alpha-app')!;
    const [missionOneEntry, missionTwo] = alpha.missions as [
      RegistryProject['missions'][number],
      RegistryProject['missions'][number],
    ];

    missionTwo.status = 'paused';
    expect(ofType(deriveAttention(input), 'mission_blocked')).toHaveLength(1);

    missionTwo.blockedReason = null; // queued/paused but reason null → no item
    expect(ofType(deriveAttention(input), 'mission_blocked')).toEqual([]);

    missionOneEntry.blockedReason = 'reason on an active mission'; // wrong status → no item
    expect(ofType(deriveAttention(input), 'mission_blocked')).toEqual([]);
  });
});

// ── rule 7: parse_warning ────────────────────────────────────────────────────

describe('parse_warning', () => {
  it('mirrors every snapshot warning as an info item', async () => {
    const input = await fixtureInput(FRESH_NOW);
    input.warnings = [
      { file: '/vault/registry/alpha-app.json', error: 'Unexpected end of JSON input' },
      { file: '/vault/inbox/broken.md', error: 'bad YAML frontmatter' },
    ];

    const items = ofType(deriveAttention(input), 'parse_warning');
    expect(items).toHaveLength(2);
    expect(items[0]).toMatchObject({ severity: 'info', project: null, mission: null, feature: null });
    expect(items[0]!.message).toContain('/vault/registry/alpha-app.json');
    expect(items[0]!.message).toContain('Unexpected end of JSON input');
    expect(items[1]!.message).toContain('bad YAML frontmatter');
  });

  it('does not fire when there are no warnings', async () => {
    const input = await fixtureInput(FRESH_NOW);
    expect(ofType(deriveAttention(input), 'parse_warning')).toEqual([]);
  });
});

// ── cross-rule behavior ──────────────────────────────────────────────────────

describe('deriveAttention — determinism and shape', () => {
  it('emits items in spec §3.5 rule-table order (UI does the warn-first sort)', async () => {
    const input = await fixtureInput(STALE_NOW);
    input.warnings = [{ file: '/vault/x.json', error: 'boom' }];

    expect(deriveAttention(input).map((i) => i.type)).toEqual([
      'orphaned_claim', // stale fixture claim
      'blocked_feature', // FEAT-ONE-005
      'unprocessed_inbox', // 09:30 report, 2h old
      'failed_inbox', // one .failed file
      'mission_blocked', // mission-two queued
      'parse_warning', // injected warning
    ]);
  });

  it('is pure: same input object twice → deep-equal output, input not mutated', async () => {
    const input = await fixtureInput(STALE_NOW);
    const snapshotBefore = JSON.stringify(input.projects) + JSON.stringify(input.inbox);
    const first = deriveAttention(input);
    const second = deriveAttention(input);
    expect(second).toEqual(first);
    expect(JSON.stringify(input.projects) + JSON.stringify(input.inbox)).toBe(snapshotBefore);
  });

  it('an idle empty vault derives zero attention items', () => {
    const items = deriveAttention({
      projects: [],
      inbox: { unprocessed: [], processed: [], failedFiles: [] },
      warnings: [],
      now: FRESH_NOW,
    });
    expect(items).toEqual([]);
  });
});

// ── claim-timing helper (shared with FEAT-DASH-006 snapshot assembly) ────────

describe('deriveClaimTiming / parseVaultTimestamp', () => {
  it('default threshold is 45 minutes, strict: 45 is fresh, 46 is stale', () => {
    expect(DEFAULT_STALE_CLAIM_MINUTES).toBe(45);
    const at = (min: number) => new Date(Date.parse('2026-01-15T10:00:00Z') + min * 60_000);

    expect(deriveClaimTiming(CLAIM_STARTED_AT, at(45), 45)).toEqual({ ageMinutes: 45, stale: false });
    expect(deriveClaimTiming(CLAIM_STARTED_AT, at(46), 46)).toEqual({ ageMinutes: 46, stale: false });
    expect(deriveClaimTiming(CLAIM_STARTED_AT, at(46), 45)).toEqual({ ageMinutes: 46, stale: true });
  });

  it('returns null for absent or unparseable started_at', () => {
    expect(deriveClaimTiming(null, FRESH_NOW, 45)).toBeNull();
    expect(deriveClaimTiming('garbage', FRESH_NOW, 45)).toBeNull();
  });

  it('parses offset-less vault timestamps as UTC, matching the inbox ISO normalization', () => {
    // Raw registry string and the gray-matter/js-yaml ISO form are the SAME instant.
    expect(parseVaultTimestamp('2026-01-15T10:00:00')).toBe(
      parseVaultTimestamp('2026-01-15T10:00:00.000Z'),
    );
    expect(parseVaultTimestamp('2026-01-15 10:00:00')).toBe(
      parseVaultTimestamp('2026-01-15T10:00:00Z'),
    );
    expect(parseVaultTimestamp(null)).toBeNull();
    expect(parseVaultTimestamp('not a time')).toBeNull();
  });
});
