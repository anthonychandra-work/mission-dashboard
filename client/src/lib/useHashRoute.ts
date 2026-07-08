/**
 * useHashRoute (spec §3.7) — the thin `window`/`hashchange` subscription over
 * the pure `parseHashRoute`. Routes: `#/`, `#/p/<project>`, `#/m/<project>/<mission>`.
 * All parsing (and its tests) live in `route.ts`; this hook is only the wiring.
 */
import { useEffect, useState } from 'react';

import { parseHashRoute, type Route } from './route';

export function useHashRoute(): Route {
  const [route, setRoute] = useState<Route>(() => parseHashRoute(window.location.hash));

  useEffect(() => {
    const onHashChange = (): void => setRoute(parseHashRoute(window.location.hash));
    window.addEventListener('hashchange', onHashChange);
    // Re-sync in case the hash changed between the initial render and this effect.
    onHashChange();
    return () => window.removeEventListener('hashchange', onHashChange);
  }, []);

  return route;
}
