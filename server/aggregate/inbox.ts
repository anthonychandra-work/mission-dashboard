/**
 * Inbox reader — top-level inbox/*.md + .processed/ and .failed/ counts
 * (spec §3.1 module list; §3.4 inbox summary; vault SCHEMA §7).
 *
 * Top-level reports are the "unprocessed" set: listed sorted by filename (the
 * `<YYYYMMDD-HHMMSS>-…` prefix makes that chronological, oldest first) with
 * their gray-matter frontmatter summarized into `InboxReportSummary` rows.
 * `.processed/` is counted AND summarized — the orphaned_claim attention rule
 * (spec §3.5) must match reports "top-level or .processed/" by
 * project+mission+feature+role and timestamp, so counts alone would starve
 * FEAT-DASH-005. `.failed/` is counted by file name only (its rule fires on
 * mere existence).
 *
 * Tolerance contract (spec §5):
 *   - a missing inbox/ (or subdir) is real state → zero counts, no warning
 *     (an empty/minimal vault is valid);
 *   - file reads funnel through SafeReader; a report whose frontmatter cannot
 *     be parsed is STILL counted (the file exists) with null fields plus a
 *     warning; a report that vanishes between listing and reading (librarian
 *     drain race) is skipped silently;
 *   - shape garbage inside frontmatter that parsed is coerced silently
 *     (non-string → null); YAML timestamps arrive as Date objects from
 *     gray-matter and are normalized to ISO strings;
 *   - dot-entries, non-.md files and directories are never reports.
 *
 * This module never writes anywhere (INV-A).
 */
import { readdir } from 'node:fs/promises';
import path from 'node:path';
import matter from 'gray-matter';

import type { InboxReportSummary, SnapshotWarning } from '../../shared/types.js';
import type { SafeReader } from './safeRead.js';

export interface InboxReadResult {
  unprocessedCount: number;
  processedCount: number;
  failedCount: number;
  /** Top-level reports, sorted by filename (oldest first). */
  unprocessed: InboxReportSummary[];
  /** `.processed/` reports (orphaned_claim rule input), sorted by filename. */
  processed: InboxReportSummary[];
  /** `.failed/` file names, sorted. */
  failedFiles: string[];
  warnings: SnapshotWarning[];
}

function isEnoent(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    (error as NodeJS.ErrnoException).code === 'ENOENT'
  );
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * List report files (plain `*.md`, no dot-entries, no directories) in `dir`,
 * sorted by name. A missing directory is real state → empty list, no warning.
 */
async function listReports(
  dir: string,
  warnings: SnapshotWarning[],
): Promise<string[]> {
  try {
    const entries = await readdir(dir, { withFileTypes: true });
    return entries
      .filter((e) => e.isFile() && e.name.endsWith('.md') && !e.name.startsWith('.'))
      .map((e) => e.name)
      .sort();
  } catch (error) {
    if (!isEnoent(error)) warnings.push({ file: dir, error: describeError(error) });
    return [];
  }
}

/** Coerce a frontmatter value to string; YAML dates normalize to ISO. */
function asStringish(value: unknown): string | null {
  if (typeof value === 'string') return value;
  if (value instanceof Date) return value.toISOString();
  return null;
}

function summarize(file: string, data: Record<string, unknown> | null): InboxReportSummary {
  return {
    file,
    project: asStringish(data?.project),
    mission: asStringish(data?.mission),
    feature: asStringish(data?.feature),
    role: asStringish(data?.role),
    result: asStringish(data?.result),
    timestamp: asStringish(data?.timestamp),
  };
}

/**
 * gray-matter parse funneled through SafeReader (throws on broken YAML).
 * The options object is REQUIRED: without it gray-matter uses a global
 * content-keyed cache that it populates BEFORE parsing, so a failed parse
 * poisons the cache and the SafeReader retry would "succeed" with empty data.
 */
function parseFrontmatter(raw: string): Record<string, unknown> {
  return matter(raw, {}).data as Record<string, unknown>;
}

/**
 * Read and summarize every report in `dir`. Reads are `optional`: a file that
 * vanished after listing (librarian drain) is dropped; an unreadable one is
 * kept with null fields and a warning.
 */
async function summarizeDir(
  reader: SafeReader,
  dir: string,
  warnings: SnapshotWarning[],
): Promise<InboxReportSummary[]> {
  const summaries: InboxReportSummary[] = [];
  for (const name of await listReports(dir, warnings)) {
    const read = await reader.read(path.join(dir, name), parseFrontmatter, {
      optional: true,
    });
    if (read.missing) continue; // moved away mid-scan — no longer in this set
    if (read.warning) warnings.push(read.warning);
    summaries.push(summarize(name, read.value));
  }
  return summaries;
}

/**
 * Read the vault inbox: unprocessed (top-level) and processed reports with
 * frontmatter summaries, failed file names. Never throws.
 */
export async function readInbox(
  reader: SafeReader,
  vaultPath: string,
): Promise<InboxReadResult> {
  const warnings: SnapshotWarning[] = [];
  const inboxDir = path.join(vaultPath, 'inbox');

  const unprocessed = await summarizeDir(reader, inboxDir, warnings);
  const processed = await summarizeDir(reader, path.join(inboxDir, '.processed'), warnings);
  const failedFiles = await listReports(path.join(inboxDir, '.failed'), warnings);

  return {
    unprocessedCount: unprocessed.length,
    processedCount: processed.length,
    failedCount: failedFiles.length,
    unprocessed,
    processed,
    failedFiles,
    warnings,
  };
}
