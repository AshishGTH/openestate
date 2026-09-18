import { test, expect } from '@playwright/test';
import { createSystemPrismaClient } from '@openestate/db';
import { readFixture } from '../fixtures/state';
import { login } from '../fixtures/actions';
import { currentTotpCode } from '../fixtures/totp';
import type { E2eFixture } from '../fixtures/seed';
import { DATABASE_URL_SYSTEM, PORTAL_URL } from '../playwright.config';

/**
 * Portal counterpart of admin-2fa-reset.spec.ts. The customer turns 2FA on
 * in the portal's Security page; a staff admin resets it from the
 * customer's record in the staff app (Applicant360) through a real
 * window.confirm; the customer's open portal session ends on its next load,
 * and a fresh portal sign-in needs the password alone.
 *
 * Its own fixture company and portal user (portalTotpReset): this spec
 * turns 2FA on for that account, which would break any other spec that
 * signs in as it.
 */

let fixture: E2eFixture;
let prisma: ReturnType<typeof createSystemPrismaClient>;
let applicantId: string;

test.beforeAll(async () => {
  fixture = readFixture('portalTotpReset');
  prisma = createSystemPrismaClient(DATABASE_URL_SYSTEM);
  const portalUser = await prisma.user.findFirstOrThrow({
    where: { companyId: fixture.companyId, phone: fixture.portalIdentifier },
  });
  applicantId = portalUser.applicantId!;
});

test.afterAll(async () => {
  await prisma?.$disconnect();
});

test('portal: admin resets a customer\'s 2FA from their record — their session ends and the password alone signs in', async ({ page, browser }) => {
  // ── The customer turns 2FA on in the portal. ──
  const customerContext = await browser.newContext();
  const cp = await customerContext.newPage();
  try {
    await cp.goto(`${PORTAL_URL}/portal/login`);
    await cp.locator('#identifier').fill(fixture.portalIdentifier!);
    await cp.locator('#password').fill(fixture.portalPassword!);
    await cp.getByRole('button', { name: 'Sign in' }).click();
    await expect(cp).toHaveURL(/\/portal\/profile$/);

    await cp.goto(`${PORTAL_URL}/portal/security`);
    const [setupResponse] = await Promise.all([
      cp.waitForResponse((r) => r.url().includes('/portal/auth/totp/setup') && r.ok()),
      cp.getByRole('button', { name: 'Enable 2FA' }).click(),
    ]);
    const { secret } = (await setupResponse.json()) as { secret: string };
    await cp.locator('input[inputmode="numeric"]').pressSequentially(currentTotpCode(secret));
    await cp.getByRole('button', { name: 'Confirm' }).click();
    await expect(cp.getByText('Save these recovery codes — shown once')).toBeVisible();
    await cp.getByRole('button', { name: 'Done' }).click();

    // ── A staff admin resets it from the customer's record. ──
    await login(page, fixture);
    await page.goto(`/postsales/applicants/${applicantId}`);
    const resetButton = page.getByRole('button', { name: 'Reset portal 2FA' });
    await expect(resetButton).toBeVisible();

    let dialogText = '';
    page.once('dialog', (d) => {
      dialogText = d.message();
      void d.accept();
    });
    const [first] = await Promise.all([
      page.waitForResponse((r) => r.url().endsWith('/admin/portal-2fa-resets') && r.request().method() === 'POST'),
      resetButton.click(),
    ]);
    expect(first.status()).toBe(200);
    expect(await first.json()).toEqual({ wasEnabled: true });
    expect(dialogText).toMatch(/portal account/);
    await expect(page.getByRole('status').filter({ hasText: 'Two-factor authentication cleared' })).toBeVisible();

    // A second reset finds nothing to clear, and says so.
    page.once('dialog', (d) => void d.accept());
    const [second] = await Promise.all([
      page.waitForResponse((r) => r.url().endsWith('/admin/portal-2fa-resets') && r.request().method() === 'POST'),
      resetButton.click(),
    ]);
    expect(await second.json()).toEqual({ wasEnabled: false });
    await expect(page.getByRole('status').filter({ hasText: 'already off' })).toBeVisible();

    // ── The customer's open portal session ends on its next load. ──
    await cp.reload();
    await expect(cp).toHaveURL(/\/portal\/login$/);
  } finally {
    await customerContext.close();
  }

  // ── A fresh portal sign-in needs the password alone. ──
  const fresh = await browser.newContext();
  try {
    const fp = await fresh.newPage();
    await fp.goto(`${PORTAL_URL}/portal/login`);
    await fp.locator('#identifier').fill(fixture.portalIdentifier!);
    await fp.locator('#password').fill(fixture.portalPassword!);
    await fp.getByRole('button', { name: 'Sign in' }).click();
    await expect(fp).toHaveURL(/\/portal\/profile$/);
    await expect(fp.locator('#totp')).toHaveCount(0);
  } finally {
    await fresh.close();
  }
});
