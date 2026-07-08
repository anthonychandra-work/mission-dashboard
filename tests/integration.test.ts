/**
 * FEAT-DASH-009 -- end-to-end M2 gate (spec 3.2 / 3.6; VAL-101 e2e, VAL-103, INV-B).
 *
 * Boots the REAL `startServer` wiring (config -> store -> HTTP/SSE -> watcher, bound
 * on 127.0.0.1) against a temp copy of the fixture vault, and proves the pieces the
 * unit tests can't:
 *   - VAL-103 + INV-B: with the requested port occupied, the server scans to the
 *     next free port <= start+9, binds `127.0.0.1` ONLY, and prints EXACTLY
 *     `mission-dashboard listening on http://127.0.0.1:<port>` (the port actually
 *     bound); `bindWithScan` errors when every candidate is taken;
 *   - warm boot: `await store.rebuild()` runs before binding, so `/api/state` is a
 *     200 (never the cold 503) the instant the server is up;
 *   - the detail route is wired ahead of http.ts's `/api/*` 404 guard, and its
 *     traversal defense holds over the wire; and
 *   - VAL-101 (end-to-end): an atomic tmp+rename write burst drives the watcher ->
 *     store -> SSE path and connected clients receive EXACTLY ONE snapshot event
 *     with an incremented revision.
 *
 * Everything runs against mkdtemp temp copies, never the real vault (INV-A); the
 * macOS FSEvents drain-before-watch pattern (FEAT-DASH-007) is reused so the copy's
 * late events cannot leak a spurious rebuild.
 */
import { afterEach, describe, expect, it } from 'vitest';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { cp, mkdtemp, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import type { Snapshot } from '../shared/types.js';
import { bindWithScan, startServer, type RunningServer } from '../server/index.js';

const FIXTURE_VAULT = fileURLToPath(new URL('./fixtures/vault-basic', import.meta.url));
const NOW = new Date('2026-01-15T10:10:00Z');
const FSEVENTS_DRAIN_MS = 700;

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

const teardowns: Array<() => Promise<void> | void> = [];
afterEach(async () => {
  while (teardowns.length > 0) {
    const fn = teardowns.pop();
    if (fn) await fn();
  }
});

async function copyFixture(): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), 'mission-dashboard-int-'));
  teardowns.push(() => rm(root, { recursive: true, force: true }));
  const vault = path.join(root, 'vault-basic');
  await cp(FIXTURE_VAULT, vault, { recursive: true });
  return vault;
}

async function atomicWrite(file: string, content: string): Promise<void> {
  const tmp = path.join(path.dirname(file), `.tmp-${randomUUID()}`);
  await writeFile(tmp, content, 'utf8');
  await rename(tmp, file);
}

async function appendFeature(vault: string): Promise<void> {
  const file = path.join(vault, 'projects', 'alpha-app', 'missions', 'mission-one', 'features.json');
  const parsed = JSON.parse(await readFile(file, 'utf8')) as { features: unknown[] };
  parsed.features.push({
    id: 'FEAT-ONE-008',
    milestone: 'M1',
    title: 'Added',
    status: 'planned',
    ownerFiles: ['src/added.ts'],
    dependsOn: [],
  });
  await atomicWrite(file, JSON.stringify(parsed, null, 2));
}

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
      res.on('end', () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body }));
    });
    req.on('error', reject);
  });
}

async function waitFor(pred: () => boolean, timeoutMs: number): Promise<void> {
  const start = Date.now();
  while (!pred()) {
    if (Date.now() - start > timeoutMs) throw new Error('waitFor timed out');
    await sleep(20);
  }
}

/** An SSE client that accumulates parsed `snapshot` events off the raw stream. */
interface SseClient {
  snapshots: Snapshot[];
  close(): void;
}

