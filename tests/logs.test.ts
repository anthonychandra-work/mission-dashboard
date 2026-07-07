/**
 * FEAT-DASH-004 — activity log reader (spec §3.1 module list, §3.4 assembly
 * rules): parse `## [YYYY-MM-DD HH:MM] <type> | <title>` entries from the
 * global log.md + every project log.md; last ~15 each, capped at 30 merged
 * newest-first.
 *
 * Contract under test:
 *   - the tolerant parser: lines not matching the entry header fold into the
 *     previous entry's body; garbage BEFORE the first entry is skipped;
 *     drifted headers (bad timestamp, missing pipe) fold instead of failing;
 *     pure garbage input yields [] — never a throw (log-format drift, spec §5);
 *   - per-log tail (last 15 entries) and the merged cap of 30, newest-first,
 *     with stable ordering on timestamp ties (global before project);
 *   - absent log files are real state (no warning); unreadable ones warn via
 *     the SafeReader funnel while the other logs still flow.
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
  MERGED_ACTIVITY_CAP,
  PER_LOG_TAIL,
  parseLogEntries,
  readActivity,
  type ProjectLogRef,
} from '../server/aggregate/logs.js';

const FIXTURE_VAULT = fileURLToPath(new URL('./fixtures/vault-basic', import.meta.url));

const FIXTURE_PROJECTS: ProjectLogRef[] = [
  { slug: 'alpha-app', vaultDir: 'projects/alpha-app' },
  { slug: 'legacy-tool', vaultDir: 'projects/legacy-tool' },
];

let root: string;

beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), 'mission-dashboard-logs-'));
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

/** Generate a log with `count` entries, minutes 00..count-1, oldest first. */
function generatedLog(day: string, count: number, type: string): string {
  const entries: string[] = ['# Generated log', ''];
  for (let i = 0; i < count; i++) {
    const minute = String(i).padStart(2, '0');
    entries.push(`## [${day} 10:${minute}] ${type} | entry ${i}`, `body ${i}`, '');
  }
  return entries.join('\n');
}

describe('readActivity — fixture vault', () => {
  it('merges global + project logs newest-first with correct scopes', async () => {
    const vault = await tempVaultCopy();
    const result = await readActivity(fastReader(), vault, FIXTURE_PROJECTS);

    expect(result.warnings).toEqual([]);
    expect(
      result.activity.map((e) => [e.scope, e.timestamp, e.type, e.title]),
    ).toEqual([
      ['global', '2026-01-15 10:00', 'dispatch', 'executor → alpha-app/mission-one/FEAT-ONE-003'],
      ['project:alpha-app', '2026-01-15 09:30', 'mission', 'FEAT-ONE-002 validated_failed'],
      // 2026-01-14 12:00 tie: stable sort keeps global before project.
      ['global', '2026-01-14 12:00', 'sync', 'inbox drained (1 report)'],
      ['project:alpha-app', '2026-01-14 12:00', 'sync', 'FEAT-ONE-001 validated_passed'],
      ['global', '2026-01-12 09:30', 'mission', 'alpha-app/mission-one activated'],
      ['project:legacy-tool', '2025-12-20 16:00', 'conclude', 'imported-mission complete'],
    ]);
  });

  it('folds the deliberate non-header body line into the previous entry (fixture)', async () => {
    const vault = await tempVaultCopy();
    const result = await readActivity(fastReader(), vault, FIXTURE_PROJECTS);

    const folded = result.activity.find(
      (e) => e.scope === 'global' && e.title === 'inbox drained (1 report)',
    )!;
    expect(folded.body).toBe(
      'FEAT-ONE-001 validator report processed and merged.\n' +
        'This second body line must fold into the same entry.',
    );
  });

  it('a project without a log.md is skipped silently; a missing global log is no warning', async () => {
    const vault = await tempVaultCopy();
    await rm(path.join(vault, 'log.md'));
    const ghost: ProjectLogRef = { slug: 'ghost', vaultDir: 'projects/ghost' };

    const result = await readActivity(fastReader(), vault, [...FIXTURE_PROJECTS, ghost]);
    expect(result.warnings).toEqual([]);
    expect(result.activity.every((e) => e.scope !== 'global')).toBe(true);
    expect(result.activity).toHaveLength(3);
  });

  it('an unreadable log warns but never blocks the other logs', async () => {
    const vault = await tempVaultCopy();
    await rm(path.join(vault, 'log.md'));
    await mkdir(path.join(vault, 'log.md')); // a directory: read fails, not ENOENT

    const result = await readActivity(fastReader(), vault, FIXTURE_PROJECTS);
    expect(result.warnings).toHaveLength(1);
    expect(result.warnings[0]!.file).toBe(path.join(vault, 'log.md'));
    expect(result.activity.some((e) => e.scope === 'project:alpha-app')).toBe(true);
  });

  it('keeps the last 15 entries per log and caps the merge at 30, newest first', async () => {
    const vault = await tempVaultCopy();
    // 20 global + 20 alpha entries; legacy keeps its 1 fixture entry.
    await writeFile(path.join(vault, 'log.md'), generatedLog('2026-02-02', 20, 'sync'));
    await writeFile(
      path.join(vault, 'projects', 'alpha-app', 'log.md'),
      generatedLog('2026-02-01', 20, 'mission'),
    );

    const result = await readActivity(fastReader(), vault, FIXTURE_PROJECTS);

    // Tails: 15 + 15 + 1 = 31 → capped at 30.
    expect(result.activity).toHaveLength(MERGED_ACTIVITY_CAP);
    const globalEntries = result.activity.filter((e) => e.scope === 'global');
    expect(globalEntries).toHaveLength(PER_LOG_TAIL);
    // Newest first: the last generated global entry leads.
    expect(result.activity[0]!.title).toBe('entry 19');
    expect(result.activity[0]!.timestamp).toBe('2026-02-02 10:19');
    // Oldest global survivor is entry 5 (last 15 of 20).
    expect(globalEntries.at(-1)!.title).toBe('entry 5');
    // The single oldest entry (legacy 2025-12-20) fell off the cap.
    expect(result.activity.some((e) => e.scope === 'project:legacy-tool')).toBe(false);
  });
});

