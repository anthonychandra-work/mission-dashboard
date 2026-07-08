/**
 * Playwright global setup (FEAT-DASH-014) — build the app once before the suite.
 *
 * The e2e tests boot the BUILT server (`dist/server/index.js`) serving the BUILT
 * client (`dist/client`), so `dist/` must exist and reflect the CURRENT source
 * (including this feature's client edge-case polish). Running `npm run build`
 * here makes `npx playwright test` self-contained: a fresh checkout needs no
 * separate build step to go green.
 */
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const repoRoot = fileURLToPath(new URL('..', import.meta.url));

export default function globalSetup(): void {
  // `vite build && tsc -p tsconfig.server.json` -> dist/client + dist/server + dist/shared.
  execFileSync('npm', ['run', 'build'], { cwd: repoRoot, stdio: 'inherit' });
}
