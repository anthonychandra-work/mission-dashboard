/**
 * InboxPanel (FEAT-DASH-011, spec §3.7) — undrained worker reports.
 *
 * Lists the top-level inbox reports the librarian has not yet folded into memory,
 * with the failed-report count surfaced in the header when non-zero. Each report
 * shows its role, result, and age; when it names a project + mission it links to
 * that mission (`#/m/<project>/<mission>`), otherwise it shows the raw filename.
 */
import type { ReactNode } from 'react';

import type { InboxReportSummary, InboxSummary } from '../../../shared/types';
import { formatRoute } from '../lib/route';

/** ISO / "YYYY-MM-DD HH:MM" → "Jan 15 · 09:30"; unparseable input renders raw. */
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
function formatTimestamp(raw: string): string {
  const match = /^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}:\d{2})/.exec(raw);
  if (match === null) return raw;
  const month = MONTHS[Number(match[2]) - 1] ?? match[2];
  const day = String(Number(match[3]));
  return `${month} ${day} · ${match[4]}`;
}

function InboxRow({ report }: { report: InboxReportSummary }): ReactNode {
  const target =
    report.project !== null && report.mission !== null
      ? formatRoute({ name: 'mission', project: report.project, mission: report.mission })
      : null;
  const label =
    report.project !== null && report.mission !== null
      ? `${report.project}/${report.mission}${report.feature !== null ? ` · ${report.feature}` : ''}`
      : report.file;

  return (
    <li className="inbox__item">
      <div className="inbox__meta">
        <span className="inbox__role">{report.role ?? 'report'}</span>
        {report.result !== null && <span className="inbox__result">{report.result}</span>}
        {report.timestamp !== null && (
          <span className="inbox__time num">{formatTimestamp(report.timestamp)}</span>
        )}
      </div>
      {target !== null ? (
        <a className="inbox__target mono" href={target}>
          {label}
        </a>
      ) : (
        <span className="inbox__target mono">{label}</span>
      )}
    </li>
  );
}

export function InboxPanel({ inbox }: { inbox: InboxSummary }): ReactNode {
  return (
    <section className="panel inbox" aria-label="Inbox">
      <header className="panel__head">
        <h2 className="panel__title">Inbox</h2>
        {inbox.failedCount > 0 && (
          <span className="panel__badge panel__badge--warn" title="failed reports">
            {inbox.failedCount} failed
          </span>
        )}
        <span className="panel__count">{inbox.unprocessedCount}</span>
      </header>
      {inbox.unprocessed.length === 0 ? (
        <p className="panel__empty">inbox clear — all reports drained</p>
      ) : (
        <ol className="inbox__list">
          {inbox.unprocessed.map((report) => (
            <InboxRow key={report.file} report={report} />
          ))}
        </ol>
      )}
    </section>
  );
}
