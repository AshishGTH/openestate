import { test, expect } from '@playwright/test';
import { readFixture } from '../fixtures/state';
import { currentTotpCode } from '../fixtures/totp';
import { PORTAL_URL } from '../playwright.config';

// Portal counterpart to auth-2fa.spec.ts — portal 2FA enrolment has never
// been browser-tested at all before this (existing coverage is staff-only).
// Mirrors that spec's shape exactly where the two apps genuinely are the
// same (TotpService, totpVerifySchema, and Security.tsx's enrolment UI are
// byte-for-byte the same as Settings.tsx's — CLAUDE.md's "TOTP enrolment
// gets a real QR code" entry), and diverges only where the portal genuinely
// does: no forced-password-change gate exists on this side at all (a
// deliberate Phase 6 decision, not a gap), and 2FA verification is inline
// in Login.tsx (a #totp input, no separate heading, the SAME "Sign in"
// button relabels itself "Verify") rather than staff's separate routed
// TotpVerify.tsx (#code, a dedicated "Two-Factor Authentication" heading).
//
// Adds one scenario auth-2fa.spec.ts doesn't cover on either side: Disable
// 2FA, and a login afterward proving no code is asked for — genuinely new
// coverage, not just a mirror. Recovery-code login stays out of this spec
// (tracked separately) — the shared totpVerifySchema and TotpService make
// it very likely to behave the same as staff's untested-either-side path,
// but "very likely" isn't "verified," and it needs its own sequencing to
// consume a code safely.
//
// Exactly two full page.goto() navigations (the initial /portal/login, and
// the first /portal/security visit) — matching auth-2fa.spec.ts's own
// count, deliberately, to keep this spec's exposure to the documented
// refresh-rotation race (CLAUDE.md, "Pre-sales reporting suite (PR #27)")
// no higher than that already-stable spec's. The second security visit
// (after the 2FA-gated login) uses the in-app "Security" nav link instead
// of a second goto — client-side routing, no extra AuthProvider mount, no
// extra /auth/refresh call — which also exercises the portal's real nav,
// not just deep-linking.
test('portal: 2FA enrollment → login with a TOTP code → disable → login needs no code', async ({ page }) => {
  const fixture = readFixture('portalTwoFactor');

  await page.goto(`${PORTAL_URL}/portal/login`);
  await page.locator('#identifier').fill(fixture.portalIdentifier!);
  await page.locator('#password').fill(fixture.portalPassword!);
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page).toHaveURL(/\/portal\/profile$/);

  await page.goto(`${PORTAL_URL}/portal/security`);
  const [setupResponse] = await Promise.all([
    page.waitForResponse((r) => r.url().includes('/portal/auth/totp/setup') && r.ok()),
    page.getByRole('button', { name: 'Enable 2FA' }).click(),
  ]);
  const { secret } = (await setupResponse.json()) as { secret: string };

  // Server-rendered QR — the manual-entry secret below it must still be
  // shown too, as a fallback, not replaced by the image (mirrors
  // auth-2fa.spec.ts's identical assertion against the same component).
  await expect(page.locator('img[src^="data:image/svg+xml"]')).toBeVisible();
  await expect(page.getByText(secret)).toBeVisible();

  await page.locator('input[inputmode="numeric"]').fill(currentTotpCode(secret));
  await page.getByRole('button', { name: 'Confirm' }).click();
  await expect(page.getByText('Save these recovery codes — shown once')).toBeVisible();
  await page.getByRole('button', { name: 'Done' }).click();

  await page.getByRole('button', { name: 'Sign out' }).click();
  await expect(page).toHaveURL(/\/portal\/login$/);

  // Log in again — this account now has 2FA, so login returns a tempToken
  // instead of a session. Portal folds verification into the SAME form
  // (no page.goto, matching the staff spec's own re-use of its already-
  // loaded login form): the #identifier/#password fields are replaced by
  // #totp, and the same submit button relabels "Sign in" -> "Verify".
  await page.locator('#identifier').fill(fixture.portalIdentifier!);
  await page.locator('#password').fill(fixture.portalPassword!);
  await page.getByRole('button', { name: 'Sign in' }).click();

  await expect(page.locator('#totp')).toBeVisible();
  await page.locator('#totp').fill(currentTotpCode(secret));
  await page.getByRole('button', { name: 'Verify' }).click();
  await expect(page).toHaveURL(/\/portal\/profile$/);

  // Disable 2FA — new coverage beyond auth-2fa.spec.ts, on either side.
  // Reached via the real in-app nav link, from a session that just
  // authenticated with a 2FA code (not leftover component state from the
  // enrolment step above), so /portal/auth/me's refetch here is a genuine
  // proof the account is enabled, not an assumption carried over.
  await page.getByRole('link', { name: 'Security' }).click();
  await expect(page).toHaveURL(/\/portal\/security$/);
  await expect(page.getByText('2FA is enabled on your account.')).toBeVisible();

  await Promise.all([
    page.waitForResponse((r) => r.url().includes('/portal/auth/totp/disable') && r.ok()),
    page.getByRole('button', { name: 'Disable 2FA' }).click(),
  ]);
  await expect(page.getByText('2FA is not enabled.')).toBeVisible();

  await page.getByRole('button', { name: 'Sign out' }).click();
  await expect(page).toHaveURL(/\/portal\/login$/);

  // Final proof: logging in now goes straight through, no #totp prompt —
  // disable actually took effect server-side, not just in the UI.
  await page.locator('#identifier').fill(fixture.portalIdentifier!);
  await page.locator('#password').fill(fixture.portalPassword!);
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page).toHaveURL(/\/portal\/profile$/);
  await expect(page.locator('#totp')).toHaveCount(0);
});
