/**
 * Shared snapshot data model — the one shape the frontend consumes.
 *
 * Source of truth: docs/specs/mission-dashboard/spec.md §3.4 (pinned 1f5b8ee).
 * Built by server/aggregate/snapshot.ts, streamed over SSE, imported by the client.
 *
 * Convention: values we derive ourselves (attention types, severities) are closed
 * literal unions; values read from vault files (mission/feature statuses) are typed
 * as documented string aliases so schema drift in the vault can never crash the
 * aggregator (spec §5: tolerant reads, garbage never fatal).
 */

/** A non-fatal read/parse problem surfaced during snapshot assembly (spec §3.3). */
export interface SnapshotWarning {
  /** Vault-relative or absolute path of the offending file. */
  file: string;
  /** Human-readable parse/read error. */
  error: string;
}

/**
 * Mission status as recorded in the project registry.
 * Known values: "queued" | "active" | "paused" | "complete" — tolerated as string.
 */
export type MissionStatus = string;

/**
 * Feature status as recorded in features.json.
 * Known values: "planned" | "ready" | "in-progress" | "implemented" |
 * "implemented_with_findings" | "validated_passed" | "validated_failed" —
 * tolerated as string (vault-sourced).
 */
export type FeatureStatus = string;

/** Autonomy policy block from the per-project registry (vault SCHEMA §4). */
export interface AutonomyPolicy {
  mode: string;
  maxFixPasses: number;
  maxCrashRetries: number;
  diagnoseOnFailed: boolean;
}

/**
 * The registry claim object — the only liveness signal (spec §1).
 * `ageMinutes`/`stale` are derived at snapshot time from `startedAt` and the
 * configured staleness threshold (default 45 min).
 */
export interface Claim {
  worker: string;
  feature: string | null;
  startedAt: string;
  session: string | null;
  ageMinutes: number;
  stale: boolean;
}

/** Aggregated per-mission feature counts (drives progress bars). */
export interface FeatureCounts {
  total: number;
  ready: number;
  planned: number;
  inProgress: number;
  implemented: number;
  implementedWithFindings: number;
  validatedPassed: number;
  validatedFailed: number;
}

/**
 * One feature row: status from features.json, escalation counters joined in
 * from the mission's registry maps (fix_passes / failed_attempts / crash_retries /
 * blocked_features — commander-owned, never in features.json).
 */
export interface FeatureEntry {
  name: string;
  status: FeatureStatus;
  fixPasses: number;
  failedAttempts: number;
  crashRetries: number;
  blockedReason: string | null;
}

export interface Mission {
  slug: string;
  title: string | null;
  status: MissionStatus;
  dependsOn: string[];
  blockedReason: string | null;
  branch: string | null;
  prUrl: string | null;
  added: string | null;
  activated: string | null;
  concluded: string | null;
  planSource: string | null;
  summary: string | null;
  claim: Claim | null;
  /** false for imported/legacy missions with no features.json — render from `summary`. */
  hasFeaturesFile: boolean;
  featureCounts: FeatureCounts | null;
  /**
   * The claimed feature if a claim exists, else the first in-progress feature,
   * else the first non-terminal feature (spec §3.4 assembly rules).
   */
  currentFeature: FeatureEntry | null;
  /** First actionable line of the mission's prompt-queue.md. */
  nextAction: string | null;
  features: FeatureEntry[];
  /** feature id → blocking reason, from the registry `blocked_features` map. */
  blockedFeatures: Record<string, string>;
}

export interface Project {
  slug: string;
  repoPath: string | null;
  defaultBranch: string | null;
  registryUpdated: string | null;
  autonomy: AutonomyPolicy | null;
  missions: Mission[];
}

/** The seven derivation rules of spec §3.5 — a closed set (we produce these). */
export type AttentionType =
  | 'orphaned_claim'
  | 'awaiting_merge'
  | 'blocked_feature'
  | 'unprocessed_inbox'
  | 'failed_inbox'
  | 'mission_blocked'
  | 'parse_warning';

/** UI sorts 'warn' before 'info'. */
export type AttentionSeverity = 'warn' | 'info';

export interface AttentionItem {
  type: AttentionType;
  severity: AttentionSeverity;
  project: string | null;
  mission: string | null;
  feature: string | null;
  message: string;
  since: string | null;
}

/** One parsed `## [YYYY-MM-DD HH:MM] <type> | <title>` entry from a log.md. */
export interface ActivityEntry {
  /** "global" or "project:<slug>". */
  scope: string;
  timestamp: string;
  type: string;
  title: string;
  body: string;
}

/** Frontmatter summary of one unprocessed top-level inbox report. */
export interface InboxReportSummary {
  file: string;
  project: string | null;
  mission: string | null;
  feature: string | null;
  role: string | null;
  result: string | null;
  timestamp: string | null;
}

export interface InboxSummary {
  unprocessedCount: number;
  failedCount: number;
  unprocessed: InboxReportSummary[];
}

/** The full immutable snapshot — rebuilt whole on every vault change (spec §3.3). */
export interface Snapshot {
  /** Monotonically incrementing rebuild counter. */
  revision: number;
  /** ISO timestamp of this rebuild. */
  generatedAt: string;
  vaultPath: string;
  warnings: SnapshotWarning[];
  projects: Project[];
  attention: AttentionItem[];
  /** Merged newest-first, last ~15 per log capped at 30 (spec §3.4). */
  activity: ActivityEntry[];
  inbox: InboxSummary;
}
