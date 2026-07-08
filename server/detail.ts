/**
 * On-demand mission detail (spec 3.6) -- the heavy per-mission documents that are
 * deliberately NOT part of the live snapshot.
 *
 * `GET /api/missions/:project/:mission` is read ON DEMAND: never watched, never
 * in the snapshot, so opening one mission's detail view costs one request's worth
 * of file reads and nothing rebuilds. The payload gathers, each field nullable if
 * absent:
 *   - the mission note's frontmatter + markdown body (reuses the aggregate
 *     `readMissionNote` reader),
 *   - `milestones.md`, the FULL `prompt-queue.md`, and `issues-log.md` as raw
 *     markdown (the snapshot only keeps prompt-queue's first actionable LINE),
 *   - a recursive listing of the mission's `evidence/` tree, and
 *   - any `diagnosis-*.md` notes a diagnostician dropped in the mission folder.
 *
 * -- SECURITY: path traversal (standing 004/006/008 flag) --
 * `:project` and `:mission` arrive from the URL and are joined into a vault path,
 * so they MUST be sanitized BEFORE any join. {@link sanitizeSegment} rejects `..`,
 * `.`, path separators, NUL, and leading dots; the handler additionally decodes
 * percent-escapes first (so `%2e%2e`/`%2f` can't smuggle a separator past the
 * matcher) and re-checks containment under `<vault>/projects` as belt-and-braces.
 * A rejected segment is a `400`; a well-formed but non-existent mission is a `200`
 * with all-null fields (absence is real state, spec 3.6).
 *
 * This module never writes anywhere (INV-A): it only reads vault files on demand.
 */
import { readdir } from 'node:fs/promises';
import path from 'node:path';

import type { SnapshotWarning } from '../shared/types.js';
import { createSafeReader, type SafeReader } from './aggregate/safeRead.js';
import { readMissionNote } from './aggregate/missionNote.js';

/** One `diagnosis-*.md` note from the mission folder (detail view only). */
export interface MissionDetailDiagnosis {
  /** Bare file name, e.g. `diagnosis-FEAT-DASH-009.md`. */
  file: string;
  /** Raw markdown, or null if the file became unreadable between listing and read. */
  content: string | null;
}

/** The `/api/missions/:project/:mission` payload (spec 3.6). Every field nullable. */
export interface MissionDetail {
  project: string;
  mission: string;
  note: {
    frontmatter: Record<string, unknown> | null;
    body: string | null;
  };
  /** Raw `milestones.md`, or null if absent. */
  milestones: string | null;
  /** The FULL raw `prompt-queue.md` (not just the first actionable line), or null. */
  promptQueue: string | null;
  /** Raw `issues-log.md`, or null if absent. */
  issuesLog: string | null;
  /** Recursive relative file listing of `evidence/`, sorted; null if the dir is absent. */
  evidence: string[] | null;
  /** Any `diagnosis-*.md` notes, sorted by name (empty when none). */
  diagnoses: MissionDetailDiagnosis[];
  /** Non-fatal read/parse problems encountered while gathering the payload. */
  warnings: SnapshotWarning[];
}

/** The request path this feature owns; two path segments, optional trailing slash. */
const MISSION_DETAIL_RE = /^\/api\/missions\/([^/]+)\/([^/]+)\/?$/;

/**
 * Match a (dot-segment-normalized) URL pathname against the detail route.
 * Returns the RAW (still percent-encoded) segments, or null. Pure — the WHATWG
 * `URL` parser has already collapsed `..`/`.`; decoding + sanitization happen in
 * the handler, since a segment like `a%2fb` only reveals its separator after
 * `decodeURIComponent`. Exported for direct testing.
 */
export function matchMissionDetailPath(pathname: string): { project: string; mission: string } | null {
  const m = MISSION_DETAIL_RE.exec(pathname);
  if (m === null) return null;
  return { project: m[1] as string, mission: m[2] as string };
}

/**
 * Validate one decoded path segment for use as a vault directory name. Returns
 * the segment unchanged when safe, or null when it could escape the intended
 * directory. The only ways to escape a `path.join(base, seg)` are a separator or
 * a `..` component, so rejecting those (plus `.`, NUL, empty, and leading dots)
 * is sufficient; the handler adds a containment re-check anyway. Pure/exported.
 */
