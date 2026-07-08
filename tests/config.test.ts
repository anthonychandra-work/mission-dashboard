/**
 * FEAT-DASH-001 — config resolution (spec §3.2).
 *
 * All tests run against temp dirs created under os.tmpdir(). The real vault and the
 * real ~/.claude/mission-control.json are NEVER read or written (INV-A): every call
 * injects `env` and `missionControlPath` explicitly.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import {
  resolveConfig,
  ConfigError,
  DEFAULT_PORT,
  DEFAULT_STALE_CLAIM_MINUTES,
  DEFAULT_DEBOUNCE_MS,
} from '../server/config.js';

let root: string;

/** Create a minimal valid vault under the test root and return its path. */
async function makeVault(name = 'vault', projects: unknown = {}): Promise<string> {
  const vault = path.join(root, name);
  await mkdir(path.join(vault, 'registry'), { recursive: true });
  await writeFile(
    path.join(vault, 'registry', 'projects.json'),
    JSON.stringify(projects, null, 2),
  );
  return vault;
}

/** Write a mission-control.json into the test root and return its path. */
async function makeMissionControl(content: unknown): Promise<string> {
  const p = path.join(root, 'mission-control.json');
  await writeFile(
    p,
    typeof content === 'string' ? content : JSON.stringify(content, null, 2),
  );
  return p;
}

/** A mission-control path that does not exist — the "unconfigured machine" case. */
function absentMissionControl(): string {
  return path.join(root, 'no-such-dir', 'mission-control.json');
}

beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), 'mission-dashboard-config-'));
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

describe('vault resolution order', () => {
  it('resolves the vault from the --vault flag (space form)', async () => {
    const vault = await makeVault();
    const config = await resolveConfig({
      argv: ['--vault', vault],
      env: {},
      missionControlPath: absentMissionControl(),
    });
    expect(config.vaultPath).toBe(vault);
  });

  it('resolves the vault from the --vault=<path> form', async () => {
    const vault = await makeVault();
    const config = await resolveConfig({
      argv: [`--vault=${vault}`],
      env: {},
      missionControlPath: absentMissionControl(),
    });
    expect(config.vaultPath).toBe(vault);
  });

  it('prefers the flag over env and mission-control.json', async () => {
    const flagVault = await makeVault('flag-vault');
    const envVault = await makeVault('env-vault');
    const mcVault = await makeVault('mc-vault');
    const mc = await makeMissionControl({ vault_path: mcVault });
    const config = await resolveConfig({
      argv: ['--vault', flagVault],
      env: { MISSION_DASHBOARD_VAULT: envVault },
      missionControlPath: mc,
    });
    expect(config.vaultPath).toBe(flagVault);
  });

  it('prefers MISSION_DASHBOARD_VAULT over mission-control.json', async () => {
    const envVault = await makeVault('env-vault');
    const mcVault = await makeVault('mc-vault');
    const mc = await makeMissionControl({ vault_path: mcVault });
    const config = await resolveConfig({
      argv: [],
      env: { MISSION_DASHBOARD_VAULT: envVault },
      missionControlPath: mc,
    });
    expect(config.vaultPath).toBe(envVault);
  });

  it('falls back to mission-control.json vault_path', async () => {
    const mcVault = await makeVault('mc-vault');
    const mc = await makeMissionControl({ vault_path: mcVault });
    const config = await resolveConfig({
      argv: [],
      env: {},
      missionControlPath: mc,
    });
    expect(config.vaultPath).toBe(mcVault);
  });

  it('returns an absolute vault path', async () => {
    const vault = await makeVault();
    const config = await resolveConfig({
      argv: ['--vault', vault],
      env: {},
      missionControlPath: absentMissionControl(),
    });
    expect(path.isAbsolute(config.vaultPath)).toBe(true);
  });
});

