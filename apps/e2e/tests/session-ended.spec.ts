import { test, expect } from '@playwright/test';
import { SYSTEM_ROLES, ROLE_DISPLAY_NAMES, SESSION_ENDED_MESSAGE } from '@openestate/shared';
import { readFixture } from '../fixtures/state';
import { login, controlAfterLabel } from '../fixtures/actions';

/**
 * UA-116, end to end in two real browsers: an admin deactivates a user who is
 * signed in elsewhere, and that user's very next click lands them on the
 * sign-in page with "Your session has ended. Please sign in again." Before
 * Part H the deactivated user kept working for up to 15 minutes (the access
 * token was never checked against the database).
 */
test('a signed-in user who is deactivated is sent to the sign-in page on their next click', async ({ page, browser }) => {
  const fixture = readFixture('mastersCrud');
  await login(page, fixture);

  // The user who will be deactivated, created through the real form.
  const tag = Date.now();
  const name = `E2E Session Ended ${tag}`;
  const email = `e2e-session-ended-${tag}@test.com`;
  const firstPassword = 'InitialPass123';
  const password = 'SessionEndedPass456';
  await page.goto('/admin/users/new');
  await controlAfterLabel(page, 'Name').fill(name);
  await controlAfterLabel(page, 'Email').fill(email);
  await controlAfterLabel(page, 'Password').fill(firstPassword);
  await controlAfterLabel(page, 'Phone').fill('9800000077');
  await controlAfterLabel(page, 'Role').selectOption({ label: ROLE_DISPLAY_NAMES[SYSTEM_ROLES.SUPER_ADMIN] });
  const [created] = await Promise.all([
    page.waitForResponse((r) => r.url().endsWith('/users') && r.request().method() === 'POST'),
    page.getByRole('button', { name: 'Create User' }).click(),
  ]);
  expect(created.ok()).toBe(true);

  // Second browser: the user signs in (first login forces a new password).
  const userContext = await browser.newContext();
  const userPage = await userContext.newPage();
  try {
    await userPage.goto('/login');
    await userPage.locator('#email').fill(email);
    await userPage.locator('#password').fill(firstPassword);
    await userPage.getByRole('button', { name: 'Sign in' }).click();
    await expect(userPage.getByRole('heading', { name: 'Change Password' })).toBeVisible();
    await userPage.locator('#newPassword').fill(password);
    await userPage.locator('#confirmPassword').fill(password);
    await userPage.getByRole('button', { name: 'Set Password' }).click();
    await expect(userPage).toHaveURL(/\/login$/);
    await userPage.locator('#email').fill(email);
    await userPage.locator('#password').fill(password);
    await userPage.getByRole('button', { name: 'Sign in' }).click();
    await expect(userPage).toHaveURL(/\/$/);

    // Control: before the deactivation, navigating works.
    await userPage.goto('/admin/users');
    await expect(userPage).toHaveURL(/\/admin\/users$/);
    await expect(userPage.getByPlaceholder('Search by name or email…')).toBeVisible();

    // The admin deactivates them.
    await page.goto('/admin/users');
    await page.getByPlaceholder('Search by name or email…').fill(name);
    const row = page.getByRole('row', { name: new RegExp(name) });
    const [deactivated] = await Promise.all([
      page.waitForResponse((r) => r.url().includes('/users/') && r.url().endsWith('/deactivate')),
      row.getByRole('button', { name: 'Deactivate' }).click(),
    ]);
    expect(deactivated.ok()).toBe(true);

    // The user's next click: the request is refused, the refresh is refused,
    // and they land on the sign-in page with the message.
    await userPage.getByRole('link', { name: 'Dashboard', exact: true }).click();
    await expect(userPage).toHaveURL(/\/login$/);
    await expect(userPage.getByRole('status')).toHaveText(SESSION_ENDED_MESSAGE);
  } finally {
    await userContext.close();
  }
});
