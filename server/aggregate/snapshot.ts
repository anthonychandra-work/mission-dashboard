/**
 * Snapshot assembly — the spec §3.4 shape, built as a PURE function of read
 * results (spec §3.1 module list; the M1 gate, VAL-001/002/004).
 *
 * Two exports make up the pipeline:
 *
 *   - {@link collectSnapshotReads} — the async fan-out over the 003/004
 *     readers (registry → per-mission features + prompt-queue → inbox →
 *     activity). All reads funnel through ONE shared SafeReader so the
 *     last-good cache is per rebuild; M2's store.ts holds a long-lived reader
 *     across rebuilds (scaffold decision, knowledge-base.md). Never throws.
 *
 *   - {@link buildSnapshot} — pure: no I/O, no clock (both `now` and
 *     `revision` are injected — the store owns the counter in M2), no input
 *     mutation. The same reads and `now` always yield the same snapshot,
 *     which is what makes the golden-snapshot test deterministic (VAL-001).
 *
 * Assembly rules (spec §3.4):
 *   - feature statuses come from features.json; per-feature fixPasses /
 *     failedAttempts / crashRetries / blockedReason join in from the
 *     mission's registry maps (SCHEMA §4: commander-owned, never in
 *     features.json);
 *   - currentFeature = the claimed feature if a claim exists, else the first
 *     in-progress feature, else the first non-terminal feature;
 *   - hasFeaturesFile:false for missions with no features.json — rendered
 *     from the registry summary alone (spec §1, VAL-002);
 *   - nextAction = first actionable line of the mission's prompt-queue.md;
 *   - claim ageMinutes/stale come from deriveClaimTiming (FEAT-DASH-005, the
 *     single source of claim staleness); an unparseable started_at surfaces
 *     the claim with null timing — staleness unknowable, never invented;
 *   - warnings aggregate in deterministic read order (registry, then each
 *     project's missions in registry order — features then prompt-queue —
 *     then inbox, then activity) and are mirrored as parse_warning attention
 *     items by deriveAttention (spec §3.5 rule 7, VAL-004);
 *   - attention items keep deriveAttention's rule-table order — the
 *     warn-before-info sort is the UI's job (spec §3.5), never re-sorted here.
 *
 * This module never writes anywhere (INV-A).
 */
import type {
  Claim,
  FeatureCounts,
  FeatureEntry,
  Mission,
  Project,
  Snapshot,
  SnapshotWarning,
} from '../../shared/types.js';
import { deriveAttention, deriveClaimTiming } from './attention.js';
import { readFeatures, type FeaturesReadResult, type MissionFeature } from './features.js';
import { readInbox, type InboxReadResult } from './inbox.js';
import { readActivity, type ActivityReadResult } from './logs.js';
import { readPromptQueue, type PromptQueueReadResult } from './promptQueue.js';
import {
  readRegistry,
  UNKNOWN_STATUS,
  type RegistryClaim,
  type RegistryMission,
  type RegistryReadResult,
} from './registry.js';
import type { SafeReader } from './safeRead.js';

/**
 * Feature statuses with nothing left to do. Everything else — including
 * validated_failed (needs a fix pass) and unknown drifted strings — is
 * non-terminal and eligible to be the mission's currentFeature.
 */
export const TERMINAL_FEATURE_STATUSES: ReadonlySet<string> = new Set(['validated_passed']);

/** The per-mission file reads joined against one registry mission entry. */
export interface MissionReads {
  features: FeaturesReadResult;
  promptQueue: PromptQueueReadResult;
}

/** Everything buildSnapshot consumes — the output of one read fan-out. */
export interface SnapshotReads {
  registry: RegistryReadResult;
  /** Keyed by {@link missionKey}; missing entries read as wholly absent files. */
  missions: ReadonlyMap<string, MissionReads>;
  inbox: InboxReadResult;
  activity: ActivityReadResult;
}

export interface BuildSnapshotInput {
  /** Monotonic rebuild counter — owned by the store (M2), injected here. */
  revision: number;
  /** Injected clock (purity/VAL-001): generatedAt + all claim/inbox timing. */
  now: Date;
  vaultPath: string;
  reads: SnapshotReads;
  /** Staleness threshold in minutes; default 45 (SETTLED, spec §4). */
  staleClaimMinutes?: number;
}

