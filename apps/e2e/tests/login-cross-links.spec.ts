import { test, expect } from '@playwright/test';
import { PORTAL_URL } from '../playwright.config';

/**
 * Cross-navigation links between the staff and portal login screens. Real
 * problem: a customer who received a portal link once has no way to find
 * the portal again without remembering the URL — there was previously no
 * link between the two login screens in either direction.
 *
 * Asserts the href, not a click-through: the two apps are separate origins
 * in this harness (staff :5273, portal :5274, see playwright.config.ts),
 * matching dev but not production (same origin, portal under /portal/ —
 * see deploy/native/nginx). Clicking would navigate to a dead path here.
 * The href itself is exactly what's correct in production.
 */

test('staff login links to the portal login', async ({ page }) => {
  await page.goto('/login');
  const link = page.getByRole('link', { name: 'Customer or broker? Go to the portal' });
  await expect(link).toBeVisible();
  await expect(link).toHaveAttribute('href', '/portal/');
});

test('portal login links to the staff login', async ({ page }) => {
  await page.goto(`${PORTAL_URL}/portal/login`);
  const link = page.getByRole('link', { name: 'Staff member? Go to the staff login' });
  await expect(link).toBeVisible();
  await expect(link).toHaveAttribute('href', '/');

  // Also present alongside the pre-existing Forgot password link, and both
  // gone once mid-2FA — following that link's own established precedent
  // (neither is relevant while entering a 6-digit code).
  await expect(page.getByRole('link', { name: 'Forgot password?' })).toBeVisible();
});
