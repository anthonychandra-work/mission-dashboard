# Spec — mission-dashboard web frontend

> Fulfils vault `ROADMAP.md` item #1 ("Web dashboard frontend"). Designed 2026-07-07 in a
> dedicated brainstorming/plan session; extends the requirements settled there without
> re-litigating them.

## 1. Problem & context

The Mission Control workflow stores all portfolio state as files in the Obsidian vault
(`registry/*.json`, `missions/<slug>/features.json`, `inbox/`, `log.md` files), but the only
human views are static: the generated tier of `DASHBOARD.md` (rewritten once per commander
cycle) and a "live" Dataview tier that does not actually render (Dataview is not installed;
no `.base` files exist). There is no way to *watch* running missions — which worker holds a
claim, which feature is in progress, what failed validation, what needs attention — without
opening raw JSON.

The `mission-dashboard` skill currently says "Web frontend (`--serve`) is intentionally NOT
implemented yet." This spec implements it.

Current-state observability facts (verified in the design session):
- The **only liveness signal** is the registry `claim` object
  (`{worker, feature, started_at, session}`) — written before a worker spawns, cleared after
  its inbox report is processed. A stale claim with no matching report = possibly-dead worker.
- Feature statuses live in `features.json`; escalation counters (`fix_passes`,
  `failed_attempts`, `crash_retries`, `blocked_features`) live in the registry mission entry.
- All workflow JSON writes are atomic (tmp + rename); the watcher must tolerate rename bursts
  and mid-write reads.
- Imported/legacy missions may have **no features.json** (real case: `thing-editor-web`).

## 2. Goals / non-goals

**Goals**
- Live browser dashboard over the whole portfolio: running missions (current feature, worker
  claim + elapsed time, next action), queued missions with blocking reasons, finished
  missions, attention items, recent activity — global and per-project drill-down.
- Updates push to the browser the moment vault files change (file-watch → SSE). No polling,
  no manual refresh; client auto-reconnects (Mac sleep).
- Zero new state: read-only over existing vault files; no database; no workflow/schema changes.
- Launched as `/mission-dashboard --serve` via a `dashboard_path` key in
  `~/.claude/mission-control.json`; code lives in this standalone repo.

**Non-goals**
- Write actions (pause mission, approve dispatch) — explicitly a later discussion (ROADMAP).
- Ambient second-monitor "board mode" and mobile layout — excluded from v1 by decision.
- A commander heartbeat or any new liveness signal — liveness is inferred from claims only.
- Replacing the generated markdown tier — `--serve` complements it, never replaces it.
- Network access beyond localhost — `127.0.0.1` bind is the security model.

## 3. Design

### 3.1 Repo & process layout

TypeScript + ESM, Node ≥ 20. Single npm package (no workspaces): `server/` + `client/` +
`shared/`. One Node process serves the HTTP API, the SSE stream, and the built frontend from
`dist/client/` (SPA fallback to `index.html`).

```
server/
  index.ts        CLI entry: flags (--vault, --port, --stale-minutes), wire modules
  config.ts       vault resolution + tunables (staleness threshold, debounce)
  watcher.ts      chokidar setup, debounce, emits "vault-changed"
  store.ts        current snapshot + revision counter; rebuild() orchestration;
                  per-file last-good cache
  aggregate/
    snapshot.ts   builds the full normalized snapshot (pure function of read results)
    registry.ts   read registry/projects.json + registry/<p>.json
    features.ts   read projects/<p>/missions/<slug>/features.json
    promptQueue.ts first actionable line from prompt-queue.md
    inbox.ts      list + parse frontmatter of inbox/*.md; count .processed/.failed
    logs.ts       parse "## [YYYY-MM-DD HH:MM] <type> | <title>" entries, last N
    missionNote.ts frontmatter of mission note (detail endpoint only)
    attention.ts  derive attention items (pure function, §3.5)
  detail.ts       on-demand reader for /api/missions/:p/:slug (heavy docs)
  sse.ts          client set, heartbeat, broadcast
  http.ts         express app: static, /api/state, /api/events, /api/missions/...
shared/types.ts   Snapshot, Mission, AttentionItem, ... — imported by client too
client/src/       React app (§3.7)
tests/fixtures/vault-basic/   miniature committed vault for tests (§7)
```

Dependencies (complete list): `express` (v4), `chokidar`, `gray-matter`; dev: `vite`,
`react`, `react-dom`, `typescript`, `tsx`, `vitest`, `@playwright/test`. No router lib, no
state lib, no CSS framework.

