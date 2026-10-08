import { test, expect } from '@playwright/test';
import { SESSION_ENDED_MESSAGE } from '@openestate/shared';
import { readFixture } from '../fixtures/state';
import { login } from '../fixtures/actions';
import { PORTAL_URL } from '../playwright.config';

/**
 * Portal mirror of session-ended.spec.ts (UA-116), in two real browsers: a
 * staff admin deactivates a customer who is signed in to the portal, and the
 * customer's very next click lands on the portal sign-in page with "Your
 * session has ended. Please sign in again." Uses its own fixture company,
 * because it deactivates that company's portal user.
 */
test('portal: a signed-in customer who is deactivated is sent to the portal sign-in page on their next click', async ({ page, browser }) => {
  const fixture = readFixture('portalSessionEnded');

  // Customer, in their own browser.
  const customerContext = await browser.newContext();
  const customer = await customerContext.newPage();
  try {
    await customer.goto(`${PORTAL_URL}/portal/login`);
    await customer.locator('#identifier').fill(fixture.portalIdentifier!);
    await customer.locator('#password').fill(fixture.portalPassword!);
    await customer.getByRole('button', { name: 'Sign in' }).click();
    await expect(customer).toHaveURL(/\/portal\/profile$/);

    // Control: before the deactivation, the customer's navigation works.
    await customer.getByRole('link', { name: /Property/ }).click();
    await expect(customer).toHaveURL(/\/portal\/property$/);

    // Staff admin deactivates the customer's portal account.
    await login(page, fixture);
    await page.goto('/admin/users');
    await page.getByPlaceholder('Search by name or email…').fill('E2E Customer');
    const row = page.getByRole('row', { name: /E2E Customer/ });
    const [deactivated] = await Promise.all([
      page.waitForResponse((r) => r.url().includes('/users/') && r.url().endsWith('/deactivate')),
      row.getByRole('button', { name: 'Deactivate' }).click(),
    ]);
    expect(deactivated.ok()).toBe(true);

    // The customer's next click.
    await customer.getByRole('link', { name: /Account/ }).click();
    await expect(customer).toHaveURL(/\/portal\/login$/);
    await expect(customer.getByRole('status')).toHaveText(SESSION_ENDED_MESSAGE);
  } finally {
    await customerContext.close();
  }
});
