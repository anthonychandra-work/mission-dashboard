/**
 * App shell (spec §3.7) — SnapshotProvider + hash router + layout scaffold.
 *
 * This feature (FEAT-DASH-010) ships the SHELL only, plus EmptyState. The app
 * bar (brand + live connection status + freshness) and the routed layout with
 * clearly-labelled SLOTS are the scaffold the later M3 features mount into:
 * HeaderSummary / AttentionList / ProjectSection / MissionCard / ActivityFeed /
 * InboxPanel (FEAT-DASH-011) and MissionDetail / FeatureTable (FEAT-DASH-012).
 *
 * The slot bodies render a lightweight PREVIEW straight from the snapshot (count
 * chips, a mission list, status pills built on the design tokens) purely to
 * prove the SnapshotProvider → hash-router → tokens pipeline end-to-end; each is
 * explicitly tagged with the feature that replaces it. No 011/012 component is
 * implemented here.
 */
import { useEffect, useState } from 'react';
import type { ReactNode } from 'react';

import type { Snapshot } from '../../shared/types';
import { EmptyState } from './components/EmptyState';
// FEAT-DASH-011 global views mounted into the slots the FEAT-DASH-010 shell reserved.
import { ActivityFeed } from './components/ActivityFeed';
import { AttentionList } from './components/AttentionList';
import { ConnectionDot } from './components/ConnectionDot';
import { HeaderSummary } from './components/HeaderSummary';
import { InboxPanel } from './components/InboxPanel';
import { ProjectSection } from './components/ProjectSection';
import { useHashRoute } from './lib/useHashRoute';
import { formatRoute, type Route } from './lib/route';
import { SnapshotProvider, useSnapshot, type SnapshotContextValue } from './lib/useSnapshot';

export function App(): ReactNode {
  return (
    <SnapshotProvider>
      <Shell />
    </SnapshotProvider>
  );
}

function Shell(): ReactNode {
  const { snapshot, status } = useSnapshot();
  const route = useHashRoute();
  const now = useNow(1000);

  return (
    <div className="app">
      <AppBar snapshot={snapshot} status={status} now={now} />
      <main className="app-main">
        <Content snapshot={snapshot} route={route} />
      </main>
    </div>
  );
}

/* ---------------------------------------------------------------- *
 *  App bar
 * ---------------------------------------------------------------- */
function AppBar({
  snapshot,
  status,
  now,
}: {
  snapshot: Snapshot | null;
  status: SnapshotContextValue['status'];
  now: number;
}): ReactNode {
  return (
    <header className="app-bar">
      <div className="app-bar__brand">
        <span className="app-bar__mark" aria-hidden="true">
          <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
            <circle cx="12" cy="12" r="3" />
            <path d="M12 2v3M12 19v3M2 12h3M19 12h3M4.9 4.9l2.1 2.1M17 17l2.1 2.1M19.1 4.9 17 7M7 17l-2.1 2.1" />
          </svg>
        </span>
        <span className="app-bar__wordmark">Mission Control</span>
        <span className="app-bar__tagline">live dashboard</span>
      </div>
      <div className="app-bar__meta">
        <span className="app-bar__updated">
          {snapshot === null ? 'awaiting first snapshot' : `updated ${relativeAge(snapshot.generatedAt, now)}`}
        </span>
        {snapshot !== null && (
          <span className="app-bar__rev num mono">rev {snapshot.revision}</span>
        )}
        <ConnectionDot status={status} />
      </div>
    </header>
  );
}

/* ---------------------------------------------------------------- *
 *  Content router
 * ---------------------------------------------------------------- */
function Content({ snapshot, route }: { snapshot: Snapshot | null; route: Route }): ReactNode {
  if (snapshot === null) {
    return (
      <div className="state loading" role="status" aria-live="polite">
        <span className="loading__spinner" aria-hidden="true" />
        <span className="loading__text">connecting to the vault…</span>
      </div>
    );
  }

  if (snapshot.projects.length === 0) {
    return <EmptyState />;
  }

  switch (route.name) {
    case 'project':
      return <ProjectView snapshot={snapshot} project={route.project} />;
    case 'mission':
      return <MissionView snapshot={snapshot} project={route.project} mission={route.mission} />;
    case 'global':
    default:
      return <GlobalView snapshot={snapshot} />;
  }
}

/* ---------------------------------------------------------------- *
 *  Global view scaffold
 * ---------------------------------------------------------------- */