/**
 * Stable map key for one mission's reads. `/` cannot appear in a directory
 * name, so the key is collision-free for any project/mission slug pair.
 */
export function missionKey(project: string, mission: string): string {
  return `${project}/${mission}`;
}

/** What a mission with no readable files at all looks like (caller-bug guard). */
const ABSENT_MISSION_READS: MissionReads = {
  features: { hasFeaturesFile: false, features: [], stale: false, warning: null },
  promptQueue: { nextAction: null, warning: null },
};

// ── the async fan-out ────────────────────────────────────────────────────────

/**
 * Run every reader over the vault, through one shared SafeReader (one
 * last-good cache per reader instance — the store keeps it long-lived in M2).
 * Never throws: every reader degrades to warnings (VAL-004).
 */
export async function collectSnapshotReads(
  reader: SafeReader,
  vaultPath: string,
): Promise<SnapshotReads> {
  const registry = await readRegistry(reader, vaultPath);

  const missions = new Map<string, MissionReads>();
  for (const project of registry.projects) {
    for (const mission of project.missions) {
      missions.set(missionKey(project.slug, mission.slug), {
        features: await readFeatures(reader, vaultPath, project.slug, mission.slug),
        promptQueue: await readPromptQueue(reader, vaultPath, project.slug, mission.slug),
      });
    }
  }

  const inbox = await readInbox(reader, vaultPath);
  const activity = await readActivity(reader, vaultPath, registry.projects);

  return { registry, missions, inbox, activity };
}

// ── pure assembly helpers ────────────────────────────────────────────────────

/** Join one features.json row with the mission's registry escalation maps. */
function joinFeature(feature: MissionFeature, mission: RegistryMission): FeatureEntry {
  return {
    name: feature.id,
    status: feature.status,
    fixPasses: mission.fixPasses[feature.id] ?? 0,
    failedAttempts: mission.failedAttempts[feature.id] ?? 0,
    crashRetries: mission.crashRetries[feature.id] ?? 0,
    blockedReason: mission.blockedFeatures[feature.id] ?? null,
  };
}

/** Bucket per counted status; anything else increments `total` only. */
const COUNT_BUCKETS: Readonly<Record<string, keyof Omit<FeatureCounts, 'total'>>> = {
  ready: 'ready',
  planned: 'planned',
  'in-progress': 'inProgress',
  implemented: 'implemented',
  implemented_with_findings: 'implementedWithFindings',
  validated_passed: 'validatedPassed',
  validated_failed: 'validatedFailed',
};

/**
 * Count features per status. Unknown/drifted statuses (vault-sourced strings,
 * spec §5) contribute to `total` but to no bucket — never fatal.
 */
function deriveFeatureCounts(features: readonly FeatureEntry[]): FeatureCounts {
  const counts: FeatureCounts = {
    total: features.length,
    ready: 0,
    planned: 0,
    inProgress: 0,
    implemented: 0,
    implementedWithFindings: 0,
    validatedPassed: 0,
    validatedFailed: 0,
  };
  for (const feature of features) {
    const bucket = COUNT_BUCKETS[feature.status];
    if (bucket) counts[bucket] += 1;
  }
  return counts;
}

/**
 * Spec §3.4: the claimed feature if a claim exists, else the first
 * in-progress feature, else the first non-terminal feature. A claim on a
 * feature id absent from features.json (or on a mission without the file)
 * synthesizes an unknown-status row from the registry maps rather than
 * hiding the one feature a worker is provably holding.
 */
function deriveCurrentFeature(
  mission: RegistryMission,
  features: readonly FeatureEntry[],
): FeatureEntry | null {
  const claimed = mission.claim?.feature;
  if (claimed) {
    return (
      features.find((f) => f.name === claimed) ??
      joinFeature(
        { id: claimed, title: null, milestone: null, status: UNKNOWN_STATUS, dependsOn: [] },
        mission,
      )
    );
  }
  return (
    features.find((f) => f.status === 'in-progress') ??
    features.find((f) => !TERMINAL_FEATURE_STATUSES.has(f.status)) ??
    null
  );
}

