/**
 * FEAT-DASH-008 -- SSE hub (spec 3.6; VAL-102 SSE half).
 *
 * Two layers:
 *   - unit tests drive {@link SseHub} with FAKE response objects (the hub types
 *     the response structurally, so no HTTP server is needed) to prove: the
 *     connect frame carries the FULL snapshot, headers are set, a null cache
 *     sends no connect frame, close drops the client, broadcast fans out, and
 *     the `: ping` heartbeat fires on the INJECTED interval; and
 *   - one integration test opens a REAL raw SSE stream over a bound express app
 *     and asserts the connect snapshot, a broadcast-on-rebuild frame with an
 *     incremented revision, and a `: ping` comment on a short injected interval.
 *
 * VAL-102 also requires the 25 s default to be asserted -- see the first test.
 * No watcher is involved here (broadcast is driven directly by
 * `hub.broadcast(await store.rebuild())`), so the FSEvents drain-before-watch
 * pattern does not apply. Everything runs over a temp copy of the fixture vault
 * or in memory (INV-A).
 */
import { afterEach, describe, expect, it } from 'vitest';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { cp, rm, mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import type { Snapshot } from '../shared/types.js';
import {
  createSseHub,
  DEFAULT_HEARTBEAT_MS,
  SseHub,
  type SseRequest,
  type SseResponse,
} from '../server/sse.js';
import { createHttpApp } from '../server/http.js';
import { createStore } from '../server/store.js';

const FIXTURE_VAULT = fileURLToPath(new URL('./fixtures/vault-basic', import.meta.url));
const NOW = new Date('2026-01-15T10:10:00Z');
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

// -- a fake SSE response/request that captures writes and the close listener --

interface FakeClient {
  res: SseResponse;
  req: SseRequest;
  writes: string[];
  headers: Record<string, string>;
  flushed: boolean;
  ended: boolean;
  fireClose: () => void;
}

function fakeClient(): FakeClient {
  const writes: string[] = [];
  const headers: Record<string, string> = {};
  const closeListeners: Array<() => void> = [];
  const state = { flushed: false, ended: false };
  const res: SseResponse = {
    statusCode: 0,
    setHeader(name, value) {
      headers[name.toLowerCase()] = value;
      return undefined;
    },
    flushHeaders() {
      state.flushed = true;
    },
    write(chunk) {
      writes.push(chunk);
      return true;
    },
    end() {
      state.ended = true;
    },
    on(_event, listener) {
      closeListeners.push(listener);
      return undefined;
    },
  };
  const req: SseRequest = {
    on(_event, listener) {
      closeListeners.push(listener);
      return undefined;
    },
  };
  return {
    res,
    req,
    writes,
    headers,
    get flushed() {
      return state.flushed;
    },
    get ended() {
      return state.ended;
    },
    fireClose: () => closeListeners.forEach((l) => l()),
  };
}

function snap(revision: number): Snapshot {
  return {
    revision,
    generatedAt: '2026-01-15T10:10:00.000Z',
    vaultPath: '/tmp/vault',
    warnings: [],
    projects: [],
    attention: [],
    activity: [],
    inbox: { unprocessedCount: 0, failedCount: 0, unprocessed: [] },
  };
}

// track hubs/servers/requests to tear down so a lingering socket never hangs
const cleanups: Array<() => void | Promise<void>> = [];
afterEach(async () => {
  while (cleanups.length > 0) {
    const fn = cleanups.pop();
    if (fn) await fn();
  }
});

describe('SseHub -- heartbeat default (VAL-102)', () => {
  it('defaults the heartbeat to exactly 25 s', () => {
    expect(DEFAULT_HEARTBEAT_MS).toBe(25_000);
  });
});

describe('SseHub -- connect frame', () => {
  it('sets SSE headers, flushes, and sends the full snapshot on connect', () => {
    const hub = createSseHub({ heartbeatMs: 10_000 });
    cleanups.push(() => hub.close());
    const c = fakeClient();

    hub.addClient(c.req, c.res, snap(7));

    expect(c.res.statusCode).toBe(200);
    expect(c.headers['content-type']).toContain('text/event-stream');
    expect(c.headers['cache-control']).toContain('no-cache');
    expect(c.flushed).toBe(true);
    expect(hub.clientCount).toBe(1);

    expect(c.writes).toHaveLength(1);
    const frame = c.writes[0]!;
    expect(frame.startsWith('event: snapshot\ndata: ')).toBe(true);
    expect(frame.endsWith('\n\n')).toBe(true);
    const dataLine = frame.slice('event: snapshot\ndata: '.length, -2);
    expect(JSON.parse(dataLine)).toEqual(snap(7)); // FULL snapshot, one line
  });

  it('sends NO connect frame when the cache is still null (pre-first-rebuild)', () => {
    const hub = createSseHub({ heartbeatMs: 10_000 });
    cleanups.push(() => hub.close());
    const c = fakeClient();

    hub.addClient(c.req, c.res, null);

    expect(c.res.statusCode).toBe(200); // still connects
    expect(c.writes).toHaveLength(0); // but no snapshot yet
    expect(hub.clientCount).toBe(1);
  });

  it('drops the client when the connection closes', () => {
    const hub = createSseHub({ heartbeatMs: 10_000 });
    cleanups.push(() => hub.close());
    const c = fakeClient();
    hub.addClient(c.req, c.res, snap(1));
    expect(hub.clientCount).toBe(1);

    c.fireClose();
    expect(hub.clientCount).toBe(0);
  });
});

describe('SseHub -- broadcast', () => {
  it('fans one snapshot frame out to every connected client', () => {
    const hub = createSseHub({ heartbeatMs: 10_000 });
    cleanups.push(() => hub.close());
    const a = fakeClient();
    const b = fakeClient();
    hub.addClient(a.req, a.res, null);
    hub.addClient(b.req, b.res, null);

    hub.broadcast(snap(2));

    for (const c of [a, b]) {
      expect(c.writes).toHaveLength(1);
      const dataLine = c.writes[0]!.slice('event: snapshot\ndata: '.length, -2);
      expect(JSON.parse(dataLine).revision).toBe(2);
    }
  });

  it('is a no-op after close(), and close() ends every client', () => {
    const hub = createSseHub({ heartbeatMs: 10_000 });
    const c = fakeClient();
    hub.addClient(c.req, c.res, null);
    hub.close();
    expect(c.ended).toBe(true);
    expect(hub.clientCount).toBe(0);

    hub.broadcast(snap(9)); // must not throw or write
    expect(c.writes).toHaveLength(0);
  });
});

describe('SseHub -- heartbeat on the injected interval', () => {
  it('writes a ": ping" comment to clients on the injected cadence', async () => {
    const hub = createSseHub({ heartbeatMs: 30 });
    cleanups.push(() => hub.close());
    const c = fakeClient();
    hub.addClient(c.req, c.res, null); // no connect frame -> writes start empty

    await sleep(120); // several 30 ms ticks
    const pings = c.writes.filter((w) => w === ': ping\n\n');
    expect(pings.length).toBeGreaterThanOrEqual(1);
  });
});

// -- integration: a real raw SSE stream over a bound express app --

interface SseConn {
  buffer: () => string;
  frames: () => string[];
  waitFor: (predicate: (buf: string) => boolean, timeoutMs?: number) => Promise<void>;
  close: () => void;
}

function openSse(port: number, urlPath: string): SseConn {
  let buffer = '';
  const req = http.get({ host: '127.0.0.1', port, path: urlPath }, (res) => {
    res.setEncoding('utf8');
    res.on('data', (chunk: string) => {
      buffer += chunk;
    });
  });
  req.on('error', () => {
    /* torn down in close() */
  });
  const conn: SseConn = {
    buffer: () => buffer,
    frames: () => buffer.split('\n\n').filter((f) => f.length > 0),
    async waitFor(predicate, timeoutMs = 2000) {
      const start = Date.now();
      while (!predicate(buffer)) {
        if (Date.now() - start > timeoutMs) {
          throw new Error(`SSE waitFor timed out; buffer so far:\n${buffer}`);
        }
        await sleep(15);
      }
    },
    close: () => req.destroy(),
  };
  return conn;
}

async function listen(server: http.Server): Promise<number> {
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  return (server.address() as AddressInfo).port;
}

describe('GET /api/events -- real SSE stream (VAL-102 SSE half)', () => {
  it('sends the connect snapshot, a broadcast-on-rebuild frame, and a ": ping" heartbeat', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'mission-dashboard-sse-'));
    const vault = path.join(root, 'vault-basic');
    await cp(FIXTURE_VAULT, vault, { recursive: true });
    cleanups.push(() => rm(root, { recursive: true, force: true }));

    const store = createStore({ vaultPath: vault, now: () => NOW });
    await store.rebuild(); // revision 1 -- the boot snapshot index.ts guarantees
    const hub = new SseHub({ heartbeatMs: 40 }); // short heartbeat for the test
    cleanups.push(() => hub.close());

    const app = createHttpApp({ store, sse: hub });
    const server = http.createServer(app);
    cleanups.push(() => new Promise<void>((r) => server.close(() => r())));
    const port = await listen(server);

    const conn = openSse(port, '/api/events');
    cleanups.push(() => conn.close());

    // 1) connect frame: the FULL current snapshot (revision 1)
    await conn.waitFor((b) => b.includes('event: snapshot'));
    const firstData = conn.buffer().split('data: ')[1]!.split('\n\n')[0]!;
    expect(JSON.parse(firstData).revision).toBe(1);
    expect(hub.clientCount).toBe(1);

    // 2) broadcast-on-rebuild: a second snapshot frame with revision 2
    hub.broadcast(await store.rebuild());
    await conn.waitFor((b) => (b.match(/event: snapshot/g) ?? []).length >= 2);
    const dataFrames = conn.buffer().split('event: snapshot').slice(1);
    const secondData = dataFrames[1]!.split('data: ')[1]!.split('\n\n')[0]!;
    expect(JSON.parse(secondData).revision).toBe(2);

    // 3) heartbeat: a ": ping" comment on the injected 40 ms cadence
    await conn.waitFor((b) => b.includes(': ping'));
  });
});
