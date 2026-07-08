/**
 * VAL-203 (regression) + stale-claim styling.
 *
 *  - An empty vault (zero projects) renders the idle EmptyState (spec §5).
 *  - A live claim badge ticks its elapsed time client-side every second,
 *    independent of any new snapshot (VAL-203 claim-tick half).
 *  - A claim older than the 45-min threshold renders with the stale styling and
 *    the "possibly dead" copy (never a bare "dead") — the fixture claim
 *    (2026-01-15) is far past the threshold, so the server marks it stale.
 */
import { test, expect } from './harness';

test.describe('VAL-203 — empty vault + client-side claim tick + stale styling', () => {
  test('an empty vault renders the idle EmptyState', async ({ page, boot }) => {
    const dash = await boot('empty');
    await page.goto(dash.baseURL);

    await expect(page.locator('.empty-state__title')).toHaveText('vault is idle — no active missions');
    await expect(page.locator('.mission-card')).toHaveCount(0);

    await page.screenshot({ path: 'test-results/screens/val203-emptystate.png', fullPage: true });
  });

  test('the claim badge ticks its elapsed time client-side', async ({ page, boot }) => {
    const dash = await boot('fixture');
    await page.goto(dash.baseURL);

    const timer = page.locator('.claim-badge__elapsed').first();
    await expect(timer).toBeVisible();
    await expect(timer).toContainText('elapsed');

    const first = await timer.textContent();
    // Wait past one 1 s tick; the elapsed readout must advance with NO new snapshot.
    await page.waitForTimeout(1600);
    const second = await timer.textContent();
    expect(second).not.toBe(first);
  });

  test('a stale (>45 min) claim renders with stale styling', async ({ page, boot }) => {
    const dash = await boot('fixture');
    await page.goto(dash.baseURL);

    const staleBadge = page.locator('.claim-badge--stale').first();
    await expect(staleBadge).toBeVisible();
    await expect(staleBadge.locator('.claim-badge__flag')).toHaveText('possibly dead');

    await page.screenshot({ path: 'test-results/screens/val203-stale-claim.png' });
  });
});
