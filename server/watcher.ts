/**
 * Vault watcher -- chokidar over the spec 3.3 watched set, debounced to one
 * `vault-changed` event per burst (spec 3.3).
 *
 * -- Why a filter function, not globs --
 * The spec phrases the watched set as globs, but chokidar v4+ (v5 is installed)
 * DROPPED glob support entirely: `watch()` takes real paths only. The documented
 * migration is to watch a directory and pass an `ignored` predicate. So we watch
 * the vault ROOT and let {@link isWatchedOrAncestorPath} both (a) keep exactly
 * the directories that can contain a watched file -- pruning `.git`, `.obsidian`,
 * per-project `wiki/`, `inbox/.processed/`, `inbox/.failed/`, evidence dirs, etc.
 * so we never traverse the whole vault -- and (b) surface events only for the
 * exact watched files ({@link isWatchedRelativePath}).
 *
 * Watched files (relative to the vault, spec 3.3 -- globs written with <...>
 * placeholders so this block comment does not close on a literal star-slash):
 *   - registry/<name>.json
 *   - projects/<p>/missions/<m>/features.json
 *   - projects/<p>/missions/<m>/prompt-queue.md
 *   - inbox/<name>.md          (top level only; `.processed/` and `.failed/` are
 *                              COUNTED during rebuild, never watched)
 *   - log.md
 *   - projects/<p>/log.md
 *
 * -- Burst tolerance --
 *   - `awaitWriteFinish { stabilityThreshold: 200, pollInterval: 50 }` waits for
 *     a file to stop changing before emitting, which also absorbs the add/unlink
 *     pair a tmp+rename atomic write produces; and
 *   - a 300 ms TRAILING debounce collapses a commander cycle's burst (registry +
 *     features + log + inbox landing within a second) into a single rebuild.
 * Together they satisfy VAL-101: an atomic tmp+rename write burst yields exactly
 * one `vault-changed`.
 *
 * The watcher decides only WHEN to rebuild; the store decides HOW (a full
 * re-read). This module never writes anywhere (INV-A).
 */
import { EventEmitter } from 'node:events';
import path from 'node:path';

import { watch, type FSWatcher } from 'chokidar';

/** Spec 3.3 trailing debounce. */
export const DEFAULT_DEBOUNCE_MS = 300;

/** Spec 3.3 awaitWriteFinish tuning (also absorbs atomic add/unlink pairs). */
export const DEFAULT_AWAIT_WRITE_FINISH = {
  stabilityThreshold: 200,
  pollInterval: 50,
} as const;

/** The single event this watcher emits per settled burst. */
export const VAULT_CHANGED_EVENT = 'vault-changed';

/** Split a relative path into clean segments (tolerant of `/`, `\`, `./`). */
function toSegments(rel: string): string[] {
  return rel.split(/[\\/]+/).filter((s) => s.length > 0 && s !== '.');
}

/**
 * True iff `rel` (a vault-relative path) is one of the exact watched files
 * (spec 3.3). Pure and exported for direct testing.
 */
export function isWatchedRelativePath(rel: string): boolean {
  const seg = toSegments(rel);
  switch (seg.length) {
    case 1:
      return seg[0] === 'log.md';
    case 2:
      if (seg[0] === 'registry') return seg[1]?.endsWith('.json') === true;
      if (seg[0] === 'inbox') return seg[1]?.endsWith('.md') === true;
      return false;
    case 3:
      return seg[0] === 'projects' && seg[2] === 'log.md';
    case 5:
      return (
        seg[0] === 'projects' &&
        seg[2] === 'missions' &&
        (seg[4] === 'features.json' || seg[4] === 'prompt-queue.md')
      );
    default:
      return false;
  }
}

/**
 * True iff `rel` is a watched file OR a directory that can contain one -- i.e.
 * chokidar should NOT ignore it. Any other path is pruned, so the watcher never
 * descends into `.git`, `.obsidian`, wiki trees, `inbox/.processed/`, evidence
 * dirs, or the mission-note markdown. Pure and exported for direct testing.
 */
