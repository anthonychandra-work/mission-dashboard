/**
 * MissionDetail (FEAT-DASH-012, spec §3.7) — the per-mission drill-down mounted
 * into the App shell's reserved `#/m/<project>/<mission>` route slot.
 *
 * TWO data sources, by design:
 *
 *   1. the LIVE snapshot (`useSnapshot`) supplies the mission's feature list, so
 *      the Features tab / FeatureTable re-renders within ~1 s of a `features.json`
 *      disk edit with NO page reload (VAL-202) — the SSE snapshot frame drives it,
 *      no extra fetch, no polling.
 *   2. the on-demand detail endpoint `GET /api/missions/:project/:mission` supplies
 *      the heavy documents (mission-note body, milestones.md, the FULL
 *      prompt-queue.md, issues-log.md) that are deliberately NOT in the snapshot;
 *      fetched once per route entry. The payload TYPE is imported from
 *      `server/detail.ts` (its type home per FEAT-DASH-009), not shared/types.ts —
 *      a type-only import, erased at build (no server code enters the client bundle).
 *
 * Tabs: Features | Docs | Issues. First paint tolerates a cold-boot `/api/state`
 * 503 (the shell shows its own loading state before this view mounts, so `snapshot`
 * is non-null here) AND a detail fetch that is still in flight or has failed — each
 * document tab shows a loading / error / empty state and never crashes.
 */
import { useEffect, useState } from 'react';
import type { ReactNode } from 'react';

import type { Mission } from '../../../shared/types';
import type { MissionDetail as MissionDetailPayload } from '../../../server/detail';
import { useSnapshot } from '../lib/useSnapshot';
import { FeatureTable } from './FeatureTable';
import { StatusPill } from './MissionCard';

type TabKey = 'features' | 'docs' | 'issues';

const TABS: Array<{ key: TabKey; label: string }> = [
  { key: 'features', label: 'Features' },
  { key: 'docs', label: 'Docs' },
  { key: 'issues', label: 'Issues' },
];

/** The detail-fetch lifecycle for the Docs / Issues tabs. */
type DetailState =
  | { phase: 'loading' }
  | { phase: 'ready'; detail: MissionDetailPayload }
  | { phase: 'error'; message: string };

export function MissionDetail({
  project,
  mission,
}: {
  project: string;
  mission: string;
}): ReactNode {
  const { snapshot } = useSnapshot();
  const [tab, setTab] = useState<TabKey>('features');
  const [detail, setDetail] = useState<DetailState>({ phase: 'loading' });

  // On-demand detail load, re-run only when the route (project/mission) changes —
  // NOT on every snapshot frame (the docs are heavy and route-scoped). A
  // features.json edit updates the Features tab via the live snapshot below.
  useEffect(() => {
    let cancelled = false;
    setDetail({ phase: 'loading' });
    const url = `/api/missions/${encodeURIComponent(project)}/${encodeURIComponent(mission)}`;
    fetch(url, { headers: { accept: 'application/json' } })
      .then(async (res) => {
        if (!res.ok) throw new Error(`detail request failed (${res.status})`);
        return (await res.json()) as MissionDetailPayload;
      })
      .then((payload) => {
        if (!cancelled) setDetail({ phase: 'ready', detail: payload });
      })
      .catch((error: unknown) => {
        if (!cancelled) {
          setDetail({
            phase: 'error',
            message: error instanceof Error ? error.message : String(error),
          });
        }
      });
    return () => {
      cancelled = true;
    };
  }, [project, mission]);

  // The live mission from the snapshot — drives the Features tab and updates over
  // SSE. Null when this mission is not in the current snapshot (the docs still load).
  const liveMission =
    snapshot?.projects.find((p) => p.slug === project)?.missions.find((m) => m.slug === mission) ??
    null;

  return (
    <section className="mission-detail">
      <MissionDetailHeader project={project} mission={mission} live={liveMission} />

      <div className="tabs" role="tablist" aria-label="Mission detail sections">
        {TABS.map((entry) => {
          const on = tab === entry.key;
          return (
            <button
              key={entry.key}
              type="button"
              role="tab"
              id={`tab-${entry.key}`}
              aria-selected={on}
              aria-controls={`panel-${entry.key}`}
              className={`tab${on ? ' tab--on' : ''}`}
              onClick={() => setTab(entry.key)}
            >
              <span className="tab__label">{entry.label}</span>
              {entry.key === 'features' && liveMission?.featureCounts != null && (
                <span className="tab__badge num">{liveMission.featureCounts.total}</span>
              )}
              {entry.key === 'issues' && issuesCount(detail) > 0 && (
                <span className="tab__badge tab__badge--warn num">{issuesCount(detail)}</span>
              )}
            </button>
          );
        })}
      </div>

      <div
        className="mission-detail__panel"
        role="tabpanel"
        id={`panel-${tab}`}
        aria-labelledby={`tab-${tab}`}
      >
        {tab === 'features' && <FeaturesPanel live={liveMission} />}
        {tab === 'docs' && <DocsPanel detail={detail} />}
        {tab === 'issues' && <IssuesPanel detail={detail} />}
      </div>
    </section>
  );
}