Scripts: `dev` = `tsx watch server/index.ts` + `vite` (proxies `/api`); `build` =
`vite build` (→ `dist/client`) + `tsc -p server` (→ `dist/server`); `start` =
`node dist/server/index.js`; `test` = `vitest run`.

### 3.2 Vault resolution & port

`config.ts` order: `--vault <path>` flag → `MISSION_DASHBOARD_VAULT` env →
`~/.claude/mission-control.json` → `vault_path`. Fail fast with a clear message if the vault
dir or `registry/projects.json` is missing; an *empty* projects map is valid (idle state).
All file access via `node:fs/promises` with absolute paths — never through a shell.

Port: default **4646**, overridable via `--port` / `MISSION_DASHBOARD_PORT`. On `EADDRINUSE`
scan 4647–4655, then error out. On success print exactly one parseable line:
`mission-dashboard listening on http://127.0.0.1:<port>`.

### 3.3 Aggregation model — full rebuild, always

On any relevant file event: re-read everything → build one immutable snapshot → bump
`revision` → broadcast to all SSE clients. No incremental patching or diffing in v1:
snapshots are a few KB, rebuild cost < 50 ms, and full rebuilds eliminate the
cache-invalidation bug class.

Watched globs (relative to vault): `registry/*.json` ·
`projects/*/missions/*/features.json` and `.../prompt-queue.md` · `inbox/*.md` (top level
only; `.processed/` and `.failed/` are counted during rebuild, not watched) · `log.md` ·
`projects/*/log.md`.

Debounce & mid-write tolerance:
- chokidar `awaitWriteFinish: { stabilityThreshold: 200, pollInterval: 50 }` (also absorbs
  add/unlink pairs from atomic renames);
- a **300 ms trailing debounce** in `watcher.ts` collapses a commander cycle's burst
  (registry + features + log + inbox within a second) into one rebuild;
- every JSON/YAML read goes through `safeRead`: on parse failure retry once after 250 ms; if
  still bad, keep the **last-good parsed value** for that path (cache in `store.ts`) and
  append `{file, error}` to `snapshot.warnings`. Never crash, never flash an empty state.

### 3.4 Snapshot data model (`shared/types.ts`)

The one shape the frontend consumes:

```json
{
  "revision": 42,
  "generatedAt": "2026-07-07T12:00:00.000Z",
  "vaultPath": "/Users/Work/Documents/_obsidian",
  "warnings": [],
  "projects": [
    {
      "slug": "thing-editor-web",
      "repoPath": "/Users/Work/Documents/my-projects/thing-editor-web",
      "defaultBranch": "main",
      "registryUpdated": "2026-07-07T00:00:00",
      "autonomy": { "mode": "auto", "maxFixPasses": 2, "maxCrashRetries": 1, "diagnoseOnFailed": true },
      "missions": [
        {
          "slug": "sound-engine",
          "title": "Sound engine v1",
          "status": "active",
          "dependsOn": [],
          "blockedReason": null,
          "branch": "mission/sound-engine",
          "prUrl": null,
          "added": "2026-07-01", "activated": "2026-07-02", "concluded": null,
          "planSource": "repo:docs/specs/sound-engine/spec.md",
          "summary": null,
          "claim": {
            "worker": "executor", "feature": "FEAT-SND-003",
            "startedAt": "2026-07-07T11:20:00", "session": "abc123",
            "ageMinutes": 40, "stale": false
          },
          "hasFeaturesFile": true,
          "featureCounts": { "total": 12, "ready": 3, "planned": 2, "inProgress": 1,
                             "implemented": 1, "implementedWithFindings": 0,
                             "validatedPassed": 4, "validatedFailed": 1 },
          "currentFeature": { "name": "FEAT-SND-003", "status": "in-progress",
                              "fixPasses": 1, "failedAttempts": 0, "crashRetries": 0 },
          "nextAction": "validate FEAT-SND-003 once executor report lands",
          "features": [
            { "name": "FEAT-SND-003", "status": "in-progress",
              "fixPasses": 1, "failedAttempts": 0, "crashRetries": 0, "blockedReason": null }
          ],
          "blockedFeatures": { "FEAT-SND-007": "needs upstream API decision" }
        }
      ]
    }
  ],
  "attention": [
    { "type": "orphaned_claim", "severity": "warn",
      "project": "thing-editor-web", "mission": "sound-engine", "feature": "FEAT-SND-003",
      "message": "executor claim on FEAT-SND-003 started 2h ago, no report filed — possibly dead",
      "since": "2026-07-07T09:20:00" }
  ],
  "activity": [
    { "scope": "project:thing-editor-web", "timestamp": "2026-07-07 11:20",
      "type": "dispatch", "title": "executor → sound-engine/FEAT-SND-003", "body": "…" }
  ],
  "inbox": { "unprocessedCount": 1, "failedCount": 0,
             "unprocessed": [ { "file": "20260707-112000-thing-editor-web-sound-engine-FEAT-SND-003-executor.md",
                                "project": "thing-editor-web", "mission": "sound-engine",
                                "feature": "FEAT-SND-003", "role": "executor",
                                "result": "implemented", "timestamp": "2026-07-07T11:20:00" } ] }
}
```