function connectSse(port: number): Promise<SseClient> {
  return new Promise((resolve, reject) => {
    const snapshots: Snapshot[] = [];
    let buffer = '';
    const req = http.get({ host: '127.0.0.1', port, path: '/api/events' }, (res) => {
      res.setEncoding('utf8');
      res.on('data', (chunk: string) => {
        buffer += chunk;
        let idx: number;
        while ((idx = buffer.indexOf('\n\n')) !== -1) {
          const frame = buffer.slice(0, idx);
          buffer = buffer.slice(idx + 2);
          const lines = frame.split('\n');
          if (lines.some((l) => l.startsWith('event: snapshot'))) {
            const data = lines.find((l) => l.startsWith('data: '));
            if (data) snapshots.push(JSON.parse(data.slice('data: '.length)) as Snapshot);
          }
        }
      });
      resolve({ snapshots, close: () => req.destroy() });
    });
    req.on('error', reject);
  });
}

function track(running: RunningServer): RunningServer {
  teardowns.push(() => running.close());
  return running;
}

// -- VAL-103 + INV-B: port scan + localhost bind + exact stdout line ---------

describe('VAL-103 / INV-B -- port scan, 127.0.0.1 bind, exact stdout line', () => {
  it('scans past an occupied port and prints the actual bound port on 127.0.0.1', async () => {
    const vault = await copyFixture();

    // Occupy a start port on 127.0.0.1 to force the scan (equivalent to VAL-103's
    // "port 4646 occupied", but a dynamically-allocated port keeps the test off
    // machine-specific state / CI port contention).
    const blocker = http.createServer((_q, s) => s.end());
    await new Promise<void>((r) => blocker.listen(0, '127.0.0.1', r));
    teardowns.push(() => new Promise<void>((r) => blocker.close(() => r())));
    const occupied = (blocker.address() as AddressInfo).port;

    const lines: string[] = [];
    const running = track(
      await startServer({
        vaultPath: vault,
        port: occupied,
        now: () => NOW,
        heartbeatMs: 10_000,
        log: (line) => lines.push(line),
      }),
    );

    // Bound the NEXT free port within the scan window, never the occupied one.
    expect(running.port).toBeGreaterThan(occupied);
    expect(running.port).toBeLessThanOrEqual(occupied + 9);

    // INV-B: the bound address is 127.0.0.1 only.
    const addr = running.server.address() as AddressInfo;
    expect(addr.address).toBe('127.0.0.1');

    // Exactly one parseable line, matching the ACTUAL bound port (spec 3.2).
    expect(lines).toEqual([`mission-dashboard listening on http://127.0.0.1:${running.port}`]);
  });

  it('binds the requested port with no scan when it is free', async () => {
    const vault = await copyFixture();
    const lines: string[] = [];
    const running = track(
      await startServer({
        vaultPath: vault,
        port: 0, // ephemeral: guaranteed free, still prints the real bound port
        now: () => NOW,
        heartbeatMs: 10_000,
        log: (line) => lines.push(line),
      }),
    );
    expect(running.port).toBeGreaterThan(0);
    expect(lines).toEqual([`mission-dashboard listening on http://127.0.0.1:${running.port}`]);
  });

  it('bindWithScan errors when every candidate port is taken', async () => {
    const blocker = http.createServer((_q, s) => s.end());
    await new Promise<void>((r) => blocker.listen(0, '127.0.0.1', r));
    teardowns.push(() => new Promise<void>((r) => blocker.close(() => r())));
    const occupied = (blocker.address() as AddressInfo).port;

    const server = http.createServer((_q, s) => s.end());
    teardowns.push(() => new Promise<void>((r) => server.close(() => r())));
    // count = 1 -> only the occupied port is tried -> all candidates in use.
    await expect(bindWithScan(server, '127.0.0.1', occupied, 1)).rejects.toThrow(/in use/);
  });
});

// -- warm boot + detail route over the wire ---------------------------------

