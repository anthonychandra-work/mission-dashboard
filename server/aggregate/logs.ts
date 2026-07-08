/**
 * Activity log reader — global log.md + every project log.md
 * (spec §3.1 module list; §3.4 assembly rules).
 *
 * Log format (vault SCHEMA: append-only, one `##` entry per write):
 *
 *   ## [YYYY-MM-DD HH:MM] <type> | <title>
 *   body lines until the next entry header
 *
 * Tolerant parser (spec §5 "log format drift → garbage never fatal"):
 *   - only lines matching the header pattern start entries; anything else —
 *     including drifted headers with a bad timestamp or missing pipe — folds
 *     into the previous entry's body;
 *   - lines before the first valid header (titles, format prose, garbage) are
 *     skipped; input with no valid header at all yields [];
 *   - `<type>` never contains `|`; the title keeps any further pipes.
 *
 * Volume: the last {@link PER_LOG_TAIL} (~15) entries per log (append-only ⇒
 * the file tail is newest), merged newest-first across all logs and capped at
 * {@link MERGED_ACTIVITY_CAP} (30). The merge sort is stable on timestamp
 * ties: global entries come before project entries, projects in given order.
 *
 * Absent log files are real state (empty vaults and freshly onboarded
 * projects have none) → no warning; unreadable ones warn via the SafeReader
 * funnel while every other log still flows.
 *
 * This module never writes anywhere (INV-A).
 */
import path from 'node:path';

import type { ActivityEntry, SnapshotWarning } from '../../shared/types.js';
import type { SafeReader } from './safeRead.js';

/** "last ~15 each" (spec §3.4). */
export const PER_LOG_TAIL = 15;

/** "capped at 30 merged" (spec §3.4). */
export const MERGED_ACTIVITY_CAP = 30;

/** Scope tag for the global log; projects use `project:<slug>`. */
export const GLOBAL_SCOPE = 'global';

/** `## [YYYY-MM-DD HH:MM] <type> | <title>` — type is pipe-free, title keeps pipes. */
const ENTRY_HEADER = /^##\s*\[(\d{4}-\d{2}-\d{2} \d{2}:\d{2})\]\s*([^|]*?)\s*\|\s*(.*?)\s*$/;

/** What readActivity needs to locate one project's log (RegistryProject fits). */
export interface ProjectLogRef {
  slug: string;
  /** Vault-relative project dir, e.g. "projects/alpha-app" (SCHEMA §3). */
  vaultDir: string;
}

export interface ActivityReadResult {
  /** Merged newest-first, last ~15 per log, capped at 30 (spec §3.4). */
  activity: ActivityEntry[];
  warnings: SnapshotWarning[];
}

/**
 * Parse one log's markdown into entries, file order (oldest first). Pure and
 * total: any input — including binary garbage — yields a (possibly empty)
 * array, never a throw. Exported for direct unit testing.
 */
export function parseLogEntries(markdown: string, scope: string): ActivityEntry[] {
  const entries: ActivityEntry[] = [];
  let current: { header: Omit<ActivityEntry, 'body'>; bodyLines: string[] } | null = null;

  const flush = () => {
    if (current) entries.push({ ...current.header, body: current.bodyLines.join('\n').trim() });
    current = null;
  };

  for (const line of markdown.split(/\r?\n/)) {
    const match = ENTRY_HEADER.exec(line);
    if (match) {
      flush();
      current = {
        header: { scope, timestamp: match[1]!, type: match[2]!, title: match[3]! },
        bodyLines: [],
      };
    } else if (current) {
      current.bodyLines.push(line); // non-matching line folds into the previous entry
    }
    // else: garbage before the first entry — skipped, never fatal
  }
  flush();

  return entries;
}

/** The last `PER_LOG_TAIL` entries of a log, newest first. */
function tailNewestFirst(entries: ActivityEntry[]): ActivityEntry[] {
  return entries.slice(-PER_LOG_TAIL).reverse();
}

/**
 * Read the global log plus every project log, merge newest-first, cap at 30.
 * Never throws.
 */
export async function readActivity(
  reader: SafeReader,
  vaultPath: string,
  projects: readonly ProjectLogRef[],
): Promise<ActivityReadResult> {
  const warnings: SnapshotWarning[] = [];
  const merged: ActivityEntry[] = [];

  const logs: Array<{ file: string; scope: string }> = [
    { file: path.join(vaultPath, 'log.md'), scope: GLOBAL_SCOPE },
    ...projects.map((p) => ({
      file: path.join(vaultPath, p.vaultDir, 'log.md'),
      scope: `project:${p.slug}`,
    })),
  ];

  for (const { file, scope } of logs) {
    const read = await reader.read(file, (raw) => raw, { optional: true });
    if (read.warning) warnings.push(read.warning);
    if (read.value === null) continue; // absent (real state) or unreadable with no last-good
    merged.push(...tailNewestFirst(parseLogEntries(read.value, scope)));
  }

  // Stable sort: timestamp descending; ties keep input order (global first,
  // then projects in given order, newest-in-file first).
  merged.sort((a, b) => (a.timestamp < b.timestamp ? 1 : a.timestamp > b.timestamp ? -1 : 0));

  return { activity: merged.slice(0, MERGED_ACTIVITY_CAP), warnings };
}
