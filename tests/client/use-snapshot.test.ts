/**
 * FEAT-DASH-010 — SSE snapshot connection controller (the testable core of
 * `useSnapshot`).
 *
 * `useSnapshot`/`SnapshotProvider` is a thin React wrapper that wires the real
 * `EventSource`, `fetch('/api/state')`, and `document.visibilitychange` into
 * `createSnapshotClient`. The connection state machine — connect frame, per-
 * rebuild frames, revision dedup, `onerror → reconnecting`, and the
 * refetch-on-reconnect / refetch-on-visible catch-up (Mac-sleep coverage) —
 * lives in `client/src/lib/snapshotClient.ts` and is exercised here with a fake
 * EventSource + fake fetch, in a plain Node environment (no DOM).
 */
import { describe, it, expect, vi } from 'vitest';

import {
  createSnapshotClient,
  type EventSourceLike,
  type ConnectionStatus,
} from '../../client/src/lib/snapshotClient.js';
import type { Snapshot } from '../../shared/types.js';

function makeSnapshot(revision: number): Snapshot {
  return {
    revision,
    generatedAt: `2026-07-08T00:00:0${revision % 10}.000Z`,
    vaultPath: '/vault',
    warnings: [],
    projects: [],
    attention: [],
    activity: [],
    inbox: { unprocessedCount: 0, failedCount: 0, unprocessed: [] },
  };
}

/** A controllable EventSource stand-in that records listeners and lets tests fire events. */
class FakeEventSource implements EventSourceLike {
  readonly url: string;
  closed = false;
  private readonly listeners = new Map<string, Array<(event: { data?: unknown }) => void>>();

  constructor(url: string) {
    this.url = url;
  }

  addEventListener(type: string, listener: (event: { data?: unknown }) => void): void {
    const bucket = this.listeners.get(type) ?? [];
    bucket.push(listener);
    this.listeners.set(type, bucket);
  }

  close(): void {
    this.closed = true;
  }

  emit(type: string, event: { data?: unknown } = {}): void {
    for (const listener of this.listeners.get(type) ?? []) listener(event);
  }

  emitSnapshot(snapshot: Snapshot): void {
    this.emit('snapshot', { data: JSON.stringify(snapshot) });
  }
}

