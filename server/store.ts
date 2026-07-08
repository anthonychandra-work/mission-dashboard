/**
 * Snapshot store -- the live server's single source of truth (spec 3.3).
 *
 * The store owns two things the pure M1 aggregation core deliberately does not:
 *
 *   1. the monotonically incrementing `revision` counter -- bumped once per
 *      completed rebuild; every SSE client sees revisions strictly increase
 *      (FEAT-DASH-008), and VAL-101 asserts one burst -> one bump; and
 *   2. ONE long-lived {@link SafeReader} shared across every rebuild, so the
 *      per-path last-good cache survives from one rebuild to the next (spec
 *      3.3 "keep the last-good parsed value for that path (cache in store.ts)").
 *      A mid-write read that fails on this rebuild degrades to the value cached
 *      on a previous one instead of flashing empty (VAL-004).
 *
 * `rebuild()` does a FULL re-read every time -- no diffing, no incremental
 * patching (SETTLED, spec 3.3). Snapshots are a few KB and rebuild cost is
 * < 50 ms, so a full rebuild eliminates the whole cache-invalidation bug class.
 * It composes exactly the M1 pipeline the snapshot module documents:
 * `buildSnapshot({ revision, now, vaultPath, reads: await
 * collectSnapshotReads(reader, vaultPath) })` -- the store injects the counter
 * and the clock at that boundary; everything downstream stays pure.
 *
 * `collectSnapshotReads` never throws (VAL-004), so `rebuild()` never throws:
 * the revision is committed only after the snapshot is assembled, keeping the
 * counter monotonic even if a future change made a read path fail hard.
 *
 * This module never writes anywhere (INV-A) -- it only reads the vault through
 * the aggregation core and holds the result in memory.
 */
import type { Snapshot } from '../shared/types.js';
import { createSafeReader, type SafeReader } from './aggregate/safeRead.js';
import { buildSnapshot, collectSnapshotReads } from './aggregate/snapshot.js';

export interface StoreOptions {
  /** Absolute path of the vault under observation (from resolveConfig). */
  vaultPath: string;
  /** Staleness threshold in minutes; forwarded to buildSnapshot (default 45). */
  staleClaimMinutes?: number;
  /** Injectable clock so tests get deterministic generatedAt / claim timing. */
  now?: () => Date;
  /**
   * The long-lived SafeReader. Defaults to a fresh one; tests may inject their
   * own to observe the shared last-good cache. Do NOT create a second reader
   * per rebuild -- that would defeat the cross-rebuild last-good fallback.
   */
  reader?: SafeReader;
}

/**
 * Holds the current immutable snapshot plus the rebuild revision counter, and
 * orchestrates full re-reads. One instance per running server.
 */
export class SnapshotStore {
  private current: Snapshot | null = null;
  private revisionCounter = 0;

  private readonly vaultPath: string;
  private readonly staleClaimMinutes: number | undefined;
  private readonly now: () => Date;
  private readonly reader: SafeReader;

  constructor(options: StoreOptions) {
    this.vaultPath = options.vaultPath;
    this.staleClaimMinutes = options.staleClaimMinutes;
    this.now = options.now ?? (() => new Date());
    this.reader = options.reader ?? createSafeReader();
  }

  /** The current rebuild revision (0 before the first rebuild). */
  get revision(): number {
    return this.revisionCounter;
  }

  /**
   * The last successfully built snapshot, or null before the first rebuild.
   * `/api/state` (FEAT-DASH-008) serves THIS cached value and never triggers a
   * rebuild on request -- rebuilds happen only on watcher bursts.
   */
  getSnapshot(): Snapshot | null {
    return this.current;
  }

  /**
   * Full re-read, assemble, bump revision, cache. Returns the new snapshot
   * (the SSE broadcast payload, FEAT-DASH-008). Never throws.
   */
  async rebuild(): Promise<Snapshot> {
    // Compute the next revision but commit it only after a snapshot exists, so
    // the counter is monotonic and gap-free even under a hypothetical failure.
    const revision = this.revisionCounter + 1;
    const reads = await collectSnapshotReads(this.reader, this.vaultPath);
    const snapshot = buildSnapshot({
      revision,
      now: this.now(),
      vaultPath: this.vaultPath,
      reads,
      ...(this.staleClaimMinutes === undefined
        ? {}
        : { staleClaimMinutes: this.staleClaimMinutes }),
    });
    this.revisionCounter = revision;
    this.current = snapshot;
    return snapshot;
  }
}

/** Factory mirroring the injectable style of the rest of the server. */
export function createStore(options: StoreOptions): SnapshotStore {
  return new SnapshotStore(options);
}
