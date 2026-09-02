import { test, expect } from '@playwright/test';
import { readFixture } from '../fixtures/state';
import { login, controlAfterLabel } from '../fixtures/actions';

// Regression coverage for "Systematic VM admin walkthrough — issue #4"
// (CLAUDE.md): every master edit, of any type, ever submitted 400'd
// (useApiMutation's body included the `id` field against a `.strict()`
// PATCH schema); and Interest Rules was one of the 6 of 17 master types
// that could never be created at all (the generic Name-only form never
// collected rateType/ratePercent/frequency, which the Prisma model
// requires).

test('create a master with type-specific optional fields → edit it → deactivate it', async ({ page }) => {
  const fixture = readFixture('mastersCrud');
  const name = `E2E Standard Interest ${Date.now()}`;

  await login(page, fixture);
  await page.goto('/admin/masters');
  await page.getByRole('button', { name: 'Interest Rules', exact: true }).click();
  await page.getByRole('button', { name: 'Add Item' }).click();

  // Interest Rules is one of TYPE_FIELDS' entries — rateType/ratePercent/
  // frequency beyond the generic name/isActive/sortOrder — exactly the
  // fields that never reached the create request before the fix.
  await controlAfterLabel(page, 'Name').fill(name);
  await controlAfterLabel(page, 'Rate Type').selectOption('SIMPLE');
  await controlAfterLabel(page, 'Rate %').fill('18');
  await controlAfterLabel(page, 'Frequency').selectOption('YEARLY');

  const [createResponse] = await Promise.all([
    page.waitForResponse((r) => r.url().includes('/masters/interest-rules') && r.request().method() === 'POST' && r.status() !== 401),
    page.getByRole('button', { name: 'Create' }).click(),
  ]);
  expect(createResponse.ok()).toBe(true);

  const row = page.getByRole('row', { name: new RegExp(name) });
  await expect(row).toBeVisible();
  await expect(row.getByRole('cell').nth(1)).toHaveText('Yes'); // Active column, default on create

  // Edit — the id-leak .strict() 400 reproduced on literally every prior
  // edit attempt, for every master type, unconditionally.
  await row.getByRole('button', { name: 'Edit' }).click();
  await controlAfterLabel(page, 'Rate %').fill('24');
  const [updateResponse] = await Promise.all([
    page.waitForResponse((r) => r.url().includes('/masters/interest-rules/') && r.request().method() === 'PATCH' && r.status() !== 401),
    page.getByRole('button', { name: 'Update' }).click(),
  ]);
  expect(updateResponse.ok()).toBe(true);

  // Reopen edit and confirm the update actually persisted (not just a
  // 200 with the write silently dropped) — the freshly-refetched item's
  // ratePercent should now populate the form as '24'.
  await row.getByRole('button', { name: 'Edit' }).click();
  await expect(controlAfterLabel(page, 'Rate %')).toHaveValue('24');

  // Deactivate — "deactivate a master" was previously unreachable (the
  // Active checkbox was only ever set once, at creation).
  await page.locator('label', { hasText: 'Active' }).locator('input[type="checkbox"]').uncheck();
  const [deactivateResponse] = await Promise.all([
    page.waitForResponse((r) => r.url().includes('/masters/interest-rules/') && r.request().method() === 'PATCH' && r.status() !== 401),
    page.getByRole('button', { name: 'Update' }).click(),
  ]);
  expect(deactivateResponse.ok()).toBe(true);
  await expect(row.getByRole('cell').nth(1)).toHaveText('No');
});
