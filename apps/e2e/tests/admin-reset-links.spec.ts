import { test, expect, type Browser, type Page } from '@playwright/test';
import { createSystemPrismaClient } from '@openestate/db';
import { NO_PORTAL_ACCOUNT_ERROR, SYSTEM_ROLES } from '@openestate/shared';
import * as argon2 from '@node-rs/argon2';
import { readFixture } from '../fixtures/state';
import { login } from '../fixtures/actions';
import type { E2eFixture } from '../fixtures/seed';
import { DATABASE_URL_SYSTEM, PORTAL_URL, WEB_URL } from '../playwright.config';

/**
 * Admin-generated password-reset links, staff and portal, driven through
 * the real UI end to end: an admin generates a link, the link is read off
 * the page exactly as the admin would copy it, and the recipient — in a
 * fresh, logged-out browser context, like someone opening a WhatsApp
 * message — uses it to set a password and then logs in with it.
 *
 * Throttle budget: staff POST /auth/password-reset/confirm sits behind
 * PasswordChangeThrottlerGuard at 5 per 300s per IP. This harness does NOT
 * raise that limit, and the counter lives in Redis, so it survives from one
 * Playwright run to the next. This file spends exactly 2 per run (B1's
 * successful confirm, B2's rejected one). Adding a third would let two
 * back-to-back local runs trip a 429 that looks like a logic failure.
 * The portal confirm and portal login are on the 'portal-auth' bucket,
 * which the harness raises to 100.
 */

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

let fixture: E2eFixture;
let prisma: ReturnType<typeof createSystemPrismaClient>;
let staffRoleId: string;
let portalUserId: string;
let portalApplicantId: string;

test.beforeAll(async () => {
  fixture = readFixture('resetLinks');
  prisma = createSystemPrismaClient(DATABASE_URL_SYSTEM);
  staffRoleId = (
    await prisma.role.findFirstOrThrow({ where: { companyId: fixture.companyId, slug: SYSTEM_ROLES.SUPER_ADMIN } })
  ).id;
  const portalUser = await prisma.user.findFirstOrThrow({
    where: { companyId: fixture.companyId, phone: fixture.portalIdentifier },
  });
  portalUserId = portalUser.id;
  portalApplicantId = portalUser.applicantId!;
});

test.afterAll(async () => {
  await prisma?.$disconnect();
});

async function createStaffTarget(label: string) {
  const email = `e2e-reset-${label}-${Date.now()}@test.com`;
  const password = 'OriginalPass#123';
  const user = await prisma.user.create({
    data: {
      companyId: fixture.companyId,
      email,
      name: `E2E Reset ${label}`,
      passwordHash: await argon2.hash(password, { algorithm: argon2.Algorithm.Argon2id }),
      roleId: staffRoleId,
      forcePasswordChange: false,
    },
  });
  return { id: user.id, email, password };
}

/**
 * Clicks "Generate reset link" on UserForm and returns the URL exactly as
 * the reveal panel shows it (read from the DOM, not the clipboard), plus
 * the response's expiresAt. `previousUrl` makes the read wait for the panel
 * to show the NEW link rather than racing a re-render.
 */
async function generateStaffLink(page: Page, previousUrl?: string) {
  const [res] = await Promise.all([
    page.waitForResponse((r) => r.url().endsWith('/force-password-reset') && r.request().method() === 'POST'),
    page.getByRole('button', { name: 'Generate reset link' }).click(),
  ]);
  expect(res.status()).toBe(200);
  const { expiresAt } = (await res.json()) as { expiresAt: string };
  const code = page.locator('code', { hasText: '/reset-password?token=' });
  await expect(code).toBeVisible();
  if (previousUrl) await expect(code).not.toHaveText(previousUrl);
  return { url: ((await code.textContent()) ?? '').trim(), expiresAt };
}

/**
 * The production-critical assertion: the link the admin copies must be
 * EXACTLY `<the admin's own page origin><path>?token=<uuid>` — nothing more
 * in the query, no fragment, no bare token. Compared as a whole string
 * because that string is what gets pasted into WhatsApp.
 */
