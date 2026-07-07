/**
 * Vault resolution + tunables (spec §3.2).
 *
 * Resolution order for the vault path:
 *   1. `--vault <path>` flag
 *   2. `MISSION_DASHBOARD_VAULT` env var
 *   3. `~/.claude/mission-control.json` → `vault_path`
 *
 * Fails fast with a clear message if the vault dir or `registry/projects.json` is
 * missing. An *empty* projects map is valid (idle state). All file access goes
 * through `node:fs/promises` with absolute paths — never through a shell.
 *
 * This module only READS configuration; it never writes anywhere (INV-A).
 */
import { readFile, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import path from 'node:path';

export const DEFAULT_PORT = 4646;
export const DEFAULT_STALE_CLAIM_MINUTES = 45;
export const DEFAULT_DEBOUNCE_MS = 300;

/** Resolved runtime configuration consumed by the rest of the server. */
export interface DashboardConfig {
  /** Absolute path of the vault under observation. */
  vaultPath: string;
  /** Claims older than this many minutes count as stale (spec §3.4). */
  staleClaimMinutes: number;
  /** Trailing debounce applied to watcher bursts (spec §3.3). */
  debounceMs: number;
  /** Preferred listen port; EADDRINUSE scanning is the server's job (spec §3.2). */
  port: number;
}

/** A fatal, user-facing configuration problem — print the message and exit. */
export class ConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ConfigError';
  }
}

/** Injection points so tests never touch real process state or the real home dir. */
export interface ResolveConfigOptions {
  /** CLI arguments (defaults to `process.argv.slice(2)`). */
  argv?: string[];
  /** Environment (defaults to `process.env`). */
  env?: Record<string, string | undefined>;
  /** Path to mission-control.json (defaults to `~/.claude/mission-control.json`). */
  missionControlPath?: string;
}

/** The subset of CLI flags this module understands; unknown flags are ignored. */
interface ParsedFlags {
  vault?: string;
  port?: string;
  staleMinutes?: string;
}

const FLAG_NAMES: Record<string, keyof ParsedFlags> = {
  '--vault': 'vault',
  '--port': 'port',
  '--stale-minutes': 'staleMinutes',
};

/** Parse `--flag value` and `--flag=value` forms; a flag without a value is fatal. */
function parseFlags(argv: string[]): ParsedFlags {
  const flags: ParsedFlags = {};
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === undefined) continue;
    const eq = arg.indexOf('=');
    const name = eq === -1 ? arg : arg.slice(0, eq);
    const key = FLAG_NAMES[name];
    if (key === undefined) continue;
    if (eq !== -1) {
      flags[key] = arg.slice(eq + 1);
      continue;
    }
    const value = argv[i + 1];
    if (value === undefined || value.startsWith('--')) {
      throw new ConfigError(`Missing value for ${name}`);
    }
    flags[key] = value;
    i++;
  }
  return flags;
}

/** Read `vault_path` from mission-control.json; null if the file does not exist. */
async function vaultFromMissionControl(missionControlPath: string): Promise<string | null> {
  let raw: string;
  try {
    raw = await readFile(missionControlPath, 'utf8');
  } catch {
    return null;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    throw new ConfigError(
      `Could not parse ${missionControlPath}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  const vaultPath = (parsed as { vault_path?: unknown }).vault_path;
  if (typeof vaultPath !== 'string' || vaultPath.length === 0) {
    throw new ConfigError(
      `${missionControlPath} has no usable "vault_path" — set it, or pass --vault / MISSION_DASHBOARD_VAULT`,
    );
  }
  return vaultPath;
}

/** Parse a positive integer in [min, max]; anything else is a fatal config error. */
function parseIntStrict(value: string, what: string, min: number, max: number): number {
  const n = Number(value);
  if (!Number.isInteger(n) || n < min || n > max) {
    throw new ConfigError(`Invalid ${what} "${value}" — expected an integer between ${min} and ${max}`);
  }
  return n;
}

/** Assert `p` is an existing directory. */
async function assertDirectory(p: string, what: string): Promise<void> {
  try {
    const s = await stat(p);
    if (!s.isDirectory()) {
      throw new ConfigError(`${what} is not a directory: ${p}`);
    }
  } catch (error) {
    if (error instanceof ConfigError) throw error;
    throw new ConfigError(`${what} does not exist: ${p}`);
  }
}

/** Assert `p` is an existing file. */
async function assertFile(p: string, what: string): Promise<void> {
  try {
    const s = await stat(p);
    if (!s.isFile()) {
      throw new ConfigError(`${what} is not a file: ${p}`);
    }
  } catch (error) {
    if (error instanceof ConfigError) throw error;
    throw new ConfigError(`${what} not found: ${p}`);
  }
}

/**
 * Resolve and validate the full runtime configuration.
 * Throws {@link ConfigError} on any unrecoverable problem (fail fast, spec §3.2).
 */
export async function resolveConfig(options: ResolveConfigOptions = {}): Promise<DashboardConfig> {
  const argv = options.argv ?? process.argv.slice(2);
  const env = options.env ?? process.env;
  const missionControlPath =
    options.missionControlPath ?? path.join(homedir(), '.claude', 'mission-control.json');

  const flags = parseFlags(argv);

  const rawVault =
    flags.vault ??
    env['MISSION_DASHBOARD_VAULT'] ??
    (await vaultFromMissionControl(missionControlPath));
  if (rawVault === null || rawVault === undefined || rawVault.length === 0) {
    throw new ConfigError(
      'No vault configured — pass --vault <path>, set MISSION_DASHBOARD_VAULT, ' +
        `or set "vault_path" in ${missionControlPath}`,
    );
  }

  const vaultPath = path.resolve(rawVault);
  await assertDirectory(vaultPath, 'Vault directory');
  await assertFile(
    path.join(vaultPath, 'registry', 'projects.json'),
    `Vault registry (registry/projects.json) in ${vaultPath}`,
  );
  // NOTE: an empty projects map is valid (idle vault); content parsing is the
  // aggregator's job, guarded by safeRead — existence is all config checks.

  const rawPort = flags.port ?? env['MISSION_DASHBOARD_PORT'];
  const port = rawPort === undefined ? DEFAULT_PORT : parseIntStrict(rawPort, 'port', 1, 65535);

  const rawStale = flags.staleMinutes ?? env['MISSION_DASHBOARD_STALE_MINUTES'];
  const staleClaimMinutes =
    rawStale === undefined
      ? DEFAULT_STALE_CLAIM_MINUTES
      : parseIntStrict(rawStale, 'stale-minutes', 1, Number.MAX_SAFE_INTEGER);

  return {
    vaultPath,
    staleClaimMinutes,
    debounceMs: DEFAULT_DEBOUNCE_MS,
    port,
  };
}
