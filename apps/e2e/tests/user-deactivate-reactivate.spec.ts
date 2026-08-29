import { test, expect } from '@playwright/test';
import { SYSTEM_ROLES, ROLE_DISPLAY_NAMES } from '@openestate/shared';
import { readFixture } from '../fixtures/state';
import { login, controlAfterLabel } from '../fixtures/actions';

// Regression coverage for a real bug: Users.tsx's deactivate/reactivate
// mutations called useApiMutation('PATCH', ... '/users/:id/deactivate'|
// '/users/:id/reactivate'), but UsersController declares both routes as
// @Post(), matching Brokers.tsx's identical deactivate/reactivate shape,
// which already correctly used POST. Every click on Deactivate/Reactivate
// in the real admin UI silently 404'd — this class of bug (a frontend
// method mismatch) is invisible to a server-side supertest, which builds
// the request by hand and would pass regardless of what the frontend
// actually sends; only a real browser driving the real request-building
// code proves it, per this project's standing rule on frontend
// request-construction changes.

test('deactivating and reactivating a user, through the real button clicks', async ({ page }) => {
  const fixture = readFixture('mastersCrud');
  await login(page, fixture);

  await page.goto('/admin/users/new');
  const targetName = `E2E Deactivate Target ${Date.now()}`;
  const targetEmail = `e2e-deactivate-${Date.now()}@test.com`;
  await controlAfterLabel(page, 'Name').fill(targetName);
  await controlAfterLabel(page, 'Email').fill(targetEmail);
  await controlAfterLabel(page, 'Password').fill('InitialPass123');
  await controlAfterLabel(page, 'Phone').fill('9800000002');
  await controlAfterLabel(page, 'Role').selectOption({ label: ROLE_DISPLAY_NAMES[SYSTEM_ROLES.SUPER_ADMIN] });

  const [createResponse] = await Promise.all([
    page.waitForResponse((r) => r.url().endsWith('/users') && r.request().method() === 'POST'),
    page.getByRole('button', { name: 'Create User' }).click(),
  ]);
  expect(createResponse.ok()).toBe(true);
  await expect(page).toHaveURL(/\/admin\/users$/);

  const row = page.getByRole('row', { name: new RegExp(targetName) });
  await expect(row).toBeVisible();
  await expect(row.getByText('Active', { exact: true })).toBeVisible();

  // Pre-fix, this request was built as PATCH and 404'd against the real
  // @Post() route — the button click produced no visible error (the
  // mutation just failed silently in the background) and the row never
  // changed. Asserting the response is genuinely ok() AND that the DOM
  // reflects it is what catches that class of silent failure.
  const [deactivateResponse] = await Promise.all([
    page.waitForResponse((r) => r.url().includes('/users/') && r.url().endsWith('/deactivate')),
    row.getByRole('button', { name: 'Deactivate' }).click(),
  ]);
  expect(deactivateResponse.request().method()).toBe('POST');
  expect(deactivateResponse.ok()).toBe(true);
  await expect(row.getByText('Inactive', { exact: true })).toBeVisible();

  // Persisted server-side, not just an optimistic client-side flip.
  await page.reload();
  const reloadedRow = page.getByRole('row', { name: new RegExp(targetName) });
  await expect(reloadedRow.getByText('Inactive', { exact: true })).toBeVisible();

  const [reactivateResponse] = await Promise.all([
    page.waitForResponse((r) => r.url().includes('/users/') && r.url().endsWith('/reactivate')),
    reloadedRow.getByRole('button', { name: 'Reactivate' }).click(),
  ]);
  expect(reactivateResponse.request().method()).toBe('POST');
  expect(reactivateResponse.ok()).toBe(true);
  await expect(reloadedRow.getByText('Active', { exact: true })).toBeVisible();

  await page.reload();
  const finalRow = page.getByRole('row', { name: new RegExp(targetName) });
  await expect(finalRow.getByText('Active', { exact: true })).toBeVisible();
});
