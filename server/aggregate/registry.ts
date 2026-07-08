/**
 * Registry reader — registry/projects.json + every registry/<p>.json
 * (vault SCHEMA §3/§4; spec §3.1 module list).
 *
 * Produces the normalized intermediate shapes snapshot assembly (FEAT-DASH-006)
 * joins against features.json data: project metadata, autonomy policy,
 * mission entries with the raw claim, the commander-owned escalation maps
 * (fix_passes / failed_attempts / crash_retries) and blocked_features.
 *
 * Tolerance contract (spec §5: vault-sourced values may drift):
 *   - every read goes through SafeReader (retry → last-good → warning);
 *     failed reads surface as `warnings`, never as throws;
 *   - shape garbage inside a file that PARSED is coerced field-by-field
 *     (non-string → null, non-object map → {}, non-number counters dropped);
 *   - a missing autonomy block or field means the SCHEMA §4 defaults.
 *
 * Derivation (claim ageMinutes/stale, feature joins) is deliberately NOT done
 * here — that is snapshot/attention territory where `now` is injected.
 *
 * This module never writes anywhere (INV-A).
 */
import path from 'node:path';

import type { AutonomyPolicy, SnapshotWarning } from '../../shared/types.js';
import type { SafeReader } from './safeRead.js';

/** SCHEMA §4: "A missing block or field means the defaults above." */
export const AUTONOMY_DEFAULTS: AutonomyPolicy = {
  mode: 'confirm',
  maxFixPasses: 2,
  maxCrashRetries: 1,
  diagnoseOnFailed: true,
};

/** Fallback for vault-sourced status strings that are absent or non-string. */
export const UNKNOWN_STATUS = 'unknown';

/** The raw registry claim (SCHEMA §4) — no derived fields (see module header). */
export interface RegistryClaim {
  worker: string;
  feature: string | null;
  startedAt: string | null;
  session: string | null;
}

/** One normalized mission entry from a per-project registry. */
export interface RegistryMission {
  slug: string;
  title: string | null;
  status: string;
  dependsOn: string[];
  blockedReason: string | null;
  branch: string | null;
  prUrl: string | null;
  added: string | null;
  activated: string | null;
  concluded: string | null;
  planSource: string | null;
  summary: string | null;
  claim: RegistryClaim | null;
  fixPasses: Record<string, number>;
  failedAttempts: Record<string, number>;
  crashRetries: Record<string, number>;
  blockedFeatures: Record<string, string>;
}

/** One project: projects.json entry merged with its per-project registry. */
export interface RegistryProject {
  slug: string;
  repoPath: string | null;
  defaultBranch: string | null;
  /** Vault-relative project dir, e.g. "projects/alpha-app" (SCHEMA §3). */
  vaultDir: string;
  registryUpdated: string | null;
  autonomy: AutonomyPolicy;
  missions: RegistryMission[];
}

export interface RegistryReadResult {
  projects: RegistryProject[];
  warnings: SnapshotWarning[];
}

// ── tolerant coercion helpers ────────────────────────────────────────────────

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function asString(value: unknown): string | null {
  return typeof value === 'string' ? value : null;
}

function asStringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((v): v is string => typeof v === 'string') : [];
}

/** Keep only finite-number entries of a counter map (SCHEMA §4 escalation maps). */
function asNumberMap(value: unknown): Record<string, number> {
  const record = asRecord(value);
  if (!record) return {};
  const out: Record<string, number> = {};
  for (const [key, entry] of Object.entries(record)) {
    if (typeof entry === 'number' && Number.isFinite(entry)) out[key] = entry;
  }
  return out;
}

/** Keep only string entries of a reason map (blocked_features). */
function asStringMap(value: unknown): Record<string, string> {
  const record = asRecord(value);
  if (!record) return {};
  const out: Record<string, string> = {};
  for (const [key, entry] of Object.entries(record)) {
    if (typeof entry === 'string') out[key] = entry;
  }
  return out;
}

