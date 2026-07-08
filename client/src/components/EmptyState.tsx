/**
 * EmptyState (spec §3.7) — the idle vault view. Renders exactly the copy
 * "vault is idle — no active missions" when the snapshot has zero projects
 * (a valid state — an empty vault, spec §5). Evidence: VAL-203 (empty-vault half).
 */
import type { ReactNode } from 'react';

export function EmptyState(): ReactNode {
  return (
    <div className="state empty-state" role="status" aria-live="polite">
      <svg
        className="empty-state__icon"
        width="40"
        height="40"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinecap="round"
        strokeLinejoin="round"
        aria-hidden="true"
      >
        <path d="M3 12h4l2 3h6l2-3h4" />
        <path d="M5 6h14a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2Z" />
      </svg>
      <p className="empty-state__title">vault is idle — no active missions</p>
      <p className="empty-state__hint">
        Missions appear here the moment the vault changes — no refresh needed.
      </p>
    </div>
  );
}
