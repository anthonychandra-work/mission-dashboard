/**
 * Framework-agnostic SSE snapshot connection controller (spec §3.7).
 *
 * The dashboard receives the whole snapshot over Server-Sent Events: an
 * `event: snapshot` frame carrying the full JSON on connect and one more per
 * server rebuild (full-snapshot SSE, no diffing — SETTLED, spec §3.3/§3.6). This
 * module owns the connection state machine; the React hook `useSnapshot` wires
 * it to the real `EventSource`, `fetch`, and `document.visibilitychange`.
 *
 * It deliberately references NO DOM globals — the browser primitives are
 * injected (`createEventSource`, `fetchSnapshot`) behind the local
 * {@link EventSourceLike} interface — so the whole-repo `tsc --noEmit` (ES2022
 * lib, no DOM) can type-check it and `use-snapshot.test.ts` can drive it with a
 * fake EventSource in a plain Node environment.
 *
 * Mac-sleep coverage (spec §3.7): `EventSource` reconnects natively; on top of
 * that, `onerror` surfaces a `reconnecting` status, and on the next `open` after
 * an error — plus whenever the tab becomes visible again — we refetch
 * `/api/state` once. The revision check makes that refetch idempotent, so it can
 * never double-apply the frame the reconnect already delivered.
 */
import type { Snapshot } from '../../../shared/types.js';

/** Connection status for the ConnectionDot (added by FEAT-DASH-011). */
export type ConnectionStatus = 'connecting' | 'live' | 'reconnecting';

/** The minimal `EventSource` surface this controller uses (DOM-free by design). */
export interface EventSourceLike {
  addEventListener(type: string, listener: (event: { data?: unknown }) => void): void;
  close(): void;
}

export interface SnapshotClientOptions {
  /** Opens the SSE stream. The hook passes `(url) => new EventSource(url)`. */
  createEventSource: (url: string) => EventSourceLike;
  /**
   * Fetches `/api/state` once for a revision-idempotent catch-up. Resolves
   * `null` when unavailable (e.g. the cold-boot 503 tolerated on first paint).
   */
  fetchSnapshot: () => Promise<Snapshot | null>;
  /** Invoked with each newly-applied snapshot (deduplicated by revision). */
  onSnapshot: (snapshot: Snapshot) => void;
  /** Invoked whenever the connection status changes. */
  onStatus: (status: ConnectionStatus) => void;
  /** SSE endpoint; defaults to {@link DEFAULT_EVENTS_URL}. */
  url?: string;
}

export interface SnapshotClient {
  /** The current connection status. */
  readonly status: ConnectionStatus;
  /** Revision of the last applied snapshot, or `null` before the first. */
  readonly revision: number | null;
  /**
   * Catch-up refetch of `/api/state` — call after a reconnect and when the tab
   * becomes visible again (Mac-sleep coverage). Idempotent via the revision
   * check; a no-op after {@link close}.
   */
  refresh(): void;
  /** Close the stream and stop applying frames. Idempotent. */
  close(): void;
}

/** Default SSE endpoint (spec §3.6). */
export const DEFAULT_EVENTS_URL = '/api/events';

export function createSnapshotClient(options: SnapshotClientOptions): SnapshotClient {
  const url = options.url ?? DEFAULT_EVENTS_URL;

  let status: ConnectionStatus = 'connecting';
  let revision: number | null = null;
  let sawError = false;
  let closed = false;

  const setStatus = (next: ConnectionStatus): void => {
    if (status === next) return;
    status = next;
    options.onStatus(next);
  };

  /**
   * Apply a snapshot iff its revision differs from the last one applied. A
   * wholesale replace is cheap, but skipping a duplicate revision dedups the
   * reconnect connect-frame against the catch-up refetch (both carry the current
   * revision), so the UI never re-renders for identical data. A server restart
   * resets revision to 1 (`!== previous`), so its fresh snapshot still applies.
   */
  const apply = (snapshot: Snapshot): void => {
    if (revision !== null && snapshot.revision === revision) return;
    revision = snapshot.revision;
    options.onSnapshot(snapshot);
  };

  const refresh = (): void => {
    if (closed) return;
    void options.fetchSnapshot().then(
      (snapshot) => {
        if (!closed && snapshot !== null) apply(snapshot);
      },
      () => {
        /* transient fetch failure — the SSE stream stays the source of truth */
      },
    );
  };

  const source = options.createEventSource(url);

  source.addEventListener('open', () => {
    if (closed) return;
    const reconnected = sawError;
    sawError = false;
    setStatus('live');
    // Re-open after an error (or Mac wake): catch up on any rebuild missed while
    // the stream was down. The revision check keeps this idempotent.
    if (reconnected) refresh();
  });

  source.addEventListener('snapshot', (event) => {
    if (closed) return;
    if (typeof event.data !== 'string') return;
    try {
      apply(JSON.parse(event.data) as Snapshot);
      setStatus('live');
    } catch {
      /* a malformed frame is ignored — never crash the client */
    }
  });

  source.addEventListener('error', () => {
    if (closed) return;
    // EventSource auto-reconnects natively; surface the interim state so the
    // ConnectionDot (FEAT-DASH-011) can show "reconnecting".
    sawError = true;
    setStatus('reconnecting');
  });

  const close = (): void => {
    if (closed) return;
    closed = true;
    source.close();
  };

  return {
    get status(): ConnectionStatus {
      return status;
    },
    get revision(): number | null {
      return revision;
    },
    refresh,
    close,
  };
}
