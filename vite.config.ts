/**
 * Vite config (spec §3.1/§3.7) for the React client — also carries the Vitest
 * config for the whole repo.
 *
 * - `root: 'client'` — the app lives under client/ (index.html + src/).
 * - JSX via Vite 8's built-in Oxc transformer in the automatic runtime, so no
 *   `import React` is needed and — deliberately — NO `@vitejs/plugin-react` is
 *   added: the dependency list is CLOSED (spec §3.1; react/react-dom/vite are on
 *   it, the plugin is NOT) and package.json is a spine file owned by
 *   FEAT-DASH-001/013. Native Oxc JSX keeps us inside the closed list.
 * - Dev server proxies /api (REST + the SSE stream) to the Node server on 4646.
 * - `build.outDir: '../dist/client'` — the Node server serves this statically
 *   with SPA fallback (FEAT-DASH-008 http.ts resolves dist/client).
 *
 * -- Vitest root note --
 * Vite's `root` (client/) and Vitest's root are the SAME field, so `test.root`
 * is pinned back to the repo root (this file's directory) and `test.include` to
 * `tests/**` — otherwise the whole-repo `npm test` would look for tests under
 * client/ and find none. Tests run in the default `node` environment; the two
 * client suites (tests/client/*) import only DOM-free modules.
 *
 * This file is owned by FEAT-DASH-010 (created here) and FEAT-DASH-013 (may
 * adjust build output) per agent-boundaries.md.
 */
import { fileURLToPath } from 'node:url';

import { defineConfig } from 'vitest/config';

const repoRoot = fileURLToPath(new URL('.', import.meta.url));

export default defineConfig({
  root: 'client',
  // JSX: automatic runtime (react/jsx-runtime). In Vite 8 the transform is Oxc,
  // not esbuild; `oxc.jsx.runtime` is the current option.
  oxc: {
    jsx: {
      runtime: 'automatic',
      importSource: 'react',
    },
  },
  server: {
    port: 5173,
    // http-proxy streams responses, so the SSE endpoint (/api/events) proxies fine.
    proxy: {
      '/api': {
        target: 'http://127.0.0.1:4646',
        changeOrigin: true,
      },
    },
  },
  build: {
    outDir: '../dist/client',
    emptyOutDir: true,
  },
  test: {
    root: repoRoot,
    include: ['tests/**/*.test.ts'],
    environment: 'node',
  },
});
