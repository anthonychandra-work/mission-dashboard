/**
 * Mission-note reader — projects/<p>/missions/<slug>/<slug>.md
 * (spec §3.1 module list; vault SCHEMA §1 mission layout).
 *
 * Consumed by the DETAIL endpoint only (spec §3.6): the note is never watched
 * and never part of the snapshot. Returns the gray-matter frontmatter plus
 * the markdown body below it; "each field nullable if absent".
 *
 * Tolerance contract:
 *   - an absent note is real state (imported missions may be sparse) →
 *     `missing: true`, null fields, no warning;
 *   - reads funnel through SafeReader: broken frontmatter YAML → null fields
 *     plus a warning, with last-good values served (`stale: true`) once this
 *     reader instance has seen the note parse. Never throws;
 *   - frontmatter is passed through raw (`Record<string, unknown>`): YAML
 *     dates stay Date objects and JSON-serialize to ISO strings when the
 *     detail endpoint responds.
 *
 * This module never writes anywhere (INV-A).
 */
import path from 'node:path';
import matter from 'gray-matter';

import type { SnapshotWarning } from '../../shared/types.js';
import type { SafeReader } from './safeRead.js';

export interface MissionNoteReadResult {
  /** True only when the note file is legitimately absent. */
  missing: boolean;
  /** Raw frontmatter mapping, or null when unavailable. */
  frontmatter: Record<string, unknown> | null;
  /** Markdown body below the frontmatter (outer whitespace trimmed), or null. */
  body: string | null;
  /** True when frontmatter/body came from the last-good cache. */
  stale: boolean;
  /** Non-null when the note exists but the current read failed. */
  warning: SnapshotWarning | null;
}

interface ParsedNote {
  frontmatter: Record<string, unknown>;
  body: string;
}

/**
 * gray-matter parse (throws on broken YAML — handled by the SafeReader
 * ladder). The options object is REQUIRED: without it gray-matter uses a
 * global content-keyed cache that it populates BEFORE parsing, so a failed
 * parse poisons the cache and the SafeReader retry would "succeed" with
 * empty data (and a shared mutable result object).
 */
function parseNote(raw: string): ParsedNote {
  const parsed = matter(raw, {});
  return {
    frontmatter: parsed.data as Record<string, unknown>,
    body: parsed.content.trim(),
  };
}

/**
 * Read one mission's note (frontmatter + body). Never throws — absence is
 * state, unreadability is a warning with last-good fallback.
 */
export async function readMissionNote(
  reader: SafeReader,
  vaultPath: string,
  project: string,
  mission: string,
): Promise<MissionNoteReadResult> {
  const file = path.join(vaultPath, 'projects', project, 'missions', mission, `${mission}.md`);
  const result = await reader.read(file, parseNote, { optional: true });

  return {
    missing: result.missing,
    frontmatter: result.value?.frontmatter ?? null,
    body: result.value?.body ?? null,
    stale: result.stale,
    warning: result.warning,
  };
}