Assembly rules:
- Feature statuses come from `features.json`; per-feature `fixPasses` / `failedAttempts` /
  `crashRetries` / `blockedReason` join in from the mission's registry maps (SCHEMA §4:
  commander-owned, never in features.json).
- `currentFeature` = the claimed feature if a claim exists, else the first `in-progress`
  feature, else the first non-terminal feature.
- `hasFeaturesFile: false` for missions with no `features.json` — render from the registry
  `summary` alone.
- `nextAction` = first actionable line of the mission's `prompt-queue.md` (nullable).
- `activity` = merged newest-first parse of global `log.md` + every project `log.md` (last
  ~15 each, capped at 30 merged). Tolerant parser: lines not matching the
  `## [ts] type | title` header fold into the previous entry's body; garbage is skipped,
  never fatal.
- `claim.stale` = `now − started_at > staleClaimMinutes` (default 45, `--stale-minutes` /
  env override).

### 3.5 Attention derivation (`attention.ts`, pure function)

| type | rule | severity |
|---|---|---|
| `orphaned_claim` | claim non-null AND stale AND no inbox report (top-level or `.processed/`) matching project+mission+feature+role with timestamp ≥ `started_at` | warn |
| `awaiting_merge` | mission `status == "active"` AND `pr_url` set | info |
| `blocked_feature` | one item per entry of registry `blocked_features`, with its reason | warn |
| `unprocessed_inbox` | any top-level `inbox/*.md` older than 10 min ("inbox not drained; run memory-sync") | info |
| `failed_inbox` | any file in `inbox/.failed/` | warn |
| `mission_blocked` | mission queued/paused with non-null `blocked_reason` | info |
| `parse_warning` | mirror of `snapshot.warnings` | info |

UI sorts `warn` before `info`.

### 3.6 API surface (three routes + static)

- `GET /api/state` → the store's cached snapshot (never rebuilds on request).
- `GET /api/events` → SSE. On connect immediately send `event: snapshot` with the full
  current snapshot; thereafter one `snapshot` event per rebuild; comment heartbeat
  (`: ping`) every 25 s. Full snapshots make `Last-Event-ID` replay unnecessary.
- `GET /api/missions/:project/:mission` → detail payload read **on demand** (never watched,
  never in the snapshot): mission-note markdown body + frontmatter, `milestones.md`, full
  `prompt-queue.md`, `issues-log.md`, `evidence/` file listing, any `diagnosis-*.md`. Each
  field nullable if absent.
- `GET /*` → static `dist/client` with SPA fallback.

### 3.7 Frontend (React)

Hash-based hand-rolled routing (~40-line `useHashRoute` hook): `#/` (global),
`#/p/<project>`, `#/m/<project>/<mission>`. Single vanilla CSS file with custom-property
design tokens, dark theme default.

```
client/src/
  main.tsx, App.tsx            shell: SnapshotProvider + hash router + layout
  lib/useSnapshot.ts           SSE connection + state
  lib/useHashRoute.ts
  components/
    HeaderSummary.tsx          global counts (active/queued/attention/workers running),
                               ConnectionDot, "updated Xs ago"
    AttentionList.tsx          sorted attention items, click → jumps to mission
    ProjectSection.tsx         per-project group (whole page at #/p/<slug>)
    MissionCard.tsx            status pill, progress bar from featureCounts, claim badge
                               with live-ticking elapsed time, current feature, nextAction,
                               pr_url link; click → #/m/…
    MissionDetail.tsx          fetches /api/missions/…; tabs: Features | Docs | Issues
    FeatureTable.tsx           plain table (51 rows is nothing), status filter chips,
                               fix-pass/fail counters, blocked rows highlighted
    ActivityFeed.tsx           merged log entries, scope tag per entry
    InboxPanel.tsx             unprocessed report list
    EmptyState.tsx             "vault is idle — no active missions"
```