function GlobalView({ snapshot }: { snapshot: Snapshot }): ReactNode {
  return (
    <>
      <Breadcrumb trail={[{ label: 'all projects' }]} />
      <HeaderSummary snapshot={snapshot} />
      <div className="global-grid">
        <div className="global-grid__main">
          {snapshot.projects.map((project) => (
            <ProjectSection key={project.slug} project={project} />
          ))}
        </div>
        <aside className="global-grid__side">
          <AttentionList attention={snapshot.attention} />
          <ActivityFeed activity={snapshot.activity} />
          <InboxPanel inbox={snapshot.inbox} />
        </aside>
      </div>
    </>
  );
}

/* ---------------------------------------------------------------- *
 *  Project view scaffold
 * ---------------------------------------------------------------- */
function ProjectView({ snapshot, project }: { snapshot: Snapshot; project: string }): ReactNode {
  const found = snapshot.projects.find((p) => p.slug === project);
  const projectAttention = snapshot.attention.filter((item) => item.project === project);
  return (
    <>
      <Breadcrumb trail={[{ label: 'all projects', route: { name: 'global' } }, { label: project }]} />
      {found === undefined ? (
        <div className="panel">
          <p className="panel__empty">no project “{project}” in the current snapshot</p>
        </div>
      ) : (
        <>
          <ProjectSection project={found} standalone />
          {projectAttention.length > 0 && <AttentionList attention={projectAttention} />}
        </>
      )}
    </>
  );
}

/* ---------------------------------------------------------------- *
 *  Mission detail view scaffold
 * ---------------------------------------------------------------- */
function MissionView({
  snapshot,
  project,
  mission,
}: {
  snapshot: Snapshot;
  project: string;
  mission: string;
}): ReactNode {
  const foundProject = snapshot.projects.find((p) => p.slug === project);
  const foundMission = foundProject?.missions.find((m) => m.slug === mission);
  return (
    <>
      <Breadcrumb
        trail={[
          { label: 'all projects', route: { name: 'global' } },
          { label: project, route: { name: 'project', project } },
          { label: mission },
        ]}
      />
      {foundMission !== undefined && (
        <div className="stat-strip">
          <StatChip label="status" value={foundMission.status} />
          <StatChip label="features" value={foundMission.featureCounts?.total ?? '—'} />
          <StatChip label="current" value={foundMission.currentFeature?.name ?? '—'} />
        </div>
      )}
      <Slot
        span
        component="MissionDetail · FeatureTable"
        feature="FEAT-DASH-012"
        hint={`Tabs (Features · Docs · Issues) load on demand from GET /api/missions/${project}/${mission}.`}
      />
    </>
  );
}

/* ---------------------------------------------------------------- *
 *  Shared scaffold pieces
 * ---------------------------------------------------------------- */
function StatChip({
  label,
  value,
  variant,
}: {
  label: string;
  value: number | string;
  variant?: 'attention';
}): ReactNode {
  return (
    <div className={`stat-chip${variant === 'attention' ? ' stat-chip--attention' : ''}`}>
      <span className="stat-chip__value num">{value}</span>
      <span className="stat-chip__label">{label}</span>
    </div>
  );
}

function Slot({
  component,
  feature,
  hint,
  span,
  children,
}: {
  component: string;
  feature: string;
  hint: string;
  span?: boolean;
  children?: ReactNode;
}): ReactNode {
  return (
    <section className={`slot${span ? ' slot--span' : ''}`}>
      <div className="slot__label">
        <span>{component}</span>
        <span className="slot__tag">{feature}</span>
      </div>
      <p className="slot__hint">{hint}</p>
      {children}
    </section>
  );
}

function Breadcrumb({ trail }: { trail: Array<{ label: string; route?: Route }> }): ReactNode {
  return (
    <nav className="scaffold__route" aria-label="Breadcrumb">
      <span className="scaffold__crumb">
        {trail.map((crumb, index) => (
          <span className="scaffold__crumb" key={`${crumb.label}-${index}`}>
            {index > 0 && <span className="scaffold__crumb-sep" aria-hidden="true">/</span>}
            {crumb.route !== undefined && index < trail.length - 1 ? (
              <a href={formatRoute(crumb.route)}>{crumb.label}</a>
            ) : (
              <span className="scaffold__crumb-current">{crumb.label}</span>
            )}
          </span>
        ))}
      </span>
    </nav>
  );
}

/* ---------------------------------------------------------------- *
 *  Ticking clock (shell freshness readout)
 * ---------------------------------------------------------------- */
function useNow(intervalMs: number): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = window.setInterval(() => setNow(Date.now()), intervalMs);
    return () => window.clearInterval(id);
  }, [intervalMs]);
  return now;
}

function relativeAge(fromIso: string, now: number): string {
  const then = Date.parse(fromIso);
  if (Number.isNaN(then)) return 'just now';
  const seconds = Math.max(0, Math.round((now - then) / 1000));
  if (seconds < 5) return 'just now';
  if (seconds < 60) return `${seconds}s ago`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return `${days}d ago`;
}
