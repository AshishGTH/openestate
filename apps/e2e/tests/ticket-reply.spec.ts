import { test, expect, type Page } from '@playwright/test';
import { readFixture } from '../fixtures/state';
import { login } from '../fixtures/actions';
import { PORTAL_URL } from '../playwright.config';

// v0.2.1's whole point: customers could raise tickets and staff had no UI
// to answer at all (see CLAUDE.md's PORTALS-phase entry). This is the one
// scenario in the harness that drives BOTH apps/portal and apps/web in a
// single test — the round-trip across both is the actual feature, not
// either half in isolation.

async function loginPortal(page: Page, identifier: string, password: string) {
  await page.goto(`${PORTAL_URL}/portal/login`);
  await page.locator('#identifier').fill(identifier);
  await page.locator('#password').fill(password);
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page).toHaveURL(/\/portal\/profile$/);
}

test('customer raises a ticket, staff replies and resolves it, customer sees the reply', async ({ page }) => {
  const fixture = readFixture('ticketReply');
  const subject = `E2E leaking tap ${Date.now()}`;

  // 1. Customer raises a ticket in the portal.
  await loginPortal(page, fixture.portalIdentifier!, fixture.portalPassword!);
  await page.goto(`${PORTAL_URL}/portal/tickets`);
  await page.getByRole('button', { name: 'Raise query' }).click();
  await page.getByRole('combobox').selectOption({ label: fixture.ticketCategoryName! });
  await page.getByPlaceholder('Subject').fill(subject);
  await page.getByPlaceholder('How can we help?').fill('The kitchen tap has been leaking for two days.');
  await page.getByRole('button', { name: 'Submit' }).click();
  await expect(page.getByText(subject)).toBeVisible();

  // 2. Staff sees it in the queue and opens the thread.
  await login(page, fixture);
  await page.goto('/support/tickets');
  await page.getByRole('link', { name: subject }).click();
  await expect(page).toHaveURL(/\/support\/tickets\/.+/);
  await expect(page.getByText('The kitchen tap has been leaking for two days.')).toBeVisible();
  // Enrichment (task 71): the queue/thread resolve the raiser's real name,
  // not a bare applicantId.
  await expect(page.getByRole('heading', { name: subject })).toBeVisible();

  // 3. Staff replies.
  const replyBody = 'A plumber has been scheduled for tomorrow morning.';
  await page.locator('textarea').fill(replyBody);
  await Promise.all([
    page.waitForResponse((r) => r.url().includes('/respond') && r.request().method() === 'POST' && r.status() !== 401),
    page.getByRole('button', { name: 'Send Reply' }).click(),
  ]);
  await expect(page.getByText(replyBody)).toBeVisible();

  // 4. Staff marks it resolved.
  await Promise.all([
    page.waitForResponse((r) => r.url().includes('/status') && r.request().method() === 'PATCH' && r.status() !== 401),
    page.getByRole('button', { name: 'Mark RESOLVED' }).click(),
  ]);
  await expect(page.getByText('Status: RESOLVED')).toBeVisible();

  // 5. Customer sees the reply and the resolved status back in the portal
  // — the refresh cookie silently re-authenticates the session on this
  // fresh navigation, same as a real user reopening the tab.
  await page.goto(`${PORTAL_URL}/portal/tickets`);
  await page.getByText(subject).click();
  await expect(page).toHaveURL(/\/portal\/tickets\/.+/);
  await expect(page.getByText(replyBody)).toBeVisible();
  await expect(page.getByText('RESOLVED')).toBeVisible();
});
