import { test, expect } from '@playwright/test';
import { readFixture } from '../fixtures/state';
import { login, controlAfterLabel } from '../fixtures/actions';

// Regression coverage for a "check before building" item: FollowUp.
// createdById has been captured on every follow-up since Phase 3, and
// FollowUpService.findAllForInquiry already fetched it (`include:
// { createdBy: true }`) — but InquiryDetail.tsx never read it, so who
// logged a follow-up was invisible in the UI despite the data already
// being on the wire. Wiring the display up also surfaced a real,
// separate leak: that bare `createdBy: true` (and, in inquiry.service.ts,
// `assignedTo: true`) returned every scalar column on User —
// passwordHash/totpSecret included — over the wire; both are now scoped
// selects (covered by a backend test, e2e-inquiry-assignment.test.ts).

test('logging a follow-up shows who logged it', async ({ page }) => {
  const fixture = readFixture('mastersCrud');
  const applicantName = `E2E Attribution Applicant ${Date.now()}`;

  await login(page, fixture);
  await page.goto('/presales/inquiries');
  await page.getByRole('button', { name: 'Add Inquiry' }).click();
  await controlAfterLabel(page, 'Applicant Name').fill(applicantName);
  await controlAfterLabel(page, 'Phone').fill('9812322222');
  const [createResponse] = await Promise.all([
    page.waitForResponse((r) => r.url().endsWith('/inquiries') && r.request().method() === 'POST'),
    page.getByRole('button', { name: 'Create' }).click(),
  ]);
  expect(createResponse.ok()).toBe(true);

  await page.getByRole('link', { name: applicantName }).click();
  await expect(page).toHaveURL(/\/presales\/inquiries\/.+/);

  await page.locator('textarea').first().fill('Called, interested, will visit site next week');
  const [followUpResponse] = await Promise.all([
    page.waitForResponse((r) => r.url().includes('/follow-ups') && r.request().method() === 'POST'),
    page.getByRole('button', { name: 'Log Follow-up' }).click(),
  ]);
  expect(followUpResponse.ok()).toBe(true);

  await expect(page.getByText('by E2E Admin')).toBeVisible();
});
