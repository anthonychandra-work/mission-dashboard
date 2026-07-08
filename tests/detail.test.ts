/**
 * FEAT-DASH-009 -- on-demand mission detail endpoint (spec 3.6).
 *
 * Covers the three layers of server/detail.ts:
 *   - `sanitizeSegment` / `matchMissionDetailPath` -- the pure security + routing
 *     primitives (path-traversal rejection is proven here at the unit level;
 *     the over-the-wire proof lands in integration.test.ts);
 *   - `readMissionDetail` -- gathers note + milestones + full prompt-queue +
 *     issues-log + evidence listing + diagnosis-*.md, each field nullable when
 *     absent, never throwing; and
 *   - `createDetailHandler` -- decode -> sanitize -> containment -> read -> JSON,
 *     answering 400 on any traversal attempt and 200-with-nulls for a well-formed
 *     but non-existent mission.
 *
 * All reads target the committed fixture vault (read-only) or mkdtemp temp trees;
 * never the real vault, and the detail path writes nothing (INV-A).
 */
import { afterEach, describe, expect, it } from 'vitest';
import { cp, mkdir, mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { createSafeReader } from '../server/aggregate/safeRead.js';
import {
  createDetailHandler,
  matchMissionDetailPath,
  readMissionDetail,
  sanitizeSegment,
  type DetailResponse,
  type MissionDetail,
} from '../server/detail.js';

const FIXTURE_VAULT = fileURLToPath(new URL('./fixtures/vault-basic', import.meta.url));

const cleanups: Array<() => Promise<void> | void> = [];
afterEach(async () => {
  while (cleanups.length > 0) {
    const fn = cleanups.pop();
    if (fn) await fn();
  }
});

async function tempRoot(): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), 'mission-dashboard-detail-'));
  cleanups.push(() => rm(root, { recursive: true, force: true }));
  return root;
}

/** A minimal DetailResponse capturing status/headers/body for handler tests. */
class FakeResponse implements DetailResponse {
  statusCode = 200;
  headers: Record<string, string> = {};
  body = '';
  ended = false;
  setHeader(name: string, value: string): this {
    this.headers[name.toLowerCase()] = value;
    return this;
  }
  end(chunk?: string): void {
    if (chunk !== undefined) this.body += chunk;
    this.ended = true;
  }
  json(): unknown {
    return JSON.parse(this.body);
  }
}

// -- sanitizeSegment ---------------------------------------------------------

describe('sanitizeSegment -- traversal defense (unit)', () => {
  it('accepts ordinary slugs', () => {
    for (const ok of ['alpha-app', 'mission-one', 'FEAT-DASH-009', 'a', 'a_b.c', 'thing2']) {
      expect(sanitizeSegment(ok)).toBe(ok);
    }
  });

  it('rejects every traversal / escape vector', () => {
    for (const bad of [
      '',
      '.',
      '..',
      '../etc',
      'a/b',
      'a\\b',
      '/abs',
      'x\0y',
      '.hidden',
      '.git',
    ]) {
      expect(sanitizeSegment(bad)).toBeNull();
    }
  });
});

// -- matchMissionDetailPath --------------------------------------------------

describe('matchMissionDetailPath -- route shape (unit)', () => {
  it('matches exactly two segments (with an optional trailing slash)', () => {
    expect(matchMissionDetailPath('/api/missions/alpha-app/mission-one')).toEqual({
      project: 'alpha-app',
      mission: 'mission-one',
    });
    expect(matchMissionDetailPath('/api/missions/alpha-app/mission-one/')).toEqual({
      project: 'alpha-app',
      mission: 'mission-one',
    });
  });

  it('returns the RAW (still-encoded) segments for the handler to decode', () => {
    // %2f would be a smuggled separator -- the matcher passes it through so the
    // handler can decode + reject it (a WHATWG URL keeps %2f encoded).
    expect(matchMissionDetailPath('/api/missions/a%2fb/c')).toEqual({
      project: 'a%2fb',
      mission: 'c',
    });
  });

  it('does not match other shapes', () => {
    for (const p of [
      '/api/missions/alpha',
      '/api/missions/a/b/c',
      '/api/missions/',
      '/api/state',
      '/api/events',
      '/',
      '/etc/passwd',
    ]) {
      expect(matchMissionDetailPath(p)).toBeNull();
    }
  });
});

