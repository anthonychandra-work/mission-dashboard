/**
 * FEAT-DASH-008 -- express HTTP app (spec 3.6; VAL-102 /api/state half).
 *
 * Integration tests over a REAL bound express app (ephemeral port, node:http
 * client -- no supertest, which is outside the closed dependency list). They
 * prove:
 *   - GET /api/state returns the store's CACHED snapshot verbatim and NEVER
 *     triggers a rebuild on request (the revision counter does not move, however
 *     many times it is hit) -- VAL-102;
 *   - before the first rebuild the cache is null -> 503, and STILL no rebuild;
 *   - an unknown /api/* path returns JSON 404 (not the SPA shell);
 *   - static assets are served from the build dir, with an SPA fallback to
 *     index.html for client-side routes; and
 *   - INV-A: serving requests writes nothing into the vault.
 *
 * The store reads a TEMP copy of the fixture vault (INV-A); no watcher is
 * involved, so the FSEvents drain pattern does not apply.
 */
import { afterEach, describe, expect, it } from 'vitest';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { cp, mkdtemp, mkdir, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { createHttpApp } from '../server/http.js';
import { createSseHub, type SseHub } from '../server/sse.js';
import { createStore, type SnapshotStore } from '../server/store.js';

const FIXTURE_VAULT = fileURLToPath(new URL('./fixtures/vault-basic', import.meta.url));
const NOW = new Date('2026-01-15T10:10:00Z');

interface Res {
  status: number;
  headers: http.IncomingHttpHeaders;
  body: string;
}

function request(port: number, urlPath: string): Promise<Res> {
  return new Promise((resolve, reject) => {
    const req = http.get({ host: '127.0.0.1', port, path: urlPath }, (res) => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (c: string) => {
        body += c;
      });
      res.on('end', () =>
        resolve({ status: res.statusCode ?? 0, headers: res.headers, body }),
      );
    });
    req.on('error', reject);
  });
}

/** Recursive relative-path listing, sorted -- an INV-A "nothing changed" probe. */
async function listTree(root: string): Promise<string[]> {
  const out: string[] = [];
  async function walk(dir: string, prefix: string): Promise<void> {
    const entries = await readdir(dir, { withFileTypes: true });
    for (const e of entries) {
      const rel = prefix ? `${prefix}/${e.name}` : e.name;
      out.push(rel);
      if (e.isDirectory()) await walk(path.join(dir, e.name), rel);
    }
  }
  await walk(root, '');
  return out.sort();
}

// -- per-test lifecycle: temp dirs + a bound server we always tear down --

interface Harness {
  store: SnapshotStore;
  hub: SseHub;
  server: http.Server;
  port: number;
  vault: string;
  clientDir: string;
  root: string;
}

const teardowns: Array<() => Promise<void> | void> = [];
afterEach(async () => {
  while (teardowns.length > 0) {
    const fn = teardowns.pop();
    if (fn) await fn();
  }
});

async function makeHarness(opts: { rebuild: boolean; withClient?: boolean }): Promise<Harness> {
  const root = await mkdtemp(path.join(tmpdir(), 'mission-dashboard-http-'));
  teardowns.push(() => rm(root, { recursive: true, force: true }));

  const vault = path.join(root, 'vault-basic');
  await cp(FIXTURE_VAULT, vault, { recursive: true });

  const clientDir = path.join(root, 'client');
  if (opts.withClient) {
    await mkdir(path.join(clientDir, 'assets'), { recursive: true });
    await writeFile(path.join(clientDir, 'index.html'), '<!doctype html><title>APP</title>', 'utf8');
    await writeFile(path.join(clientDir, 'assets', 'app.js'), 'console.log("app");', 'utf8');
  }

  const store = createStore({ vaultPath: vault, now: () => NOW });
  if (opts.rebuild) await store.rebuild();
  const hub = createSseHub({ heartbeatMs: 10_000 });
  teardowns.push(() => hub.close());

  const app = createHttpApp({ store, sse: hub, clientDir });
  const server = http.createServer(app);
  teardowns.push(() => new Promise<void>((r) => server.close(() => r())));
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const port = (server.address() as AddressInfo).port;

  return { store, hub, server, port, vault, clientDir, root };
}

describe('GET /api/state -- cached, never rebuilds (VAL-102)', () => {
  it('returns the store\'s cached snapshot verbatim', async () => {
    const h = await makeHarness({ rebuild: true });
    const res = await request(h.port, '/api/state');

    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toContain('application/json');
    expect(res.headers['cache-control']).toContain('no-store');

    const expected = JSON.parse(JSON.stringify(h.store.getSnapshot()));
    expect(JSON.parse(res.body)).toEqual(expected);
    expect(JSON.parse(res.body).revision).toBe(1);
  });

  it('never triggers a rebuild -- the revision counter never moves on request', async () => {
    const h = await makeHarness({ rebuild: true });
    expect(h.store.revision).toBe(1);

    for (let i = 0; i < 4; i++) {
      const res = await request(h.port, '/api/state');
      expect(res.status).toBe(200);
      expect(h.store.revision).toBe(1); // NO rebuild happened on the request
    }
  });

  it('returns 503 before the first rebuild, and STILL does not rebuild', async () => {
    const h = await makeHarness({ rebuild: false });
    expect(h.store.revision).toBe(0);
    expect(h.store.getSnapshot()).toBeNull();

    const res = await request(h.port, '/api/state');
    expect(res.status).toBe(503);
    expect(JSON.parse(res.body)).toEqual({ error: 'snapshot not ready' });
    expect(h.store.revision).toBe(0); // reads never rebuild, even cold
  });
});

describe('/api/* unknown -> JSON 404 (never the SPA shell)', () => {
  it('returns a JSON 404 for an unknown API path', async () => {
    const h = await makeHarness({ rebuild: true, withClient: true });
    const res = await request(h.port, '/api/does-not-exist');
    expect(res.status).toBe(404);
    expect(res.headers['content-type']).toContain('application/json');
    expect(JSON.parse(res.body)).toEqual({ error: 'not found' });
  });
});

describe('static serving + SPA fallback', () => {
  it('serves index.html at /, an asset by path, and falls back to index.html for SPA routes', async () => {
    const h = await makeHarness({ rebuild: true, withClient: true });

    const index = await request(h.port, '/');
    expect(index.status).toBe(200);
    expect(index.body).toContain('<title>APP</title>');

    const asset = await request(h.port, '/assets/app.js');
    expect(asset.status).toBe(200);
    expect(asset.body).toContain('console.log');

    // A client-side route with no file on disk -> SPA fallback to index.html.
    const spa = await request(h.port, '/m/alpha-app/mission-one');
    expect(spa.status).toBe(200);
    expect(spa.body).toContain('<title>APP</title>');
  });

  it('degrades to a plain 404 when the client build is missing', async () => {
    const h = await makeHarness({ rebuild: true, withClient: false });
    const res = await request(h.port, '/some/spa/route');
    expect(res.status).toBe(404);
    expect(res.body).toContain('client build not found');
  });
});

describe('INV-A -- serving requests writes nothing into the vault', () => {
  it('leaves the vault tree byte-for-byte identical after a batch of requests', async () => {
    const h = await makeHarness({ rebuild: true, withClient: true });
    const before = await listTree(h.vault);

    await request(h.port, '/api/state');
    await request(h.port, '/api/state');
    await request(h.port, '/api/unknown');
    await request(h.port, '/');
    await request(h.port, '/deep/link');

    const after = await listTree(h.vault);
    expect(after).toEqual(before);
  });
});
