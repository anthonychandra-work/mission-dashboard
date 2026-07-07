/**
 * Attention derivation — pure function over reader outputs (spec §3.5).
 *
 * Implements EXACTLY the seven rules of the spec §3.5 table:
 *
 * | type              | rule                                                        | severity |
 * |-------------------|-------------------------------------------------------------|----------|
 * | orphaned_claim    | claim non-null AND stale AND no inbox report (top-level or  | warn     |
 * |                   | .processed/) matching project+mission+feature+role with     |          |
 * |                   | timestamp >= started_at                                     |          |
 * | awaiting_merge    | mission status == "active" AND pr_url set                   | info     |
 * | blocked_feature   | one item per registry blocked_features entry, with reason   | warn     |
 * | unprocessed_inbox | any top-level inbox/*.md older than 10 min                  | info     |
 * | failed_inbox      | any file in inbox/.failed/                                  | warn     |
 * | mission_blocked   | mission queued/paused with non-null blocked_reason          | info     |
 * | parse_warning     | mirror of snapshot.warnings                                 | info     |
 *
 * Purity contract (VAL-003): NO clock access — `now` is injected, and
 * `claim.stale = now − started_at > staleClaimMinutes` (default 45,
 * configurable via --stale-minutes/env upstream; SETTLED). The fixture's
 * FIXED claim timestamps stay valid forever because tests pick `now`.
 *
 * Copy contract: the orphaned_claim message says "possibly dead", NEVER a
 * bare "dead" — claims-only liveness cannot prove death (spec §4, SETTLED).
 *
 * Timestamp semantics (knowledge-base, FEAT-DASH-004): registry claim
 * `started_at` is the raw offset-less vault string while inbox report
 * timestamps were normalized to ISO-UTC (`…Z`) by js-yaml, which reads
 * offset-less datetimes as UTC. Comparing via bare `Date.parse` would read
 * the raw side as LOCAL time and skew by the host offset, so every
 * comparison funnels through {@link parseVaultTimestamp}, which applies the
 * same offset-less→UTC convention to both sides. Never string equality.
 *
 * Items are emitted in rule-table order; the warn-before-info sort is the
 * UI's job (spec §3.5 "UI sorts warn before info").
 *
 * FEAT-DASH-006 reuses {@link deriveClaimTiming} for `Claim.ageMinutes` /
 * `Claim.stale` so the staleness rule lives in exactly one place.
 */
import type { AttentionItem, InboxReportSummary, SnapshotWarning } from '../../shared/types.js';
import type { RegistryMission, RegistryProject } from './registry.js';

/** SETTLED default staleness threshold (spec §1/§4): 45 minutes. */
export const DEFAULT_STALE_CLAIM_MINUTES = 45;

/** Spec §3.5: a top-level inbox report older than 10 min means "not drained". */
export const UNPROCESSED_INBOX_GRACE_MINUTES = 10;

/**
 * Parse a vault timestamp string to epoch milliseconds, or null.
 *
 * Offset-less date-times (`2026-01-15T10:00:00`, `2026-01-15 10:00`) are read
 * as UTC — the same convention js-yaml applied to inbox frontmatter — so raw
 * registry strings and normalized ISO-UTC report timestamps stay comparable
 * regardless of the host timezone (see module header).
 */
export function parseVaultTimestamp(value: string | null): number | null {
  if (!value) return null;
  const trimmed = value.trim();
  const offsetless = /^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?$/;
  const normalized = offsetless.test(trimmed) ? `${trimmed.replace(' ', 'T')}Z` : trimmed;
  const ms = Date.parse(normalized);
  return Number.isNaN(ms) ? null : ms;
}

/** Derived claim timing — the inputs to the staleness rule and the claim badge. */
export interface ClaimTiming {
  /** Whole minutes elapsed since started_at (floored, never negative). */
  ageMinutes: number;
  /** `now − started_at > staleClaimMinutes` (strict — spec §3.4). */
  stale: boolean;
}

/**
 * Derive a claim's age and staleness from its raw `started_at` string and the
 * injected `now`. Returns null when `started_at` is absent or unparseable —
 * staleness is then unknowable, so no liveness rule can fire on it.
 */
export function deriveClaimTiming(
  startedAt: string | null,
  now: Date,
  staleClaimMinutes: number = DEFAULT_STALE_CLAIM_MINUTES,
): ClaimTiming | null {
  const startedMs = parseVaultTimestamp(startedAt);
  if (startedMs === null) return null;
  const ageMs = now.getTime() - startedMs;
  return {
    ageMinutes: Math.max(0, Math.floor(ageMs / 60_000)),
    stale: ageMs > staleClaimMinutes * 60_000,
  };
}

/** The inbox slice attention needs — `InboxReadResult` fits structurally. */
export interface AttentionInboxInput {
  /** Top-level inbox/*.md frontmatter summaries (oldest first). */
  unprocessed: InboxReportSummary[];
  /** inbox/.processed/ summaries — orphaned_claim match pool (FEAT-DASH-004). */
  processed: InboxReportSummary[];
  /** inbox/.failed/ file names. */
  failedFiles: string[];
}

/** Everything deriveAttention sees — reader outputs plus the injected clock. */
export interface AttentionInput {
  projects: RegistryProject[];
  inbox: AttentionInboxInput;
  /** The assembled snapshot warnings (mirrored as parse_warning items). */
  warnings: SnapshotWarning[];
  /** Injected clock — this module never reads the wall clock (VAL-003). */
  now: Date;
  /** Staleness threshold in minutes; defaults to {@link DEFAULT_STALE_CLAIM_MINUTES}. */
  staleClaimMinutes?: number;
}

