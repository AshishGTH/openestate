import { test, expect } from '@playwright/test';
import { createSystemPrismaClient } from '@openestate/db';
import { readFixture } from '../fixtures/state';
import { login } from '../fixtures/actions';
import { seedOrgChart } from '../fixtures/org-chart';
import { DATABASE_URL_SYSTEM } from '../playwright.config';

/**
 * Read-only org tree at /admin/hierarchy, gated on the pre-existing
 * ADMIN_USER_READ (no new permission invented — sales_manager already
 * holds it, sales_executive already does not).
 *
 * Two behaviours are worth a real browser: the manager's tree is rooted at
 * THEMSELVES even though their own manager is out of scope (a naive
 * implementation returns an empty tree, since no visible node's parent is
 * present), and an unrelated peer never appears.
 */

async function signIn(page: import('@playwright/test').Page, email: string, password: string) {
  await page.goto('/login');
  await page.locator('#email').fill(email);
  await page.locator('#password').fill(password);
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page).toHaveURL(/\/$/);
}

test('a manager sees their own subtree rooted at themselves; an unrelated peer is absent', async ({
  page,
}) => {
  const fixture = readFixture('mastersCrud');
  const prisma = createSystemPrismaClient(DATABASE_URL_SYSTEM);

  try {
    const org = await seedOrgChart(prisma, fixture.companyId);

    // Give the manager a manager of their own — deliberately OUTSIDE the
    // manager's own visible set. This is the case that breaks a naive
    // "roots are users with managerId === null" implementation.
    const boss = await prisma.user.findFirstOrThrow({
      where: { companyId: fixture.companyId, email: fixture.adminEmail },
    });
    const manager = await prisma.user.findFirstOrThrow({
      where: { companyId: fixture.companyId, email: org.managerEmail },
    });
    await prisma.user.update({ where: { id: manager.id }, data: { managerId: boss.id } });

    await signIn(page, org.managerEmail, org.password);
    await page.goto('/admin/hierarchy');

    await expect(page.getByRole('heading', { name: 'Reporting hierarchy' })).toBeVisible();

    // Rooted at the manager, with their report nested under them.
    await expect(page.getByText(org.managerName)).toBeVisible();
    await expect(page.getByText(org.repName)).toBeVisible();
    await expect(page.getByText('1 direct report')).toBeVisible();

    // The out-of-scope boss is not shown, and neither is the peer.
    await expect(page.getByText(org.peerName)).not.toBeVisible();
  } finally {
    await prisma.$disconnect();
  }
});

test('an admin sees users outside any reporting line too', async ({ page }) => {
  const fixture = readFixture('mastersCrud');
  const prisma = createSystemPrismaClient(DATABASE_URL_SYSTEM);

  try {
    const org = await seedOrgChart(prisma, fixture.companyId);

    await login(page, fixture);
    await page.goto('/admin/hierarchy');

    await expect(page.getByRole('heading', { name: 'Reporting hierarchy' })).toBeVisible();
    await expect(page.getByText(org.managerName)).toBeVisible();
    await expect(page.getByText(org.repName)).toBeVisible();
    // The peer reports to nobody — invisible to the manager above, but an
    // admin sees the whole company including unattached users.
    await expect(page.getByText(org.peerName)).toBeVisible();
  } finally {
    await prisma.$disconnect();
  }
});

test('the hierarchy link is reachable from the Admin nav section', async ({ page }) => {
  const fixture = readFixture('mastersCrud');
  await login(page, fixture);

  await page.getByRole('button', { name: 'Admin' }).click();
  await page.getByRole('link', { name: 'Hierarchy' }).click();

  await expect(page).toHaveURL(/\/admin\/hierarchy$/);
  await expect(page.getByRole('heading', { name: 'Reporting hierarchy' })).toBeVisible();
});