/** Flush pending microtasks so a `fetchSnapshot().then(...)` settles. */
function tick(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

interface Harness {
  source: FakeEventSource;
  snapshots: Snapshot[];
  statuses: ConnectionStatus[];
  fetchSnapshot: ReturnType<typeof vi.fn>;
  client: ReturnType<typeof createSnapshotClient>;
}

function setup(fetchImpl: () => Promise<Snapshot | null> = () => Promise.resolve(null)): Harness {
  let source!: FakeEventSource;
  const snapshots: Snapshot[] = [];
  const statuses: ConnectionStatus[] = [];
  const fetchSnapshot = vi.fn(fetchImpl);
  const client = createSnapshotClient({
    createEventSource: (url) => {
      source = new FakeEventSource(url);
      return source;
    },
    fetchSnapshot,
    onSnapshot: (snapshot) => snapshots.push(snapshot),
    onStatus: (status) => statuses.push(status),
  });
  return { source, snapshots, statuses, fetchSnapshot, client };
}

describe('createSnapshotClient', () => {
  it('opens the default SSE endpoint', () => {
    const { source } = setup();
    expect(source.url).toBe('/api/events');
  });

  it('applies the connect snapshot frame and goes live', () => {
    const { source, snapshots, statuses, client } = setup();
    source.emit('open');
    source.emitSnapshot(makeSnapshot(1));

    expect(snapshots).toHaveLength(1);
    expect(snapshots[0]?.revision).toBe(1);
    expect(client.status).toBe('live');
    expect(client.revision).toBe(1);
    expect(statuses).toEqual(['live']);
  });

  it('applies one frame per rebuild', () => {
    const { source, snapshots } = setup();
    source.emitSnapshot(makeSnapshot(1));
    source.emitSnapshot(makeSnapshot(2));
    source.emitSnapshot(makeSnapshot(3));
    expect(snapshots.map((s) => s.revision)).toEqual([1, 2, 3]);
  });

  it('deduplicates a repeated revision (idempotent reconnect frame)', () => {
    const { source, snapshots } = setup();
    source.emitSnapshot(makeSnapshot(2));
    source.emitSnapshot(makeSnapshot(2));
    expect(snapshots.map((s) => s.revision)).toEqual([2]);
  });

  it('still applies a lower revision after a server restart (revision reset)', () => {
    const { source, snapshots } = setup();
    source.emitSnapshot(makeSnapshot(5));
    source.emitSnapshot(makeSnapshot(1)); // restarted server → counter reset
    expect(snapshots.map((s) => s.revision)).toEqual([5, 1]);
  });

  it('ignores a malformed frame without throwing or emitting', () => {
    const { source, snapshots } = setup();
    expect(() => source.emit('snapshot', { data: '{not json' })).not.toThrow();
    expect(() => source.emit('snapshot', { data: 42 })).not.toThrow();
    expect(snapshots).toHaveLength(0);
  });

  it('surfaces "reconnecting" on error, then "live" again on re-open', () => {
    const { source, statuses } = setup();
    source.emit('open');
    source.emitSnapshot(makeSnapshot(1));
    source.emit('error');
    source.emit('open');
    expect(statuses).toEqual(['live', 'reconnecting', 'live']);
  });

  it('does not emit duplicate status transitions', () => {
    const { source, statuses } = setup();
    source.emitSnapshot(makeSnapshot(1));
    source.emitSnapshot(makeSnapshot(2)); // still live — no repeat
    expect(statuses).toEqual(['live']);
  });

  it('refetches /api/state once on re-open after an error (Mac-sleep catch-up)', async () => {
    const { source, snapshots, fetchSnapshot } = setup(() => Promise.resolve(makeSnapshot(7)));
    source.emit('open');
    source.emitSnapshot(makeSnapshot(1));
    expect(fetchSnapshot).not.toHaveBeenCalled(); // no refetch on the FIRST open

    source.emit('error');
    source.emit('open');
    await tick();

    expect(fetchSnapshot).toHaveBeenCalledTimes(1);
    expect(snapshots.map((s) => s.revision)).toEqual([1, 7]);
  });

  it('refresh() (tab re-visible) fetches and applies a newer snapshot', async () => {
    const { source, snapshots, fetchSnapshot, client } = setup(() =>
      Promise.resolve(makeSnapshot(9)),
    );
    source.emitSnapshot(makeSnapshot(1));
    client.refresh();
    await tick();
    expect(fetchSnapshot).toHaveBeenCalledTimes(1);
    expect(snapshots.map((s) => s.revision)).toEqual([1, 9]);
  });

  it('refresh() that returns the current revision is idempotent (no re-render)', async () => {
    const { source, snapshots, client } = setup(() => Promise.resolve(makeSnapshot(1)));
    source.emitSnapshot(makeSnapshot(1));
    client.refresh();
    await tick();
    expect(snapshots.map((s) => s.revision)).toEqual([1]);
  });

  it('tolerates a cold 503 (fetchSnapshot resolves null) on the visibility refetch', async () => {
    const { source, snapshots, client } = setup(() => Promise.resolve(null));
    source.emitSnapshot(makeSnapshot(1));
    client.refresh();
    await tick();
    expect(snapshots.map((s) => s.revision)).toEqual([1]);
  });

  it('stops applying frames and refetches after close()', async () => {
    const { source, snapshots, fetchSnapshot, client } = setup(() =>
      Promise.resolve(makeSnapshot(2)),
    );
    source.emitSnapshot(makeSnapshot(1));
    client.close();
    expect(source.closed).toBe(true);

    source.emitSnapshot(makeSnapshot(2));
    client.refresh();
    await tick();

    expect(fetchSnapshot).not.toHaveBeenCalled();
    expect(snapshots.map((s) => s.revision)).toEqual([1]);
  });
});
