/**
 * HeaderSummary (FEAT-DASH-011, spec §3.7) — the global-count header band.
 *
 * Four stat tiles derived from the snapshot: active missions, queued, work that
 * needs attention, and workers currently running (missions holding a claim). The
 * "attention" tile lights up warning-coloured when anything is pending and the
 * "workers running" tile lights up accent-coloured when a worker is live — colour
 * plus the number plus the label, never colour alone (dataviz status rule).
 *
 * Header-zone division of labour: the sticky app bar (shell, FEAT-DASH-010) owns
 * the "updated Xs ago" freshness readout and the {@link ConnectionDot}; this
 * content-level summary owns the portfolio counts. Together they are the header
 * summary the spec describes. Tiles use tabular figures so the numbers never jitter.
 */
import type { ReactNode } from 'react';

import type { Snapshot } from '../../../shared/types';

type Tone = 'neutral' | 'good' | 'attention' | 'accent';

interface Tile {
  label: string;
  value: number;
  tone: Tone;
  sub?: string;
}

export function HeaderSummary({ snapshot }: { snapshot: Snapshot }): ReactNode {
  let active = 0;
  let queued = 0;
  let paused = 0;
  let complete = 0;
  let workers = 0;
  let missions = 0;
  for (const project of snapshot.projects) {
    for (const mission of project.missions) {
      missions += 1;
      if (mission.claim !== null) workers += 1;
      switch (mission.status) {
        case 'active':
          active += 1;
          break;
        case 'queued':
          queued += 1;
          break;
        case 'paused':
          paused += 1;
          break;
        case 'complete':
          complete += 1;
          break;
        default:
          break;
      }
    }
  }

  const attention = snapshot.attention.length;
  const warnCount = snapshot.attention.reduce(
    (sum, item) => sum + (item.severity === 'warn' ? 1 : 0),
    0,
  );

  const tiles: Tile[] = [
    { label: 'active missions', value: active, tone: active > 0 ? 'good' : 'neutral' },
    { label: 'queued', value: queued, tone: 'neutral' },
    {
      label: 'needs attention',
      value: attention,
      tone: attention > 0 ? 'attention' : 'neutral',
      sub: attention > 0 ? `${warnCount} warn · ${attention - warnCount} info` : 'all clear',
    },
    {
      label: 'workers running',
      value: workers,
      tone: workers > 0 ? 'accent' : 'neutral',
    },
  ];

  const contextParts = [
    `${snapshot.projects.length} project${snapshot.projects.length === 1 ? '' : 's'}`,
    `${missions} mission${missions === 1 ? '' : 's'}`,
  ];
  if (paused > 0) contextParts.push(`${paused} paused`);
  if (complete > 0) contextParts.push(`${complete} complete`);

  return (
    <section className="header-summary" aria-label="Portfolio summary">
      <div className="header-summary__tiles">
        {tiles.map((tile) => (
          <div key={tile.label} className={`hs-tile hs-tile--${tile.tone}`}>
            <span className="hs-tile__value num">{tile.value}</span>
            <span className="hs-tile__label">{tile.label}</span>
            {tile.sub !== undefined && <span className="hs-tile__sub">{tile.sub}</span>}
          </div>
        ))}
      </div>
      <p className="header-summary__context">{contextParts.join(' · ')}</p>
    </section>
  );
}
