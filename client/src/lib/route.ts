/**
 * Hash-route model + pure parser/formatter (spec §3.7).
 *
 * The client is a single page with three hand-rolled hash routes (no
 * react-router — SETTLED): the global view, a per-project view, and a
 * per-mission detail view. All parsing lives here as a PURE function of the
 * hash string so it is testable in a plain Node environment with no DOM — the
 * React hook `useHashRoute` only adds the `window`/`hashchange` subscription on
 * top of this. Keeping the parser DOM-free is what lets `tsc --noEmit` (the
 * whole-repo typecheck, ES2022 lib, no DOM) check the module the tests import.
 */

/** The three routes of the dashboard (spec §3.7). Unknown hashes fall back to `global`. */
export type Route =
  | { readonly name: 'global' }
  | { readonly name: 'project'; readonly project: string }
  | { readonly name: 'mission'; readonly project: string; readonly mission: string };

/** Decode one path segment; a malformed `%`-escape falls back to the raw segment. */
function decodeSegment(segment: string): string {
  try {
    return decodeURIComponent(segment);
  } catch {
    return segment;
  }
}

/**
 * Parse a location hash into a {@link Route}.
 *
 *   `''` · `'#'` · `'#/'`            → global
 *   `'#/p/<project>'`                → project
 *   `'#/m/<project>/<mission>'`      → mission
 *
 * Trailing slashes, missing leading `#`, and percent-encoding are tolerated;
 * anything unrecognised degrades to the global view (never throws).
 */
export function parseHashRoute(hash: string): Route {
  const withoutHash = hash.startsWith('#') ? hash.slice(1) : hash;
  const parts = withoutHash
    .split('/')
    .filter((segment) => segment.length > 0)
    .map(decodeSegment);

  const [head, second, third] = parts;

  if (head === 'p' && second !== undefined) {
    return { name: 'project', project: second };
  }
  if (head === 'm' && second !== undefined && third !== undefined) {
    return { name: 'mission', project: second, mission: third };
  }
  return { name: 'global' };
}

/** Build the canonical hash for a route (inverse of {@link parseHashRoute}). */
export function formatRoute(route: Route): string {
  switch (route.name) {
    case 'global':
      return '#/';
    case 'project':
      return `#/p/${encodeURIComponent(route.project)}`;
    case 'mission':
      return `#/m/${encodeURIComponent(route.project)}/${encodeURIComponent(route.mission)}`;
  }
}
