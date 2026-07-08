/**
 * Server-Sent Events hub (spec 3.6) -- the live push half of the server.
 *
 * A single {@link SseHub} owns the set of connected `/api/events` clients and
 * two responsibilities:
 *
 *   1. On connect, send the FULL current snapshot as an `event: snapshot` frame
 *      so a freshly-opened (or reconnected) client is immediately whole -- no
 *      Last-Event-ID replay is needed because every push carries the entire
 *      snapshot (SETTLED, spec 3.4 / decisions.md 2026-07-07).
 *   2. On every rebuild, {@link SseHub.broadcast} pushes one `snapshot` frame to
 *      each client. FEAT-DASH-009's `index.ts` wires this to the watcher:
 *      `watcher.on('vault-changed', async () => hub.broadcast(await store.rebuild()))`.
 *
 * A `: ping` comment heartbeat every {@link DEFAULT_HEARTBEAT_MS} (25 s) keeps
 * intermediaries and the browser's EventSource from treating an idle connection
 * as dead, and gives the client a signal to notice a half-open socket after a
 * Mac sleep. The interval is INJECTABLE so tests don't wait 25 s; the 25 s
 * default is itself asserted (VAL-102).
 *
 * The hub touches only in-memory {@link Snapshot} values handed to it by the
 * store; it never reads or writes the vault (INV-A).
 */
import type { Snapshot } from '../shared/types.js';

/** Production heartbeat cadence: one `: ping` comment every 25 s (VAL-102). */
export const DEFAULT_HEARTBEAT_MS = 25_000;

/**
 * The subset of an HTTP response the hub writes to. Express's `Response` (an
 * `http.ServerResponse` subclass) satisfies this structurally, so the hub needs
 * no express types of its own and stays trivially unit-testable with a fake.
 */
export interface SseResponse {
  statusCode: number;
  setHeader(name: string, value: string): unknown;
  /** Present on `http.ServerResponse`; flushes status + headers before body. */
  flushHeaders?(): void;
  write(chunk: string): boolean;
  end(chunk?: string): void;
  on(event: 'close', listener: () => void): unknown;
}

/** The subset of an HTTP request the hub listens to (client-disconnect). */
export interface SseRequest {
  on(event: 'close', listener: () => void): unknown;
}

/** Serialize a snapshot as a single-line SSE `snapshot` event frame. */
function snapshotFrame(snapshot: Snapshot): string {
  // JSON.stringify without indentation emits no literal newlines (they are
  // escaped), so the whole snapshot fits on one `data:` line -- a valid frame.
  return `event: snapshot\ndata: ${JSON.stringify(snapshot)}\n\n`;
}

export interface SseHubOptions {
  /** Heartbeat cadence in ms; default {@link DEFAULT_HEARTBEAT_MS} (25 s). */
  heartbeatMs?: number;
}

/**
 * Holds the connected SSE clients and fans snapshots + heartbeats out to them.
 * One instance per running server.
 */
export class SseHub {
  private readonly clients = new Set<SseResponse>();
  private readonly heartbeatTimer: ReturnType<typeof setInterval>;
  private closed = false;

  constructor(options: SseHubOptions = {}) {
    const heartbeatMs = options.heartbeatMs ?? DEFAULT_HEARTBEAT_MS;
    this.heartbeatTimer = setInterval(() => this.sendHeartbeat(), heartbeatMs);
    // Never keep the process alive just for the heartbeat -- the HTTP server is
    // what should hold the event loop open (matters for tests and clean exit).
    this.heartbeatTimer.unref?.();
  }

  /** Number of currently connected clients (test/observability aid). */
  get clientCount(): number {
    return this.clients.size;
  }

  /**
   * Register a new `/api/events` client: write the SSE headers, send the full
   * current snapshot as the connect frame (if one exists), and keep the
   * connection open until the peer closes it.
   *
   * `initial` is the store's cached snapshot at connect time (may be null before
   * the very first rebuild -- in production `index.ts` rebuilds once before
   * binding, so a connecting client always gets a snapshot).
   */
  addClient(req: SseRequest, res: SseResponse, initial: Snapshot | null): void {
    res.statusCode = 200;
    res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
    res.setHeader('Cache-Control', 'no-cache, no-transform');
    res.setHeader('Connection', 'keep-alive');
    // Defeat proxy/response buffering so events flush immediately.
    res.setHeader('X-Accel-Buffering', 'no');
    res.flushHeaders?.();

    this.clients.add(res);

    if (initial !== null) {
      this.writeTo(res, snapshotFrame(initial));
    }

    const drop = (): void => {
      this.clients.delete(res);
    };
    req.on('close', drop);
    res.on('close', drop);
  }

  /**
   * Push one `snapshot` frame (the full snapshot) to every connected client.
   * Called once per rebuild by `index.ts` (FEAT-DASH-009). The payload is
   * exactly the snapshot `store.rebuild()` returned.
   */
  broadcast(snapshot: Snapshot): void {
    if (this.closed) return;
    const frame = snapshotFrame(snapshot);
    for (const res of this.clients) {
      this.writeTo(res, frame);
    }
  }

  /** Write a `: ping` comment to every client (keep-alive; VAL-102). */
  private sendHeartbeat(): void {
    if (this.closed) return;
    for (const res of this.clients) {
      this.writeTo(res, ': ping\n\n');
    }
  }

  /**
   * Write to one client, dropping it if the socket has gone away. A dead peer
   * must never take down the hub or a broadcast to the other clients.
   */
  private writeTo(res: SseResponse, chunk: string): void {
    try {
      res.write(chunk);
    } catch {
      this.clients.delete(res);
    }
  }

  /**
   * Stop the heartbeat and end every open connection. Idempotent. Called on
   * server shutdown (and in tests, so a lingering interval/socket never hangs).
   */
  close(): void {
    if (this.closed) return;
    this.closed = true;
    clearInterval(this.heartbeatTimer);
    for (const res of this.clients) {
      try {
        res.end();
      } catch {
        // best-effort: the socket may already be gone
      }
    }
    this.clients.clear();
  }
}

/** Factory mirroring the injectable style of the rest of the server. */
export function createSseHub(options: SseHubOptions = {}): SseHub {
  return new SseHub(options);
}
