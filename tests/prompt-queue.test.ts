/**
 * FEAT-DASH-003 — prompt-queue reader (spec §3.1 module list, §3.4:
 * "nextAction = first actionable line of the mission's prompt-queue.md (nullable)").
 *
 * Contract under test:
 *   - the "first actionable line" prefers the content of the first `NEXT`
 *     section (real queues lead with a "## NEXT — …" heading); headings, blank
 *     lines, fenced code, comments and horizontal rules are never actionable;
 *   - list/blockquote markers are stripped so the UI gets bare text;
 *   - an absent prompt-queue.md is real state → null, no warning;
 *   - reads funnel through SafeReader: unreadable file → null + warning,
 *     never a throw.
 *
 * INV-A: mutation only in temp copies of tests/fixtures/vault-basic.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { cp, mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { createSafeReader } from '../server/aggregate/safeRead.js';
import {
  firstActionableLine,
  readPromptQueue,
  type PromptQueueReadResult,
} from '../server/aggregate/promptQueue.js';

const FIXTURE_VAULT = fileURLToPath(new URL('./fixtures/vault-basic', import.meta.url));

let root: string;

beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), 'mission-dashboard-prompt-queue-'));
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

describe('readPromptQueue — fixture vault', () => {
  it('returns the NEXT-section action line for mission-one', async () => {
    const vault = await tempVaultCopy();
    const result = await readPromptQueue(fastReader(), vault, 'alpha-app', 'mission-one');
    expect(result.nextAction).toBe('validate FEAT-ONE-004 once the executor report lands');
    expect(result.warning).toBeNull();
  });

  it('a mission without prompt-queue.md → null nextAction, no warning', async () => {
    const vault = await tempVaultCopy();
    const result = await readPromptQueue(fastReader(), vault, 'legacy-tool', 'imported-mission');
    expect(result.nextAction).toBeNull();
    expect(result.warning).toBeNull();
  });

  it('an unreadable prompt-queue.md (a directory) → null + warning, never throws', async () => {
    const vault = await tempVaultCopy();
    await mkdir(
      path.join(vault, 'projects', 'legacy-tool', 'missions', 'imported-mission', 'prompt-queue.md'),
    );
    let result: PromptQueueReadResult | undefined;
    await expect(
      (async () => {
        result = await readPromptQueue(fastReader(), vault, 'legacy-tool', 'imported-mission');
      })(),
    ).resolves.toBeUndefined();
    expect(result!.nextAction).toBeNull();
    expect(result!.warning).not.toBeNull();
  });
});

describe('firstActionableLine — extraction rules', () => {
  it('returns null for empty, whitespace-only, or headings-only content', () => {
    expect(firstActionableLine('')).toBeNull();
    expect(firstActionableLine('   \n\n\t\n')).toBeNull();
    expect(firstActionableLine('# Title\n\n## NEXT — something\n\n### deeper\n')).toBeNull();
  });

  it('prefers the first content line AFTER a NEXT heading over earlier preamble prose', () => {
    const md = [
      '# Prompt Queue — mission-one',
      '',
      'The next paste-ready action for this mission.', // preamble, must be skipped
      '',
      '## NEXT — validate FEAT-ONE-004',
      '',
      'validate FEAT-ONE-004 once the executor report lands',
      '',
      '## Queued after that',
      '',
      '- Fix pass on FEAT-ONE-002.',
    ].join('\n');
    expect(firstActionableLine(md)).toBe('validate FEAT-ONE-004 once the executor report lands');
  });

  it('skips fenced code blocks (the paste-ready prompt body) and fence markers', () => {
    const md = [
      '## NEXT — execute FEAT-X',
      '',
      '```text',
      'Implement FEAT-X for the mission on branch',
      'mission/x (multi-line prompt body).',
      '```',
      '',
      'run the executor for FEAT-X',
    ].join('\n');
    expect(firstActionableLine(md)).toBe('run the executor for FEAT-X');
  });

  it('strips list and blockquote markers', () => {
    expect(firstActionableLine('## NEXT\n\n- validate FEAT-A now\n')).toBe('validate FEAT-A now');
    expect(firstActionableLine('## NEXT\n\n1. validate FEAT-B now\n')).toBe(
      'validate FEAT-B now',
    );
    expect(firstActionableLine('## NEXT\n\n> validate FEAT-C now\n')).toBe('validate FEAT-C now');
  });

  it('falls back to the first plain content line when no NEXT heading exists', () => {
    const md = ['# Prompt Queue', '', 'continue FEAT-Y fix pass', ''].join('\n');
    expect(firstActionableLine(md)).toBe('continue FEAT-Y fix pass');
  });

  it('ignores horizontal rules and HTML comments', () => {
    const md = ['## NEXT', '', '---', '<!-- keep for the validator -->', '', 'do the thing'].join(
      '\n',
    );
    expect(firstActionableLine(md)).toBe('do the thing');
  });

  it('a NEXT section with no content falls back to scanning the whole file', () => {
    const md = ['intro line before sections', '', '## NEXT — empty', ''].join('\n');
    expect(firstActionableLine(md)).toBe('intro line before sections');
  });
});
