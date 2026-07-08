/**
 * Prompt-queue reader — spec §3.4: "nextAction = first actionable line of the
 * mission's prompt-queue.md (nullable)".
 *
 * "First actionable line" (decided here, matching the real queue format the
 * mission skills write — a `## NEXT — …` section leads the file):
 *   1. prefer the first content line AFTER the first heading whose text
 *      contains "NEXT" (case-insensitive) — this skips the file's preamble
 *      prose ("The next paste-ready action for this mission.");
 *   2. if there is no NEXT heading, or its section holds no content, fall back
 *      to the first content line anywhere in the file;
 *   3. headings, blank lines, fenced code (the multi-line paste-ready prompt
 *      body), horizontal rules and HTML comment lines are never actionable;
 *      list / ordered-list / blockquote markers are stripped from the result.
 *
 * The file is optional per mission (imported/legacy missions have none) —
 * absence yields `nextAction: null` with no warning; an unreadable file yields
 * null plus a `{file, error}` warning via the SafeReader funnel. Never throws.
 *
 * This module never writes anywhere (INV-A).
 */
import path from 'node:path';

import type { SnapshotWarning } from '../../shared/types.js';
import type { SafeReader } from './safeRead.js';

export interface PromptQueueReadResult {
  /** First actionable line of prompt-queue.md, or null (absent/empty/unreadable). */
  nextAction: string | null;
  /** Non-null when the file exists but the current read failed. */
  warning: SnapshotWarning | null;
}

const HEADING = /^#{1,6}\s/;
const FENCE = /^\s*(```|~~~)/;
const HORIZONTAL_RULE = /^\s*(-{3,}|\*{3,}|_{3,})\s*$/;
const HTML_COMMENT_LINE = /^\s*<!--/;
const LIST_OR_QUOTE_MARKERS = /^\s*(?:(?:[-*+]|\d+[.)])\s+|>\s*)+/;

interface Line {
  text: string;
  heading: boolean;
  /** True for fence delimiters AND everything inside a fence. */
  fenced: boolean;
}

/** One pass over the markdown, tagging headings and fenced regions. */
function analyze(markdown: string): Line[] {
  const lines: Line[] = [];
  let inFence = false;
  for (const text of markdown.split(/\r?\n/)) {
    const isDelimiter = FENCE.test(text);
    const fenced = inFence || isDelimiter;
    if (isDelimiter) inFence = !inFence;
    lines.push({ text, heading: !inFence && !isDelimiter && HEADING.test(text), fenced });
  }
  return lines;
}

/** First actionable line at or after `start`, up to `end` (exclusive). */
function scan(lines: Line[], start: number, end: number): string | null {
  for (let i = start; i < end; i++) {
    const line = lines[i]!;
    if (line.fenced || line.heading) continue;
    const text = line.text;
    if (
      text.trim() === '' ||
      HORIZONTAL_RULE.test(text) ||
      HTML_COMMENT_LINE.test(text)
    ) {
      continue;
    }
    const stripped = text.replace(LIST_OR_QUOTE_MARKERS, '').trim();
    if (stripped !== '') return stripped;
  }
  return null;
}

/**
 * Extract the first actionable line from prompt-queue.md content (see module
 * header for the rules). Pure; exported for direct unit testing.
 */
export function firstActionableLine(markdown: string): string | null {
  const lines = analyze(markdown);

  const nextIdx = lines.findIndex((l) => l.heading && /NEXT/i.test(l.text));
  if (nextIdx !== -1) {
    // The NEXT section ends at the next heading (or EOF).
    let sectionEnd = lines.length;
    for (let i = nextIdx + 1; i < lines.length; i++) {
      if (lines[i]!.heading) {
        sectionEnd = i;
        break;
      }
    }
    const fromNext = scan(lines, nextIdx + 1, sectionEnd);
    if (fromNext !== null) return fromNext;
  }

  return scan(lines, 0, lines.length);
}

/**
 * Read one mission's prompt-queue.md and extract its next action.
 * Never throws.
 */
export async function readPromptQueue(
  reader: SafeReader,
  vaultPath: string,
  project: string,
  mission: string,
): Promise<PromptQueueReadResult> {
  const file = path.join(vaultPath, 'projects', project, 'missions', mission, 'prompt-queue.md');
  const result = await reader.read(file, (raw) => raw, { optional: true });

  return {
    nextAction: result.value === null ? null : firstActionableLine(result.value),
    warning: result.warning,
  };
}