// -- readMissionDetail against the fixture (sparse mission) ------------------

describe('readMissionDetail -- fixture mission (sparse)', () => {
  it('returns note + full prompt-queue and nulls for the absent documents', async () => {
    const reader = createSafeReader({ sleep: async () => {} });
    const detail = await readMissionDetail(reader, FIXTURE_VAULT, 'alpha-app', 'mission-one');

    // Note frontmatter + body (reuses the aggregate mission-note reader).
    expect(detail.note.frontmatter).toMatchObject({ project: 'alpha-app', mission: 'mission-one' });
    expect(detail.note.body).toContain('Mission One');

    // The FULL prompt-queue (not just the first actionable line).
    expect(detail.promptQueue).toContain('# Prompt Queue');
    expect(detail.promptQueue).toContain('Queued after that');

    // mission-one has no milestones / issues-log / evidence / diagnoses.
    expect(detail.milestones).toBeNull();
    expect(detail.issuesLog).toBeNull();
    expect(detail.evidence).toBeNull();
    expect(detail.diagnoses).toEqual([]);
    expect(detail.warnings).toEqual([]);
  });

  it('returns all-null fields for a well-formed but non-existent mission (absence is state)', async () => {
    const reader = createSafeReader({ sleep: async () => {} });
    const detail = await readMissionDetail(reader, FIXTURE_VAULT, 'alpha-app', 'no-such-mission');

    expect(detail).toMatchObject({
      project: 'alpha-app',
      mission: 'no-such-mission',
      note: { frontmatter: null, body: null },
      milestones: null,
      promptQueue: null,
      issuesLog: null,
      evidence: null,
      diagnoses: [],
      warnings: [],
    });
  });
});

// -- readMissionDetail against a fully-populated temp mission ----------------

async function buildRichMission(): Promise<{ vault: string; project: string; mission: string }> {
  const root = await tempRoot();
  const vault = path.join(root, 'vault');
  const project = 'proj';
  const mission = 'rich';
  const missionDir = path.join(vault, 'projects', project, 'missions', mission);
  await mkdir(path.join(missionDir, 'evidence', 'FEAT-X'), { recursive: true });

  await writeFile(
    path.join(missionDir, `${mission}.md`),
    '---\ntype: mission\nstatus: active\n---\n\n# Rich Mission\n\nBody text.\n',
    'utf8',
  );
  await writeFile(path.join(missionDir, 'milestones.md'), '# Milestones\n\n- M1 done\n', 'utf8');
  await writeFile(path.join(missionDir, 'prompt-queue.md'), '# Prompt Queue\n\n## NEXT\n\nvalidate X\n', 'utf8');
  await writeFile(path.join(missionDir, 'issues-log.md'), '# Issues\n\n| ISSUE-01 | open |\n', 'utf8');
  await writeFile(path.join(missionDir, 'evidence', 'bar.txt'), 'bar', 'utf8');
  await writeFile(path.join(missionDir, 'evidence', 'FEAT-X', 'foo.txt'), 'foo', 'utf8');
  await writeFile(path.join(missionDir, 'diagnosis-FEAT-Y.md'), '# Diag Y\n', 'utf8');
  await writeFile(path.join(missionDir, 'diagnosis-FEAT-X.md'), '# Diag X\n', 'utf8');
  // A decoy that must NOT be picked up as a diagnosis.
  await writeFile(path.join(missionDir, 'not-a-diagnosis.md'), 'nope\n', 'utf8');

  return { vault, project, mission };
}

