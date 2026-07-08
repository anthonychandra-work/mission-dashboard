/**
 * CLI entry + process wiring (spec 3.2) -- the M2 gate.
 *
 * Boots the whole live server: resolve config -> build the store and warm it
 * with ONE rebuild before binding (so `/api/state` and the SSE connect frame are
 * never cold -- a cold `/api/state` is 503 by design, FEAT-DASH-008) -> stand up
 * the HTTP app + SSE hub -> bind `127.0.0.1` on port 4646 (scanning 4647..4655 on
 * EADDRINUSE) -> start the watcher and rebuild+broadcast once per settled burst.
 *
 * -- Wiring the detail route without touching the frozen http.ts --
 * FEAT-DASH-008's `createHttpApp` registers an `/api/*` JSON-404 guard BEFORE its
 * static/SPA fallback, so any route appended after it would be shadowed. Rather
 * than edit another feature's owner file, the detail route lives here as an OUTER
 * `http.createServer` dispatcher: a `GET /api/missions/:project/:mission` request
 * is matched first and handed to the detail handler (which owns traversal
 * sanitization); everything else delegates to the express app (itself a valid
 * `http.RequestListener`). Order therefore guarantees the detail route wins over
 * the 404 guard.
 *
 * -- INV-B: localhost is the entire auth model --
 * The bind host is the {@link BIND_HOST} constant `127.0.0.1` and nothing else --
 * no `0.0.0.0`, no external interface. On success exactly one parseable line is
 * printed: `mission-dashboard listening on http://127.0.0.1:<port>` (the
 * `--serve` skill parses it, FEAT-DASH-015).
 *
 * This module never writes into the vault (INV-A); it only reads through the
 * store/detail readers and serves the in-memory snapshot.
 */
import http from 'node:http';
import { pathToFileURL } from 'node:url';

import { resolveConfig, ConfigError, type DashboardConfig } from './config.js';
import { createStore, type SnapshotStore } from './store.js';
import { createSseHub, type SseHub } from './sse.js';
import { createHttpApp } from './http.js';
import { createVaultWatcher, VAULT_CHANGED_EVENT, type VaultWatcher } from './watcher.js';
import { createDetailHandler, matchMissionDetailPath } from './detail.js';
import type { SafeReader } from './aggregate/safeRead.js';

/** INV-B: the ONLY address this server ever binds. Localhost is the auth model. */
export const BIND_HOST = '127.0.0.1';

/**
 * How many consecutive ports the scan tries starting at the configured port.
 * For the default 4646 this covers 4646..4655 (spec 3.2: "scan 4647-4655").
 */
export const DEFAULT_PORT_SCAN_COUNT = 10;

export interface StartServerOptions {
  /** Absolute vault path (from resolveConfig). */
  vaultPath: string;
  /** Preferred listen port; the scan starts here (spec 3.2). */
  port: number;
  /** Claim-staleness threshold in minutes; forwarded to the store. */
  staleClaimMinutes?: number;
  /** Trailing debounce for the watcher; forwarded through. */
  debounceMs?: number;
  /** awaitWriteFinish tuning for the watcher; forwarded through. */
  awaitWriteFinish?: { stabilityThreshold: number; pollInterval: number };
  /** Injectable clock (tests). */
  now?: () => Date;
  /** Injectable SafeReader for the store (tests observe last-good across rebuilds). */
  reader?: SafeReader;
  /** SSE heartbeat cadence (tests use a short one). */
  heartbeatMs?: number;
  /** Built-client dir override (tests). */
  clientDir?: string;
  /** How many ports to scan from `port`; default {@link DEFAULT_PORT_SCAN_COUNT}. */
  portScanCount?: number;
  /** Where the single "listening" line goes; default `console.log` (tests capture it). */
  log?: (line: string) => void;
  /** Where non-fatal runtime problems go; default `console.error`. */
  logError?: (line: string) => void;
}

/** A fully wired, bound, watching server plus a clean async shutdown. */
export interface RunningServer {
  server: http.Server;
  /** The port actually bound (may differ from the requested one after a scan). */
  port: number;
  store: SnapshotStore;
  sse: SseHub;
  watcher: VaultWatcher;
  /** Stop watching, close the SSE hub, and close the HTTP server. Idempotent. */
  close(): Promise<void>;
}

/** Resolve once the server is listening, or reject with the listen error. */
function attemptListen(server: http.Server, port: number, host: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const onError = (err: unknown): void => {
      server.removeListener('listening', onListening);
      reject(err);
    };
    const onListening = (): void => {
      server.removeListener('error', onError);
      resolve();
    };
    server.once('error', onError);
    server.once('listening', onListening);
    server.listen(port, host);
  });
}

function isEaddrinuse(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    (error as NodeJS.ErrnoException).code === 'EADDRINUSE'
  );
}

/**
 * Bind `server` to the first free port in `[startPort, startPort + count)`
 * (capped at 65535), retrying only on EADDRINUSE. A node `http.Server` can be
 * re-`listen`ed after a failed bind, so the same server is reused across the
 * scan. Throws a clear error if every candidate is taken.
 */
