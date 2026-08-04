import type { Page } from '@playwright/test';
import { expect } from '@playwright/test';
import type { E2eFixture } from './seed';

/** Straight login for fixtures seeded with forcePasswordChange: false (the default). */
export async function login(page: Page, fixture: E2eFixture) {
  await page.goto('/login');
  await page.locator('#email').fill(fixture.adminEmail);
  await page.locator('#password').fill(fixture.adminPassword);
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page).toHaveURL(/\/$/);
}

/**
 * Several forms across this app (Masters, ReceiptEntry, ...) pair a
 * <label> with its input/select/textarea by position only — no id/
 * htmlFor, so getByLabel can't find them. This locates the control
 * immediately following a label with the given exact text.
 */
export function controlAfterLabel(page: Page, label: string) {
  return page.locator(
    `xpath=//label[normalize-space(text())="${label}"]/following-sibling::*[self::input or self::select or self::textarea][1]`,
  );
}

/** Reads a Reports page Stat tile's value by its label (e.g. "Total collected"). */
export async function readStat(page: Page, label: string): Promise<string> {
  const value = page.locator(`xpath=//div[normalize-space(text())="${label}"]/following-sibling::div[1]`);
  return (await value.textContent()) ?? '';
}
