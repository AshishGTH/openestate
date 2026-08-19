import { test, expect } from '@playwright/test';
import { createSystemPrismaClient } from '@openestate/db';
import * as argon2 from '@node-rs/argon2';
import { ALL_PERMISSIONS, PERMISSIONS } from '@openestate/shared';
import { readFixture } from '../fixtures/state';
import { login } from '../fixtures/actions';
import { DATABASE_URL_SYSTEM } from '../playwright.config';

/**
 * The sidebar was a flat list of ~20 links. It is now collapsible
 * sections. Three properties matter and none are provable server-side:
 *
 *  - a section actually collapses and expands
 *  - the open/closed choice survives navigation AND a full page reload
 *    (React state alone covers the first, localStorage the second)
 *  - a section whose every item is permission-hidden does not render at
 *    all — not an empty header, not a shell that opens onto nothing
 */

const PASSWORD = 'NavGroupPass123';

test('sections collapse and expand, and an explicit choice survives navigation', async ({ page }) => {
  const fixture = readFixture('mastersCrud');
  await login(page, fixture);

  // Landing on "/" (Dashboard) — no section owns that route, so every
  // section starts collapsed and its links are genuinely not rendered.
  const adminToggle = page.getByRole('button', { name: 'Admin' });
  await expect(adminToggle).toBeVisible();
  await expect(adminToggle).toHaveAttribute('aria-expanded', 'false');
  await expect(page.getByRole('link', { name: 'Company Config' })).not.toBeVisible();

  await adminToggle.click();
  await expect(adminToggle).toHaveAttribute('aria-expanded', 'true');
  await expect(page.getByRole('link', { name: 'Company Config' })).toBeVisible();

  // Client-side navigation (what a real user does when clicking the nav)
  // — the section must still be open on the page we land on.
  await page.getByRole('link', { name: 'Company Config' }).click();
  await expect(page).toHaveURL(/\/admin\/config$/);
  await expect(page.getByRole('button', { name: 'Admin' })).toHaveAttribute('aria-expanded', 'true');

  // An explicit collapse must WIN over the "auto-open the section owning
  // the active route" default — otherwise a user could never keep the
  // section for the page they're on shut. Deliberately asserted while ON
  // /admin/config, where the default is OPEN, so `false` can only come
  // from the explicit override and the check can't pass vacuously.
  await page.getByRole('button', { name: 'Admin' }).click();
  await expect(page.getByRole('button', { name: 'Admin' })).toHaveAttribute('aria-expanded', 'false');
  await expect(page.getByRole('link', { name: 'Company Config' })).not.toBeVisible();
});

test('the open/closed choice survives a full page reload', async ({ page }) => {
  const fixture = readFixture('mastersCrud');
  await login(page, fixture);

  // Asserted on "/" where the default for Admin is CLOSED, so a post-reload
  // "true" can only have come from the persisted choice — React state alone
  // cannot survive a reload, and the active-route default would say closed.
  await page.getByRole('button', { name: 'Admin' }).click();
  await expect(page.getByRole('button', { name: 'Admin' })).toHaveAttribute('aria-expanded', 'true');

  await page.reload();
  await expect(page.getByRole('button', { name: 'Admin' })).toHaveAttribute('aria-expanded', 'true');
  await expect(page.getByRole('link', { name: 'Company Config' })).toBeVisible();
});

test('a section with no permitted items does not render at all', async ({ page }) => {
  const fixture = readFixture('mastersCrud');
  const prisma = createSystemPrismaClient(DATABASE_URL_SYSTEM);
  const tag = Date.now();

  try {
    for (const key of ALL_PERMISSIONS) {
      await prisma.permission.upsert({ where: { key }, update: {}, create: { key } });
    }
    const inquiryRead = await prisma.permission.findUniqueOrThrow({
      where: { key: PERMISSIONS.PRESALES_INQUIRY_READ },
    });

    const role = await prisma.role.create({
      data: {
        companyId: fixture.companyId,
        name: `E2E NavGroup PresalesOnly ${tag}`,
        slug: `e2e-navgroup-presales-only-${tag}`,
        isSystem: false,
      },
    });
    await prisma.rolePermission.create({
      data: { roleId: role.id, permissionId: inquiryRead.id },
    });

    const email = `e2e-navgroup-${tag}@test.com`;
    await prisma.user.create({
      data: {
        companyId: fixture.companyId,
        email,
        passwordHash: await argon2.hash(PASSWORD, { algorithm: argon2.Algorithm.Argon2id }),
        name: `E2E NavGroup User ${tag}`,
        roleId: role.id,
        forcePasswordChange: false,
      },
    });

    await page.goto('/login');
    await page.locator('#email').fill(email);
    await page.locator('#password').fill(PASSWORD);
    await page.getByRole('button', { name: 'Sign in' }).click();
    await expect(page).toHaveURL(/\/$/);

    // The one section this role can see anything in.
    await expect(page.getByRole('button', { name: 'Pre-Sales' })).toBeVisible();

    // Every other section holds only links this role lacks — so the
    // section headers themselves must be absent, not present-but-empty.
    for (const section of ['Admin', 'Post-Sales', 'Inventory', 'Brokers', 'Reports', 'Support']) {
      await expect(page.getByRole('button', { name: section })).not.toBeVisible();
    }
  } finally {
    await prisma.$disconnect();
  }
});