describe('parseLogEntries — tolerant parser', () => {
  it('parses header + body and skips preamble before the first entry', () => {
    const md = [
      '# Global log',
      '',
      'Format prose that is not an entry.',
      '',
      '## [2026-01-15 10:00] dispatch | executor → somewhere',
      'Claim written.',
      '',
    ].join('\n');
    expect(parseLogEntries(md, 'global')).toEqual([
      {
        scope: 'global',
        timestamp: '2026-01-15 10:00',
        type: 'dispatch',
        title: 'executor → somewhere',
        body: 'Claim written.',
      },
    ]);
  });

  it('folds drifted headers (bad timestamp, missing pipe, deeper heading) into the previous body', () => {
    const md = [
      '## [2026-01-15 10:00] sync | good entry',
      'line one',
      '## [not-a-timestamp] crash | drifted',
      '## missing pipe 2026-01-15 11:00',
      '### [2026-01-15 11:30] deep | heading',
      '## [2026-01-15 12:00] mission | next good entry',
      'tail body',
    ].join('\n');
    const entries = parseLogEntries(md, 'global');
    expect(entries.map((e) => e.title)).toEqual(['good entry', 'next good entry']);
    expect(entries[0]!.body).toBe(
      [
        'line one',
        '## [not-a-timestamp] crash | drifted',
        '## missing pipe 2026-01-15 11:00',
        '### [2026-01-15 11:30] deep | heading',
      ].join('\n'),
    );
    expect(entries[1]!.body).toBe('tail body');
  });

  it('a title may itself contain pipes; type never does', () => {
    const entries = parseLogEntries(
      '## [2026-01-15 10:00] sync | title | with | pipes\n',
      'global',
    );
    expect(entries[0]!.type).toBe('sync');
    expect(entries[0]!.title).toBe('title | with | pipes');
  });

  it('handles CRLF input and trims outer blank lines from bodies', () => {
    const md = '## [2026-01-15 10:00] sync | crlf\r\n\r\nbody line\r\n\r\n';
    expect(parseLogEntries(md, 'global')[0]!.body).toBe('body line');
  });

  it('garbage input never throws and yields no entries', () => {
    expect(parseLogEntries('', 'global')).toEqual([]);
    expect(parseLogEntries('utter nonsense\nno headers at all', 'global')).toEqual([]);
    expect(parseLogEntries('  binary-ish � garbage', 'global')).toEqual([]);
  });
});
