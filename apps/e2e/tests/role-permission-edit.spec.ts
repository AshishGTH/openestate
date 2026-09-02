import { test, expect } from '@playwright/test';
import { createSystemPrismaClient } from '@openestate/db';
import { readFixture } from '../fixtures/state';
import { login, controlAfterLabel } from '../fixtures/actions';
import { DATABASE_URL_SYSTEM } from '../playwright.config';

// Regression coverage for a real bug found while trying to grant v0.2.0's
// two new permissions to an existing seeded role on the VM: RolesService
// .update() rejected ANY change to a system role (isSystem: true), not just
// a rename — so a permission added in a later release could never be
// granted to any seeded role (super_admin, company_admin, ...) through the
// UI, ever. RoleForm.tsx always sends the role's current, unchanged name
// alongside permissionIds on every save, so this fired on every system-role
// permission edit, not just renames — the exact request shape reproduced
// here. See CLAUDE.md's "v0.2.0 — upgrade-path permission delivery" entry.

test('toggling a permission on a system role persists, and the name field is locked', async ({ page }) => {
  const fixture = readFixture('mastersCrud');

  await login(page, fixture);
  await page.goto('/admin/roles');
  const row = page.getByRole('row', { name: /Super Admin/ });
  await expect(row).toBeVisible();
  await row.getByRole('link', { name: 'Edit' }).click();
  await expect(page).toHaveURL(/\/admin\/roles\/.+/);

  // System role's own identity is protected — this is the other half of
  // the fix (RoleForm.tsx disables the name input when role.isSystem).
  await expect(page.locator('input[type="text"]').first()).toBeDisabled();

  const plcCheckbox = page
    .locator('label', { has: page.getByText('unit.plc-manage', { exact: true }) })
    .locator('input[type="checkbox"]');
  await expect(plcCheckbox).toBeChecked(); // super_admin's fixture seed grants every permission

  const [uncheckResponse] = await Promise.all([
    page.waitForResponse((r) => r.url().includes('/roles/') && r.request().method() === 'PATCH' && r.status() !== 401),
    (async () => {
      await plcCheckbox.uncheck();
      await page.getByRole('button', { name: 'Update Role' }).click();
    })(),
  ]);
  expect(uncheckResponse.ok()).toBe(true); // pre-fix: this 400'd, "Cannot modify system roles"
  await expect(page).toHaveURL(/\/admin\/roles$/);

  // Reload the edit page fresh — confirms the removal actually persisted,
  // not just a 200 with the write silently dropped.
  await page.getByRole('row', { name: /Super Admin/ }).getByRole('link', { name: 'Edit' }).click();
  const plcCheckboxReloaded = page
    .locator('label', { has: page.getByText('unit.plc-manage', { exact: true }) })
    .locator('input[type="checkbox"]');
  await expect(plcCheckboxReloaded).not.toBeChecked();

  // Re-grant it — the exact real-world scenario this bug blocked: adding a
  // permission the role doesn't currently have, to a system role.
  const [recheckResponse] = await Promise.all([
    page.waitForResponse((r) => r.url().includes('/roles/') && r.request().method() === 'PATCH' && r.status() !== 401),
    (async () => {
      await plcCheckboxReloaded.check();
      await page.getByRole('button', { name: 'Update Role' }).click();
    })(),
  ]);
  expect(recheckResponse.ok()).toBe(true);

  await page.getByRole('row', { name: /Super Admin/ }).getByRole('link', { name: 'Edit' }).click();
  await expect(
    page.locator('label', { has: page.getByText('unit.plc-manage', { exact: true }) }).locator('input[type="checkbox"]'),
  ).toBeChecked();
});

// Regression coverage for isIntraStateSupply() throwing (not silently
// defaulting to intra-state) when a company's GST config is incomplete —
// see CLAUDE.md's "v0.2.0 — upgrade-path permission delivery" entry. The
// persistent AppShell banner is the only on-screen signal an admin gets
// before hitting that error on a Booking/Receipt screen, so it needs to
// actually render, not just exist as dead code that typechecks.
test('a persistent banner appears when Company Config GST fields are incomplete', async ({ page }) => {
  const fixture = readFixture('mastersCrud');
  const prisma = createSystemPrismaClient(DATABASE_URL_SYSTEM);
  try {
    // mastersCrud's own spec files (masters-crud, this one) never book —
    // safe to null this company's GST config without affecting either.
    await prisma.companyConfig.update({
      where: { companyId: fixture.companyId },
      data: { companyGstin: null, gstStateCode: null },
    });

    await login(page, fixture);
    await expect(page.getByText('GST configuration is incomplete')).toBeVisible();
    await page.getByRole('link', { name: 'Complete Company Config' }).click();
    await expect(page).toHaveURL(/\/admin\/config$/);

    // Fill in both fields and confirm the banner disappears.
    await controlAfterLabel(page, 'GSTIN').fill('09ABCDE1234F1Z5');
    await controlAfterLabel(page, 'GST State Code').fill('09');
    await Promise.all([
      page.waitForResponse((r) => r.url().includes('/company/config') && r.request().method() === 'PATCH' && r.status() !== 401),
      page.getByRole('button', { name: 'Save Configuration' }).click(),
    ]);
    await expect(page.getByText('GST configuration is incomplete')).not.toBeVisible();
  } finally {
    await prisma.$disconnect();
  }
});