`useSnapshot`: `EventSource('/api/events')`; on `snapshot` event replace state (single
`useState` at provider level — snapshot is small). EventSource auto-reconnects natively
(covers Mac sleep); additionally `onerror` → connection status "reconnecting", and on
re-`open` after an error plus on `visibilitychange`→visible, fetch `/api/state` once
(revision check makes it idempotent). Claim elapsed times tick client-side from `startedAt`
(1 s interval) so the UI feels live between events.

UI/visual design: apply the `dataviz` and `ui-ux-pro-max` skills at implementation time
(SKILL_MAP domain rules) — this spec fixes information hierarchy, not pixels.

### 3.8 Integration outside this repo (milestone M4)

1. `~/.claude/mission-control.json` — add
   `"dashboard_path": "/Users/Work/Documents/my-projects/mission-dashboard"` (file currently
   holds only `vault_path`).
2. `~/.claude/skills/mission-dashboard/SKILL.md` — replace the rule "Web frontend (`--serve`)
   is intentionally NOT implemented yet — see vault ROADMAP.md" with a `## --serve mode`
   section: read `dashboard_path` from mission-control.json (missing → instruct the user to
   set it); if `dist/` missing run `npm install && npm run build`; run `npm start`; parse the
   `listening on http://127.0.0.1:<port>` line; `open` that URL. State explicitly that
   `--serve` complements, never replaces, the generated markdown tier.
3. Vault `ROADMAP.md` item 1 → marked done at `mission-conclude` time (conclude flow handles
   it; not an implementation task).

## 4. Alternatives considered

- **Obsidian Bases native dashboard first** — honors the original ship-order, but Bases can't
  show claim liveness, feature-level progress, or attention derivation; chosen instead to
  build the web tier now (this was ROADMAP #1's deferred design session).
- **Commander heartbeat for liveness** — more accurate "running" signal, but adds a new write
  surface and schema change; rejected for v1 (claims + staleness threshold suffice and match
  the commander's own orphan-scan model).
- **Diff/patch SSE events** — less bandwidth, but invites cache-invalidation bugs; full
  snapshots are a few KB, so full-rebuild-and-replace wins.
- **react-router / state libs / CSS framework** — unnecessary for 3 routes and one snapshot
  object; hand-rolled hash routing + one CSS file keeps the dependency footprint minimal.
- **Plain `node:http` instead of express** — saves one dependency but costs hand-rolled
  static/mime/SPA-fallback handling; express 4 is boring and reliable.
- **Second-monitor board mode / mobile** — deferred by explicit form-factor decision.

## 5. Risks & edge cases

- **Empty vault / zero projects:** valid — idle EmptyState, empty arrays.
- **Missing features.json** (imported/complete missions — real case in this vault):
  `hasFeaturesFile:false`, render from summary.
- **51+ features:** plain table + filter chips; no virtualization.
- **Mid-write / atomic-rename JSON:** awaitWriteFinish + retry + last-good cache + warnings;
  never crash, never flash empty.
- **Claim staleness:** long legitimate runs exist — 45 min default, configurable, copy says
  "possibly dead", never "dead".
- **Port in use:** 4646 → scan to 4655 → parseable stdout line for the skill.
- **Vault path with spaces:** fs API only, no shell interpolation.
- **Mac sleep:** EventSource auto-reconnect + visibility refetch + heartbeat.
- **Log format drift:** tolerant parser; garbage never fatal.
- **Security:** `127.0.0.1` bind is the auth model; document in README.

## 6. Open questions

None — all candidates were resolved in the design session: staleness default (45 min,
configurable), port (4646 + scan), transport (full-snapshot SSE, no diffing), auth
(localhost bind), scope (no mobile/board mode in v1).

## 7. Acceptance (seeds the VAL-* in plan.md)

- Given the fixture vault, `buildSnapshot` returns the documented shape: every mission's
  status/claim/featureCounts/currentFeature correct, including `hasFeaturesFile:false` for
  the mission without features.json.
- Given a stale claim with no matching inbox report, the snapshot contains an
  `orphaned_claim` attention item; given a fresh claim, it does not.
- Given a malformed JSON file mid-run, the server keeps serving the last-good data and the
  snapshot carries a `parse_warning`; it never crashes or emits an empty snapshot.
- Given a burst of atomic tmp+rename writes within 300 ms, SSE clients receive exactly one
  new snapshot event with an incremented revision.
- Given the dashboard open in a browser and `features.json` changed on disk, the feature
  table updates within ~1 s with no page reload.
- Given an empty vault (no projects), the UI shows the idle EmptyState.
- `npm run build && npm start` boots and serves `/api/state` within 2 s on a fresh clone.
- `/mission-dashboard --serve` (after M4) resolves `dashboard_path`, starts the server, and
  opens the browser to a rendering dashboard.
