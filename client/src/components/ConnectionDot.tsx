/**
 * ConnectionDot (FEAT-DASH-011) — the live SSE connection indicator.
 *
 * Consumes the SnapshotProvider `status` ('live' | 'connecting' | 'reconnecting')
 * already surfaced by FEAT-DASH-010's `useSnapshot`. A colored dot plus a text
 * label — colour is never the sole signal (the word always accompanies it, per
 * the dataviz / ui-ux-pro-max `color-not-alone` rule). Mounted in the sticky app
 * bar so the connection state stays visible while the content scrolls; it reuses
 * the `.conn` token classes the shell (styles.css) already defines.
 */
import type { ReactNode } from 'react';

import type { ConnectionStatus } from '../lib/snapshotClient';

const LABELS: Record<ConnectionStatus, string> = {
  live: 'live',
  connecting: 'connecting',
  reconnecting: 'reconnecting',
};

export function ConnectionDot({ status }: { status: ConnectionStatus }): ReactNode {
  return (
    <span className={`conn conn--${status}`} role="status" aria-live="polite">
      <span className="conn__dot" aria-hidden="true" />
      {LABELS[status]}
    </span>
  );
}