/** "40m" under an hour, whole "2h" above — mirrors the spec §3.4 sample copy. */
function formatAge(ageMinutes: number): string {
  return ageMinutes >= 60 ? `${Math.floor(ageMinutes / 60)}h` : `${ageMinutes}m`;
}

/**
 * True when some report (top-level or .processed/) matches the claim on
 * project+mission+feature+role AND is timestamped at/after started_at.
 * A report without a parseable timestamp can never vouch for a claim.
 */
function hasMatchingReport(
  reports: InboxReportSummary[],
  project: RegistryProject,
  mission: RegistryMission,
  claim: NonNullable<RegistryMission['claim']>,
  startedMs: number,
): boolean {
  return reports.some((report) => {
    if (report.project !== project.slug) return false;
    if (report.mission !== mission.slug) return false;
    if (report.feature !== claim.feature) return false;
    if (report.role !== claim.worker) return false;
    const reportMs = parseVaultTimestamp(report.timestamp);
    return reportMs !== null && reportMs >= startedMs;
  });
}

/**
 * Derive the attention list from reader outputs. Pure: no I/O, no clock, no
 * input mutation; the same input always yields the same items, in rule-table
 * order (spec §3.5).
 */
export function deriveAttention(input: AttentionInput): AttentionItem[] {
  const { projects, inbox, warnings, now } = input;
  const staleClaimMinutes = input.staleClaimMinutes ?? DEFAULT_STALE_CLAIM_MINUTES;
  const items: AttentionItem[] = [];

  // Rule 1 — orphaned_claim (warn): stale claim with no report vouching for it.
  const reportPool = [...inbox.unprocessed, ...inbox.processed];
  for (const project of projects) {
    for (const mission of project.missions) {
      const claim = mission.claim;
      if (!claim) continue;
      const timing = deriveClaimTiming(claim.startedAt, now, staleClaimMinutes);
      if (!timing?.stale) continue; // fresh, or staleness unknowable
      const startedMs = parseVaultTimestamp(claim.startedAt)!;
      if (hasMatchingReport(reportPool, project, mission, claim, startedMs)) continue;
      const subject = claim.feature ? `claim on ${claim.feature}` : 'claim';
      items.push({
        type: 'orphaned_claim',
        severity: 'warn',
        project: project.slug,
        mission: mission.slug,
        feature: claim.feature,
        message: `${claim.worker} ${subject} started ${formatAge(timing.ageMinutes)} ago, no report filed — possibly dead`,
        since: claim.startedAt,
      });
    }
  }

  // Rule 2 — awaiting_merge (info): active mission with an open PR.
  for (const project of projects) {
    for (const mission of project.missions) {
      if (mission.status !== 'active' || !mission.prUrl) continue;
      items.push({
        type: 'awaiting_merge',
        severity: 'info',
        project: project.slug,
        mission: mission.slug,
        feature: null,
        message: `mission ${mission.slug} is active with an open PR — awaiting merge (${mission.prUrl})`,
        since: mission.activated,
      });
    }
  }

  // Rule 3 — blocked_feature (warn): one item per registry blocked_features entry.
  for (const project of projects) {
    for (const mission of project.missions) {
      for (const [feature, reason] of Object.entries(mission.blockedFeatures)) {
        items.push({
          type: 'blocked_feature',
          severity: 'warn',
          project: project.slug,
          mission: mission.slug,
          feature,
          message: `${feature} blocked — ${reason}`,
          since: null,
        });
      }
    }
  }

  // Rule 4 — unprocessed_inbox (info): top-level report older than 10 min.
  // A report with no parseable timestamp counts as undrained — its age cannot
  // be shown to be inside the grace period, and the file is sitting top-level.
  const graceMs = UNPROCESSED_INBOX_GRACE_MINUTES * 60_000;
  for (const report of inbox.unprocessed) {
    const reportMs = parseVaultTimestamp(report.timestamp);
    if (reportMs !== null && now.getTime() - reportMs <= graceMs) continue;
    const age =
      reportMs === null
        ? 'an unknown time'
        : formatAge(Math.max(0, Math.floor((now.getTime() - reportMs) / 60_000)));
    items.push({
      type: 'unprocessed_inbox',
      severity: 'info',
      project: report.project,
      mission: report.mission,
      feature: report.feature,
      message: `inbox report ${report.file} waiting ${age} — inbox not drained; run memory-sync`,
      since: report.timestamp,
    });
  }

  // Rule 5 — failed_inbox (warn): any file in inbox/.failed/.
  for (const file of inbox.failedFiles) {
    items.push({
      type: 'failed_inbox',
      severity: 'warn',
      project: null,
      mission: null,
      feature: null,
      message: `inbox/.failed/${file} — report failed memory-sync processing; needs manual review`,
      since: null,
    });
  }

  // Rule 6 — mission_blocked (info): queued/paused mission with a reason.
  for (const project of projects) {
    for (const mission of project.missions) {
      const gated = mission.status === 'queued' || mission.status === 'paused';
      if (!gated || mission.blockedReason === null) continue;
      items.push({
        type: 'mission_blocked',
        severity: 'info',
        project: project.slug,
        mission: mission.slug,
        feature: null,
        message: `mission ${mission.slug} ${mission.status} — ${mission.blockedReason}`,
        since: null,
      });
    }
  }

  // Rule 7 — parse_warning (info): mirror of snapshot.warnings.
  for (const warning of warnings) {
    items.push({
      type: 'parse_warning',
      severity: 'info',
      project: null,
      mission: null,
      feature: null,
      message: `${warning.file}: ${warning.error}`,
      since: null,
    });
  }

  return items;
}
