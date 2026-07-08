/**
 * VAL-202 (the automated proof) — a features.json disk edit updates the OPEN
 * feature table within ~1 s with NO page reload.
 *
 * This is the whole reason the e2e suite exists: it re-certifies the live-SSE
 * update path end-to-end (watcher -> debounce -> full rebuild -> SSE snapshot ->
 * React re-render) in a real browser. A window sentinel proves the update landed
 * IN PLACE (a full reload would wipe it), and the true edit->render latency is
 * measured and asserted sub-3 s (the debounce+awaitWriteFinish floor is ~0.5 s).
 */
import { test, expect, setFeatureStatus } from './harness';

test.describe('VAL-202 — live feature-table update on a features.json disk edit', () => {
  test('the open feature table updates within ~1 s with NO page reload', async ({ page, boot }) => {
    const dash = await boot('fixture');
    await page.goto(`${dash.baseURL}/#/m/alpha-app/mission-one`);

    // FEAT-ONE-007 starts as "planned" in the fixture; the row must be visible.
    const row = page.locator('tr.ftable__row', {
      has: page.getByText('FEAT-ONE-007', { exact: true }),
    });
    await expect(row).toBeVisible();
    await expect(row.locator('.feat-pill')).toHaveText('planned');

    const revValue = async (): Promise<number> => {
      const text = (await page.locator('.app-bar__rev').textContent()) ?? '';
      return Number(text.replace(/\D+/g, ''));
    };
    const baselineRev = await revValue();

    // Plant a sentinel: a full page reload wipes window state, an SSE update does not.
    await page.evaluate(() => {
      (window as unknown as { __e2eAlive?: string }).__e2eAlive = `ALIVE-${Date.now()}`;
    });
    const sentinel = await page.evaluate(
      () => (window as unknown as { __e2eAlive?: string }).__e2eAlive,
    );

    // Atomic on-disk edit: FEAT-ONE-007 planned -> validated_passed.
    const t0 = Date.now();
    await setFeatureStatus(dash.vaultPath, 'FEAT-ONE-007', 'validated_passed');

    // Auto-retry until the SAME open row reflects the new status.
    await expect(row.locator('.feat-pill')).toHaveText('validated', { timeout: 8_000 });
    const latencyMs = Date.now() - t0;

    // The sentinel survived -> the table updated in place, NO reload (VAL-202 core).
    const survived = await page.evaluate(
      () => (window as unknown as { __e2eAlive?: string }).__e2eAlive,
    );
    expect(survived).toBe(sentinel);

    // A fresh SSE snapshot was applied (revision advanced).
    expect(await revValue()).toBeGreaterThan(baselineRev);

    // "within ~1 s": assert comfortably under 3 s and record the real latency.
    expect(latencyMs).toBeLessThan(3_000);
    // eslint-disable-next-line no-console
    console.log(`[VAL-202] feature-table live-update latency: ${latencyMs} ms (no page reload)`);

    await page.screenshot({ path: 'test-results/screens/val202-after-live-edit.png', fullPage: true });
  });
});
