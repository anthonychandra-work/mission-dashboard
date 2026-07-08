/**
 * ActivityFeed (FEAT-DASH-011, spec §3.7) — the merged log stream.
 *
 * Renders the snapshot's already-merged, newest-first activity (global + every
 * project log, capped server-side). Each row shows a compact timestamp, the entry
 * type, its title, and a scope tag ("global" or the project slug). The list is
 * read-only history — no navigation.
 */
import type { ReactNode } from 'react';

import type { ActivityEntry } from '../../../shared/types';

/** "project:alpha-app" → "alpha-app"; "global" stays "global". */
function scopeLabel(scope: string): string {
  return scope.startsWith('project:') ? scope.slice('project:'.length) : scope;
}

/** "2026-01-15 10:00" / ISO → "Jan 15 · 10:00"; unparseable input renders raw. */
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
function formatTimestamp(raw: string): string {
  const match = /^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}:\d{2})/.exec(raw);
  if (match === null) return raw;
  const month = MONTHS[Number(match[2]) - 1] ?? match[2];
  const day = String(Number(match[3]));
  return `${month} ${day} · ${match[4]}`;
}

export function ActivityFeed({ activity }: { activity: ActivityEntry[] }): ReactNode {
  return (
    <section className="panel activity" aria-label="Activity">
      <header className="panel__head">
        <h2 className="panel__title">Activity</h2>
        <span className="panel__count">{activity.length}</span>
      </header>
      {activity.length === 0 ? (
        <p className="panel__empty">no recent activity</p>
      ) : (
        <ol className="activity__list">
          {activity.map((entry, index) => (
            <li key={`${entry.scope}-${entry.timestamp}-${index}`} className="activity__item">
              <span className="activity__time num mono">{formatTimestamp(entry.timestamp)}</span>
              <span className="activity__type">{entry.type}</span>
              <span className="activity__title">{entry.title}</span>
              <span className="activity__scope">{scopeLabel(entry.scope)}</span>
            </li>
          ))}
        </ol>
      )}
    </section>
  );
}
