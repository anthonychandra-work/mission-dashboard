/**
 * SnapshotProvider + useSnapshot (spec §3.7) — the React binding over the
 * DOM-free `createSnapshotClient` state machine.
 *
 * A SINGLE `useState` at the provider level holds the whole snapshot and is
 * replaced wholesale on each `snapshot` frame (snapshots are a few KB). A second
 * piece of state tracks the connection status so the ConnectionDot
 * (FEAT-DASH-011) can render it. Everything hard to test in a browser — the SSE
 * reconnect/refetch logic — lives in `snapshotClient.ts` and is unit-tested; the
 * hook just supplies the real `EventSource`, `fetch`, and visibility wiring.
 */
import { createContext, createElement, useContext, useEffect, useState } from 'react';
import type { ReactNode } from 'react';

import type { Snapshot } from '../../../shared/types';
import {
  createSnapshotClient,
  type ConnectionStatus,
  type EventSourceLike,
} from './snapshotClient';

export interface SnapshotContextValue {
  /** The current snapshot, or `null` before the first frame/fetch. */
  snapshot: Snapshot | null;
  /** SSE connection status (for the ConnectionDot). */
  status: ConnectionStatus;
}

const SnapshotContext = createContext<SnapshotContextValue>({
  snapshot: null,
  status: 'connecting',
});

export function SnapshotProvider({ children }: { children: ReactNode }): ReactNode {
  const [snapshot, setSnapshot] = useState<Snapshot | null>(null);
  const [status, setStatus] = useState<ConnectionStatus>('connecting');

  useEffect(() => {
    const client = createSnapshotClient({
      createEventSource: (url) => new EventSource(url) as unknown as EventSourceLike,
      fetchSnapshot: async () => {
        try {
          const res = await fetch('/api/state', { headers: { accept: 'application/json' } });
          // Tolerate the cold-boot 503 (spec §3.6) on first paint — SSE fills in.
          if (!res.ok) return null;
          return (await res.json()) as Snapshot;
        } catch {
          return null;
        }
      },
      onSnapshot: setSnapshot,
      onStatus: setStatus,
    });

    // Fetch once on mount so first paint doesn't wait for the SSE connect frame
    // (the server warms /api/state before binding, so this is normally instant).
    // The revision check dedups it against the connect frame.
    client.refresh();

    const onVisibility = (): void => {
      if (document.visibilityState === 'visible') client.refresh();
    };
    document.addEventListener('visibilitychange', onVisibility);

    return () => {
      document.removeEventListener('visibilitychange', onVisibility);
      client.close();
    };
  }, []);

  return createElement(SnapshotContext.Provider, { value: { snapshot, status } }, children);
}

export function useSnapshot(): SnapshotContextValue {
  return useContext(SnapshotContext);
}
