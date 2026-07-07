/**
 * FEAT-DASH-004 — mission-note reader (spec §3.1 module list; consumed by the
 * detail endpoint only, spec §3.6: "mission-note markdown body + frontmatter
 * … each field nullable if absent").
 *
 * Contract under test:
 *   - the note lives at projects/<p>/missions/<slug>/<slug>.md; frontmatter
 *     parses via gray-matter, body is the markdown below it;
 *   - an absent note is real state → missing: true, null fields, no warning;
 *   - broken frontmatter → null fields + warning, never a throw; last-good
 *     values are served (stale: true) once the reader has seen the note parse;
 *   - frontmatter is passed through raw (YAML dates stay Date objects — they
 *     JSON-serialize to ISO strings on the detail endpoint).
 *
 * INV-A: mutation only in temp copies of tests/fixtures/vault-basic.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { cp, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { createSafeReader } from '../server/aggregate/safeRead.js';
import {
  readMissionNote,
  type MissionNoteReadResult,
} from '../server/aggregate/missionNote.js';

const FIXTURE_VAULT = fileURLToPath(new URL('./fixtures/vault-basic', import.meta.url));

let root: string;

beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), 'mission-dashboard-mission-note-'));
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

function fastReader() {
  return createSafeReader({ sleep: async () => {} });
}

async function tempVaultCopy(): Promise<string> {
  const dest = path.join(root, 'vault-basic');
  await cp(FIXTURE_VAULT, dest, { recursive: true });
  return dest;
}

function notePath(vault: string, project: string, mission: string): string {
  return path.join(vault, 'projects', project, 'missions', mission, `${mission}.md`);
}

describe('readMissionNote — fixture vault', () => {
  it('returns frontmatter + body for mission-one', async () => {
    const vault = await tempVaultCopy();
    const result = await readMissionNote(fastReader(), vault, 'alpha-app', 'mission-one');

    expect(result.missing).toBe(false);
    expect(result.warning).toBeNull();
    expect(result.stale).toBe(false);
    expect(result.frontmatter).toMatchObject({
      type: 'mission',
      project: 'alpha-app',
      mission: 'mission-one',
      status: 'active',
      tags: ['mission'],
    });
    expect(result.body).toContain('# Mission One — engine core');
    expect(result.body).toContain('detail endpoint reader.');
    // The body never carries the frontmatter block.
    expect(result.body).not.toContain('---');
  });

  it('reads the imported (featureless) mission note too', async () => {
    const vault = await tempVaultCopy();
    const result = await readMissionNote(fastReader(), vault, 'legacy-tool', 'imported-mission');

    expect(result.missing).toBe(false);
    expect(result.frontmatter).toMatchObject({ status: 'complete' });
    expect(result.body).toContain('# Imported mission');
  });

  it('an absent note is real state — missing: true, nulls, no warning', async () => {
    const vault = await tempVaultCopy();
    const result = await readMissionNote(fastReader(), vault, 'alpha-app', 'mission-ghost');

    expect(result).toEqual<MissionNoteReadResult>({
      missing: true,
      frontmatter: null,
      body: null,
      stale: false,
      warning: null,
    });
  });

  it('a note without frontmatter yields an empty frontmatter object and the full body', async () => {
    const vault = await tempVaultCopy();
    const dir = path.join(vault, 'projects', 'alpha-app', 'missions', 'bare-mission');
    await mkdir(dir, { recursive: true });
    await writeFile(path.join(dir, 'bare-mission.md'), '# Bare note\n\nNo frontmatter here.\n');

    const result = await readMissionNote(fastReader(), vault, 'alpha-app', 'bare-mission');
    expect(result.missing).toBe(false);
    expect(result.frontmatter).toEqual({});
    expect(result.body).toContain('# Bare note');
    expect(result.warning).toBeNull();
  });
});

describe('readMissionNote — tolerance', () => {
  it('broken frontmatter → nulls + warning, never a throw', async () => {
    const vault = await tempVaultCopy();
    const file = notePath(vault, 'alpha-app', 'mission-one');
    await writeFile(file, '---\nstatus: [unclosed\n---\n\nbody\n');

    let result: MissionNoteReadResult | undefined;
    await expect(
      (async () => {
        result = await readMissionNote(fastReader(), vault, 'alpha-app', 'mission-one');
      })(),
    ).resolves.toBeUndefined();

    expect(result!.missing).toBe(false);
    expect(result!.frontmatter).toBeNull();
    expect(result!.body).toBeNull();
    expect(result!.stale).toBe(false);
    expect(result!.warning).not.toBeNull();
    expect(result!.warning!.file).toBe(file);
  });

  it('serves the last-good note (stale: true) after the file goes bad mid-write', async () => {
    const vault = await tempVaultCopy();
    const reader = fastReader();

    const good = await readMissionNote(reader, vault, 'alpha-app', 'mission-one');
    expect(good.frontmatter).toMatchObject({ status: 'active' });

    await writeFile(notePath(vault, 'alpha-app', 'mission-one'), '---\nbroken: [\n---\n');
    const after = await readMissionNote(reader, vault, 'alpha-app', 'mission-one');

    expect(after.stale).toBe(true);
    expect(after.warning).not.toBeNull();
    expect(after.frontmatter).toMatchObject({ status: 'active' });
    expect(after.body).toBe(good.body);
  });

  it('an unreadable note (a directory) → nulls + warning', async () => {
    const vault = await tempVaultCopy();
    const dir = path.join(vault, 'projects', 'alpha-app', 'missions', 'dir-note');
    await mkdir(path.join(dir, 'dir-note.md'), { recursive: true });

    const result = await readMissionNote(fastReader(), vault, 'alpha-app', 'dir-note');
    expect(result.missing).toBe(false);
    expect(result.frontmatter).toBeNull();
    expect(result.body).toBeNull();
    expect(result.warning).not.toBeNull();
  });
});
