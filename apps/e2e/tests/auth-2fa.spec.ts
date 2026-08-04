import { test, expect } from '@playwright/test';
import { readFixture } from '../fixtures/state';
import { currentTotpCode } from '../fixtures/totp';

// Regression coverage for three bugs found in the VM admin walkthrough
// (CLAUDE.md, "Systematic VM admin walkthrough — issue #1" and "#2"):
//
//  - Secure cookies set over plain HTTP meant the CSRF cookie was never
//    stored by any real browser, so no mutation after login could ever
//    succeed. The very first mutation this test makes (force-change-
//    password) is that exact CSRF-protected call — the API server this
//    harness starts runs with NODE_ENV=production over plain HTTP
//    (see playwright.config.ts's comment on the API webServer's env),
//    reproducing the exact condition that broke it, not a synthetic one.
//  - Forced first-login password change was fully built but never
//    enforced — ProtectedRoute now gates every route behind it when the
//    JWT carries forcePasswordChange: true.
//  - The 2FA-pending login response never set the CSRF cookie, so
//    totp/verify 403'd unconditionally for every account with 2FA
//    enabled. This test enrolls 2FA and logs back in with a code,
//    exercising that exact second-mutation-after-tempToken path.
test('login → forced password change → 2FA enrollment → logout → login with a TOTP code', async ({ page }) => {
  const fixture = readFixture('authTwoFactor');
  const newPassword = 'E2eHarness#Pass2';

  await page.goto('/login');
  await page.locator('#email').fill(fixture.adminEmail);
  await page.locator('#password').fill(fixture.adminPassword);
  await page.getByRole('button', { name: 'Sign in' }).click();

  // ProtectedRoute renders ForceChangePassword in place of the dashboard —
  // issue #1 was this component existing, fully wired, and never rendering.
  await expect(page.getByRole('heading', { name: 'Change Password' })).toBeVisible();
  await page.locator('#newPassword').fill(newPassword);
  await page.locator('#confirmPassword').fill(newPassword);
  await page.getByRole('button', { name: 'Set Password' }).click();

  // Success revokes every session (including this one) and logs out —
  // if the CSRF cookie were never stored (issue #2), this 403s instead
  // and the error banner shows, never reaching /login again.
  await expect(page).toHaveURL(/\/login$/);
  await expect(page.locator('.text-red-700')).toHaveCount(0);

  // Log back in with the new password — no 2FA yet, so this lands
  // directly on the dashboard.
  await page.locator('#email').fill(fixture.adminEmail);
  await page.locator('#password').fill(newPassword);
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page).toHaveURL(/\/$/);

  await page.goto('/settings');
  const [setupResponse] = await Promise.all([
    page.waitForResponse((r) => r.url().includes('/auth/totp/setup') && r.ok()),
    page.getByRole('button', { name: 'Enable 2FA' }).click(),
  ]);
  const { secret } = (await setupResponse.json()) as { secret: string };

  await page.locator('input[inputmode="numeric"]').fill(currentTotpCode(secret));
  await page.getByRole('button', { name: 'Confirm' }).click();
  await expect(page.getByText('Save these recovery codes — shown once')).toBeVisible();
  await page.getByRole('button', { name: 'Done' }).click();

  await page.getByRole('button', { name: 'Sign out' }).click();
  await expect(page).toHaveURL(/\/login$/);

  // Log in again — this account now has 2FA, so login returns a
  // tempToken instead of a session, and totp/verify must succeed on its
  // own freshly-set CSRF cookie (the exact call issue #1/#2's fix covers).
  await page.locator('#email').fill(fixture.adminEmail);
  await page.locator('#password').fill(newPassword);
  await page.getByRole('button', { name: 'Sign in' }).click();

  await expect(page.getByRole('heading', { name: 'Two-Factor Authentication' })).toBeVisible();
  await page.locator('#code').fill(currentTotpCode(secret));
  await page.getByRole('button', { name: 'Verify' }).click();

  await expect(page).toHaveURL(/\/$/);
  await expect(page.getByRole('button', { name: 'Sign out' })).toBeVisible();
});
