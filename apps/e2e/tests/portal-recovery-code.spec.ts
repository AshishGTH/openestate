import { test, expect, type Page } from '@playwright/test';
import { readFixture } from '../fixtures/state';
import { currentTotpCode } from '../fixtures/totp';
import { PORTAL_URL } from '../playwright.config';

// Portal counterpart to auth-recovery-code.spec.ts, same steps. The portal
// field never had the staff length cap. This covers it anyway: CLAUDE.md
// treats staff and portal auth as mirrors, and portal recovery-code login
// had never been tested. Step 2 (lowercase with spaces) is the one that
// depends on the shared schema normalising the code.

const VERIFY_URL = '/api/v1/portal/auth/totp/verify';

async function openCodePrompt(page: Page, identifier: string, password: string) {
  await page.locator('#identifier').fill(identifier);
  await page.locator('#password').fill(password);
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page.locator('#totp')).toBeVisible();
}

async function submitCode(page: Page) {
  const [response] = await Promise.all([
    page.waitForResponse((r) => r.url().endsWith(VERIFY_URL) && r.request().method() === 'POST'),
    page.getByRole('button', { name: 'Verify' }).click(),
  ]);
  return response;
}

async function signOut(page: Page) {
  await page.getByRole('button', { name: 'Sign out' }).click();
  await expect(page).toHaveURL(/\/portal\/login$/);
}

test('portal: a recovery code signs in, is single-use, and is accepted in lowercase', async ({ page }) => {
  const fixture = readFixture('portalRecoveryCode');
  const identifier = fixture.portalIdentifier!;
  const password = fixture.portalPassword!;

  await page.goto(`${PORTAL_URL}/portal/login`);
  await page.locator('#identifier').fill(identifier);
  await page.locator('#password').fill(password);
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page).toHaveURL(/\/portal\/profile$/);

  await page.goto(`${PORTAL_URL}/portal/security`);
  const [setupResponse] = await Promise.all([
    page.waitForResponse((r) => r.url().includes('/portal/auth/totp/setup') && r.ok()),
    page.getByRole('button', { name: 'Enable 2FA' }).click(),
  ]);
  const { secret } = (await setupResponse.json()) as { secret: string };

  await page.locator('input[inputmode="numeric"]').pressSequentially(currentTotpCode(secret));
  const [confirmResponse] = await Promise.all([
    page.waitForResponse((r) => r.url().includes('/portal/auth/totp/confirm') && r.ok()),
    page.getByRole('button', { name: 'Confirm' }).click(),
  ]);
  const issued = ((await confirmResponse.json()) as { recoveryCodes: string[] }).recoveryCodes;

  const shown = await page
    .getByText('Save these recovery codes — shown once')
    .locator('xpath=following-sibling::ul[1]/li')
    .allTextContents();
  expect(shown).toEqual(issued);
  expect(shown).toHaveLength(8);
  await page.getByRole('button', { name: 'Done' }).click();
  await signOut(page);

  const codeField = page.locator('#totp');

  // 1. A full recovery code, in the default field.
  await openCodePrompt(page, identifier, password);
  await codeField.pressSequentially(shown[0]);
  await expect(codeField, 'the whole recovery code must fit in the field').toHaveValue(shown[0]);
  const first = await submitCode(page);
  expect(first.status(), await first.text()).toBe(200);
  await expect(page).toHaveURL(/\/portal\/profile$/);
  await signOut(page);

  // 2. Lowercase with surrounding spaces.
  await openCodePrompt(page, identifier, password);
  const messy = `  ${shown[1].toLowerCase()} `;
  await codeField.pressSequentially(messy);
  await expect(codeField).toHaveValue(messy);
  const second = await submitCode(page);
  expect(second.status(), await second.text()).toBe(200);
  await expect(page).toHaveURL(/\/portal\/profile$/);
  await signOut(page);

  // 3. The recovery toggle: text keyboard, a reused code is refused, a fresh
  //    one works.
  await openCodePrompt(page, identifier, password);
  await page.getByRole('button', { name: 'Lost your phone? Use a recovery code' }).click();
  await expect(page.getByText('Enter one of your recovery codes (XXXXX-XXXXX)')).toBeVisible();
  await expect(codeField).toHaveAttribute('inputmode', 'text');
  await page.getByRole('button', { name: 'Use your authenticator app instead' }).click();
  await expect(codeField).toHaveAttribute('inputmode', 'numeric');
  await page.getByRole('button', { name: 'Lost your phone? Use a recovery code' }).click();

  await codeField.pressSequentially(shown[0]);
  const reused = await submitCode(page);
  expect(reused.status()).toBe(401);
  await expect(page.getByText('Invalid TOTP code')).toBeVisible();
  await expect(page).toHaveURL(/\/portal\/login$/);

  await codeField.clear();
  await codeField.pressSequentially(shown[2]);
  const third = await submitCode(page);
  expect(third.status(), await third.text()).toBe(200);
  await expect(page).toHaveURL(/\/portal\/profile$/);
});
