import { test, expect } from '@playwright/test';

// Checks the harness itself, not the app. Every spec types with fill() or
// pressSequentially() and relies on the browser to enforce input limits the
// way a real keyboard would, so a field that cuts off a value can't pass
// unnoticed. Verified against Playwright 1.62 / Chromium 151 while
// investigating the staff recovery-code bug. If an upgrade changes that,
// this spec fails and every other spec's typing needs re-checking.
test('harness: fill() and pressSequentially() respect maxlength; a scripted value set does not', async ({ page }) => {
  await page.setContent(`
    <input id="fill" type="text" inputmode="numeric" maxlength="6">
    <input id="keys" type="text" inputmode="numeric" maxlength="6">
    <input id="scripted" type="text" inputmode="numeric" maxlength="6">
  `);

  await page.locator('#fill').fill('FA897-AF930');
  await page.locator('#keys').pressSequentially('FA897-AF930');
  await page.locator('#scripted').evaluate((el, value) => {
    Object.assign(el, { value });
  }, 'FA897-AF930');

  await expect(page.locator('#fill')).toHaveValue('FA897-');
  await expect(page.locator('#keys')).toHaveValue('FA897-');
  // A test that sets the value by script would never see the truncation.
  await expect(page.locator('#scripted')).toHaveValue('FA897-AF930');
});
