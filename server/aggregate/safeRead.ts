/**
 * safeRead — tolerant file reads with retry + last-good fallback (spec §3.3).
 *
 * Every JSON/YAML read in the aggregator goes through this funnel:
 *   1. read + parse; on any failure (I/O or parse) retry ONCE after 250 ms —
 *      this absorbs mid-write reads during atomic tmp+rename bursts;
 *   2. if the retry also fails, serve the LAST-GOOD parsed value for that path
 *      (per-path cache) and report a `{file, error}` warning;
 *   3. NEVER throw — a corrupt vault file must never crash the server or flash
 *      an empty dashboard (VAL-004).
 *
 * The cache is held by the SafeReader instance. M1 uses a fresh reader per
 * test; in M2 `store.ts` owns one long-lived instance so last-good values
 * survive across rebuilds (scaffold decision, knowledge-base.md).
 *
 * Optional files (e.g. a mission without features.json — real imported-mission
 * case, spec §1): absence is REAL state, not an error. An ENOENT on an
 * `optional` read returns `missing: true` immediately — no retry delay, no
 * warning — and drops any cached value so deleted data cannot be resurrected
 * by a later malformed rewrite.
 *
 * This module never writes anywhere (INV-A).
 */
import { readFile } from 'node:fs/promises';
import { setTimeout as delay } from 'node:timers/promises';

import type { SnapshotWarning } from '../../shared/types.js';

/** Spec §3.3: "retry once after 250 ms". */
export const DEFAULT_RETRY_DELAY_MS = 250;

/** Outcome of a safe read — exactly one of the flag combinations below. */
export interface SafeReadResult<T> {
  /**
   * The parsed value: fresh on success, the last-good cached value when the
   * current content is unreadable (`stale: true`), or null when no good value
   * has ever been seen for this path.
   */
  value: T | null;
  /** True only for an `optional` file that does not exist (legitimate absence). */
  missing: boolean;
  /** True when `value` was served from the last-good cache. */
  stale: boolean;
  /** Non-null whenever the current read failed (even if last-good was served). */
  warning: SnapshotWarning | null;
}

export interface SafeReaderOptions {
  /** Delay before the single retry; defaults to {@link DEFAULT_RETRY_DELAY_MS}. */
  retryDelayMs?: number;
  /** Injectable sleep so tests never wait real time. */
  sleep?: (ms: number) => Promise<void>;
}

export interface SafeReadOptions {
  /** Absence of an optional file is real state (missing), never a warning. */
  optional?: boolean;
}

/** A parse function turning raw file text into a value; may throw on bad input. */
export type Parser<T> = (raw: string) => T;

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
 * Tolerant reader with a per-path last-good cache.
 * One instance = one cache lifetime (the store owns the long-lived one in M2).
 */
export class SafeReader {
  private readonly lastGood = new Map<string, unknown>();
  private readonly retryDelayMs: number;
  private readonly sleep: (ms: number) => Promise<void>;

  constructor(options: SafeReaderOptions = {}) {
    this.retryDelayMs = options.retryDelayMs ?? DEFAULT_RETRY_DELAY_MS;
    this.sleep = options.sleep ?? ((ms) => delay(ms));
  }

  /**
   * Read `file` and parse it with `parse`, applying the full retry →
   * last-good → warning ladder. Never throws.
   */
  async read<T>(
    file: string,
    parse: Parser<T>,
    options: SafeReadOptions = {},
  ): Promise<SafeReadResult<T>> {
    const optional = options.optional === true;

    const first = await this.attempt(file, parse);
    if (first.ok) return this.success(file, first.value);
    if (optional && first.enoent) return this.absent(file);

    // Retry once — absorbs mid-write reads during atomic rename bursts.
    try {
      await this.sleep(this.retryDelayMs);
    } catch {
      // An injected sleep must never be able to break the never-throws contract.
    }

    const second = await this.attempt(file, parse);
    if (second.ok) return this.success(file, second.value);
    if (optional && second.enoent) return this.absent(file);

    return this.failure(file, second.error);
  }

  /** JSON convenience wrapper — the common case for vault files. */
  async readJson<T = unknown>(
    file: string,
    options: SafeReadOptions = {},
  ): Promise<SafeReadResult<T>> {
    return this.read<T>(file, (raw) => JSON.parse(raw) as T, options);
  }

  private async attempt<T>(
    file: string,
    parse: Parser<T>,
  ): Promise<{ ok: true; value: T } | { ok: false; enoent: boolean; error: unknown }> {
    try {
      const raw = await readFile(file, 'utf8');
      return { ok: true, value: parse(raw) };
    } catch (error) {
      return { ok: false, enoent: isEnoent(error), error };
    }
  }

  private success<T>(file: string, value: T): SafeReadResult<T> {
    this.lastGood.set(file, value);
    return { value, missing: false, stale: false, warning: null };
  }

  private absent<T>(file: string): SafeReadResult<T> {
    // Legitimate deletion: forget the cached value so it can never resurrect.
    this.lastGood.delete(file);
    return { value: null, missing: true, stale: false, warning: null };
  }

  private failure<T>(file: string, error: unknown): SafeReadResult<T> {
    const warning: SnapshotWarning = { file, error: describeError(error) };
    if (this.lastGood.has(file)) {
      return { value: this.lastGood.get(file) as T, missing: false, stale: true, warning };
    }
    return { value: null, missing: false, stale: false, warning };
  }
}

/** Factory mirroring the injectable style of `resolveConfig` (FEAT-DASH-001). */
export function createSafeReader(options: SafeReaderOptions = {}): SafeReader {
  return new SafeReader(options);
}
