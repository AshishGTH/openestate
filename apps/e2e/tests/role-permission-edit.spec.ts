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

test('the super_admin role cannot be edited: its name is locked and a permission change is refused and not saved', async ({ page }) => {
  const fixture = readFixture('mastersCrud');

  await login(page, fixture);
  await page.goto('/admin/roles');
  const row = page.getByRole('row', { name: /Super Admin/ });
  await expect(row).toBeVisible();
  await row.getByRole('link', { name: 'Edit' }).click();
  await expect(page).toHaveURL(/\/admin\/roles\/.+/);

  // System role's own identity is protected (RoleForm disables the name input).
  await expect(page.locator('input[type="text"]').first()).toBeDisabled();

  const plcCheckbox = page
    .locator('label', { has: page.getByText('unit.plc-manage', { exact: true }) })
    .locator('input[type="checkbox"]');
  await expect(plcCheckbox).toBeChecked(); // super_admin holds every permission

  // v0.8.2: super_admin's permission set is immutable — the API refuses, with a reason.
  const [response] = await Promise.all([
    page.waitForResponse((r) => r.url().includes('/roles/') && r.request().method() === 'PATCH'),
    (async () => {
      await plcCheckbox.uncheck();
      await page.getByRole('button', { name: 'Update Role' }).click();
    })(),
  ]);
  expect(response.status()).toBe(400);
  expect((await response.json()).message).toContain('cannot be edited');

  // Fresh load: nothing was saved.
  await page.goto('/admin/roles');
  await page.getByRole('row', { name: /Super Admin/ }).getByRole('link', { name: 'Edit' }).click();
  await expect(
    page.locator('label', { has: page.getByText('unit.plc-manage', { exact: true }) }).locator('input[type="checkbox"]'),
  ).toBeChecked();
});

// A portal role (Customer, Broker) can only hold portal.* permissions — the
// API refuses anything else — so the screen offers only those for it.
test('a portal role lists only portal permissions, and a change to it saves', async ({ page }) => {
  const fixture = readFixture('rolesPortal');
  const permBox = (label: string) =>
    page.locator('label', { has: page.getByText(label, { exact: true }) }).locator('input[type="checkbox"]');

  await login(page, fixture);
  await page.goto('/admin/roles');
  await page.getByRole('row', { name: /Customer/ }).getByRole('link', { name: 'Edit' }).click();
  await expect(page).toHaveURL(/\/admin\/roles\/.+/);

  await expect(permBox('ticket.read')).toBeChecked();
  await expect(page.getByText('unit.plc-manage', { exact: true })).toHaveCount(0);
  await expect(page.getByText('user.read', { exact: true })).toHaveCount(0);

  const [response] = await Promise.all([
    page.waitForResponse((r) => r.url().includes('/roles/') && r.request().method() === 'PATCH'),
    (async () => {
      await permBox('ticket.read').uncheck();
      await page.getByRole('button', { name: 'Update Role' }).click();
    })(),
  ]);
  expect(response.ok()).toBe(true);
  await expect(page).toHaveURL(/\/admin\/roles$/);

  await page.getByRole('row', { name: /Customer/ }).getByRole('link', { name: 'Edit' }).click();
  await expect(permBox('ticket.read')).not.toBeChecked();
  await expect(permBox('booking.read')).toBeChecked();
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
      page.waitForResponse((r) => r.url().includes('/company/config') && r.request().method() === 'PATCH'),
      page.getByRole('button', { name: 'Save Configuration' }).click(),
    ]);
    await expect(page.getByText('GST configuration is incomplete')).not.toBeVisible();
  } finally {
    await prisma.$disconnect();
  }
});
