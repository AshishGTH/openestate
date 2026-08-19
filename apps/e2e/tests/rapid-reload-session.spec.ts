import { test, expect } from '@playwright/test';
import { readFixture } from '../fixtures/state';
import { login } from '../fixtures/actions';
import { API_URL, PORTAL_URL } from '../playwright.config';

/**
 * Regression: re-presenting a just-consumed refresh token used to log the
 * user out.
 *
 * Each full page load fires /auth/refresh from AuthProvider's mount
 * effect. If that response is never applied — the user navigated again,
 * the browser restored several tabs at once, the response was simply lost
 * — the server has still consumed the token and issued a replacement the
 * client never received. The cookie therefore still holds the OLD token,
 * and the next request re-presents it. Pre-fix that was read as token
 * theft and revoked the entire family: the user landed on /login with no
 * explanation and could never reproduce it on demand. Fixed server-side
 * with a short reuse grace window (TokenService.rotateRefreshToken).
 *
 * Reproducing it needs care, and two earlier drafts of this spec passed
 * against a server with the fix DISABLED — i.e. proved nothing:
 *
 *  - a ~1s pause between loads lets every refresh finish, so nothing is
 *    ever re-presented (this is why the bug survived so long unnoticed);
 *  - `waitUntil: 'commit'` navigates away so early the refresh never
 *    reaches the server at all, so no token is consumed either.
 *
 * The window is genuinely narrow: the request must be PROCESSED but its
 * response not applied. Plain sequential goto()s hit it reliably on the
 * portal and only sometimes on staff, so the staff case is additionally
 * covered by the deterministic form of the same thing — two concurrent
 * refreshes sharing one cookie jar, which is exactly what a browser
 * restoring two tabs does.
 *
 * Both apps, per this project's mirrored-auth standing rule: they share
 * one TokenService, but "shared code, therefore fine" is the assumption
 * that has already broken this project's auth twice.
 */

const LOADS = 6;

test('staff: two concurrent refreshes sharing one cookie do not end the session', async ({ page }) => {
  const fixture = readFixture('mastersCrud');
  await login(page, fixture);

  // Both requests read the cookie before either response can update it —
  // the same token presented twice. Deterministic, unlike a navigation
  // race, and a faithful model of a browser restoring two tabs.
  const statuses = await page.evaluate(async (apiUrl) => {
    const results = await Promise.all([
      fetch(`${apiUrl}/api/v1/auth/refresh`, { method: 'POST', credentials: 'include' }),
      fetch(`${apiUrl}/api/v1/auth/refresh`, { method: 'POST', credentials: 'include' }),
    ]);
    return results.map((r) => r.status);
  }, API_URL);

  // Pre-fix the second was a 401 AND it revoked the family, so the
  // session was already dead at this point.
  expect(statuses).toEqual([200, 200]);

  // The session still works for a real navigation afterwards.
  await page.goto('/admin/config');
  await expect(page).not.toHaveURL(/\/login$/);
  await expect(page.getByRole('heading', { name: 'Company Config' })).toBeVisible();
});

test('staff: a burst of full page loads does not end the session', async ({ page }) => {
  const fixture = readFixture('mastersCrud');
  await login(page, fixture);

  for (let i = 0; i < LOADS; i++) {
    await page.goto('/admin/config');
  }

  await expect(page).not.toHaveURL(/\/login$/);
  await expect(page.getByRole('heading', { name: 'Company Config' })).toBeVisible();

  // Genuinely usable afterwards, not merely still-rendering from a stale
  // in-memory access token.
  await page.goto('/admin/hierarchy');
  await expect(page.getByRole('heading', { name: 'Reporting hierarchy' })).toBeVisible();
});

async function loginPortal(page: import('@playwright/test').Page) {
  const fixture = readFixture('ticketReply');
  await page.goto(`${PORTAL_URL}/portal/login`);
  await page.locator('#identifier').fill(fixture.portalIdentifier!);
  await page.locator('#password').fill(fixture.portalPassword!);
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page).toHaveURL(/\/portal\/profile$/);
}

test('portal: two concurrent refreshes sharing one cookie do not end the session', async ({ page }) => {
  await loginPortal(page);

  const statuses = await page.evaluate(async (apiUrl) => {
    const results = await Promise.all([
      fetch(`${apiUrl}/api/v1/portal/auth/refresh`, { method: 'POST', credentials: 'include' }),
      fetch(`${apiUrl}/api/v1/portal/auth/refresh`, { method: 'POST', credentials: 'include' }),
    ]);
    return results.map((r) => r.status);
  }, API_URL);

  expect(statuses).toEqual([200, 200]);

  await page.goto(`${PORTAL_URL}/portal/profile`);
  await expect(page).toHaveURL(/\/portal\/profile$/);
});

test('portal: a burst of full page loads does not end the session', async ({ page }) => {
  await loginPortal(page);

  for (let i = 0; i < LOADS; i++) {
    await page.goto(`${PORTAL_URL}/portal/profile`);
  }

  await expect(page).not.toHaveURL(/\/portal\/login$/);
  await expect(page).toHaveURL(/\/portal\/profile$/);
});
