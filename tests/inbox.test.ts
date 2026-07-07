/**
 * FEAT-DASH-004 — inbox reader (spec §3.1 module list, §3.4 inbox summary):
 * "list + parse frontmatter of inbox/*.md; count .processed/.failed".
 *
 * Contract under test:
 *   - top-level `inbox/*.md` files are listed (sorted by filename — the
 *     timestamp prefix makes that chronological) with their gray-matter
 *     frontmatter summarized; dot-entries, non-.md files and directories
 *     (`.processed/`, `.failed/`) are never counted as unprocessed;
 *   - `.processed/` is counted AND summarized (the orphaned_claim rule of
 *     spec §3.5 matches reports "top-level or .processed/"); `.failed/` is
 *     counted with file names only;
 *   - YAML timestamps parse as Dates via gray-matter — the reader normalizes
 *     them back to ISO strings (InboxReportSummary.timestamp: string | null);
 *   - a report with broken frontmatter is still counted (the file exists) with
 *     null fields plus a warning; a report with NO frontmatter is counted with
 *     null fields and no warning; nothing ever throws;
 *   - a missing inbox/ (or missing subdirs) is real state → zero counts, no
 *     warning (empty vault is valid, spec §5).
 *
 * INV-A: mutation only in temp copies of tests/fixtures/vault-basic.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { cp, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { createSafeReader } from '../server/aggregate/safeRead.js';
import { readInbox, type InboxReadResult } from '../server/aggregate/inbox.js';

const FIXTURE_VAULT = fileURLToPath(new URL('./fixtures/vault-basic', import.meta.url));

const UNPROCESSED_FILE = '20260115-093000-alpha-app-mission-one-FEAT-ONE-002-executor.md';
const PROCESSED_FILE = '20260114-120000-alpha-app-mission-one-FEAT-ONE-001-validator.md';
const FAILED_FILE = '20260113-110000-legacy-tool-imported-mission-none-executor.md';

let root: string;

beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), 'mission-dashboard-inbox-'));
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

describe('readInbox — fixture vault', () => {
  it('lists the unprocessed report with its frontmatter summary', async () => {
    const vault = await tempVaultCopy();
    const result = await readInbox(fastReader(), vault);

    expect(result.unprocessedCount).toBe(1);
    expect(result.unprocessed).toHaveLength(1);
    expect(result.unprocessed[0]).toEqual({
      file: UNPROCESSED_FILE,
      project: 'alpha-app',
      mission: 'mission-one',
      feature: 'FEAT-ONE-002',
      role: 'executor',
      result: 'implemented_with_findings',
      // YAML `2026-01-15T09:30:00` parses as a Date; normalized to ISO (UTC).
      timestamp: '2026-01-15T09:30:00.000Z',
    });
    expect(result.warnings).toEqual([]);
  });

  it('counts AND summarizes .processed/ (orphaned_claim rule input)', async () => {
    const vault = await tempVaultCopy();
    const result = await readInbox(fastReader(), vault);

    expect(result.processedCount).toBe(1);
    expect(result.processed).toHaveLength(1);
    expect(result.processed[0]).toEqual({
      file: PROCESSED_FILE,
      project: 'alpha-app',
      mission: 'mission-one',
      feature: 'FEAT-ONE-001',
      role: 'validator',
      result: 'validated_passed',
      timestamp: '2026-01-14T12:00:00.000Z',
    });
  });

  it('counts .failed/ by file name', async () => {
    const vault = await tempVaultCopy();
    const result = await readInbox(fastReader(), vault);

    expect(result.failedCount).toBe(1);
    expect(result.failedFiles).toEqual([FAILED_FILE]);
  });

  it('ignores non-markdown files, dot-entries, and the subdirectories themselves', async () => {
    const vault = await tempVaultCopy();
    await writeFile(path.join(vault, 'inbox', 'notes.txt'), 'not a report');
    await writeFile(path.join(vault, 'inbox', '.hidden.md'), '---\nrole: ghost\n---\n');

    const result = await readInbox(fastReader(), vault);
    expect(result.unprocessedCount).toBe(1);
    expect(result.unprocessed.map((r) => r.file)).toEqual([UNPROCESSED_FILE]);
  });

  it('sorts multiple unprocessed reports by filename (timestamp prefix = chronological)', async () => {
    const vault = await tempVaultCopy();
    const older = '20260110-080000-alpha-app-mission-one-FEAT-ONE-000-executor.md';
    const newer = '20260116-090000-alpha-app-mission-one-FEAT-ONE-003-validator.md';
    const report = (role: string) => `---\nrole: ${role}\n---\n\n## Summary\nx\n`;
    await writeFile(path.join(vault, 'inbox', newer), report('validator'));
    await writeFile(path.join(vault, 'inbox', older), report('executor'));

    const result = await readInbox(fastReader(), vault);
    expect(result.unprocessed.map((r) => r.file)).toEqual([older, UNPROCESSED_FILE, newer]);
  });
});

describe('readInbox — tolerance', () => {
  it('a report with broken YAML frontmatter is still counted, with null fields + warning', async () => {
    const vault = await tempVaultCopy();
    const broken = '20260117-100000-broken-report-executor.md';
    await writeFile(
      path.join(vault, 'inbox', broken),
      '---\nproject: [unclosed\n---\n\nbody\n',
    );

    let result: InboxReadResult | undefined;
    await expect(
      (async () => {
        result = await readInbox(fastReader(), vault);
      })(),
    ).resolves.toBeUndefined();

    expect(result!.unprocessedCount).toBe(2);
    const brokenSummary = result!.unprocessed.find((r) => r.file === broken)!;
    expect(brokenSummary).toEqual({
      file: broken,
      project: null,
      mission: null,
      feature: null,
      role: null,
      result: null,
      timestamp: null,
    });
    expect(result!.warnings).toHaveLength(1);
    expect(result!.warnings[0]!.file).toContain(broken);
  });

  it('a report without frontmatter is counted with null fields and NO warning', async () => {
    const vault = await tempVaultCopy();
    const bare = '20260118-110000-bare-note.md';
    await writeFile(path.join(vault, 'inbox', bare), '## Just a body\nno frontmatter\n');

    const result = await readInbox(fastReader(), vault);
    expect(result.unprocessedCount).toBe(2);
    const bareSummary = result.unprocessed.find((r) => r.file === bare)!;
    expect(bareSummary.project).toBeNull();
    expect(bareSummary.role).toBeNull();
    expect(result.warnings).toEqual([]);
  });

  it('non-string frontmatter garbage is coerced to null silently (no warning)', async () => {
    const vault = await tempVaultCopy();
    const odd = '20260119-120000-odd-types.md';
    await writeFile(
      path.join(vault, 'inbox', odd),
      '---\nproject: 42\nmission: [a, b]\nrole: executor\n---\n',
    );

    const result = await readInbox(fastReader(), vault);
    const summary = result.unprocessed.find((r) => r.file === odd)!;
    expect(summary.project).toBeNull();
    expect(summary.mission).toBeNull();
    expect(summary.role).toBe('executor');
    expect(result.warnings).toEqual([]);
  });

  it('a missing inbox/ directory is real state — zero counts, no warnings', async () => {
    const vault = await tempVaultCopy();
    await rm(path.join(vault, 'inbox'), { recursive: true });

    const result = await readInbox(fastReader(), vault);
    expect(result).toEqual({
      unprocessedCount: 0,
      processedCount: 0,
      failedCount: 0,
      unprocessed: [],
      processed: [],
      failedFiles: [],
      warnings: [],
    });
  });

  it('missing .processed/ and .failed/ subdirs → zero counts, no warnings', async () => {
    const vault = await tempVaultCopy();
    await rm(path.join(vault, 'inbox', '.processed'), { recursive: true });
    await rm(path.join(vault, 'inbox', '.failed'), { recursive: true });

    const result = await readInbox(fastReader(), vault);
    expect(result.unprocessedCount).toBe(1);
    expect(result.processedCount).toBe(0);
    expect(result.failedCount).toBe(0);
    expect(result.warnings).toEqual([]);
  });
});
