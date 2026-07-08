/**
 * FeatureTable (FEAT-DASH-012, spec §3.7) — the dense per-mission feature table.
 *
 * A plain HTML table: ~51 rows is nothing, so NO virtualization (SETTLED). It is
 * driven entirely off the LIVE snapshot's `FeatureEntry[]` (passed in by
 * MissionDetail, which reads `useSnapshot`), so a `features.json` disk edit that
 * the watcher folds into a new SSE snapshot re-renders this table within ~1 s with
 * NO page reload (VAL-202). The component holds only the status-filter selection as
 * local state, which survives live updates (the user's filter is not reset by a
 * new snapshot frame).
 *
 * Design (dataviz + ui-ux-pro-max): the status cell is a `feat-pill` — a coloured
 * dot (identity) beside a text label (meaning), never colour alone, because the
 * feature ramp sits in the 8–12 ΔE floor band and REQUIRES a secondary cue. The
 * fix/fail/crash counters use tabular figures and a muted zero. Blocked rows carry
 * a warning tint AND an icon + the reason text (colour is never the only signal).
 * The status filter chips double as the table's legend.
 */
import { useMemo, useState } from 'react';
import type { ReactNode } from 'react';

import type { FeatureEntry } from '../../../shared/types';

/* ------------------------------------------------------------------ *
 *  Feature-status → token class + human label (secondary encoding)
 * ------------------------------------------------------------------ */
interface StatusMeta {
  cls: string;
  label: string;
}

const STATUS_META: Record<string, StatusMeta> = {
  validated_passed: { cls: 'vp', label: 'validated' },
  validated_failed: { cls: 'vf', label: 'failed' },
  'in-progress': { cls: 'ip', label: 'in progress' },
  implemented: { cls: 'impl', label: 'implemented' },
  implemented_with_findings: { cls: 'iwf', label: 'w/ findings' },
  ready: { cls: 'ready', label: 'ready' },
  planned: { cls: 'planned', label: 'planned' },
};

function statusMeta(status: string): StatusMeta {
  return STATUS_META[status] ?? { cls: 'unknown', label: status };
}

/** Fixed chip order: done → not-started (mirrors the MissionCard progress bar). */
const STATUS_ORDER = [
  'validated_passed',
  'implemented',
  'implemented_with_findings',
  'in-progress',
  'validated_failed',
  'ready',
  'planned',
];

interface Facet {
  status: string;
  count: number;
}

/**
 * Count features per status and emit them in the fixed display order, with any
 * unknown/drifted statuses appended in first-seen order (tolerant — vault schema
 * drift must never crash the table). Pure over the feature list.
 */
function orderedFacets(features: readonly FeatureEntry[]): Facet[] {
  const counts = new Map<string, number>();
  for (const feature of features) {
    counts.set(feature.status, (counts.get(feature.status) ?? 0) + 1);
  }
  const facets: Facet[] = [];
  for (const status of STATUS_ORDER) {
    const count = counts.get(status);
    if (count !== undefined) {
      facets.push({ status, count });
      counts.delete(status);
    }
  }
  for (const [status, count] of counts) {
    facets.push({ status, count });
  }
  return facets;
}

/* ------------------------------------------------------------------ *
 *  Escalation counter cell — tabular figure, muted zero
 * ------------------------------------------------------------------ */
function Counter({ value, kind }: { value: number; kind: 'fix' | 'fail' | 'crash' }): ReactNode {
  if (value <= 0) {
    return <span className="ftable__count-zero">0</span>;
  }
  return <span className={`ftable__count-hit ftable__count-hit--${kind}`}>{value}</span>;
}

/* ------------------------------------------------------------------ *
 *  FeatureTable
 * ------------------------------------------------------------------ */
export function FeatureTable({ features }: { features: readonly FeatureEntry[] }): ReactNode {
  const [active, setActive] = useState<string | null>(null); // null = show all
  const facets = useMemo(() => orderedFacets(features), [features]);

  // If a live update removed the currently-filtered status, fall back to "all"
  // rather than showing an empty table with a phantom active chip.
  const activePresent = active === null || facets.some((facet) => facet.status === active);
  const effectiveActive = activePresent ? active : null;

  const rows = effectiveActive === null ? features : features.filter((f) => f.status === effectiveActive);
  const blockedCount = useMemo(() => features.filter((f) => f.blockedReason !== null).length, [features]);

  if (features.length === 0) {
    return <p className="mission-detail__note">no features recorded for this mission.</p>;
  }

  return (
    <div className="feature-table">
      <div className="chips" role="group" aria-label="Filter features by status">
        <button
          type="button"
          className={`chip${effectiveActive === null ? ' chip--on' : ''}`}
          aria-pressed={effectiveActive === null}
          onClick={() => setActive(null)}
        >
          <span className="chip__label">all</span>
          <span className="chip__count num">{features.length}</span>
        </button>
        {facets.map((facet) => {
          const meta = statusMeta(facet.status);
          const on = effectiveActive === facet.status;
          return (
            <button
              key={facet.status}
              type="button"
              className={`chip chip--${meta.cls}${on ? ' chip--on' : ''}`}
              aria-pressed={on}
              onClick={() => setActive(on ? null : facet.status)}
            >
              <span className="chip__dot" aria-hidden="true" />
              <span className="chip__label">{meta.label}</span>
              <span className="chip__count num">{facet.count}</span>
            </button>
          );
        })}
      </div>

      <div className="feature-table__scroll">
        <table className="ftable">
          <thead>
            <tr>
              <th scope="col" className="ftable__th-id">
                feature
              </th>
              <th scope="col">status</th>
              <th scope="col" className="ftable__th-num" title="fix passes">
                fix
              </th>
              <th scope="col" className="ftable__th-num" title="failed attempts">
                fail
              </th>
              <th scope="col" className="ftable__th-num" title="crash retries">
                crash
              </th>
              <th scope="col">blocked</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((feature) => {
              const meta = statusMeta(feature.status);
              const blocked = feature.blockedReason !== null;
              return (
                <tr
                  key={feature.name}
                  className={`ftable__row${blocked ? ' ftable__row--blocked' : ''}`}
                >
                  <th scope="row" className="ftable__id mono">
                    {feature.name}
                  </th>
                  <td>
                    <span className={`feat-pill feat-pill--${meta.cls}`}>{meta.label}</span>
                  </td>
                  <td className="ftable__num num">
                    <Counter value={feature.fixPasses} kind="fix" />
                  </td>
                  <td className="ftable__num num">
                    <Counter value={feature.failedAttempts} kind="fail" />
                  </td>
                  <td className="ftable__num num">
                    <Counter value={feature.crashRetries} kind="crash" />
                  </td>
                  <td className="ftable__blocked-cell">
                    {blocked ? (
                      <span className="ftable__blocked-flag">
                        <span className="ftable__blocked-icon" aria-hidden="true">
                          {'⊘'}
                        </span>
                        {feature.blockedReason}
                      </span>
                    ) : (
                      <span className="ftable__dash" aria-hidden="true">
                        —
                      </span>
                    )}
                  </td>
                </tr>
              );
            })}
            {rows.length === 0 && (
              <tr>
                <td colSpan={6} className="ftable__none">
                  no features with this status
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>

      <p className="feature-table__foot">
        showing {rows.length} of {features.length}
        {blockedCount > 0 && (
          <>
            {' · '}
            <span className="feature-table__blocked-tally">{blockedCount} blocked</span>
          </>
        )}
      </p>
    </div>
  );
}