function expectLink(raw: string, expectedPath: string): URL {
  const url = new URL(raw);
  const token = url.searchParams.get('token') ?? '';
  expect(token).toMatch(UUID_RE);
  expect(raw).toBe(`${WEB_URL}${expectedPath}?token=${token}`);
  return url;
}

async function staffLoginOutcome(browser: Browser, email: string, password: string) {
  const context = await browser.newContext();
  try {
    const p = await context.newPage();
    await p.goto('/login');
    await p.locator('#email').fill(email);
    await p.locator('#password').fill(password);
    await p.getByRole('button', { name: 'Sign in' }).click();
    return await Promise.race([
      p.waitForURL(`${WEB_URL}/`).then(() => 'success' as const),
      p.getByText('Invalid credentials').waitFor().then(() => 'refused' as const),
    ]);
  } finally {
    await context.close();
  }
}

test('staff: generate a reset link, use it as the recipient, and log in with the new password', async ({ page, browser }) => {
  const target = await createStaffTarget('happy');
  await login(page, fixture);
  await page.goto(`/admin/users/${target.id}`);

  const { url } = await generateStaffLink(page);
  // No origin rewrite needed for the staff link: the admin is on the staff
  // app, so window.location.origin is the staff app's origin here exactly
  // as it is in production.
  expectLink(url, '/reset-password');

  const newPassword = 'ResetByLink#2026';
  const recipient = await browser.newContext();
  try {
    const rp = await recipient.newPage();
    await rp.goto(url);
    await expect(rp.getByRole('heading', { name: 'Set a new password' })).toBeVisible();
    await rp.locator('#newPassword').fill(newPassword);
    const [confirmRes] = await Promise.all([
      rp.waitForResponse((r) => r.url().endsWith('/auth/password-reset/confirm')),
      rp.getByRole('button', { name: 'Reset password' }).click(),
    ]);
    expect(confirmRes.status()).toBe(204);
    await expect(rp).toHaveURL(`${WEB_URL}/login`);

    await rp.locator('#email').fill(target.email);
    await rp.locator('#password').fill(newPassword);
    await rp.getByRole('button', { name: 'Sign in' }).click();
    await expect(rp).toHaveURL(`${WEB_URL}/`);
  } finally {
    await recipient.close();
  }

  // The old password must be gone, not merely a second one added.
  expect(await staffLoginOutcome(browser, target.email, target.password)).toBe('refused');
});

test('staff: generating a second link supersedes the first, which is then rejected', async ({ page, browser }) => {
  const target = await createStaffTarget('supersede');
  await login(page, fixture);
  await page.goto(`/admin/users/${target.id}`);

  const first = await generateStaffLink(page);
  const second = await generateStaffLink(page, first.url);
  expectLink(first.url, '/reset-password');
  expectLink(second.url, '/reset-password');
  expect(second.url).not.toBe(first.url);

  const recipient = await browser.newContext();
  try {
    const rp = await recipient.newPage();
    await rp.goto(first.url);
    await rp.locator('#newPassword').fill('ShouldNotApply#2026');
    const [confirmRes] = await Promise.all([
      rp.waitForResponse((r) => r.url().endsWith('/auth/password-reset/confirm')),
      rp.getByRole('button', { name: 'Reset password' }).click(),
    ]);
    expect(confirmRes.status()).toBe(401);
    await expect(rp.getByText('Invalid or expired reset token')).toBeVisible();
    await expect(rp).toHaveURL(/\/reset-password\?token=/);
  } finally {
    await recipient.close();
  }

  // The rejected link changed nothing: the original password still works.
  expect(await staffLoginOutcome(browser, target.email, target.password)).toBe('success');
});

