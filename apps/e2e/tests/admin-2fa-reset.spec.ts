import { test, expect, type Page } from '@playwright/test';
import { createSystemPrismaClient } from '@openestate/db';
import { SYSTEM_ROLES } from '@openestate/shared';
import * as argon2 from '@node-rs/argon2';
import { readFixture } from '../fixtures/state';
import { login } from '../fixtures/actions';
import { currentTotpCode } from '../fixtures/totp';
import type { E2eFixture } from '../fixtures/seed';
import { DATABASE_URL_SYSTEM, WEB_URL } from '../playwright.config';

/**
 * Admin 2FA reset for a staff user, driven entirely through the real UI:
 * the victim turns 2FA on in their own Settings, an admin resets it from
 * the user's edit screen through a real window.confirm, and then:
 *
 *  - the victim's ORIGINAL browser, still signed in, is signed out on its
 *    next page load — the reset revoked its refresh token, and the access
 *    token lives only in memory, so a reload has nothing left to renew with;
 *  - a fresh sign-in with the password alone lands on the dashboard, with no
 *    two-factor screen;
 *  - the admin's own screen flips to "not enabled" with the button disabled.
 *
 * Its own fixture company (staffTotpReset): this spec turns 2FA on and off
 * for users in that company.
 */

let fixture: E2eFixture;
let prisma: ReturnType<typeof createSystemPrismaClient>;

test.beforeAll(async () => {
  fixture = readFixture('staffTotpReset');
  prisma = createSystemPrismaClient(DATABASE_URL_SYSTEM);
});

test.afterAll(async () => {
  await prisma?.$disconnect();
});

async function createVictim() {
  const role = await prisma.role.findFirstOrThrow({
    where: { companyId: fixture.companyId, slug: SYSTEM_ROLES.SUPER_ADMIN },
  });
  const email = `e2e-totp-reset-${Date.now()}@test.com`;
  const password = 'VictimPassword#2026';
  const user = await prisma.user.create({
    data: {
      companyId: fixture.companyId,
      email,
      name: `E2E 2FA Victim ${Date.now()}`,
      passwordHash: await argon2.hash(password, { algorithm: argon2.Algorithm.Argon2id }),
      roleId: role.id,
      forcePasswordChange: false,
    },
  });
  return { id: user.id, email, password, name: user.name };
}

async function signIn(page: Page, email: string, password: string) {
  await page.goto('/login');
  await page.locator('#email').fill(email);
  await page.locator('#password').fill(password);
  await page.getByRole('button', { name: 'Sign in' }).click();
}

test('staff: admin resets a user\'s 2FA — their open session ends and the password alone signs in', async ({ page, browser }) => {
  const victim = await createVictim();

  // ── The victim turns 2FA on, through their own Settings page. ──
  const victimContext = await browser.newContext();
  const vp = await victimContext.newPage();
  try {
    await signIn(vp, victim.email, victim.password);
    await expect(vp).toHaveURL(`${WEB_URL}/`);
    await vp.goto('/settings');
    const [setupResponse] = await Promise.all([
      vp.waitForResponse((r) => r.url().includes('/auth/totp/setup') && r.ok()),
      vp.getByRole('button', { name: 'Enable 2FA' }).click(),
    ]);
    const { secret } = (await setupResponse.json()) as { secret: string };
    await vp.locator('input[inputmode="numeric"]').pressSequentially(currentTotpCode(secret));
    await vp.getByRole('button', { name: 'Confirm' }).click();
    await expect(vp.getByText('Save these recovery codes — shown once')).toBeVisible();
    await vp.getByRole('button', { name: 'Done' }).click();

    // ── The admin resets it. ──
    await login(page, fixture);
    await page.goto(`/admin/users/${victim.id}`);
    const section = page.locator('div', { has: page.getByRole('heading', { name: 'Two-factor authentication' }) }).last();
    await expect(section.getByText(/^2FA is on\./)).toBeVisible();
    const resetButton = section.getByRole('button', { name: 'Reset 2FA' });
    await expect(resetButton).toBeEnabled();

    // Cancelling the confirm sends nothing and changes nothing.
    let resetRequests = 0;
    page.on('request', (r) => {
      if (r.url().endsWith('/reset-2fa')) resetRequests++;
    });
    page.once('dialog', (d) => d.dismiss());
    await resetButton.click();
    await expect(resetButton).toBeEnabled();
    expect(resetRequests).toBe(0);

    // Accepting it resets — and the dialog names the user it will affect.
    let dialogText = '';
    page.once('dialog', (d) => {
      dialogText = d.message();
      void d.accept();
    });
    const [resetResponse] = await Promise.all([
      page.waitForResponse((r) => r.url().endsWith(`/users/${victim.id}/reset-2fa`) && r.request().method() === 'POST'),
      resetButton.click(),
    ]);
    expect(resetResponse.status()).toBe(200);
    expect(await resetResponse.json()).toEqual({ wasEnabled: true });
    expect(dialogText).toContain(victim.name);
    await expect(section.getByRole('status')).toHaveText(/Two-factor authentication cleared/);

    // The screen re-reads the user: 2FA now off, button disabled.
    await expect(section.getByText('2FA is not enabled on this account.')).toBeVisible();
    await expect(resetButton).toBeDisabled();

    // ── The victim's open browser is signed out on its next load. ──
    await vp.reload();
    await expect(vp).toHaveURL(`${WEB_URL}/login`);
  } finally {
    await victimContext.close();
  }

  // ── A fresh sign-in needs the password alone. ──
  const fresh = await browser.newContext();
  try {
    const fp = await fresh.newPage();
    await signIn(fp, victim.email, victim.password);
    await expect(fp).toHaveURL(`${WEB_URL}/`);
    await expect(fp.getByRole('heading', { name: 'Two-Factor Authentication' })).toHaveCount(0);
    await expect(fp.getByRole('button', { name: 'Sign out' })).toBeVisible();
  } finally {
    await fresh.close();
  }
});

test('staff: for a user without 2FA the reset button is disabled', async ({ page }) => {
  const victim = await createVictim();
  await login(page, fixture);
  await page.goto(`/admin/users/${victim.id}`);
  const section = page.locator('div', { has: page.getByRole('heading', { name: 'Two-factor authentication' }) }).last();
  await expect(section.getByText('2FA is not enabled on this account.')).toBeVisible();
  await expect(section.getByRole('button', { name: 'Reset 2FA' })).toBeDisabled();
});