/* ------------------------------------------------------------------ *
 *  Header — title, path, status, headline feature figure
 * ------------------------------------------------------------------ */
function MissionDetailHeader({
  project,
  mission,
  live,
}: {
  project: string;
  mission: string;
  live: Mission | null;
}): ReactNode {
  return (
    <header className="mission-detail__head">
      <div className="mission-detail__titles">
        <h2 className="mission-detail__title">{live?.title ?? mission}</h2>
        <span className="mission-detail__path mono">
          {project}/{mission}
        </span>
      </div>
      {live !== null && (
        <div className="mission-detail__meta">
          <StatusPill status={live.status} />
          {live.featureCounts !== null && (
            <span className="mission-detail__figure num">
              <strong>{live.featureCounts.validatedPassed}</strong>
              <span className="mission-detail__figure-total">/{live.featureCounts.total}</span>
              <span className="mission-detail__figure-label">validated</span>
            </span>
          )}
        </div>
      )}
    </header>
  );
}

/* ------------------------------------------------------------------ *
 *  Panels
 * ------------------------------------------------------------------ */
function FeaturesPanel({ live }: { live: Mission | null }): ReactNode {
  if (live === null) {
    return (
      <p className="mission-detail__note">
        this mission is not in the current snapshot — live feature data is unavailable.
      </p>
    );
  }
  if (!live.hasFeaturesFile) {
    return (
      <p className="mission-detail__note">
        no <code>features.json</code> for this mission
        {live.summary !== null ? ` — ${live.summary}` : '.'}
      </p>
    );
  }
  return <FeatureTable features={live.features} />;
}

function DocsPanel({ detail }: { detail: DetailState }): ReactNode {
  if (detail.phase === 'loading') return <PanelStatus kind="loading" label="loading documents…" />;
  if (detail.phase === 'error') return <PanelStatus kind="error" label={detail.message} />;

  const d = detail.detail;
  const docs: Array<{ key: string; label: string; body: string | null }> = [
    { key: 'note', label: 'mission note', body: d.note.body },
    { key: 'milestones', label: 'milestones.md', body: d.milestones },
    { key: 'prompt-queue', label: 'prompt-queue.md', body: d.promptQueue },
  ].filter((doc) => doc.body !== null && doc.body.trim().length > 0);

  if (docs.length === 0) {
    return <p className="mission-detail__note">no mission documents found.</p>;
  }

  return (
    <div className="doc-stack">
      {docs.map((doc, index) => (
        <details key={doc.key} className="doc" open={index === 0}>
          <summary className="doc__summary">
            <span className="doc__summary-label">{doc.label}</span>
            <span className="doc__summary-chevron" aria-hidden="true" />
          </summary>
          <pre className="doc__body">{doc.body}</pre>
        </details>
      ))}
    </div>
  );
}

function IssuesPanel({ detail }: { detail: DetailState }): ReactNode {
  if (detail.phase === 'loading') return <PanelStatus kind="loading" label="loading issues…" />;
  if (detail.phase === 'error') return <PanelStatus kind="error" label={detail.message} />;

  const log = detail.detail.issuesLog;
  if (log === null || log.trim().length === 0) {
    return <p className="mission-detail__note">no issues logged for this mission.</p>;
  }
  return <pre className="doc__body doc__body--full">{log}</pre>;
}

/* ------------------------------------------------------------------ *
 *  Small shared status rows
 * ------------------------------------------------------------------ */
function PanelStatus({ kind, label }: { kind: 'loading' | 'error'; label: string }): ReactNode {
  return (
    <div className={`mission-detail__status mission-detail__status--${kind}`} role="status">
      {kind === 'loading' && <span className="loading__spinner" aria-hidden="true" />}
      <span>{label}</span>
    </div>
  );
}

/**
 * Best-effort issues badge: count `ISSUE-NN` table rows in the raw issues-log
 * markdown once the detail payload is present. Purely cosmetic — the number is a
 * hint, so a drifted log format simply yields 0 (never throws).
 */
function issuesCount(detail: DetailState): number {
  if (detail.phase !== 'ready') return 0;
  const log = detail.detail.issuesLog;
  if (log === null) return 0;
  const matches = log.match(/^\|\s*ISSUE-\d+\s*\|/gim);
  return matches === null ? 0 : matches.length;
}