export async function bindWithScan(
  server: http.Server,
  host: string,
  startPort: number,
  count: number,
): Promise<number> {
  const maxPort = Math.min(startPort + count - 1, 65535);
  for (let port = startPort; port <= maxPort; port++) {
    try {
      await attemptListen(server, port, host);
      // Report the ACTUAL bound port (equals `port` unless `port` was 0/ephemeral).
      const addr = server.address();
      return addr !== null && typeof addr === 'object' && 'port' in addr ? addr.port : port;
    } catch (err) {
      if (isEaddrinuse(err) && port < maxPort) continue;
      if (isEaddrinuse(err)) {
        throw new Error(
          `No free port in ${startPort}-${maxPort} (all in use). Free one or pass --port.`,
        );
      }
      throw err;
    }
  }
  // Unreachable: the loop either returns a port or throws above.
  throw new Error('port scan exhausted');
}

/**
 * Wire config -> store -> HTTP/SSE -> watcher and bind the server. Returns the
 * running handle; does not install signal handlers or exit the process (that is
 * `main`'s job), so tests can drive and tear it down cleanly.
 */
export async function startServer(opts: StartServerOptions): Promise<RunningServer> {
  const log = opts.log ?? ((line: string): void => console.log(line));
  const logError = opts.logError ?? ((line: string): void => console.error(line));

  const store = createStore({
    vaultPath: opts.vaultPath,
    ...(opts.staleClaimMinutes === undefined ? {} : { staleClaimMinutes: opts.staleClaimMinutes }),
    ...(opts.now === undefined ? {} : { now: opts.now }),
    ...(opts.reader === undefined ? {} : { reader: opts.reader }),
  });

  // Warm the cache BEFORE binding: never expose the cold-503 window to a client.
  await store.rebuild();

  const sse = createSseHub(opts.heartbeatMs === undefined ? {} : { heartbeatMs: opts.heartbeatMs });
  const app = createHttpApp({
    store,
    sse,
    ...(opts.clientDir === undefined ? {} : { clientDir: opts.clientDir }),
  });
  const handleDetail = createDetailHandler({ vaultPath: opts.vaultPath });

  // Outer dispatcher: the detail route is matched first (it must win over the
  // frozen http.ts `/api` 404 guard); all else delegates to the express app.
  const server = http.createServer((req, res) => {
    const method = req.method ?? 'GET';
    let pathname = '/';
    try {
      pathname = new URL(req.url ?? '/', 'http://localhost').pathname;
    } catch {
      // Malformed request URL: let the express app produce the 404.
    }
    const match = method === 'GET' ? matchMissionDetailPath(pathname) : null;
    if (match !== null) {
      void handleDetail(match.project, match.mission, res);
      return;
    }
    app(req, res);
  });

  const port = await bindWithScan(
    server,
    BIND_HOST,
    opts.port,
    opts.portScanCount ?? DEFAULT_PORT_SCAN_COUNT,
  );
  log(`mission-dashboard listening on http://${BIND_HOST}:${port}`);

  const watcher = createVaultWatcher({
    vaultPath: opts.vaultPath,
    ...(opts.debounceMs === undefined ? {} : { debounceMs: opts.debounceMs }),
    ...(opts.awaitWriteFinish === undefined ? {} : { awaitWriteFinish: opts.awaitWriteFinish }),
  });
  // Full rebuild + broadcast once per settled burst (VAL-101 end-to-end).
  watcher.on(VAULT_CHANGED_EVENT, () => {
    void (async (): Promise<void> => {
      try {
        sse.broadcast(await store.rebuild());
      } catch (err) {
        logError(`rebuild failed: ${err instanceof Error ? err.message : String(err)}`);
      }
    })();
  });
  // The watcher forwards 'error' only when a listener is attached; watch errors
  // are non-fatal for a read-only observer (safeRead covers read failures).
  watcher.on('error', (err: unknown) => {
    logError(`watcher error: ${err instanceof Error ? err.message : String(err)}`);
  });
  await watcher.ready;

  let closed = false;
  const close = async (): Promise<void> => {
    if (closed) return;
    closed = true;
    await watcher.close();
    sse.close();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  };

  return { server, port, store, sse, watcher, close };
}

/** Process entry: resolve config, start the server, wire graceful shutdown. */
async function main(): Promise<void> {
  let config: DashboardConfig;
  try {
    config = await resolveConfig();
  } catch (err) {
    if (err instanceof ConfigError) {
      // Fail fast with the user-facing message (spec 3.2), no stack trace.
      console.error(err.message);
      process.exitCode = 1;
      return;
    }
    throw err;
  }

  const running = await startServer({
    vaultPath: config.vaultPath,
    port: config.port,
    staleClaimMinutes: config.staleClaimMinutes,
    debounceMs: config.debounceMs,
  });

  const shutdown = (): void => {
    void running.close().then(() => process.exit(0));
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

// Run only when invoked as the process entry (`node dist/server/index.js`), never
// when a test imports `startServer` from this module.
const entry = process.argv[1];
const isEntry = entry !== undefined && import.meta.url === pathToFileURL(entry).href;
if (isEntry) {
  void main().catch((err: unknown) => {
    console.error(err instanceof Error ? err.message : String(err));
    process.exit(1);
  });
}
