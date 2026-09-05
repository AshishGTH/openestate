import { test, expect } from '@playwright/test';
import { SYSTEM_ROLES, ROLE_DISPLAY_NAMES } from '@openestate/shared';
import { readFixture } from '../fixtures/state';
import { login, controlAfterLabel } from '../fixtures/actions';

/**
 * Attempts a login as `email`/`password` in a fresh, isolated browser
 * context (never the admin's own `page`) and asserts it's refused —
 * stays on /login with the same generic error the backend returns for
 * both a wrong password and a deactivated account
 * (`AuthService.validateUser`'s `!user.isActive` check throws the same
 * "Invalid credentials" as a bad password, deliberately not leaking
 * account existence/status). Confirms the REFUSAL, not just that the
 * deactivate button returned 200 — a deactivated user who can still log
 * in is a silent security hole no UI-state assertion would catch.
 */
async function assertLoginRefused(browser: import('@playwright/test').Browser, email: string, password: string) {
  const context = await browser.newContext();
  const page = await context.newPage();
  try {
    await page.goto('/login');
    await page.locator('#email').fill(email);
    await page.locator('#password').fill(password);
    await page.getByRole('button', { name: 'Sign in' }).click();
    await expect(page.getByText('Invalid credentials')).toBeVisible();
    await expect(page).toHaveURL(/\/login$/);
  } finally {
    await context.close();
  }
}

/**
 * Counterpart for the active/reactivated case — a fresh user gets
 * `forcePasswordChange: true` (see CLAUDE.md's forced-first-login-change
 * standing rule), so a successful login lands on the force-change-password
 * screen, not the dashboard; "leaves /login with no error" is what a
 * real successful auth attempt looks like here, regardless of which
 * authenticated screen it lands on.
 */
async function assertLoginSucceeds(browser: import('@playwright/test').Browser, email: string, password: string) {
  const context = await browser.newContext();
  const page = await context.newPage();
  try {
    await page.goto('/login');
    await page.locator('#email').fill(email);
    await page.locator('#password').fill(password);
    await page.getByRole('button', { name: 'Sign in' }).click();
    await expect(page).not.toHaveURL(/\/login$/);
    await expect(page.getByText('Invalid credentials')).toHaveCount(0);
  } finally {
    await context.close();
  }
}

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

test('deactivating and reactivating a user, through the real button clicks', async ({ page, browser }) => {
  const fixture = readFixture('mastersCrud');
  await login(page, fixture);

  await page.goto('/admin/users/new');
  const targetName = `E2E Deactivate Target ${Date.now()}`;
  const targetEmail = `e2e-deactivate-${Date.now()}@test.com`;
  const targetPassword = 'InitialPass123';
  await controlAfterLabel(page, 'Name').fill(targetName);
  await controlAfterLabel(page, 'Email').fill(targetEmail);
  await controlAfterLabel(page, 'Password').fill(targetPassword);
  await controlAfterLabel(page, 'Phone').fill('9800000002');
  await controlAfterLabel(page, 'Role').selectOption({ label: ROLE_DISPLAY_NAMES[SYSTEM_ROLES.SUPER_ADMIN] });

  const [createResponse] = await Promise.all([
    page.waitForResponse((r) => r.url().endsWith('/users') && r.request().method() === 'POST'),
    page.getByRole('button', { name: 'Create User' }).click(),
  ]);
  expect(createResponse.ok()).toBe(true);
  await expect(page).toHaveURL(/\/admin\/users$/);

  // Baseline: the freshly created, still-active user can log in — proves
  // the later refusal is caused by deactivation specifically, not a typo
  // in the credentials or an unrelated login issue.
  await assertLoginSucceeds(browser, targetEmail, targetPassword);

  // The list is company-wide and this fixture company is shared with
  // other specs (e.g. user-role-edit.spec.ts) that create their own
  // users concurrently — filter by the target's own unique name rather
  // than assuming it lands on page 1 of an unfiltered, unsorted list.
  const search = page.getByPlaceholder('Search by name or email…');
  await search.fill(targetName);
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
  // useApiMutation's onSuccess invalidates ['users'] which triggers a
  // GET /users refetch — the row's 'Inactive' text only appears once
  // that lands and TanStack Query re-renders. Under CI load, the gap
  // between mutation response and re-render exceeds Playwright's default
  // 5s expect timeout. Waiting for the refetch's response before asserting
  // the DOM makes the assertion pass as soon as the state exists, not
  // after a fixed sleep. Same shape as the CLAUDE.md booking-wizard
  // option-count-wait fix — assert the precondition explicitly rather
  // than trusting the mutation's return as a proxy for re-render.
  await page.waitForResponse(
    (r) => /\/api\/v1\/users(\?|$)/.test(r.url()) && r.request().method() === 'GET' && r.ok(),
  );
  await expect(row.getByText('Inactive', { exact: true })).toBeVisible();

  // The actual point of this test: a deactivated user must be genuinely
  // refused at login, not just show "Inactive" in an admin list. A 200
  // from the Deactivate button proves the row updated — it says nothing
  // about whether the account can still authenticate. Confirmed via
  // AuthService.validateUser's `!user.isActive` check.
  await assertLoginRefused(browser, targetEmail, targetPassword);

  // Persisted server-side, not just an optimistic client-side flip. Wait
  // for the search's own GET /users response before checking DOM — under
  // CI load and the cooldown-skipped mount pattern, the fill → debounced
  // fetch → render cycle can exceed the default 5s toBeVisible timeout.
  // See CLAUDE.md's E2E refresh-rotation cascade entry.
  await page.reload();
  await Promise.all([
    page.waitForResponse(
      (r) => /\/api\/v1\/users\?.*search=/.test(r.url()) && r.request().method() === 'GET' && r.ok(),
    ),
    page.getByPlaceholder('Search by name or email…').fill(targetName),
  ]);
  const reloadedRow = page.getByRole('row', { name: new RegExp(targetName) });
  await expect(reloadedRow.getByText('Inactive', { exact: true })).toBeVisible();

  const [reactivateResponse] = await Promise.all([
    page.waitForResponse((r) => r.url().includes('/users/') && r.url().endsWith('/reactivate')),
    reloadedRow.getByRole('button', { name: 'Reactivate' }).click(),
  ]);
  expect(reactivateResponse.request().method()).toBe('POST');
  expect(reactivateResponse.ok()).toBe(true);
  // Same refetch-then-assert pattern as the deactivate branch above.
  await page.waitForResponse(
    (r) => /\/api\/v1\/users(\?|$)/.test(r.url()) && r.request().method() === 'GET' && r.ok(),
  );
  await expect(reloadedRow.getByText('Active', { exact: true })).toBeVisible();

  await page.reload();
  await Promise.all([
    page.waitForResponse(
      (r) => /\/api\/v1\/users\?.*search=/.test(r.url()) && r.request().method() === 'GET' && r.ok(),
    ),
    page.getByPlaceholder('Search by name or email…').fill(targetName),
  ]);
  const finalRow = page.getByRole('row', { name: new RegExp(targetName) });
  await expect(finalRow.getByText('Active', { exact: true })).toBeVisible();

  // Symmetric close: reactivation genuinely restores the ability to log
  // in, not just the "Active" label.
  await assertLoginSucceeds(browser, targetEmail, targetPassword);
});
