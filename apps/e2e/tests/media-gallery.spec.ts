import { test, expect, type Page } from '@playwright/test';
import { readFixture } from '../fixtures/state';
import { login, controlAfterLabel } from '../fixtures/actions';
import { API_URL, PORTAL_URL } from '../playwright.config';

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

  const downloadLink = page.getByRole('button', { name: `Layout Plan: ${fileName}` });
  await expect(downloadLink).toBeVisible();
  const [download] = await Promise.all([page.waitForEvent('download'), downloadLink.click()]);
  expect(download.suggestedFilename()).toBe(fileName);
});

test('a staff-published construction-progress photo renders as a real image in the portal, not just a count', async ({ page, request }) => {
  const fixture = readFixture('ticketReply');

  // No staff web UI exists for construction updates at all (confirmed by
  // grep before writing this — CLAUDE.md's PORTALS-phase entry) — the
  // backend has always been API-only for this. Set up over real HTTP,
  // same authenticated session shape supertest e2e tests use, then
  // verify the RENDER through the actual browser, which is the thing
  // this scenario exists to prove.
  const loginRes = await request.post(`${API_URL}/api/v1/auth/login`, {
    data: { email: fixture.adminEmail, password: fixture.adminPassword },
  });
  expect(loginRes.ok()).toBeTruthy();
  const { accessToken } = (await loginRes.json()) as { accessToken: string };
  const csrf = (await request.storageState()).cookies.find((c) => c.name === 'openestate_csrf')?.value;
  const authHeaders = { Authorization: `Bearer ${accessToken}`, 'X-CSRF-Token': csrf ?? '' };

  const updateTitle = `E2E Construction Update ${Date.now()}`;
  const createRes = await request.post(`${API_URL}/api/v1/admin/construction-updates`, {
    headers: authHeaders,
    data: { projectId: fixture.projectId, title: updateTitle, publishedAt: new Date().toISOString() },
  });
  expect(createRes.ok()).toBeTruthy();
  const update = (await createRes.json()) as { id: string };

  const mediaRes = await request.post(`${API_URL}/api/v1/admin/construction-updates/${update.id}/media`, {
    headers: authHeaders,
    multipart: { file: { name: 'progress.png', mimeType: 'image/png', buffer: ONE_PX_PNG } },
  });
  expect(mediaRes.ok()).toBeTruthy();

  await loginPortal(page, fixture.portalIdentifier!, fixture.portalPassword!);
  await page.goto(`${PORTAL_URL}/portal/property`);
  await expect(page.getByText(updateTitle)).toBeVisible();

  const img = page.locator('img[alt="progress.png"]');
  await expect(img).toBeVisible();
  await expect(img).toHaveJSProperty('complete', true);
  const src = await img.getAttribute('src');
  expect(src).toMatch(/^blob:/);
});
