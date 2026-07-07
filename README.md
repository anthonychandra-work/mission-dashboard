# mission-dashboard

Live, read-only web dashboard for the Mission Control workflow. One local Node
process watches the Obsidian vault (registries, features.json, inbox, logs) and
pushes a normalized snapshot to a Vite/React frontend over Server-Sent Events —
running commanders, worker claims, feature progress, queue, attention items, and
activity, all updating live with no polling and no database.

Launched via the `mission-dashboard` skill: `/mission-dashboard --serve`
(resolves this repo through the `dashboard_path` key in
`~/.claude/mission-control.json`).

Status: pre-implementation. Design: `docs/specs/mission-dashboard/spec.md`.
Built via the mission workflow itself — this dashboard watches its own build.