/** Derive the spec-shape claim; timing via the single 005 staleness rule. */
function assembleClaim(
  claim: RegistryClaim | null,
  now: Date,
  staleClaimMinutes: number | undefined,
): Claim | null {
  if (!claim) return null;
  const timing = deriveClaimTiming(claim.startedAt, now, staleClaimMinutes);
  return {
    worker: claim.worker,
    feature: claim.feature,
    startedAt: claim.startedAt,
    session: claim.session,
    ageMinutes: timing?.ageMinutes ?? null,
    stale: timing?.stale ?? null,
  };
}

function assembleMission(
  projectSlug: string,
  mission: RegistryMission,
  reads: SnapshotReads,
  now: Date,
  staleClaimMinutes: number | undefined,
): Mission {
  const bundle = reads.missions.get(missionKey(projectSlug, mission.slug)) ?? ABSENT_MISSION_READS;
  const features = bundle.features.features.map((feature) => joinFeature(feature, mission));

  return {
    slug: mission.slug,
    title: mission.title,
    status: mission.status,
    dependsOn: [...mission.dependsOn],
    blockedReason: mission.blockedReason,
    branch: mission.branch,
    prUrl: mission.prUrl,
    added: mission.added,
    activated: mission.activated,
    concluded: mission.concluded,
    planSource: mission.planSource,
    summary: mission.summary,
    claim: assembleClaim(mission.claim, now, staleClaimMinutes),
    hasFeaturesFile: bundle.features.hasFeaturesFile,
    featureCounts: bundle.features.hasFeaturesFile ? deriveFeatureCounts(features) : null,
    currentFeature: deriveCurrentFeature(mission, features),
    nextAction: bundle.promptQueue.nextAction,
    features,
    blockedFeatures: { ...mission.blockedFeatures },
  };
}

/** Deterministic warning order: registry → per-mission (registry order) → inbox → activity. */
function collectWarnings(reads: SnapshotReads): SnapshotWarning[] {
  const warnings: SnapshotWarning[] = [...reads.registry.warnings];
  for (const project of reads.registry.projects) {
    for (const mission of project.missions) {
      const bundle = reads.missions.get(missionKey(project.slug, mission.slug));
      if (bundle?.features.warning) warnings.push(bundle.features.warning);
      if (bundle?.promptQueue.warning) warnings.push(bundle.promptQueue.warning);
    }
  }
  warnings.push(...reads.inbox.warnings, ...reads.activity.warnings);
  return warnings;
}

// ── the pure builder ─────────────────────────────────────────────────────────

/**
 * Build the full immutable snapshot from one read fan-out. Pure — see the
 * module header for the contract — and total: any reader output, however
 * degraded, assembles into a valid snapshot (VAL-004 never-throws).
 */
export function buildSnapshot(input: BuildSnapshotInput): Snapshot {
  const { revision, now, vaultPath, reads, staleClaimMinutes } = input;

  const warnings = collectWarnings(reads);

  const projects: Project[] = reads.registry.projects.map((project) => ({
    slug: project.slug,
    repoPath: project.repoPath,
    defaultBranch: project.defaultBranch,
    registryUpdated: project.registryUpdated,
    autonomy: { ...project.autonomy },
    missions: project.missions.map((mission) =>
      assembleMission(project.slug, mission, reads, now, staleClaimMinutes),
    ),
  }));

  const attention = deriveAttention({
    projects: reads.registry.projects,
    inbox: reads.inbox,
    warnings,
    now,
    ...(staleClaimMinutes === undefined ? {} : { staleClaimMinutes }),
  });

  return {
    revision,
    generatedAt: now.toISOString(),
    vaultPath,
    warnings,
    projects,
    attention,
    activity: reads.activity.activity.map((entry) => ({ ...entry })),
    inbox: {
      unprocessedCount: reads.inbox.unprocessedCount,
      failedCount: reads.inbox.failedCount,
      unprocessed: reads.inbox.unprocessed.map((report) => ({ ...report })),
    },
  };
}
