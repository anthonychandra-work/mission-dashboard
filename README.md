# mission-dashboard

Live, **read-only** web dashboard for the Mission Control workflow. One local Node
process watches the Obsidian vault (registries, `features.json`, `inbox/`, `log.md`
files) and pushes a normalized snapshot to a Vite/React frontend over Server-Sent
Events — running commanders, worker claims, feature progress, the queue, attention
items, and recent activity, all updating live with no polling and no database.

- **Read-only over the vault.** The server never writes any vault file. It is safe to
  run against a live vault while the workflow itself is writing.
- **Localhost only.** It binds `127.0.0.1` and nothing else — see [Security model](#security-model).
- **No new state.** No database, no schema changes; it only reads existing vault files.

## Requirements

- **Node ≥ 20** (developed and verified on Node 22).
- A Mission Control vault: a directory containing `registry/projects.json` (an empty
  projects map is a valid, idle vault). Resolution order is described in
  [Configuration](#configuration).

## Quickstart

```sh
npm ci            # install exact locked deps (or: npm install)
npm run build     # vite build → dist/client ; tsc -p tsconfig.server.json → dist/server
npm start         # node dist/server/index.js
```

On success the process prints exactly one parseable line, then serves the dashboard:

```
mission-dashboard listening on http://127.0.0.1:4646
```

Open that URL in a browser. `npm start` with no arguments resolves the vault from
`~/.claude/mission-control.json`; point it elsewhere with `--vault` or the env var:

```sh
npm start -- --vault /path/to/vault
# or
MISSION_DASHBOARD_VAULT=/path/to/vault npm start
```

## Configuration

### Vault resolution (first match wins)

1. `--vault <path>` flag
2. `MISSION_DASHBOARD_VAULT` environment variable
3. `vault_path` in `~/.claude/mission-control.json`

The server **fails fast** with a clear message if no vault is configured, or if the
resolved vault directory or its `registry/projects.json` is missing. An *empty*
projects map is valid (the dashboard renders the idle state).

### Flags and environment variables

| Flag | Env var | Default | Meaning |
|---|---|---|---|
| `--vault <path>` | `MISSION_DASHBOARD_VAULT` | from `mission-control.json` | Vault directory to watch. |
| `--port <n>` | `MISSION_DASHBOARD_PORT` | `4646` | Preferred listen port (scanned on conflict — see below). |
| `--stale-minutes <n>` | `MISSION_DASHBOARD_STALE_MINUTES` | `45` | A worker `claim` older than this, with no matching inbox report, is flagged as a possibly-dead worker. |

Flags accept both `--flag value` and `--flag=value`. A flag supplied without a value
is a fatal configuration error. When both a flag and its env var are set, the flag
wins. All file access uses absolute paths through `node:fs/promises` — never a shell —
so vault paths containing spaces are fine.

Example — a fully explicit invocation:

```sh
npm start -- --vault "/Users/me/Documents/vault" --port 4646 --stale-minutes 30
```

### Port and port scanning

The preferred port defaults to **4646**. If it is already in use (`EADDRINUSE`), the
server scans forward for the next free port — the default covers **4646–4655** (ten
ports from the chosen port) — and errors out only if every candidate is taken. On
success it prints exactly:

```
mission-dashboard listening on http://127.0.0.1:<port>
```

That single line is the machine-readable contract the `mission-dashboard --serve` skill
parses to find the running server.

## Scripts

| Script | What it does |
|---|---|
| `npm run dev` | Development: `tsx watch server/index.ts` (live server) alongside the Vite dev server, which proxies `/api` (REST + SSE) to `127.0.0.1:4646`. Serves the source client with HMR. |
| `npm run build` | Production build: `vite build` → `dist/client`, then `tsc -p tsconfig.server.json` → `dist/server` (+ `dist/shared`). |
| `npm start` | `node dist/server/index.js` — serves the built client from `dist/client` (SPA fallback) plus the API. Requires a prior `npm run build`. |
| `npm test` | `vitest run` — the whole-repo unit + integration suite. |

## HTTP surface

- `GET /api/state` — the current cached snapshot as JSON (served from memory; never
  triggers a rebuild).
- `GET /api/events` — Server-Sent Events. Sends the full snapshot on connect, then one
  `snapshot` event per vault rebuild, plus a `: ping` comment heartbeat every 25 s.
  The client reconnects automatically (covers laptop sleep).
- `GET /api/missions/:project/:mission` — on-demand mission detail (mission note,
  `milestones.md`, full `prompt-queue.md`, `issues-log.md`, an `evidence/` file listing,
  and any `diagnosis-*.md`). Never watched, never part of the snapshot.
- `GET /*` — the built client from `dist/client`, with SPA fallback to `index.html`.

## How it works

A file watcher (chokidar, `awaitWriteFinish` + a 300 ms trailing debounce) collapses a
burst of vault writes — a commander cycle touches several files at once — into a single
**full snapshot rebuild**, which is then broadcast to every connected browser. Snapshots
are a few kilobytes, so the design replaces the whole snapshot each time rather than
diffing (no cache-invalidation bug class). Every JSON/YAML read goes through a
last-good-cache reader: on a mid-write parse failure it retries once, then keeps the
last good value and surfaces a `parse_warning` — the dashboard never crashes and never
flashes an empty state.

## Security model

**The dashboard has no authentication layer, and that is by design.**

- The server binds **`127.0.0.1` only**. It is not reachable from another machine or
  another network interface. **This localhost bind is the entire authorization model.**
- **Do not expose it beyond localhost.** Do not bind it to `0.0.0.0`, port-forward it,
  or place it behind a reverse proxy. Doing so would publish your whole portfolio state
  (missions, worker claims, logs, inbox) to the network with no access control.
- It is strictly **read-only** over the vault — it never writes any vault file — so it
  is safe to run continuously against a live vault.

## Launching via the mission-dashboard skill

The intended entry point is `/mission-dashboard --serve`, which resolves this repo
through the `dashboard_path` key in `~/.claude/mission-control.json`, builds it if
`dist/` is missing, starts the server, parses the `listening on …` line, and opens the
browser. `--serve` **complements — it never replaces —** the generated markdown
dashboard tier. (The `npm run build && npm start` flow above works standalone today; the
skill wiring is added by a later step of this mission.)

## Design docs

The full design lives in `docs/specs/mission-dashboard/spec.md` (design) and
`docs/specs/mission-dashboard/plan.md` (milestones). This dashboard is built by the
Mission Control workflow itself — it watches its own build.
