# Plan (scaffold-brief) — mission-dashboard web frontend

> Thin brief for `mission-scaffold`. Per-feature decomposition is the scaffold's job — do not
> expand this into a task list. Design detail lives in `spec.md` (same folder).

## Stack

TypeScript (strict, ESM) · Node ≥ 20 · express 4 · chokidar · gray-matter · Vite · React 18 ·
Vitest · Playwright. Commands: `npm test` (vitest) · `npx playwright test` ·
`npm run build && npm start`. No database, no CSS framework, no router lib.

## Milestones

### M1 — Aggregation core
- **Goal:** `buildSnapshot(vaultPath)` — pure, fully tested vault→snapshot aggregation:
  config/vault resolution, all `aggregate/*` readers (registry, features, prompt-queue,
  inbox, logs), snapshot assembly, attention derivation, `safeRead` last-good fallback.
- **Scope (file surfaces):** `shared/**`, `server/config.ts`, `server/aggregate/**`,
  `tests/**` (incl. `tests/fixtures/vault-basic/**`), `package.json`, `tsconfig*.json`.
- **Depends on:** none.
- **Exit criteria:** `npm test` green — golden-snapshot test over the fixture vault plus
  targeted tests per attention rule and malformed-JSON fallback (VAL-001…004).

### M2 — Live server
- **Goal:** the running process: express app (`/api/state`, `/api/events` SSE with heartbeat,
  `/api/missions/:p/:slug` detail, static serving), chokidar watcher with
  awaitWriteFinish + 300 ms debounce, store with revision counter, port 4646 + scan,
  `127.0.0.1` bind, parseable startup line.
- **Scope (file surfaces):** `server/**` (index, watcher, store, sse, http, detail).
- **Depends on:** M1.
- **Exit criteria:** integration test drives a temp vault with atomic tmp+rename write bursts
  and asserts exactly one debounced snapshot event with incremented revision (VAL-101…103).

### M3 — Frontend
- **Goal:** the React app: SnapshotProvider (SSE + reconnect + visibility refetch), hash
  routing, and all views — HeaderSummary, AttentionList, ProjectSection, MissionCard,
  MissionDetail (Features | Docs | Issues tabs), FeatureTable, ActivityFeed, InboxPanel,
  EmptyState. Dark theme, single CSS file with design tokens. Apply `dataviz` and
  `ui-ux-pro-max` skills during implementation.
- **Scope (file surfaces):** `client/**`, `vite.config.*`.
- **Depends on:** M2 (may start against M1 fixture snapshots if scaffolded parallel-safe).
- **Exit criteria:** dashboard renders the fixture vault correctly in a browser; feature
  table updates live on disk change with no reload (VAL-201…203).

### M4 — Integration & polish
- **Goal:** production build pipeline (`npm start` serves `dist/client`), README, Playwright
  e2e suite, edge-case pass (empty vault, warnings badge, stale-claim styling), and the two
  external touchpoints: `dashboard_path` key in `~/.claude/mission-control.json` and the
  `## --serve mode` section replacing the "not implemented" rule in
  `~/.claude/skills/mission-dashboard/SKILL.md`.
- **Scope (file surfaces):** `README.md`, `e2e/**`, build config; external:
  `~/.claude/mission-control.json`, `~/.claude/skills/mission-dashboard/SKILL.md`.
- **Depends on:** M3.
- **Exit criteria:** `npx playwright test` green; `/mission-dashboard --serve` opens a
  rendering dashboard end-to-end (VAL-301…303).

## Draft validation assertions (VAL-*)

- **VAL-001** — Given the fixture vault, `buildSnapshot` returns the spec §3.4 shape with
  correct status/claim/featureCounts/currentFeature per mission. _(M1)_
- **VAL-002** — Given the fixture mission without features.json, the snapshot has
  `hasFeaturesFile:false` and renders data from registry `summary`. _(M1)_
- **VAL-003** — Given a stale claim with no matching inbox report, an `orphaned_claim`
  attention item is derived; a fresh claim derives none. _(M1)_
- **VAL-004** — Given a malformed JSON file, the snapshot keeps the last-good value for that
  path and carries a `parse_warning`; the build never throws. _(M1)_
- **VAL-101** — Given a burst of atomic tmp+rename writes within 300 ms, connected SSE
  clients receive exactly one snapshot event with an incremented revision. _(M2)_
- **VAL-102** — `GET /api/state` returns the cached snapshot; `GET /api/events` sends a full
  snapshot on connect and a `: ping` heartbeat every 25 s. _(M2)_
- **VAL-103** — With port 4646 occupied, the server binds the next free port ≤ 4655 and
  prints `mission-dashboard listening on http://127.0.0.1:<port>`. _(M2)_
- **VAL-201** — The dashboard renders the fixture vault: header counts, mission cards with
  status pills and progress bars, attention list sorted warn-first. _(M3)_
- **VAL-202** — Editing `features.json` on disk updates the open feature table within ~1 s
  with no page reload (Playwright). _(M3)_
- **VAL-203** — An empty vault renders the idle EmptyState; a claim badge ticks elapsed time
  client-side. _(M3)_
- **VAL-301** — `npm run build && npm start` on a fresh clone serves `/api/state` within 2 s. _(M4)_
- **VAL-302** — Full Playwright e2e suite green headless. _(M4)_
- **VAL-303** — `/mission-dashboard --serve` resolves `dashboard_path` from
  mission-control.json, starts the server, and opens the browser to a live dashboard. _(M4)_

## Known risks / constraints

- Read-only over the vault — this app must NEVER write into the vault (SCHEMA §2 ownership);
  tests use fixture/temp copies only.
- Workflow JSON writes are atomic tmp+rename — watcher must tolerate rename event pairs and
  mid-write reads (spec §3.3); never crash or flash empty on a parse failure.
- Missions may lack features.json (imported/complete) — never assume it exists.
- Claim staleness threshold is a heuristic (default 45 min, configurable); UI copy says
  "possibly dead", never "dead".
- Bind `127.0.0.1` only — localhost is the entire auth model.
- External touchpoints in M4 (`mission-control.json`, mission-dashboard SKILL.md) are outside
  this repo — declare them in `owner_surfaces` so dispatch overlap-checking sees them.
