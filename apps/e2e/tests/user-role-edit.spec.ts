import { test, expect } from '@playwright/test';
import { createSystemPrismaClient } from '@openestate/db';
import { ALL_PERMISSIONS, SYSTEM_ROLES, ROLE_PERMISSIONS, ROLE_DISPLAY_NAMES } from '@openestate/shared';
import { readFixture } from '../fixtures/state';
import { login, controlAfterLabel } from '../fixtures/actions';
import { DATABASE_URL_SYSTEM } from '../playwright.config';

// Regression coverage for a real bug: editing a user, for ANY field —
// not just role — 400'd unconditionally. UserForm.tsx's edit-mode submit
// destructured only `password` off a CreateUserDto-shaped form value,
// leaving `email` in the PATCH body; updateUserSchema is .strict() and
// never declared `email`, so every save failed with "Unrecognized key(s)
// in object: 'email'" before UsersService.update() ever ran. The user's
// own report ("role cannot be changed") was this bug's most-noticed
// symptom, not its only one — this test edits BOTH name and role in one
// save to cover the actual root cause, not just the reported symptom.
// Fixed via pickForSchema(updateUserSchema, data), which projects onto
// the update schema's own declared keys instead of subtracting fields
// off the create-shaped object.

test('editing a user (name + role) persists, through the real form submit', async ({ page }) => {
  const fixture = readFixture('mastersCrud');
  const prisma = createSystemPrismaClient(DATABASE_URL_SYSTEM);
  let secondRoleId: string;

  try {
    // Setup only — a second role to switch the user into. Not part of the
    // behavior under test (role CREATION already worked before this fix;
    // only editing a user was broken), so seeded directly rather than
    // through the UI, matching role-permission-edit.spec.ts's own
    // direct-Prisma-for-setup precedent.
    for (const key of ALL_PERMISSIONS) {
      await prisma.permission.upsert({ where: { key }, update: {}, create: { key } });
    }
    const allPerms = await prisma.permission.findMany();
    const permByKey = new Map(allPerms.map((p) => [p.key, p.id]));
    const secondRole = await prisma.role.create({
      data: {
        companyId: fixture.companyId,
        name: `${ROLE_DISPLAY_NAMES[SYSTEM_ROLES.ACCOUNTS]} E2E`,
        slug: `e2e-accounts-${Date.now()}`,
        isSystem: false,
      },
    });
    secondRoleId = secondRole.id;
    const permData = ROLE_PERMISSIONS[SYSTEM_ROLES.ACCOUNTS]
      .map((key) => permByKey.get(key))
      .filter((id): id is string => !!id)
      .map((permissionId) => ({ roleId: secondRole.id, permissionId }));
    if (permData.length > 0) await prisma.rolePermission.createMany({ data: permData });

    await login(page, fixture);
    await page.goto('/admin/users');
    await page.getByRole('link', { name: 'Add User' }).click();

    const targetName = `E2E Editable User ${Date.now()}`;
    const targetEmail = `e2e-editable-${Date.now()}@test.com`;
    await controlAfterLabel(page, 'Name').fill(targetName);
    await controlAfterLabel(page, 'Email').fill(targetEmail);
    await controlAfterLabel(page, 'Password').fill('InitialPass123');
    await controlAfterLabel(page, 'Phone').fill('9800000001');
    // The one role present at seed time — Super Admin.
    await controlAfterLabel(page, 'Role').selectOption({ label: ROLE_DISPLAY_NAMES[SYSTEM_ROLES.SUPER_ADMIN] });

    const [createResponse] = await Promise.all([
      page.waitForResponse((r) => r.url().endsWith('/users') && r.request().method() === 'POST'),
      page.getByRole('button', { name: 'Create User' }).click(),
    ]);
    expect(createResponse.ok()).toBe(true);
    await expect(page).toHaveURL(/\/admin\/users$/);

    // Edit — this is the exact request shape that always 400'd before the
    // fix: name changed AND role changed, submitted through the real form.
    const row = page.getByRole('row', { name: new RegExp(targetName) });
    await expect(row).toBeVisible();
    await row.getByRole('link', { name: 'Edit' }).click();
    await expect(page).toHaveURL(/\/admin\/users\/.+/);

    const editedName = `${targetName} Edited`;
    await controlAfterLabel(page, 'Name').fill(editedName);
    await controlAfterLabel(page, 'Role').selectOption({ label: `${ROLE_DISPLAY_NAMES[SYSTEM_ROLES.ACCOUNTS]} E2E` });

    const [updateResponse] = await Promise.all([
      page.waitForResponse((r) => r.url().includes('/users/') && r.request().method() === 'PATCH'),
      page.getByRole('button', { name: 'Update User' }).click(),
    ]);
    expect(updateResponse.ok()).toBe(true); // pre-fix: 400 "Unrecognized key(s) in object: 'email'"
    await expect(page).toHaveURL(/\/admin\/users$/);

    // Reload the list + reopen edit fresh — confirms the change actually
    // persisted server-side, not just a 200 that silently dropped it.
    await page.reload();
    // Wait for the users list refetch after reload — the cooldown-skipped
    // mount leaves accessToken null on the fresh runtime, so the first
    // /users GET 401s and api() retries after a refresh. Same
    // wait-for-precondition pattern as user-deactivate-reactivate's
    // deactivate/reactivate checks, for the same reason: under CI load
    // the full 401 → retry → refetch → re-render cycle exceeds the
    // 5s default toBeVisible timeout. See CLAUDE.md's E2E
    // refresh-rotation cascade entry.
    await page.waitForResponse(
      (r) => /\/api\/v1\/users(\?|$)/.test(r.url()) && r.request().method() === 'GET' && r.ok(),
    );
    const editedRow = page.getByRole('row', { name: new RegExp(editedName) });
    await expect(editedRow).toBeVisible();
    await editedRow.getByRole('link', { name: 'Edit' }).click();
    await expect(controlAfterLabel(page, 'Name')).toHaveValue(editedName);
    await expect(controlAfterLabel(page, 'Role')).toHaveValue(secondRoleId);
  } finally {
    await prisma.$disconnect();
  }
});