describe('boot order + detail route (spec 3.6)', () => {
  it('serves a warm /api/state (200, never the cold 503) immediately after boot', async () => {
    const vault = await copyFixture();
    const running = track(
      await startServer({ vaultPath: vault, port: 0, now: () => NOW, heartbeatMs: 10_000, log: () => {} }),
    );
    const res = await request(running.port, '/api/state');
    expect(res.status).toBe(200);
    expect(JSON.parse(res.body).revision).toBe(1);
  });

  it('routes GET /api/missions/:p/:m to the detail payload (ahead of the /api 404 guard)', async () => {
    const vault = await copyFixture();
    const running = track(
      await startServer({ vaultPath: vault, port: 0, now: () => NOW, heartbeatMs: 10_000, log: () => {} }),
    );
    const res = await request(running.port, '/api/missions/alpha-app/mission-one');
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toContain('application/json');
    const body = JSON.parse(res.body);
    expect(body.project).toBe('alpha-app');
    expect(body.note.body).toContain('Mission One');
    // Proves the detail route won over http.ts's `/api/*` JSON-404 guard.
    expect(body).not.toEqual({ error: 'not found' });
  });

  it('rejects an over-the-wire traversal attempt (encoded separator) with 400', async () => {
    const vault = await copyFixture();
    const running = track(
      await startServer({ vaultPath: vault, port: 0, now: () => NOW, heartbeatMs: 10_000, log: () => {} }),
    );
    const res = await request(running.port, '/api/missions/a%2fb/c');
    expect(res.status).toBe(400);
  });
});

// -- VAL-101 end-to-end: atomic burst -> exactly one SSE snapshot event ------

describe('VAL-101 (end-to-end) -- atomic burst -> one SSE snapshot event', () => {
  it('delivers exactly one snapshot event with an incremented revision per burst', async () => {
    const vault = await copyFixture();

    // Drain the fixture copy's late FSEvents BEFORE the watcher exists (startServer
    // creates it), so only the burst below can trigger a rebuild (FEAT-DASH-007).
    await sleep(FSEVENTS_DRAIN_MS);

    const running = track(
      await startServer({
        vaultPath: vault,
        port: 0,
        now: () => NOW,
        heartbeatMs: 10_000,
        log: () => {},
      }),
    );

    const client = await connectSse(running.port);
    teardowns.push(() => client.close());

    // Connect frame: the warm snapshot at revision 1.
    await waitFor(() => client.snapshots.length >= 1, 5000);
    expect(client.snapshots).toHaveLength(1);
    expect(client.snapshots[0]?.revision).toBe(1);

    // Commander-cycle-shaped burst: several watched files, atomic, near-simultaneous.
    const missionDir = path.join(vault, 'projects', 'alpha-app', 'missions', 'mission-one');
    await appendFeature(vault);
    await Promise.all([
      atomicWrite(path.join(missionDir, 'prompt-queue.md'), '# Prompt Queue\n\n## NEXT\n\nvalidate\n'),
      atomicWrite(path.join(vault, 'log.md'), '## [2026-01-15 12:00] cycle | burst\n'),
      atomicWrite(
        path.join(vault, 'inbox', '20260115-120000-alpha-app-mission-one-FEAT-ONE-003-validator.md'),
        '---\nreport: worker\n---\n',
      ),
    ]);

    // Wait out awaitWriteFinish + debounce + margin, then assert exactly ONE more.
    await waitFor(() => client.snapshots.length >= 2, 10_000);
    await sleep(500); // catch any (erroneous) additional broadcast

    expect(client.snapshots).toHaveLength(2);
    expect(client.snapshots[1]?.revision).toBe(2);
    expect(running.store.revision).toBe(2); // exactly one bump

    // The single rebuild did a full re-read: the appended feature is present.
    const appended = client.snapshots[1]?.projects
      .find((p) => p.slug === 'alpha-app')
      ?.missions.find((m) => m.slug === 'mission-one');
    expect(appended?.featureCounts?.total).toBe(8);
  }, 30_000);
});
