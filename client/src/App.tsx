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

import type { Mission, Project, Snapshot } from '../../shared/types';
import { EmptyState } from './components/EmptyState';
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
        <ConnStatus status={status} />
      </div>
    </header>
  );
}

function ConnStatus({ status }: { status: SnapshotContextValue['status'] }): ReactNode {
  const label = status === 'live' ? 'live' : status === 'connecting' ? 'connecting' : 'reconnecting';
  return (
    <span className={`conn conn--${status}`} role="status" aria-live="polite">
      <span className="conn__dot" aria-hidden="true" />
      {label}
    </span>
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
  const missionCount = snapshot.projects.reduce((sum, p) => sum + p.missions.length, 0);
  return (
    <>
      <Breadcrumb trail={[{ label: 'all projects' }]} />

      <div className="stat-strip">
        <StatChip label="projects" value={snapshot.projects.length} />
        <StatChip label="missions" value={missionCount} />
        <StatChip label="attention" value={snapshot.attention.length} variant="attention" />
        <StatChip label="unprocessed inbox" value={snapshot.inbox.unprocessedCount} />
      </div>

      <Slot span component="HeaderSummary" feature="FEAT-DASH-011" hint="Global counts, workers running, and the ‘updated Xs ago’ readout render here." />

      <div className="slot-grid">
        <Slot component="ProjectSection · MissionCard" feature="FEAT-DASH-011" hint="Per-project mission cards with progress bars and live claim badges.">
          <MissionPreview projects={snapshot.projects} />
        </Slot>
        <div className="slot-stack">
          <Slot component="AttentionList" feature="FEAT-DASH-011" hint={`${snapshot.attention.length} item(s), sorted warn-before-info.`} />
          <Slot component="ActivityFeed" feature="FEAT-DASH-011" hint={`${snapshot.activity.length} recent log entr(ies).`} />
          <Slot component="InboxPanel" feature="FEAT-DASH-011" hint={`${snapshot.inbox.unprocessedCount} unprocessed report(s).`} />
        </div>
      </div>
    </>
  );
}

/* ---------------------------------------------------------------- *
 *  Project view scaffold
 * ---------------------------------------------------------------- */
function ProjectView({ snapshot, project }: { snapshot: Snapshot; project: string }): ReactNode {
  const found = snapshot.projects.find((p) => p.slug === project);
  return (
    <>
      <Breadcrumb trail={[{ label: 'all projects', route: { name: 'global' } }, { label: project }]} />
      {found === undefined ? (
        <Slot span component="ProjectSection" feature="FEAT-DASH-011" hint={`No project “${project}” in the current snapshot.`} />
      ) : (
        <>
          <div className="stat-strip">
            <StatChip label="missions" value={found.missions.length} />
            <StatChip label="branch" value={found.defaultBranch ?? '—'} />
          </div>
          <Slot span component="ProjectSection · MissionCard" feature="FEAT-DASH-011" hint="The whole page for a single project renders here.">
            <MissionPreview projects={[found]} />
          </Slot>
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

function MissionPreview({ projects }: { projects: Project[] }): ReactNode {
  const rows: Array<{ project: string; mission: Mission }> = [];
  for (const project of projects) {
    for (const mission of project.missions) rows.push({ project: project.slug, mission });
  }
  return (
    <div className="preview">
      {rows.map(({ project, mission }) => (
        <div className="preview__row" key={`${project}/${mission.slug}`}>
          <a href={formatRoute({ name: 'mission', project, mission: mission.slug })} className="preview__name">
            {mission.title ?? mission.slug}
          </a>
          <span className="preview__path mono">
            {project}/{mission.slug}
          </span>
          <span className="preview__spacer" />
          <StatusPill status={mission.status} />
        </div>
      ))}
    </div>
  );
}

function StatusPill({ status }: { status: string }): ReactNode {
  const known = ['active', 'queued', 'paused', 'complete'];
  const kind = known.includes(status) ? status : 'unknown';
  return <span className={`pill pill--${kind}`}>{status}</span>;
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