export function isWatchedOrAncestorPath(rel: string): boolean {
  const seg = toSegments(rel);
  if (seg.length === 0) return true; // the vault root itself
  if (isWatchedRelativePath(rel)) return true;
  switch (seg.length) {
    case 1: // registry/ , inbox/ , projects/
      return seg[0] === 'registry' || seg[0] === 'inbox' || seg[0] === 'projects';
    case 2: // projects/<p>/
      return seg[0] === 'projects';
    case 3: // projects/<p>/missions/
      return seg[0] === 'projects' && seg[2] === 'missions';
    case 4: // projects/<p>/missions/<m>/
      return seg[0] === 'projects' && seg[2] === 'missions';
    default:
      return false;
  }
}

export interface VaultWatcherOptions {
  /** Absolute path of the vault to observe. */
  vaultPath: string;
  /** Trailing debounce in ms; default {@link DEFAULT_DEBOUNCE_MS} (300). */
  debounceMs?: number;
  /** awaitWriteFinish tuning; default {@link DEFAULT_AWAIT_WRITE_FINISH}. */
  awaitWriteFinish?: { stabilityThreshold: number; pollInterval: number };
}

/**
 * Watches the vault and emits a single {@link VAULT_CHANGED_EVENT} per settled
 * burst of changes to watched files. Also emits `ready` once the initial scan
 * completes and (only if a listener is attached) `error` on watcher failures.
 *
 * `ready` is exposed as a promise so callers can await a fully-established
 * watcher before driving writes.
 */
export class VaultWatcher extends EventEmitter {
  private readonly vaultPath: string;
  private readonly debounceMs: number;
  private readonly fsw: FSWatcher;
  private timer: ReturnType<typeof setTimeout> | null = null;

  /** Resolves once chokidar's initial scan has completed. */
  readonly ready: Promise<void>;

  constructor(options: VaultWatcherOptions) {
    super();
    this.vaultPath = path.resolve(options.vaultPath);
    this.debounceMs = options.debounceMs ?? DEFAULT_DEBOUNCE_MS;
    const awf = options.awaitWriteFinish ?? DEFAULT_AWAIT_WRITE_FINISH;

    let resolveReady!: () => void;
    this.ready = new Promise<void>((resolve) => {
      resolveReady = resolve;
    });

    this.fsw = watch(this.vaultPath, {
      ignored: (p: string) => !isWatchedOrAncestorPath(path.relative(this.vaultPath, p)),
      ignoreInitial: true, // the store does the first rebuild explicitly
      persistent: true,
      atomic: true, // coalesce editor/tmp-rename atomic writes
      awaitWriteFinish: {
        stabilityThreshold: awf.stabilityThreshold,
        pollInterval: awf.pollInterval,
      },
    });

    // Only file add/change/unlink of watched files should schedule a rebuild.
    this.fsw.on('add', (p) => this.onFsEvent(p));
    this.fsw.on('change', (p) => this.onFsEvent(p));
    this.fsw.on('unlink', (p) => this.onFsEvent(p));
    this.fsw.on('ready', () => {
      this.emit('ready');
      resolveReady();
    });
    // EventEmitter throws on an unheard 'error'; a read-only observer's watch
    // errors are non-fatal (safeRead handles read failures on rebuild), so only
    // forward when someone is listening.
    this.fsw.on('error', (err) => {
      if (this.listenerCount('error') > 0) this.emit('error', err);
    });
  }

  private onFsEvent(p: string): void {
    // Belt-and-suspenders: `ignored` already filters, but guard again so a
    // directory or stray path can never schedule a rebuild.
    if (!isWatchedRelativePath(path.relative(this.vaultPath, p))) return;
    this.schedule();
  }

  /** (Re)arm the trailing debounce; the burst emits once it goes quiet. */
  private schedule(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => {
      this.timer = null;
      this.emit(VAULT_CHANGED_EVENT);
    }, this.debounceMs);
  }

  /** Stop watching and cancel any pending debounce. Idempotent-safe. */
  async close(): Promise<void> {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    await this.fsw.close();
  }
}

/** Factory mirroring the injectable style of the rest of the server. */
export function createVaultWatcher(options: VaultWatcherOptions): VaultWatcher {
  return new VaultWatcher(options);
}
