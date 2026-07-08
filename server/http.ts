/**
 * Express HTTP app (spec 3.6) -- the request/response half of the live server.
 *
 * Two API routes plus static single-page-app serving:
 *
 *   - `GET /api/state` returns the store's CACHED snapshot verbatim. It calls
 *     `store.getSnapshot()` and NEVER `store.rebuild()` -- reads must be cheap
 *     and side-effect-free; rebuilds happen only on watcher bursts (spec 3.3,
 *     the wiring contract in wiki/components/store-and-watcher.md, VAL-102).
 *     Before the first rebuild the cache is null; `index.ts` (FEAT-DASH-009)
 *     rebuilds once before binding, so in production this always has a value.
 *     Defensively, a null cache yields `503` (never a rebuild).
 *   - `GET /api/events` hands the connection to the {@link SseHub}, which sends
 *     the full current snapshot on connect and then one frame per rebuild.
 *   - everything else serves `dist/client` statically with an SPA fallback to
 *     `index.html`, so client-side hash routes deep-link correctly.
 *
 * Route order matters: the API routes and an `/api` 404 guard come BEFORE the
 * static/SPA fallback, so an unknown `/api/...` path returns JSON `404` instead
 * of the SPA shell.
 *
 * -- express typing --
 * express@4 ships no type declarations and `@types/express` is deliberately
 * outside the closed dependency list (spec 3.1; only `@types/node` was accepted,
 * ISSUE-01). An untyped JS module also cannot be `declare module`-augmented
 * (TS2665). So the single untyped import is suppressed and the exact express
 * surface this file uses is typed locally below -- full type-checking on our own
 * usage, zero new dependencies, everything inside this feature's owner files.
 *
 * This module never reads or writes the vault (INV-A): it serves only the
 * in-memory snapshot the store hands it, and static files from the build dir.
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Server } from 'node:http';

// @ts-expect-error express@4 ships no type declarations and @types/express is
// intentionally outside the closed dependency list (spec 3.1); the surface used
// here is typed locally (HttpApp / Handler / ReqLike / ResLike) below.
import express from 'express';

import type { SnapshotStore } from './store.js';
import { type SseHub, type SseRequest, type SseResponse } from './sse.js';

/** The express `Request` members this file reads (extends the SSE request slice). */
interface ReqLike extends SseRequest {
  path: string;
}

/** The express `Response` members this file writes (extends the SSE response slice). */
interface ResLike extends SseResponse {
  json(body: unknown): unknown;
  status(code: number): ResLike;
  set(field: string, value: string): ResLike;
  type(contentType: string): ResLike;
  sendFile(filePath: string, callback?: (err?: unknown) => void): void;
}

/** An express middleware/route handler over the locally-typed req/res. */
type Handler = (req: ReqLike, res: ResLike, next: (err?: unknown) => void) => void;

/**
 * The express application surface this file uses. It is also callable as an
 * `http.RequestListener`, so tests can `http.createServer(app)`.
 */
export interface HttpApp {
  (req: unknown, res: unknown): void;
  get(path: string, ...handlers: Handler[]): void;
  use(...handlers: Handler[]): void;
  use(path: string, ...handlers: Handler[]): void;
  set(name: string, value: unknown): void;
  disable(name: string): void;
  listen(port: number, host: string, callback?: () => void): Server;
}

export interface HttpAppDeps {
  /** The live snapshot store; `/api/state` and the SSE connect frame read it. */
  store: SnapshotStore;
  /** The SSE hub the `/api/events` route hands connections to. */
  sse: SseHub;
  /**
   * Directory of the built client (served statically, SPA fallback to
   * `index.html`). Defaults to `dist/client` resolved next to the compiled
   * server; tests inject a temp dir. Need not exist -- a missing file yields 404.
   */
  clientDir?: string;
}

/** Default built-client location: `dist/client`, sibling of `dist/server/`. */
function defaultClientDir(): string {
  // At runtime this file is dist/server/http.js, so ../client -> dist/client.
  return fileURLToPath(new URL('../client', import.meta.url));
}

/**
 * Build the express app wired to the store and SSE hub. Does NOT listen -- the
 * caller (index.ts / tests) owns binding, so port-scan/bind logic stays in
 * FEAT-DASH-009 and tests can bind an ephemeral port.
 */
export function createHttpApp(deps: HttpAppDeps): HttpApp {
  const app = express() as HttpApp;
  const clientDir = deps.clientDir ?? defaultClientDir();
  const indexHtml = path.join(clientDir, 'index.html');

  app.disable('x-powered-by');
  app.set('etag', false);

  // -- API: cached snapshot, never a rebuild on request (VAL-102) --
  app.get('/api/state', (_req, res) => {
    const snapshot = deps.store.getSnapshot();
    if (snapshot === null) {
      // Cache not warm yet (index.ts rebuilds before binding, so this is the
      // rare boot race only). We do NOT rebuild here -- reads never rebuild.
      res.status(503).set('Cache-Control', 'no-store').json({ error: 'snapshot not ready' });
      return;
    }
    res.set('Cache-Control', 'no-store').json(snapshot);
  });

  // -- API: SSE stream (full snapshot on connect, then one frame per rebuild) --
  app.get('/api/events', (req, res) => {
    deps.sse.addClient(req, res, deps.store.getSnapshot());
  });

  // Unknown /api/* -> JSON 404 (before static/SPA fallback, so it never returns
  // the SPA shell for a mistyped endpoint).
  app.use('/api', (_req, res) => {
    res.status(404).set('Cache-Control', 'no-store').json({ error: 'not found' });
  });

  // -- Static assets from the built client --
  const serveStatic = (express as { static(root: string): Handler }).static(clientDir);
  app.use(serveStatic);

  // -- SPA fallback: any other GET serves index.html so hash-router deep links
  // resolve. A missing build (no index.html) degrades to a plain 404.
  app.get('*', (_req, res) => {
    res.sendFile(indexHtml, (err?: unknown) => {
      if (err) {
        res.status(404).type('text/plain').end('mission-dashboard: client build not found');
      }
    });
  });

  return app;
}