describe('fail-fast validation', () => {
  it('fails when no source yields a vault path', async () => {
    await expect(
      resolveConfig({ argv: [], env: {}, missionControlPath: absentMissionControl() }),
    ).rejects.toThrow(ConfigError);
  });

  it('fails when mission-control.json lacks vault_path', async () => {
    const mc = await makeMissionControl({ something_else: true });
    await expect(
      resolveConfig({ argv: [], env: {}, missionControlPath: mc }),
    ).rejects.toThrow(/vault_path/);
  });

  it('fails when mission-control.json is malformed JSON', async () => {
    const mc = await makeMissionControl('{ not json');
    await expect(
      resolveConfig({ argv: [], env: {}, missionControlPath: mc }),
    ).rejects.toThrow(ConfigError);
  });

  it('fails with the offending path when the vault dir does not exist', async () => {
    const missing = path.join(root, 'nope');
    await expect(
      resolveConfig({
        argv: ['--vault', missing],
        env: {},
        missionControlPath: absentMissionControl(),
      }),
    ).rejects.toThrow(missing);
  });

  it('fails when the vault path is a file, not a directory', async () => {
    const file = path.join(root, 'vault-file');
    await writeFile(file, 'not a dir');
    await expect(
      resolveConfig({
        argv: ['--vault', file],
        env: {},
        missionControlPath: absentMissionControl(),
      }),
    ).rejects.toThrow(ConfigError);
  });

  it('fails when registry/projects.json is missing', async () => {
    const vault = path.join(root, 'bare-vault');
    await mkdir(vault, { recursive: true });
    await expect(
      resolveConfig({
        argv: ['--vault', vault],
        env: {},
        missionControlPath: absentMissionControl(),
      }),
    ).rejects.toThrow(/registry\/projects\.json/);
  });

  it('accepts an empty projects map (idle vault is valid)', async () => {
    const vault = await makeVault('empty-vault', {});
    const config = await resolveConfig({
      argv: ['--vault', vault],
      env: {},
      missionControlPath: absentMissionControl(),
    });
    expect(config.vaultPath).toBe(vault);
  });

  it('fails when a flag is given without a value', async () => {
    await expect(
      resolveConfig({
        argv: ['--vault'],
        env: {},
        missionControlPath: absentMissionControl(),
      }),
    ).rejects.toThrow(ConfigError);
  });
});

describe('tunables', () => {
  async function base() {
    const vault = await makeVault();
    return {
      vault,
      opts: { env: {} as Record<string, string | undefined>, missionControlPath: absentMissionControl() },
    };
  }

  it('applies defaults: port 4646, staleClaimMinutes 45, debounceMs 300', async () => {
    const { vault, opts } = await base();
    const config = await resolveConfig({ ...opts, argv: ['--vault', vault] });
    expect(config.port).toBe(4646);
    expect(config.port).toBe(DEFAULT_PORT);
    expect(config.staleClaimMinutes).toBe(45);
    expect(config.staleClaimMinutes).toBe(DEFAULT_STALE_CLAIM_MINUTES);
    expect(config.debounceMs).toBe(300);
    expect(config.debounceMs).toBe(DEFAULT_DEBOUNCE_MS);
  });

  it('reads the port from MISSION_DASHBOARD_PORT', async () => {
    const { vault, opts } = await base();
    const config = await resolveConfig({
      ...opts,
      argv: ['--vault', vault],
      env: { MISSION_DASHBOARD_PORT: '5001' },
    });
    expect(config.port).toBe(5001);
  });

  it('prefers the --port flag over the env var', async () => {
    const { vault, opts } = await base();
    const config = await resolveConfig({
      ...opts,
      argv: ['--vault', vault, '--port', '5002'],
      env: { MISSION_DASHBOARD_PORT: '5001' },
    });
    expect(config.port).toBe(5002);
  });

  it.each(['abc', '0', '-1', '70000', '46.5'])(
    'rejects invalid port %j',
    async (bad) => {
      const { vault, opts } = await base();
      await expect(
        resolveConfig({ ...opts, argv: ['--vault', vault, '--port', bad] }),
      ).rejects.toThrow(ConfigError);
    },
  );

  it('reads staleClaimMinutes from --stale-minutes', async () => {
    const { vault, opts } = await base();
    const config = await resolveConfig({
      ...opts,
      argv: ['--vault', vault, '--stale-minutes', '90'],
    });
    expect(config.staleClaimMinutes).toBe(90);
  });

  it('reads staleClaimMinutes from MISSION_DASHBOARD_STALE_MINUTES', async () => {
    const { vault, opts } = await base();
    const config = await resolveConfig({
      ...opts,
      argv: ['--vault', vault],
      env: { MISSION_DASHBOARD_STALE_MINUTES: '10' },
    });
    expect(config.staleClaimMinutes).toBe(10);
  });

  it('prefers the --stale-minutes flag over the env var', async () => {
    const { vault, opts } = await base();
    const config = await resolveConfig({
      ...opts,
      argv: ['--vault', vault, '--stale-minutes', '15'],
      env: { MISSION_DASHBOARD_STALE_MINUTES: '10' },
    });
    expect(config.staleClaimMinutes).toBe(15);
  });

  it.each(['abc', '0', '-5'])(
    'rejects invalid stale-minutes %j',
    async (bad) => {
      const { vault, opts } = await base();
      await expect(
        resolveConfig({ ...opts, argv: ['--vault', vault, '--stale-minutes', bad] }),
      ).rejects.toThrow(ConfigError);
    },
  );
});
