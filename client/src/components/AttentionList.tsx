/**
 * AttentionList (FEAT-DASH-011, spec §3.7) — what needs a human.
 *
 * VAL-201: the aggregator emits attention items in spec §3.5 rule-table order;
 * the UI owns the sort and shows **warn before info** (a stable sort, so within a
 * severity band the rule-table order is preserved). Each item that carries a
 * project + mission is a link to `#/m/<project>/<mission>` ("click jumps to
 * mission"); items without a target (e.g. a failed inbox file) render inert.
 * Severity is icon + colour + the type label — never colour alone.
 */
import type { ReactNode } from 'react';

import type { AttentionItem, AttentionSeverity } from '../../../shared/types';
import { formatRoute } from '../lib/route';

const SEVERITY_RANK: Record<AttentionSeverity, number> = { warn: 0, info: 1 };

/** Humanise the derivation type: `orphaned_claim` → `orphaned claim`. */
function typeLabel(type: string): string {
  return type.replace(/_/g, ' ');
}

function WarnIcon(): ReactNode {
  return (
    <svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M10.3 3.9 1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0Z" />
      <path d="M12 9v4M12 17h.01" />
    </svg>
  );
}

function InfoIcon(): ReactNode {
  return (
    <svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <circle cx="12" cy="12" r="9" />
      <path d="M12 11v5M12 8h.01" />
    </svg>
  );
}

function AttentionRow({ item }: { item: AttentionItem }): ReactNode {
  const navigable = item.project !== null && item.mission !== null;
  const target =
    navigable && item.project !== null && item.mission !== null
      ? `${item.project}/${item.mission}${item.feature !== null ? ` · ${item.feature}` : ''}`
      : null;

  const inner = (
    <>
      <span className="attn-item__icon" aria-hidden="true">
        {item.severity === 'warn' ? <WarnIcon /> : <InfoIcon />}
      </span>
      <span className="attn-item__body">
        <span className="attn-item__msg">{item.message}</span>
        <span className="attn-item__foot">
          <span className="attn-item__type">{typeLabel(item.type)}</span>
          {target !== null && <span className="attn-item__target mono">{target}</span>}
        </span>
      </span>
    </>
  );

  if (navigable && item.project !== null && item.mission !== null) {
    return (
      <li className={`attn-item attn-item--${item.severity}`}>
        <a className="attn-item__link" href={formatRoute({ name: 'mission', project: item.project, mission: item.mission })}>
          {inner}
        </a>
      </li>
    );
  }
  return <li className={`attn-item attn-item--${item.severity} attn-item--inert`}>{inner}</li>;
}

export function AttentionList({ attention }: { attention: AttentionItem[] }): ReactNode {
  // Stable sort: warn band first, info band second; rule-table order kept within a band.
  const sorted = [...attention].sort((a, b) => SEVERITY_RANK[a.severity] - SEVERITY_RANK[b.severity]);

  return (
    <section className="panel attention" aria-label="Attention">
      <header className="panel__head">
        <h2 className="panel__title">Attention</h2>
        <span className="panel__count">{attention.length}</span>
      </header>
      {sorted.length === 0 ? (
        <p className="panel__empty">nothing needs attention</p>
      ) : (
        <ul className="attn-list">
          {sorted.map((item, index) => (
            <AttentionRow key={`${item.type}-${index}`} item={item} />
          ))}
        </ul>
      )}
    </section>
  );
}
