/**
 * e2e harness (FEAT-DASH-014) — boot the BUILT server against a throwaway vault.
 *
 * Every test gets a `boot(variant)` fixture that:
 *   1. materialises a TEMP vault (a copy of `tests/fixtures/vault-basic`, or an
 *      empty/malformed variant) under the OS temp dir — NEVER the real vault (INV-A),
 *   2. spawns `node dist/server/index.js --vault <temp> --port <free>` (the exact
 *      production entry, binding 127.0.0.1 only — INV-B),
 *   3. parses the one `mission-dashboard listening on http://127.0.0.1:<port>` line
 *      to discover the actually-bound URL, and
 *   4. tears the server + temp dir down when the test ends.
 *
 * The fixture returns a `boot` function (not a single server) so a test may spin up
 * more than one dashboard; all of them are cleaned up on teardown.
 */
import { test as base, expect } from '@playwright/test';
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { cp, mkdir, mkdtemp, readFile, rename, rm, writeFile } from 'node:fs/promises';
import net from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';

const repoRoot = fileURLToPath(new URL('..', import.meta.url));
const FIXTURE_VAULT = path.join(repoRoot, 'tests', 'fixtures', 'vault-basic');
const SERVER_ENTRY = path.join(repoRoot, 'dist', 'server', 'index.js');

/** Which vault a test wants booted. */
export type VaultVariant =
  | 'fixture' // faithful copy of tests/fixtures/vault-basic (2 projects, live claim)
  | 'empty' // valid but idle: registry/projects.json with an empty projects map
  | 'malformed'; // fixture copy with a CORRUPT features.json -> parse_warning

/** A booted dashboard: where to point the browser, and where its vault lives on disk. */
export interface Dashboard {
  /** e.g. http://127.0.0.1:53187 — the actually-bound origin. */
  baseURL: string;
  /** Absolute path of this dashboard's throwaway vault copy. */
  vaultPath: string;
}

/** Locate a mission's features.json inside a booted vault (for live-edit tests). */
export function featuresPath(vaultPath: string, project = 'alpha-app', mission = 'mission-one'): string {
  return path.join(vaultPath, 'projects', project, 'missions', mission, 'features.json');
}

/** Atomic tmp+rename write — mirrors how the commander writes vault JSON (SCHEMA §4). */
export async function atomicWrite(file: string, content: string): Promise<void> {
  const tmp = path.join(path.dirname(file), `.tmp-${randomUUID()}`);
  await writeFile(tmp, content, 'utf8');
  await rename(tmp, file);
}

/** Flip one feature's status in a booted vault's features.json (atomic on-disk edit). */
export async function setFeatureStatus(
  vaultPath: string,
  featureId: string,
  status: string,
): Promise<void> {
  const file = featuresPath(vaultPath);
  const parsed = JSON.parse(await readFile(file, 'utf8')) as {
    features: Array<{ id: string; status: string }>;
  };
  const feature = parsed.features.find((f) => f.id === featureId);
  if (!feature) throw new Error(`feature ${featureId} not found in ${file}`);
  feature.status = status;
  await atomicWrite(file, JSON.stringify(parsed, null, 2));
}

/** Discover a free TCP port on 127.0.0.1 (the server's scan absorbs any race). */
function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.once('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const address = srv.address();
      const port = typeof address === 'object' && address ? address.port : 0;
      srv.close(() => resolve(port));
    });
  });
}

/** Materialise a throwaway vault of the requested variant; returns [vaultPath, rootToRemove]. */
async function makeVault(variant: VaultVariant): Promise<[string, string]> {
  const root = await mkdtemp(path.join(tmpdir(), 'mission-dashboard-e2e-'));
  const vault = path.join(root, 'vault');

  if (variant === 'empty') {
    await mkdir(path.join(vault, 'registry'), { recursive: true });
    await writeFile(
      path.join(vault, 'registry', 'projects.json'),
      JSON.stringify({ schema_version: 1, projects: {} }, null, 2),
      'utf8',
    );
    return [vault, root];
  }

  await cp(FIXTURE_VAULT, vault, { recursive: true });

  if (variant === 'malformed') {
    // Corrupt one features.json: the aggregator keeps serving (registry is fine),
    // renders the mission with zeroed counts, and raises a parse_warning (spec §3.3).
    await writeFile(featuresPath(vault), '{ "features": [ this is not valid json ,,, ', 'utf8');
  }

  return [vault, root];
}

/** Spawn the built server against `vaultPath`; resolve with the bound origin. */
function spawnServer(vaultPath: string, port: number): Promise<{ proc: ChildProcessWithoutNullStreams; baseURL: string }> {
  const proc = spawn(process.execPath, [SERVER_ENTRY, '--vault', vaultPath, '--port', String(port)], {
    cwd: repoRoot,
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  return new Promise((resolve, reject) => {
    let out = '';
    const timer = setTimeout(() => {
      proc.kill('SIGKILL');
      reject(new Error(`server did not print its listening line in time. Output so far:\n${out}`));
    }, 20_000);

    const onStdout = (chunk: Buffer): void => {
      out += chunk.toString();
      const match = out.match(/listening on (http:\/\/127\.0\.0\.1:\d+)/);
      if (match) {
        clearTimeout(timer);
        proc.stdout.off('data', onStdout);
        resolve({ proc, baseURL: match[1]! });
      }
    };
    proc.stdout.on('data', onStdout);
    proc.stderr.on('data', (chunk: Buffer) => {
      out += chunk.toString();
    });
    proc.once('exit', (code) => {
      clearTimeout(timer);
      reject(new Error(`server exited early (code ${code}) before listening. Output:\n${out}`));
    });
    proc.once('error', (err) => {
      clearTimeout(timer);
      reject(err);
    });
  });
}

/** SIGTERM the server (graceful close), SIGKILL as a fallback, then remove the temp tree. */
async function stopServer(proc: ChildProcessWithoutNullStreams, root: string): Promise<void> {
  if (proc.exitCode === null && proc.signalCode === null) {
    await new Promise<void>((resolve) => {
      const kill = setTimeout(() => {
        try {
          proc.kill('SIGKILL');
        } catch {
          /* already gone */
        }
        resolve();
      }, 4_000);
      proc.once('exit', () => {
        clearTimeout(kill);
        resolve();
      });
      proc.kill('SIGTERM');
    });
  }
  await rm(root, { recursive: true, force: true });
}

interface HarnessFixtures {
  boot: (variant: VaultVariant) => Promise<Dashboard>;
}

export const test = base.extend<HarnessFixtures>({
  boot: async ({}, use) => {
    const cleanups: Array<() => Promise<void>> = [];

    const boot = async (variant: VaultVariant): Promise<Dashboard> => {
      const [vaultPath, root] = await makeVault(variant);
      let port: number;
      try {
        port = await freePort();
        const { proc, baseURL } = await spawnServer(vaultPath, port);
        cleanups.push(() => stopServer(proc, root));
        return { baseURL, vaultPath };
      } catch (err) {
        await rm(root, { recursive: true, force: true });
        throw err;
      }
    };

    await use(boot);

    // Tear down every booted server (reverse order) after the test finishes.
    for (const cleanup of cleanups.reverse()) {
      await cleanup();
    }
  },
});

export { expect };
