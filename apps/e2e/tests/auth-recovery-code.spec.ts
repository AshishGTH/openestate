import { test, expect, type Page } from '@playwright/test';
import { readFixture } from '../fixtures/state';
import { currentTotpCode } from '../fixtures/totp';
import { login } from '../fixtures/actions';

// Staff recovery-code login. TotpVerify.tsx used to cap the code field at
// 6 characters, so a real XXXXX-XXXXX recovery code was cut to "FA897-" and
// rejected before any request was sent. Codes are typed key by key and the
// field is checked before submitting, so a length cap fails here with the
// truncated value.
//
// Steps 1 and 2 type into the default field without the recovery toggle: it
// must accept either format, whichever mode it's in. Step 3 uses the toggle.
// Four verify calls in total, under the per-user limit of 5.

const VERIFY_URL = '/api/v1/auth/totp/verify';

async function openCodePrompt(page: Page, email: string, password: string) {
  await page.locator('#email').fill(email);
  await page.locator('#password').fill(password);
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page.getByRole('heading', { name: 'Two-Factor Authentication' })).toBeVisible();
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
  await expect(page).toHaveURL(/\/login$/);
}

test('staff: a recovery code signs in, is single-use, and is accepted in lowercase', async ({ page }) => {
  const fixture = readFixture('staffRecoveryCode');
  await login(page, fixture);

  await page.goto('/settings');
  const [setupResponse] = await Promise.all([
    page.waitForResponse((r) => r.url().includes('/auth/totp/setup') && r.ok()),
    page.getByRole('button', { name: 'Enable 2FA' }).click(),
  ]);
  const { secret } = (await setupResponse.json()) as { secret: string };

  await page.locator('input[inputmode="numeric"]').pressSequentially(currentTotpCode(secret));
  const [confirmResponse] = await Promise.all([
    page.waitForResponse((r) => r.url().includes('/auth/totp/confirm') && r.ok()),
    page.getByRole('button', { name: 'Confirm' }).click(),
  ]);
  const issued = ((await confirmResponse.json()) as { recoveryCodes: string[] }).recoveryCodes;

  // Codes come from what's on screen, checked against what the server issued.
  const shown = await page
    .getByText('Save these recovery codes — shown once')
    .locator('xpath=following-sibling::ul[1]/li')
    .allTextContents();
  expect(shown).toEqual(issued);
  expect(shown).toHaveLength(8);
  await page.getByRole('button', { name: 'Done' }).click();
  await signOut(page);

  const codeField = page.locator('#code');

  // 1. A full recovery code, in the default field.
  await openCodePrompt(page, fixture.adminEmail, fixture.adminPassword);
  await codeField.pressSequentially(shown[0]);
  await expect(codeField, 'the whole recovery code must fit in the field').toHaveValue(shown[0]);
  const first = await submitCode(page);
  expect(first.status(), await first.text()).toBe(200);
  await expect(page).toHaveURL(/\/$/);
  await signOut(page);

  // 2. Lowercase with surrounding spaces, as a phone keyboard or a copied
  //    line might produce.
  await openCodePrompt(page, fixture.adminEmail, fixture.adminPassword);
  const messy = `  ${shown[1].toLowerCase()} `;
  await codeField.pressSequentially(messy);
  await expect(codeField).toHaveValue(messy);
  const second = await submitCode(page);
  expect(second.status(), await second.text()).toBe(200);
  await expect(page).toHaveURL(/\/$/);
  await signOut(page);

  // 3. The recovery toggle: text keyboard, a reused code is refused, a fresh
  //    one works.
  await openCodePrompt(page, fixture.adminEmail, fixture.adminPassword);
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
  await expect(page).toHaveURL(/\/login$/);

  await codeField.clear();
  await codeField.pressSequentially(shown[2]);
  const third = await submitCode(page);
  expect(third.status(), await third.text()).toBe(200);
  await expect(page).toHaveURL(/\/$/);
});
