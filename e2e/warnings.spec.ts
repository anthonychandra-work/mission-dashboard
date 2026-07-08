/**
 * Warnings badge — a parse_warning surfaces a visible global badge.
 *
 * A malformed features.json is a non-fatal read problem (spec §3.3, §5): the
 * aggregator keeps serving (registry is fine, mission renders with zeroed counts)
 * and raises a `parse_warning`. FEAT-DASH-014's client edge-case polish surfaces
 * `snapshot.warnings` as an always-on app-bar badge; the attention list mirrors
 * the same warning as a `parse_warning` item.
 */
import { test, expect } from './harness';

test.describe('warnings badge — surfaces a parse_warning', () => {
  test('a malformed features.json raises a visible warnings badge (dashboard still renders)', async ({
    page,
    boot,
  }) => {
    const dash = await boot('malformed');
    await page.goto(dash.baseURL);

    const badge = page.getByTestId('warnings-badge');
    await expect(badge).toBeVisible();
    await expect(badge.locator('.app-bar__warnings-count')).toHaveText(/[1-9]/);
    await expect(badge).toContainText('warning');

    // Non-fatal: projects still render (last-good served, never an empty/crashed UI).
    await expect(page.locator('.mission-card').first()).toBeVisible();

    // The attention list mirrors it as a parse_warning item (spec §3.5).
    await expect(page.locator('.attn-list')).toContainText('parse warning');

    await page.screenshot({ path: 'test-results/screens/warnings-badge.png', fullPage: true });
  });
});