describe('readMissionDetail -- fully-populated mission', () => {
  it('gathers every detail field, sorted and complete', async () => {
    const { vault, project, mission } = await buildRichMission();
    const reader = createSafeReader({ sleep: async () => {} });
    const detail = await readMissionDetail(reader, vault, project, mission);

    expect(detail.note.frontmatter).toMatchObject({ type: 'mission', status: 'active' });
    expect(detail.note.body).toContain('Rich Mission');
    expect(detail.milestones).toContain('M1 done');
    expect(detail.promptQueue).toContain('validate X');
    expect(detail.issuesLog).toContain('ISSUE-01');

    // Evidence is a recursive, sorted relative listing.
    expect(detail.evidence).toEqual(['FEAT-X/foo.txt', 'bar.txt'].sort());

    // Diagnoses: only diagnosis-*.md, sorted by name, decoy excluded.
    expect(detail.diagnoses.map((d) => d.file)).toEqual(['diagnosis-FEAT-X.md', 'diagnosis-FEAT-Y.md']);
    expect(detail.diagnoses[0]?.content).toContain('Diag X');
    expect(detail.warnings).toEqual([]);
  });
});

// -- createDetailHandler -----------------------------------------------------

describe('createDetailHandler -- decode/sanitize/read/respond', () => {
  it('answers 200 with the JSON payload for a valid mission', async () => {
    const handle = createDetailHandler({ vaultPath: FIXTURE_VAULT });
    const res = new FakeResponse();
    await handle('alpha-app', 'mission-one', res);

    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toContain('application/json');
    expect(res.headers['cache-control']).toContain('no-store');
    const body = res.json() as MissionDetail;
    expect(body.project).toBe('alpha-app');
    expect(body.note.body).toContain('Mission One');
  });

  it('answers 200-with-nulls for a well-formed but non-existent mission', async () => {
    const handle = createDetailHandler({ vaultPath: FIXTURE_VAULT });
    const res = new FakeResponse();
    await handle('alpha-app', 'ghost', res);
    expect(res.statusCode).toBe(200);
    expect((res.json() as MissionDetail).note.body).toBeNull();
  });

  it('rejects encoded traversal (%2e%2e -> "..") with 400 and reads nothing', async () => {
    const handle = createDetailHandler({ vaultPath: FIXTURE_VAULT });
    const res = new FakeResponse();
    await handle('%2e%2e', 'x', res);
    expect(res.statusCode).toBe(400);
    expect(res.json()).toEqual({ error: 'invalid project or mission' });
  });

  it('rejects an encoded separator (%2f -> "/") with 400', async () => {
    const handle = createDetailHandler({ vaultPath: FIXTURE_VAULT });
    const res = new FakeResponse();
    await handle('a%2fb', 'c', res);
    expect(res.statusCode).toBe(400);
  });

  it('rejects a literal "../" segment with 400', async () => {
    const handle = createDetailHandler({ vaultPath: FIXTURE_VAULT });
    const res = new FakeResponse();
    await handle('..', 'registry', res);
    expect(res.statusCode).toBe(400);
  });

  it('rejects malformed percent-encoding with 400', async () => {
    const handle = createDetailHandler({ vaultPath: FIXTURE_VAULT });
    const res = new FakeResponse();
    await handle('%zz', 'x', res);
    expect(res.statusCode).toBe(400);
    expect(res.json()).toEqual({ error: 'invalid path encoding' });
  });
});

// -- INV-A: the detail path never writes into the vault ----------------------

async function listTree(root: string): Promise<string[]> {
  const out: string[] = [];
  async function walk(dir: string, prefix: string): Promise<void> {
    const entries = await readdir(dir, { withFileTypes: true });
    for (const e of entries) {
      const rel = prefix ? `${prefix}/${e.name}` : e.name;
      out.push(rel);
      if (e.isDirectory()) await walk(path.join(dir, e.name), rel);
    }
  }
  await walk(root, '');
  return out.sort();
}

describe('INV-A -- reading detail writes nothing into the vault', () => {
  it('leaves a temp vault byte-for-byte identical after reads + traversal probes', async () => {
    const root = await tempRoot();
    const vault = path.join(root, 'vault');
    await cp(FIXTURE_VAULT, vault, { recursive: true });
    const before = await listTree(vault);

    const handle = createDetailHandler({ vaultPath: vault });
    await handle('alpha-app', 'mission-one', new FakeResponse());
    await handle('alpha-app', 'ghost', new FakeResponse());
    await handle('%2e%2e', 'x', new FakeResponse());
    await handle('a%2fb', 'c', new FakeResponse());

    expect(await listTree(vault)).toEqual(before);
  });
});
