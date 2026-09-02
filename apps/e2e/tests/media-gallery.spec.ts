import { test, expect, type Page } from '@playwright/test';
import { readFixture } from '../fixtures/state';
import { login, controlAfterLabel } from '../fixtures/actions';
import { PORTAL_URL } from '../playwright.config';

// v0.2.2: layout plan/brochure/photo uploads, plus a real serving route
// for the pre-existing construction-progress gallery (it had an upload
// path but never a way to actually SEE a photo — only a count). Reuses
// the 'ticketReply' fixture for its portal login + real booking (added
// in this same release so RLS grants the portal session access to the
// fixture's project), not for anything ticket-related.

async function loginPortal(page: Page, identifier: string, password: string) {
  await page.goto(`${PORTAL_URL}/portal/login`);
  await page.locator('#identifier').fill(identifier);
  await page.locator('#password').fill(password);
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page).toHaveURL(/\/portal\/profile$/);
}

const ONE_PX_PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=',
  'base64',
);

test('staff uploads a layout plan through the real UI; the customer sees and downloads it in the portal', async ({ page }) => {
  const fixture = readFixture('ticketReply');
  const fileName = `layout-plan-${Date.now()}.pdf`;

  await login(page, fixture);
  await page.goto('/inventory/projects');
  await page.getByRole('link', { name: fixture.projectName }).click();

  await controlAfterLabel(page, 'File').setInputFiles({
    name: fileName,
    mimeType: 'application/pdf',
    buffer: Buffer.from('%PDF-1.4\n%%EOF'),
  });
  const [uploadResponse] = await Promise.all([
    page.waitForResponse((r) => r.url().endsWith('/media') && r.request().method() === 'POST'),
    page.getByRole('button', { name: 'Upload' }).click(),
  ]);
  expect(uploadResponse.ok()).toBe(true);
  await expect(page.getByText(fileName)).toBeVisible();

  await loginPortal(page, fixture.portalIdentifier!, fixture.portalPassword!);
  await page.goto(`${PORTAL_URL}/portal/property`);
  await expect(page.getByText('Layout plans & brochures')).toBeVisible();

  // Phase D (plotted-farmhouse-inventory.md §14): the SAME portal session
  // also has a LAND_BASED booking (this fixture's own withPortalTicketSetup
  // block) — piggybacked on this already-authenticated visit to
  // /portal/property rather than a fresh spec+login, since the whole
  // Playwright suite finishes well inside the portal-auth throttle's
  // 5-minute window and every login in the harness shares that one
  // 5-request budget (found live: a standalone fixture+login here
  // intermittently 429'd OTHER spec files' logins).
  // Shape-conditional rendering: "group · Plot N", not "tower · floor · Unit N".
  await expect(page.getByText(`${fixture.landGroupName} · Plot ${fixture.landPlotNumber}`)).toBeVisible();
  await expect(page.getByText(fixture.landProjectName!)).toBeVisible();
  // Land area shown in the PROJECT's default unit (GUNTA), not the plot's
  // own entered unit (ACRE) — 0.372 acre === 14.88 gunta exactly.
  await expect(page.getByText('14.88 gunta')).toBeVisible();

  const downloadLink = page.getByRole('button', { name: `Layout Plan: ${fileName}` });
  await expect(downloadLink).toBeVisible();
  const [download] = await Promise.all([page.waitForEvent('download'), downloadLink.click()]);
  expect(download.suggestedFilename()).toBe(fileName);
});

test('staff publishes a construction update with a photo through the real UI; the customer sees it and the photo renders in the portal', async ({ page }) => {
  const fixture = readFixture('ticketReply');
  const updateTitle = `E2E Construction Update ${Date.now()}`;

  // The staff UI for this now exists (Construction Updates panel on
  // ProjectDetail) — drives the real form/upload, not raw HTTP, which is
  // the whole point of this scenario per CLAUDE.md's "frontend
  // request-construction changes need a browser click-through" rule: a
  // request built by hand can never prove the frontend builds it correctly.
  await login(page, fixture);
  await page.goto('/inventory/projects');
  await page.getByRole('link', { name: fixture.projectName }).click();

  await controlAfterLabel(page, 'Title').fill(updateTitle);
  await controlAfterLabel(page, 'Description').fill('3rd floor slab cast');
  await controlAfterLabel(page, 'Date').fill(new Date().toISOString().slice(0, 10));
  const [createResponse] = await Promise.all([
    page.waitForResponse((r) => r.url().endsWith('/admin/construction-updates') && r.request().method() === 'POST'),
    page.getByRole('button', { name: 'Publish Update' }).click(),
  ]);
  expect(createResponse.ok()).toBe(true);
  await expect(page.getByText(updateTitle)).toBeVisible();

  const updateRow = page.locator('li', { hasText: updateTitle });
  await updateRow.locator('input[type="file"]').setInputFiles({
    name: 'progress.png',
    mimeType: 'image/png',
    buffer: ONE_PX_PNG,
  });
  const [mediaResponse] = await Promise.all([
    page.waitForResponse((r) => r.url().endsWith('/media') && r.request().method() === 'POST'),
    updateRow.getByRole('button', { name: 'Add Photo' }).click(),
  ]);
  expect(mediaResponse.ok()).toBe(true);
  await expect(updateRow.getByText('progress.png')).toBeVisible();

  await loginPortal(page, fixture.portalIdentifier!, fixture.portalPassword!);
  await page.goto(`${PORTAL_URL}/portal/property`);
  await expect(page.getByText(updateTitle)).toBeVisible();

  const img = page.locator('img[alt="progress.png"]');
  await expect(img).toBeVisible();
  await expect(img).toHaveJSProperty('complete', true);
  const src = await img.getAttribute('src');
  expect(src).toMatch(/^blob:/);
});
