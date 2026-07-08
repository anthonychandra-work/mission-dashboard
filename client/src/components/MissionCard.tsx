/**
 * MissionCard (FEAT-DASH-011, spec §3.7) — one mission at a glance.
 *
 * Renders: a status pill, a segmented progress bar built from `featureCounts`, a
 * live claim badge whose elapsed time ticks client-side every second, the current
 * feature with its escalation counters, any blocking, the next action, and a
 * `pr_url` link when set. The whole card navigates to `#/m/<project>/<mission>`
 * via a stretched link on the title (inner links — the PR link — stay clickable).
 *
 * VAL-203 (claim-tick half): the badge derives elapsed time from `claim.startedAt`
 * with its OWN 1 s interval — independent of the server-computed `ageMinutes`, so
 * it keeps ticking between snapshot rebuilds. It tolerates a null claim, a null /
 * unparseable `startedAt`, and null `ageMinutes` / `stale`: it never renders
 * "NaN". A stale claim is labelled "possibly dead" (never a bare "dead").
 */
import { useEffect, useState } from 'react';
import type { ReactNode } from 'react';

import type { Claim, FeatureCounts, FeatureEntry, Mission } from '../../../shared/types';
import { formatRoute } from '../lib/route';

/* ------------------------------------------------------------------ *
 *  Feature-status → token class (semantic --feat-* maps in styles.css)
 * ------------------------------------------------------------------ */
const FEATURE_STATUS_CLASS: Record<string, string> = {
  validated_passed: 'vp',
  validated_failed: 'vf',
  'in-progress': 'ip',
  implemented: 'impl',
  implemented_with_findings: 'iwf',
  ready: 'ready',
  planned: 'planned',
};

function featClass(status: string): string {
  return FEATURE_STATUS_CLASS[status] ?? 'unknown';
}

const KNOWN_MISSION_STATUS = ['active', 'queued', 'paused', 'complete'];

/* ------------------------------------------------------------------ *
 *  Progress bar — segmented distribution of feature statuses
 * ------------------------------------------------------------------ */
interface Segment {
  key: keyof FeatureCounts;
  label: string;
  cls: string;
}

/** Order runs done → not-started so the bar reads left-to-right as progress. */
const SEGMENTS: Segment[] = [
  { key: 'validatedPassed', label: 'validated', cls: 'vp' },
  { key: 'implemented', label: 'implemented', cls: 'impl' },
  { key: 'implementedWithFindings', label: 'w/ findings', cls: 'iwf' },
  { key: 'inProgress', label: 'in progress', cls: 'ip' },
  { key: 'validatedFailed', label: 'failed', cls: 'vf' },
  { key: 'ready', label: 'ready', cls: 'ready' },
  { key: 'planned', label: 'planned', cls: 'planned' },
];

