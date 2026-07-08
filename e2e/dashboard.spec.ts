/**
 * VAL-201 (regression) — the dashboard renders the fixture vault.
 *
 * Boots the built server over a temp copy of `tests/fixtures/vault-basic` and
 * asserts the spec §3.7 information hierarchy renders: the app bar, the header
 * summary tiles, a mission card with a status pill + progress bar, and the
 * attention list sorted warn-before-info.
 */
import { test, expect } from './harness';

test.describe('VAL-201 — dashboard renders the fixture vault', () => {
  test('renders app bar, header summary, mission cards, and warn-first attention', async ({ page, boot }) => {
    const dash = await boot('fixture');
    await page.goto(dash.baseURL);

    // App bar brand.
    await expect(page.locator('.app-bar__wordmark')).toHaveText('Mission Control');

    // Header summary: the "active missions" tile shows >= 1 (mission-one is active).
    await expect(page.locator('.header-summary')).toBeVisible();
    const activeTile = page.locator('.hs-tile', { hasText: 'active missions' });
    await expect(activeTile.locator('.hs-tile__value')).toHaveText(/[1-9]/);

    // Mission One card: title, active status pill, segmented progress bar.
    const card = page.locator('.mission-card', { hasText: 'Mission One' });
    await expect(card).toBeVisible();
    await expect(card.locator('.pill--active')).toHaveText('active');
    await expect(card.locator('.progress__bar')).toBeVisible();

    // Attention list present, and the FIRST item is a WARN (warn-before-info sort).
    await expect(page.locator('.attention')).toBeVisible();
    await expect(page.locator('.attn-list .attn-item').first()).toHaveClass(/attn-item--warn/);

    await page.screenshot({ path: 'test-results/screens/val201-dashboard.png', fullPage: true });
  });
});