export function sanitizeSegment(segment: string): string | null {
  if (typeof segment !== 'string' || segment.length === 0) return null;
  if (segment === '.' || segment === '..') return null;
  if (segment.includes('/') || segment.includes('\\')) return null;
  if (segment.includes('\0')) return null;
  // Vault project/mission slugs never begin with a dot; rejecting it also blocks
  // hidden dirs like `.git` / `.obsidian` from being addressed via this route.
  if (segment.startsWith('.')) return null;
  return segment;
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

/** Identity parser: read a file as raw text through the SafeReader ladder. */
const rawText = (raw: string): string => raw;

interface RawRead {
  text: string | null;
  warning: SnapshotWarning | null;
}

async function readRawFile(reader: SafeReader, file: string): Promise<RawRead> {
  const result = await reader.read(file, rawText, { optional: true });
  return { text: result.value, warning: result.warning };
}

/** Recursively list `evidence/` as sorted relative paths; null if the dir is absent. */
async function listEvidence(
  missionDir: string,
): Promise<{ files: string[] | null; warning: SnapshotWarning | null }> {
  const evidenceDir = path.join(missionDir, 'evidence');
  const files: string[] = [];

  async function walk(dir: string, prefix: string): Promise<void> {
    const entries = await readdir(dir, { withFileTypes: true });
    for (const entry of entries) {
      const rel = prefix.length > 0 ? `${prefix}/${entry.name}` : entry.name;
      if (entry.isDirectory()) {
        await walk(path.join(dir, entry.name), rel);
      } else {
        files.push(rel);
      }
    }
  }

  try {
    await walk(evidenceDir, '');
  } catch (error) {
    if (isEnoent(error)) return { files: null, warning: null };
    return { files: null, warning: { file: evidenceDir, error: describeError(error) } };
  }
  files.sort();
  return { files, warning: null };
}

/** Read every `diagnosis-*.md` in the mission folder (empty when the dir/files are absent). */
async function readDiagnoses(
  reader: SafeReader,
  missionDir: string,
): Promise<{ diagnoses: MissionDetailDiagnosis[]; warnings: SnapshotWarning[] }> {
  let names: string[];
  try {
    const entries = await readdir(missionDir, { withFileTypes: true });
    names = entries
      .filter((entry) => entry.isFile() && /^diagnosis-.*\.md$/.test(entry.name))
      .map((entry) => entry.name)
      .sort();
  } catch {
    // Missing mission dir (or unreadable) -> no diagnoses; the raw-file reads
    // below already surface warnings for the individual documents.
    return { diagnoses: [], warnings: [] };
  }

  const diagnoses: MissionDetailDiagnosis[] = [];
  const warnings: SnapshotWarning[] = [];
  for (const name of names) {
    const read = await readRawFile(reader, path.join(missionDir, name));
    diagnoses.push({ file: name, content: read.text });
    if (read.warning !== null) warnings.push(read.warning);
  }
  return { diagnoses, warnings };
}

/**
 * Gather the on-demand detail payload for one mission. `project`/`mission` MUST
 * already be sanitized (the handler does this). Never throws — every read funnels
 * through the SafeReader last-good ladder or a local try/catch, and absence is
 * modeled as null rather than an error.
 */
export async function readMissionDetail(
  reader: SafeReader,
  vaultPath: string,
  project: string,
  mission: string,
): Promise<MissionDetail> {
  const missionDir = path.join(vaultPath, 'projects', project, 'missions', mission);
  const warnings: SnapshotWarning[] = [];

  const note = await readMissionNote(reader, vaultPath, project, mission);
  if (note.warning !== null) warnings.push(note.warning);

  const milestones = await readRawFile(reader, path.join(missionDir, 'milestones.md'));
  if (milestones.warning !== null) warnings.push(milestones.warning);

  const promptQueue = await readRawFile(reader, path.join(missionDir, 'prompt-queue.md'));
  if (promptQueue.warning !== null) warnings.push(promptQueue.warning);

  const issuesLog = await readRawFile(reader, path.join(missionDir, 'issues-log.md'));
  if (issuesLog.warning !== null) warnings.push(issuesLog.warning);

  const evidence = await listEvidence(missionDir);
  if (evidence.warning !== null) warnings.push(evidence.warning);

  const diag = await readDiagnoses(reader, missionDir);
  warnings.push(...diag.warnings);

  return {
    project,
    mission,
    note: { frontmatter: note.frontmatter, body: note.body },
    milestones: milestones.text,
    promptQueue: promptQueue.text,
    issuesLog: issuesLog.text,
    evidence: evidence.files,
    diagnoses: diag.diagnoses,
    warnings,
  };
}

/**
 * The minimal HTTP response surface the detail handler writes to. Node's
 * `http.ServerResponse` satisfies it structurally, so the handler needs no
 * express types and is trivially unit-testable with a fake (mirrors sse.ts).
 */
export interface DetailResponse {
  statusCode: number;
  setHeader(name: string, value: string): unknown;
  end(chunk?: string): void;
}

function respondJson(res: DetailResponse, status: number, body: unknown): void {
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store');
  res.end(JSON.stringify(body));
}

export interface DetailHandlerDeps {
  /** Absolute vault path (from resolveConfig). */
  vaultPath: string;
  /**
   * SafeReader for the on-demand reads; defaults to a fresh one held for the
   * life of the handler (its last-good cache tolerates mid-write reads across
   * repeated detail requests). Tests may inject their own.
   */
  reader?: SafeReader;
}

/** A detail route handler: sanitize the raw URL segments, read, and respond. */
export type MissionDetailHandler = (
  rawProject: string,
  rawMission: string,
  res: DetailResponse,
) => Promise<void>;

/**
 * Build the `/api/missions/:project/:mission` handler. The caller (index.ts)
 * matches the route on the raw pathname and passes the two still-encoded
 * segments; this handler owns the security boundary: decode → sanitize →
 * containment-check → read → respond.
 */
export function createDetailHandler(deps: DetailHandlerDeps): MissionDetailHandler {
  const reader = deps.reader ?? createSafeReader();
  const projectsBase = path.resolve(deps.vaultPath, 'projects');

  return async function handleMissionDetail(rawProject, rawMission, res): Promise<void> {
    let decodedProject: string;
    let decodedMission: string;
    try {
      decodedProject = decodeURIComponent(rawProject);
      decodedMission = decodeURIComponent(rawMission);
    } catch {
      respondJson(res, 400, { error: 'invalid path encoding' });
      return;
    }

    const project = sanitizeSegment(decodedProject);
    const mission = sanitizeSegment(decodedMission);
    if (project === null || mission === null) {
      respondJson(res, 400, { error: 'invalid project or mission' });
      return;
    }

    // Belt-and-suspenders: even though sanitizeSegment already forbids the only
    // escape vectors, prove the resolved directory stays under <vault>/projects.
    const missionDir = path.resolve(projectsBase, project, 'missions', mission);
    if (missionDir !== projectsBase && !missionDir.startsWith(projectsBase + path.sep)) {
      respondJson(res, 400, { error: 'invalid project or mission' });
      return;
    }

    const detail = await readMissionDetail(reader, deps.vaultPath, project, mission);
    respondJson(res, 200, detail);
  };
}
