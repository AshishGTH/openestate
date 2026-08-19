import { test, expect } from '@playwright/test';
import { createSystemPrismaClient } from '@openestate/db';
import { readFixture } from '../fixtures/state';
import { seedOrgChart } from '../fixtures/org-chart';
import { DATABASE_URL_SYSTEM } from '../playwright.config';

/**
 * The dashboard was a static placeholder showing the caller's role,
 * company id and permission count. It is now real, TeamScopeService-scoped
 * work data: own figures always, plus the reporting subtree's figures and
 * a per-report breakdown for anyone who has reports.
 *
 * Scoping is the part worth testing in a browser: a manager must see their
 * report's numbers and must NOT see an unrelated peer's.
 */

async function signIn(page: import('@playwright/test').Page, email: string, password: string) {
  await page.goto('/login');
  await page.locator('#email').fill(email);
  await page.locator('#password').fill(password);
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page).toHaveURL(/\/$/);
}

test('a manager sees their own work, their team, and a per-report row for each report but not for an unrelated peer', async ({
  page,
}) => {
  const fixture = readFixture('mastersCrud');
  const prisma = createSystemPrismaClient(DATABASE_URL_SYSTEM);

  try {
    const org = await seedOrgChart(prisma, fixture.companyId);
    await signIn(page, org.managerEmail, org.password);

    await expect(page.getByRole('heading', { name: 'Dashboard' })).toBeVisible();
    await expect(page.getByText('My work')).toBeVisible();
    await expect(page.getByText(/My team \(/)).toBeVisible();
    await expect(page.getByText('Per report')).toBeVisible();

    // The report is listed with their real figures. The fixture gave this
    // rep two open inquiries (one due today, one overdue) and logged no
    // follow-ups at all — so "no activity" must be reported honestly
    // rather than as a fabricated timestamp.
    const repRow = page.getByRole('row', { name: new RegExp(org.repName) });
    await expect(repRow).toBeVisible();
    await expect(repRow).toContainText('No activity logged');

    // The negative control: an unrelated peer is outside this manager's
    // subtree and must not appear anywhere on the page.
    await expect(page.getByText(org.peerName)).not.toBeVisible();
  } finally {
    await prisma.$disconnect();
  }
});

test('a rep with no reports sees only their own work, and no team section', async ({ page }) => {
  const fixture = readFixture('mastersCrud');
  const prisma = createSystemPrismaClient(DATABASE_URL_SYSTEM);

  try {
    const org = await seedOrgChart(prisma, fixture.companyId);
    await signIn(page, org.repEmail, org.password);

    await expect(page.getByRole('heading', { name: 'Dashboard' })).toBeVisible();
    await expect(page.getByText('My work')).toBeVisible();

    // No reports configured — the team and per-report blocks must be
    // absent entirely, not rendered empty.
    await expect(page.getByText(/My team \(/)).not.toBeVisible();
    await expect(page.getByText('Per report')).not.toBeVisible();
    await expect(page.getByText('You have no reports configured')).toBeVisible();

    // Their own numbers are real: the fixture gave this rep one follow-up
    // due today and one overdue.
    await expect(page.getByText('Follow-ups due today')).toBeVisible();
    await expect(page.getByText('Overdue follow-ups')).toBeVisible();
  } finally {
    await prisma.$disconnect();
  }
});