test('staff: a portal-linked user gets a link to their customer record, not a reset button', async ({ page }) => {
  await login(page, fixture);
  await page.goto(`/admin/users/${portalUserId}`);

  await expect(page.getByText('This is a portal user.')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Generate reset link' })).toHaveCount(0);

  const recordLink = page.getByRole('link', { name: 'customer record' });
  await expect(recordLink).toHaveAttribute('href', `/postsales/applicants/${portalApplicantId}`);
  await recordLink.click();
  await expect(page).toHaveURL(`${WEB_URL}/postsales/applicants/${portalApplicantId}`);
  await expect(page.getByRole('button', { name: 'Reset portal password' })).toBeVisible();
});

test('portal: generate a reset link from the applicant screen, use it on the portal, and log in', async ({ page, browser }) => {
  await login(page, fixture);
  await page.goto(`/postsales/applicants/${portalApplicantId}`);

  const [res] = await Promise.all([
    page.waitForResponse((r) => r.url().endsWith('/admin/portal-password-resets') && r.request().method() === 'POST'),
    page.getByRole('button', { name: 'Reset portal password' }).click(),
  ]);
  expect(res.status()).toBe(200);
  const code = page.locator('code', { hasText: '/portal/reset-password?token=' });
  await expect(code).toBeVisible();
  const generated = expectLink(((await code.textContent()) ?? '').trim(), '/portal/reset-password');

  // ORIGIN REWRITE — deliberate, do not "fix" it by navigating to the
  // generated link directly. In production the staff SPA and the portal
  // SPA share ONE origin (nginx serves the portal under /portal/), so
  // `${window.location.origin}/portal/reset-password?token=…`, built on the
  // staff page, is correct as-is — and expectLink() above has already
  // asserted that exact string. This harness instead serves the two apps
  // on two different dev origins (staff :5273, portal :5274), so here the
  // generated origin points at the STAFF server. Only the origin is
  // swapped; the /portal prefix is kept, because the portal dev server
  // serves index.html for any path and its BrowserRouter basename="/portal"
  // consumes that prefix exactly as it does in production.
  const portalLink = new URL(generated.pathname + generated.search, PORTAL_URL).toString();

  const newPassword = 'PortalByLink#2026';
  const recipient = await browser.newContext();
  try {
    const rp = await recipient.newPage();
    await rp.goto(portalLink);
    await expect(rp.getByRole('heading', { name: 'Set a new password' })).toBeVisible();
    await rp.locator('#newPassword').fill(newPassword);
    const [confirmRes] = await Promise.all([
      rp.waitForResponse((r) => r.url().endsWith('/portal/auth/password-reset/confirm')),
      rp.getByRole('button', { name: 'Reset password' }).click(),
    ]);
    expect(confirmRes.status()).toBe(204);
    await expect(rp).toHaveURL(`${PORTAL_URL}/portal/login`);

    await rp.locator('#identifier').fill(fixture.portalIdentifier!);
    await rp.locator('#password').fill(newPassword);
    await rp.getByRole('button', { name: 'Sign in' }).click();
    await expect(rp).toHaveURL(`${PORTAL_URL}/portal/profile`);
  } finally {
    await recipient.close();
  }
});

test('portal: an applicant with no portal account gets a calm pointer to the invite, not an error', async ({ page }) => {
  const phone = `8${String(Date.now()).slice(-9)}`;
  const applicant = await prisma.applicant.create({
    data: {
      companyId: fixture.companyId,
      name: `E2E Never Invited ${Date.now()}`,
      primaryPhone: phone,
      primaryPhoneNormalized: phone,
    },
  });

  await login(page, fixture);
  await page.goto(`/postsales/applicants/${applicant.id}`);

  const [res] = await Promise.all([
    page.waitForResponse((r) => r.url().endsWith('/admin/portal-password-resets') && r.request().method() === 'POST'),
    page.getByRole('button', { name: 'Reset portal password' }).click(),
  ]);
  expect(res.status()).toBe(409);
  expect(((await res.json()) as { code?: string }).code).toBe(NO_PORTAL_ACCOUNT_ERROR);

  const message = page.getByText("This person doesn't have a portal account yet");
  await expect(message).toBeVisible();
  await expect(message).not.toHaveClass(/red/);

  // The pointer sits in the same block as the control it points at.
  const block = message.locator('xpath=..');
  await expect(block.getByRole('button', { name: 'Send Portal Invite' })).toBeVisible();
  await expect(block.locator('[class*="text-red"]')).toHaveCount(0);

  // No red toast contradicting the calm message, and no link was issued.
  await expect(page.getByRole('alert')).toHaveCount(0);
  await expect(page.locator('code', { hasText: '/reset-password?token=' })).toHaveCount(0);
});

const COPY_FALLBACK_RE = /^Couldn't copy — link selected, press (Ctrl\+C|⌘C)\.$/;

test('reveal panel: shows the expiry clock time, Copy confirms or falls back to selecting the link, and Dismiss removes it for good', async ({ page }) => {
  const target = await createStaffTarget('panel');
  // Write-only, so the real clipboard write succeeds and "Copied" means it.
  // No clipboard-read is granted and the clipboard contents are never read.
  await page.context().grantPermissions(['clipboard-write'], { origin: WEB_URL });
  await login(page, fixture);
  await page.goto(`/admin/users/${target.id}`);

  const { url, expiresAt } = await generateStaffLink(page);
  const token = new URL(url).searchParams.get('token')!;
  const panel = page.locator('div.border-amber-300').filter({ has: page.locator('code', { hasText: token }) });
  await expect(panel).toBeVisible();

  // The clock time the browser itself renders for the API's expiresAt —
  // same formatter, same locale, so this is exact rather than a guess.
  // The relative "N minutes from now" text is deliberately not asserted.
  const expectedClock = await page.evaluate(
    (iso) => new Date(iso).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' }),
    expiresAt,
  );
  await expect(panel.getByText(`Expires at ${expectedClock}`)).toBeVisible();
  const minutesOut = (new Date(expiresAt).getTime() - Date.now()) / 60_000;
  expect(minutesOut).toBeGreaterThan(28);
  expect(minutesOut).toBeLessThanOrEqual(30.5);

  await panel.getByRole('button', { name: 'Copy', exact: true }).click();
  await expect(panel.getByRole('button', { name: 'Copied', exact: true })).toBeVisible();
  await expect(panel.getByRole('status')).toHaveCount(0);

  await panel.getByRole('button', { name: 'Dismiss', exact: true }).click();
  await expect(page.locator('code', { hasText: token })).toHaveCount(0);
  await expect(page.getByText(token)).toHaveCount(0);

  // The fallback path, which every plain-HTTP install takes: browsers expose
  // navigator.clipboard only on HTTPS or localhost. Removed before the reload
  // so the page never has it, as on such an install.
  await page.addInitScript(() => {
    Object.defineProperty(Navigator.prototype, 'clipboard', { get: () => undefined, configurable: true });
  });

  // Not just hidden — gone. A reload has nothing to bring it back from.
  await page.reload();
  await expect(page.getByRole('button', { name: 'Generate reset link' })).toBeVisible();
  await expect(page.getByText(token)).toHaveCount(0);

  const second = await generateStaffLink(page);
  const secondToken = new URL(second.url).searchParams.get('token')!;
  const fallbackPanel = page
    .locator('div.border-amber-300')
    .filter({ has: page.locator('code', { hasText: secondToken }) });
  await fallbackPanel.getByRole('button', { name: 'Copy', exact: true }).click();
  const fallback = fallbackPanel.getByRole('status');
  await expect(fallback).toHaveText(COPY_FALLBACK_RE);
  await expect(fallback).not.toHaveClass(/red/);
  await expect(fallbackPanel.getByRole('button', { name: 'Copied', exact: true })).toHaveCount(0);
  // The URL itself is what's selected, ready for the admin's Ctrl+C.
  expect(await page.evaluate(() => window.getSelection()?.toString())).toBe(second.url);
});
