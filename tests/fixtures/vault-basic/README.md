# Fixture vault — vault-basic

A miniature committed Mission Control vault (spec §7) mirroring the real vault's
SCHEMA: registry, per-project registries with claim/autonomy/escalation maps,
missions with and without `features.json`, inbox with `.processed/` and
`.failed/`, and `## [ts] type | title` logs. Tests copy this tree into a temp
directory before mutating anything — the committed fixture never contains
malformed inputs, and no test ever touches the real vault (INV-A).

## Contents

| Path | Exercises |
| --- | --- |
| `registry/projects.json` | 2 projects: `alpha-app`, `legacy-tool` |
| `registry/alpha-app.json` | autonomy block, live claim, `fix_passes` / `failed_attempts` / `crash_retries` / `blocked_features` maps, queued mission with `blocked_reason` |
| `registry/legacy-tool.json` | imported mission WITHOUT `features.json` (real case, spec §1) — rendered from `summary` |
| `projects/alpha-app/missions/mission-one/features.json` | mixed feature statuses (all 7 known values) |
| `projects/alpha-app/missions/mission-one/prompt-queue.md` | `nextAction` source |
| `inbox/*.md` + `.processed/` + `.failed/` | inbox summary + attention rules |
| `log.md`, `projects/*/log.md` | activity feed parsing (incl. a body line that must fold into the previous entry) |

## Parameterizable timestamps

All fixture timestamps are FIXED so the fixture never rots; tests inject `now`
relative to these constants instead of using the wall clock:

- Claim `started_at` (alpha-app / mission-one / FEAT-ONE-003):
  `2026-01-15T10:00:00` — for a FRESH claim inject `now` < 45 min after this;
  for a STALE claim inject `now` > 45 min after this (VAL-003).
- Unprocessed inbox report timestamp: `2026-01-15T09:30:00`.
- Registry `updated` values: `2026-01-15T10:05:00` (alpha-app),
  `2026-01-14T09:00:00` (legacy-tool).
