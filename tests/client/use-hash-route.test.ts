/**
 * FEAT-DASH-010 — hash-route parser (the testable core of `useHashRoute`).
 *
 * `useHashRoute` is a ~15-line hook that only subscribes to `window`'s
 * `hashchange` and stores `parseHashRoute(window.location.hash)`. All routing
 * logic lives in the pure `parseHashRoute`/`formatRoute` in `client/src/lib/route.ts`,
 * so it is verified here directly — no DOM, no renderer — which also keeps the
 * whole-repo `tsc --noEmit` (no DOM lib) happy over `tests/**`.
 */
import { describe, it, expect } from 'vitest';

import { parseHashRoute, formatRoute, type Route } from '../../client/src/lib/route.js';

describe('parseHashRoute', () => {
  it('maps empty / root hashes to the global view', () => {
    for (const hash of ['', '#', '#/', '/', '#//']) {
      expect(parseHashRoute(hash)).toEqual({ name: 'global' });
    }
  });

  it('parses a project route', () => {
    expect(parseHashRoute('#/p/alpha-app')).toEqual({ name: 'project', project: 'alpha-app' });
  });

  it('parses a project route with a trailing slash', () => {
    expect(parseHashRoute('#/p/alpha-app/')).toEqual({ name: 'project', project: 'alpha-app' });
  });

  it('parses a mission route', () => {
    expect(parseHashRoute('#/m/alpha-app/mission-one')).toEqual({
      name: 'mission',
      project: 'alpha-app',
      mission: 'mission-one',
    });
  });

  it('tolerates a missing leading "#"', () => {
    expect(parseHashRoute('/m/alpha-app/mission-one')).toEqual({
      name: 'mission',
      project: 'alpha-app',
      mission: 'mission-one',
    });
  });

  it('decodes percent-encoded segments (slugs may contain spaces)', () => {
    expect(parseHashRoute('#/p/thing%20editor')).toEqual({
      name: 'project',
      project: 'thing editor',
    });
    expect(parseHashRoute('#/m/thing%20editor/sound%20engine')).toEqual({
      name: 'mission',
      project: 'thing editor',
      mission: 'sound engine',
    });
  });

  it('survives a malformed percent-escape without throwing', () => {
    expect(parseHashRoute('#/p/%E0%A4%A')).toEqual({ name: 'project', project: '%E0%A4%A' });
  });

  it('falls back to global when a project route is missing its slug', () => {
    expect(parseHashRoute('#/p')).toEqual({ name: 'global' });
    expect(parseHashRoute('#/p/')).toEqual({ name: 'global' });
  });

  it('falls back to global when a mission route is missing its mission', () => {
    expect(parseHashRoute('#/m/alpha-app')).toEqual({ name: 'global' });
  });

  it('falls back to global for an unknown prefix', () => {
    expect(parseHashRoute('#/x/y/z')).toEqual({ name: 'global' });
  });
});

describe('formatRoute', () => {
  it('is the inverse of parseHashRoute for each route kind', () => {
    const routes: Route[] = [
      { name: 'global' },
      { name: 'project', project: 'alpha-app' },
      { name: 'mission', project: 'alpha-app', mission: 'mission-one' },
    ];
    for (const route of routes) {
      expect(parseHashRoute(formatRoute(route))).toEqual(route);
    }
  });

  it('percent-encodes slugs with spaces so they round-trip', () => {
    const route: Route = { name: 'mission', project: 'thing editor', mission: 'sound engine' };
    expect(formatRoute(route)).toBe('#/m/thing%20editor/sound%20engine');
    expect(parseHashRoute(formatRoute(route))).toEqual(route);
  });
});