// ── normalization ────────────────────────────────────────────────────────────

function normalizeAutonomy(value: unknown): AutonomyPolicy {
  const block = asRecord(value);
  if (!block) return { ...AUTONOMY_DEFAULTS };
  return {
    mode: asString(block.mode) ?? AUTONOMY_DEFAULTS.mode,
    maxFixPasses:
      typeof block.max_fix_passes === 'number' && Number.isFinite(block.max_fix_passes)
        ? block.max_fix_passes
        : AUTONOMY_DEFAULTS.maxFixPasses,
    maxCrashRetries:
      typeof block.max_crash_retries === 'number' && Number.isFinite(block.max_crash_retries)
        ? block.max_crash_retries
        : AUTONOMY_DEFAULTS.maxCrashRetries,
    diagnoseOnFailed:
      typeof block.diagnose_on_failed === 'boolean'
        ? block.diagnose_on_failed
        : AUTONOMY_DEFAULTS.diagnoseOnFailed,
  };
}

function normalizeClaim(value: unknown): RegistryClaim | null {
  const claim = asRecord(value);
  if (!claim) return null;
  return {
    worker: asString(claim.worker) ?? UNKNOWN_STATUS,
    feature: asString(claim.feature),
    startedAt: asString(claim.started_at),
    session: asString(claim.session),
  };
}

function normalizeMission(slug: string, value: unknown): RegistryMission {
  const m = asRecord(value) ?? {};
  return {
    slug,
    title: asString(m.title),
    status: asString(m.status) ?? UNKNOWN_STATUS,
    dependsOn: asStringArray(m.depends_on),
    blockedReason: asString(m.blocked_reason),
    branch: asString(m.branch),
    prUrl: asString(m.pr_url),
    added: asString(m.added),
    activated: asString(m.activated),
    concluded: asString(m.concluded),
    planSource: asString(m.plan_source),
    summary: asString(m.summary),
    claim: normalizeClaim(m.claim),
    fixPasses: asNumberMap(m.fix_passes),
    failedAttempts: asNumberMap(m.failed_attempts),
    crashRetries: asNumberMap(m.crash_retries),
    blockedFeatures: asStringMap(m.blocked_features),
  };
}

// ── the reader ───────────────────────────────────────────────────────────────

/**
 * Read the whole registry layer of the vault. Never throws; read failures
 * surface in `warnings` while last-good values (when the reader has seen the
 * file parse before) keep the data flowing.
 */
export async function readRegistry(
  reader: SafeReader,
  vaultPath: string,
): Promise<RegistryReadResult> {
  const warnings: SnapshotWarning[] = [];
  const projects: RegistryProject[] = [];

  const projectsFile = path.join(vaultPath, 'registry', 'projects.json');
  const projectsRead = await reader.readJson<unknown>(projectsFile);
  if (projectsRead.warning) warnings.push(projectsRead.warning);

  const projectsMap = asRecord(asRecord(projectsRead.value)?.projects) ?? {};

  for (const [slug, entryRaw] of Object.entries(projectsMap)) {
    const entry = asRecord(entryRaw) ?? {};
    const registryRel = asString(entry.registry) ?? path.join('registry', `${slug}.json`);

    const registryRead = await reader.readJson<unknown>(path.join(vaultPath, registryRel));
    if (registryRead.warning) warnings.push(registryRead.warning);
    const registry = asRecord(registryRead.value) ?? {};

    const missionsMap = asRecord(registry.missions) ?? {};
    projects.push({
      slug,
      repoPath: asString(entry.repo_path),
      defaultBranch: asString(entry.default_branch),
      vaultDir: asString(entry.vault_dir) ?? path.join('projects', slug),
      registryUpdated: asString(registry.updated),
      autonomy: normalizeAutonomy(registry.autonomy),
      missions: Object.entries(missionsMap).map(([missionSlug, mission]) =>
        normalizeMission(missionSlug, mission),
      ),
    });
  }

  return { projects, warnings };
}
