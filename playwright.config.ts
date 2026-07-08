/**
 * Playwright e2e config (FEAT-DASH-014, milestone M4) — VAL-302 / VAL-202 / VAL-203.
 *
 * A headless suite that boots the BUILT server (`dist/server/index.js`) against
 * throwaway TEMP COPIES of the fixture vault (never the real vault — INV-A) and
 * drives it in a real Chromium. Each test owns its own server + vault copy via the
 * `boot` fixture in `e2e/harness.ts`, so the suite covers the spec §7 acceptance
 * list without any shared mutable state:
 *   - the dashboard renders the fixture vault (VAL-201 regression),
 *   - a features.json disk edit updates the OPEN feature table within ~1 s with no
 *     reload (VAL-202 — the automated live-SSE proof),
 *   - an empty vault renders the idle EmptyState and a claim badge ticks (VAL-203),
 *   - a warnings badge appears on a parse_warning, and
 *   - a stale (>45 min) claim renders with stale styling.
 *
 * `globalSetup` runs `npm run build` once so `dist/` reflects the current source
 * (incl. the FEAT-DASH-014 client edge-case polish) — the suite is self-contained:
 * `npx playwright test` alone builds and runs green.
 *
 * All Playwright artifacts land in the gitignored `test-results/` /
 * `playwright-report/` dirs so the repo tree stays clean. INV-B holds implicitly:
 * the server only ever binds 127.0.0.1 (server/index.ts BIND_HOST).
 */
import { defineConfig, devices } from '@playwright/test';

export default defineConfig({
  testDir: './e2e',
  // Serial: every test spawns its own Node server + chokidar watcher; one worker
  // keeps resource use and macOS FSEvents noise low and the run deterministic.
  fullyParallel: false,
  workers: 1,
  forbidOnly: !!process.env.CI,
  retries: 0,
  timeout: 45_000,
  // Auto-retrying assertions get a generous window; the live-update test additionally
  // MEASURES and asserts the true sub-second latency (VAL-202 "within ~1 s").
  expect: { timeout: 10_000 },
  // Build the app once before the suite so dist/ is current (self-contained run).
  globalSetup: './e2e/global-setup.ts',
  reporter: [
    ['list'],
    ['html', { outputFolder: 'playwright-report', open: 'never' }],
    ['json', { outputFile: 'test-results/results.json' }],
  ],
  use: {
    headless: true,
    viewport: { width: 1440, height: 900 },
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
    // The base server is spawned per-test; navigation uses each test's discovered URL.
  },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
});