function ProgressBar({ counts }: { counts: FeatureCounts }): ReactNode {
  const present = SEGMENTS.filter((seg) => counts[seg.key] > 0);
  const label = `${counts.validatedPassed} of ${counts.total} features validated`;
  return (
    <div className="progress">
      <div className="progress__head">
        <span className="progress__metric num">
          <strong>{counts.validatedPassed}</strong>
          <span className="progress__metric-total">/{counts.total}</span>
        </span>
        <span className="progress__metric-label">validated</span>
      </div>
      <div className="progress__bar" role="img" aria-label={label}>
        {present.map((seg) => (
          <span
            key={seg.key}
            className={`progress__seg seg--${seg.cls}`}
            style={{ flexGrow: counts[seg.key] }}
            title={`${seg.label}: ${counts[seg.key]}`}
          />
        ))}
      </div>
      <ul className="progress__legend">
        {present.map((seg) => (
          <li key={seg.key} className="progress__legend-item">
            <span className={`progress__swatch seg--${seg.cls}`} aria-hidden="true" />
            <span className="progress__legend-count num">{counts[seg.key]}</span>
            <span className="progress__legend-label">{seg.label}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}

/* ------------------------------------------------------------------ *
 *  Claim badge — client-side ticking elapsed time (VAL-203)
 * ------------------------------------------------------------------ */
const pad2 = (n: number): string => String(n).padStart(2, '0');

/** ms → "174d 03h 01m 23s" / "1h 30m 05s" / "5m 12s" / "40s" — always ends in seconds so it visibly ticks. */
function formatElapsed(ms: number): string {
  const totalSeconds = Math.floor(ms / 1000);
  const s = totalSeconds % 60;
  const m = Math.floor(totalSeconds / 60) % 60;
  const h = Math.floor(totalSeconds / 3600) % 24;
  const d = Math.floor(totalSeconds / 86_400);
  if (d > 0) return `${d}d ${pad2(h)}h ${pad2(m)}m ${pad2(s)}s`;
  if (h > 0) return `${h}h ${pad2(m)}m ${pad2(s)}s`;
  if (m > 0) return `${m}m ${pad2(s)}s`;
  return `${s}s`;
}

/**
 * Live elapsed string that ticks every second, or `null` when `startedAt` is
 * absent / unparseable (staleness/timing unknowable — never invent a value).
 */
function useLiveElapsed(startedAt: string | null): string | null {
  const [now, setNow] = useState(() => Date.now());
  const started = startedAt === null ? Number.NaN : Date.parse(startedAt);
  const parseable = !Number.isNaN(started);

  useEffect(() => {
    if (!parseable) return;
    const id = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(id);
  }, [parseable, started]);

  if (!parseable) return null;
  return formatElapsed(Math.max(0, now - started));
}

function ClaimBadge({ claim }: { claim: Claim }): ReactNode {
  const elapsed = useLiveElapsed(claim.startedAt);
  const stale = claim.stale === true;
  return (
    <div className={`claim-badge${stale ? ' claim-badge--stale' : ''}`}>
      <span className="claim-badge__pulse" aria-hidden="true" />
      <span className="claim-badge__worker">{claim.worker}</span>
      {claim.feature !== null && <span className="claim-badge__feature mono">{claim.feature}</span>}
      <span className="claim-badge__sep" aria-hidden="true">·</span>
      <span className="claim-badge__elapsed num" role="timer">
        {elapsed === null ? 'running' : `${elapsed} elapsed`}
      </span>
      {stale && <span className="claim-badge__flag">possibly dead</span>}
    </div>
  );
}

/* ------------------------------------------------------------------ *
 *  Current feature + escalation counters
 * ------------------------------------------------------------------ */
function CurrentFeature({ feature }: { feature: FeatureEntry }): ReactNode {
  const escalations: Array<{ key: string; label: string; value: number; title: string }> = [
    { key: 'fx', label: `fix ${feature.fixPasses}`, value: feature.fixPasses, title: 'fix passes' },
    { key: 'fa', label: `fail ${feature.failedAttempts}`, value: feature.failedAttempts, title: 'failed attempts' },
    { key: 'cr', label: `crash ${feature.crashRetries}`, value: feature.crashRetries, title: 'crash retries' },
  ].filter((item) => item.value > 0);

  return (
    <div className="mission-card__current">
      <span className="mission-card__current-label">current</span>
      <span className={`feat-pill feat-pill--${featClass(feature.status)}`}>{feature.name}</span>
      <span className="mission-card__current-status">{feature.status}</span>
      {escalations.map((item) => (
        <span key={item.key} className="escalation-chip" title={item.title}>
          {item.label}
        </span>
      ))}
    </div>
  );
}

/* ------------------------------------------------------------------ *
 *  Mission status pill (reuses the shell's `.pill` token classes)
 * ------------------------------------------------------------------ */
export function StatusPill({ status }: { status: string }): ReactNode {
  const kind = KNOWN_MISSION_STATUS.includes(status) ? status : 'unknown';
  return <span className={`pill pill--${kind}`}>{status}</span>;
}

/* ------------------------------------------------------------------ *
 *  MissionCard
 * ------------------------------------------------------------------ */
export function MissionCard({
  project,
  mission,
}: {
  project: string;
  mission: Mission;
}): ReactNode {
  const href = formatRoute({ name: 'mission', project, mission: mission.slug });
  const blockedFeatures = Object.entries(mission.blockedFeatures);

  return (
    <article className="mission-card">
      <div className="mission-card__head">
        <a className="mission-card__title stretched-link" href={href}>
          {mission.title ?? mission.slug}
        </a>
        <StatusPill status={mission.status} />
      </div>
      <div className="mission-card__path mono">
        {project}/{mission.slug}
      </div>

      {mission.featureCounts !== null ? (
        <ProgressBar counts={mission.featureCounts} />
      ) : (
        <p className="mission-card__no-features">
          {mission.hasFeaturesFile ? 'feature data unavailable' : 'no features.json'}
        </p>
      )}

      {!mission.hasFeaturesFile && mission.summary !== null && (
        <p className="mission-card__summary">{mission.summary}</p>
      )}

      {mission.claim !== null && <ClaimBadge claim={mission.claim} />}

      {mission.currentFeature !== null && <CurrentFeature feature={mission.currentFeature} />}

      {mission.blockedReason !== null && (
        <p className="mission-card__blocked">
          <span className="mission-card__blocked-icon" aria-hidden="true">
            {'⊘'}
          </span>
          blocked — {mission.blockedReason}
        </p>
      )}

      {blockedFeatures.length > 0 && (
        <ul className="mission-card__blocked-feats">
          {blockedFeatures.map(([id, reason]) => (
            <li key={id} className="mission-card__blocked-feat">
              <span className="feat-pill feat-pill--blocked">{id}</span>
              <span>{reason}</span>
            </li>
          ))}
        </ul>
      )}

      {mission.nextAction !== null && (
        <p className="mission-card__next">
          <span className="mission-card__next-label">next</span>
          {mission.nextAction}
        </p>
      )}

      {mission.prUrl !== null && (
        <a
          className="mission-card__pr relative-link"
          href={mission.prUrl}
          target="_blank"
          rel="noreferrer"
        >
          view pull request
          <span aria-hidden="true"> {'↗'}</span>
        </a>
      )}
    </article>
  );
}
