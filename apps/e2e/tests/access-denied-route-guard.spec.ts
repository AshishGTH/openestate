import { test, expect } from '@playwright/test';
import { createSystemPrismaClient } from '@openestate/db';
import * as argon2 from '@node-rs/argon2';
import { ALL_PERMISSIONS, PERMISSIONS } from '@openestate/shared';
import { readFixture } from '../fixtures/state';
import { DATABASE_URL_SYSTEM } from '../playwright.config';

// Regression coverage: navigating directly to an admin URL used to render
// the full page shell (buttons, headers, forms) for ANY authenticated
// user regardless of permissions — the backend correctly 403'd the
// underlying data fetch, but nothing in the frontend distinguished "no
// data yet" from "not allowed to be here." AppShell's own nav already
// hid the link; typing/bookmarking the URL directly bypassed that
// entirely. Fixed with a RequirePermission wrapper on every protected
// route.

const PASSWORD = 'NarrowRolePass123';

test('a low-permission user hitting an admin URL directly sees access-denied, not the page shell', async ({ page }) => {
  const fixture = readFixture('mastersCrud');
  const prisma = createSystemPrismaClient(DATABASE_URL_SYSTEM);

  try {
    for (const key of ALL_PERMISSIONS) {
      await prisma.permission.upsert({ where: { key }, update: {}, create: { key } });
    }
    const inquiryReadPerm = await prisma.permission.findUniqueOrThrow({
      where: { key: PERMISSIONS.PRESALES_INQUIRY_READ },
    });

    const narrowRole = await prisma.role.create({
      data: {
        companyId: fixture.companyId,
        name: 'E2E Narrow Role',
        slug: `e2e-narrow-${Date.now()}`,
        isSystem: false,
      },
    });
    await prisma.rolePermission.create({
      data: { roleId: narrowRole.id, permissionId: inquiryReadPerm.id },
    });

    const email = `e2e-narrow-${Date.now()}@test.com`;
    await prisma.user.create({
      data: {
        companyId: fixture.companyId,
        email,
        passwordHash: await argon2.hash(PASSWORD, { algorithm: argon2.Algorithm.Argon2id }),
        name: 'E2E Narrow User',
        roleId: narrowRole.id,
        forcePasswordChange: false,
      },
    });

    await page.goto('/login');
    await page.locator('#email').fill(email);
    await page.locator('#password').fill(PASSWORD);
    await page.getByRole('button', { name: 'Sign in' }).click();
    await expect(page).toHaveURL(/\/$/);

    // No nav link at all for a permission this user lacks — AppShell's
    // own filtering already worked before this fix.
    await expect(page.getByRole('link', { name: 'Users' })).not.toBeVisible();

    // The actual gap: direct URL navigation bypassed the nav filter
    // entirely and rendered the real page shell.
    await page.goto('/admin/users');
    await expect(page.getByRole('heading', { name: 'Access denied' })).toBeVisible();
    await expect(page.getByRole('link', { name: 'Add User' })).not.toBeVisible();
    await expect(page.getByRole('table')).not.toBeVisible();

    // Positive control — a permission this user DOES hold still renders
    // the real page, proving the wrapper isn't over-blocking.
    await page.goto('/presales/inquiries');
    await expect(page.getByRole('heading', { name: 'Access denied' })).not.toBeVisible();
    await expect(page.getByRole('heading', { name: 'Inquiries' })).toBeVisible();
  } finally {
    await prisma.$disconnect();
  }
});
