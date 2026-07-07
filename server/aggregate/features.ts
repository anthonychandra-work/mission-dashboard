/**
 * Features reader — projects/<p>/missions/<slug>/features.json
 * (spec §3.1 module list; assembly rules §3.4).
 *
 * ABSENCE IS REAL STATE (spec §1): imported/legacy missions may have no
 * features.json at all — that is `hasFeaturesFile: false`, no warning, and the
 * mission renders from the registry `summary` alone. A file that EXISTS but is
 * unreadable is different: `hasFeaturesFile: true` plus a warning, with
 * last-good features served when this reader instance has seen the file parse
 * before (`stale: true`).
 *
 * Deriving featureCounts / currentFeature and joining the registry escalation
 * maps is snapshot assembly's job (FEAT-DASH-006) — this reader only
 * normalizes what the file itself says.
 *
 * This module never writes anywhere (INV-A).
 */
import path from 'node:path';

import type { SnapshotWarning } from '../../shared/types.js';
import { UNKNOWN_STATUS } from './registry.js';
import type { SafeReader } from './safeRead.js';

/** One normalized feature row as recorded in features.json. */
export interface MissionFeature {
  id: string;
  title: string | null;
  milestone: string | null;
  status: string;
  dependsOn: string[];
}

export interface FeaturesReadResult {
  /** False only when features.json is legitimately absent (spec §1). */
  hasFeaturesFile: boolean;
  features: MissionFeature[];
  /** True when `features` came from the last-good cache after a failed read. */
  stale: boolean;
  /** Non-null when the current read failed (file present but unreadable). */
  warning: SnapshotWarning | null;
}

function normalizeFeatures(value: unknown): MissionFeature[] {
  const record =
    typeof value === 'object' && value !== null && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : null;
  const rows = record && Array.isArray(record.features) ? record.features : [];

  const features: MissionFeature[] = [];
  for (const row of rows) {
    if (typeof row !== 'object' || row === null || Array.isArray(row)) continue;
    const f = row as Record<string, unknown>;
    if (typeof f.id !== 'string') continue; // a feature without a string id is unusable
    features.push({
      id: f.id,
      title: typeof f.title === 'string' ? f.title : null,
      milestone: typeof f.milestone === 'string' ? f.milestone : null,
      status: typeof f.status === 'string' ? f.status : UNKNOWN_STATUS,
      dependsOn: Array.isArray(f.dependsOn)
        ? f.dependsOn.filter((d): d is string => typeof d === 'string')
        : [],
    });
  }
  return features;
}

/**
 * Read one mission's features.json. Never throws — absence is state,
 * unreadability is a warning (with last-good fallback via the SafeReader).
 */
export async function readFeatures(
  reader: SafeReader,
  vaultPath: string,
  project: string,
  mission: string,
): Promise<FeaturesReadResult> {
  const file = path.join(vaultPath, 'projects', project, 'missions', mission, 'features.json');
  const result = await reader.readJson<unknown>(file, { optional: true });

  return {
    hasFeaturesFile: !result.missing,
    features: normalizeFeatures(result.value),
    stale: result.stale,
    warning: result.warning,
  };
}
