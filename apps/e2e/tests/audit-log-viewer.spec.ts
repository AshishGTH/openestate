import { test, expect } from '@playwright/test';
import { createSystemPrismaClient } from '@openestate/db';
import { readFixture } from '../fixtures/state';
import { login, controlAfterLabel } from '../fixtures/actions';
import { DATABASE_URL_SYSTEM } from '../playwright.config';

// v0.7.1: an edit made through the real UI shows up in Admin → Audit Log,
// with the admin's own name as the actor. Before v0.7.1 this edit wrote no
// audit row at all (ProjectService.update used the un-awaited withTenantTx
// callback form), and rows that were written showed "System" — no actor.
//
// Uses its own project so it can't collide with project-edit.spec.ts,
// which edits the fixture's project on the same 'mastersCrud' company.

test('a project edited in the UI appears in the audit log with the admin as the user', async ({ page }) => {
  const fixture = readFixture('mastersCrud');
  const prisma = createSystemPrismaClient(DATABASE_URL_SYSTEM);
  const stamp = Date.now();
  const projectName = `E2E Audit Project ${stamp}`;
  const newAddress = `Audit Street ${stamp}`;

  try {
    await prisma.project.create({
      data: { companyId: fixture.companyId, name: projectName, code: `AUD-${stamp}` },
    });

    await login(page, fixture);
    await page.goto('/inventory/projects');
    await page.getByRole('link', { name: projectName }).click();
    await page.getByRole('button', { name: 'Edit Project' }).click();
    await controlAfterLabel(page, 'Address').fill(newAddress);
    const [patch] = await Promise.all([
      page.waitForResponse((r) => r.url().includes('/projects/') && r.request().method() === 'PATCH'),
      page.getByRole('button', { name: 'Save' }).click(),
    ]);
    expect(patch.ok()).toBe(true);

    await page.goto('/admin/audit');
    await Promise.all([
      page.waitForResponse((r) => r.url().includes('/audit?') && r.url().includes('entityType=Project')),
      page.getByPlaceholder('Filter by entity type…').fill('Project'),
    ]);

    // Newest first. Open each UPDATE row by the admin until the one whose
    // details carry this edit — another spec may edit a project concurrently.
    const rows = page.getByRole('row').filter({ hasText: 'UPDATE' }).filter({ hasText: 'E2E Admin' });
    await expect(rows.first()).toBeVisible();
    let found = false;
    for (let i = 0; i < Math.min(await rows.count(), 5) && !found; i++) {
      await rows.nth(i).getByRole('button', { name: 'Details' }).click();
      found = await expect(page.getByText(newAddress))
        .toBeVisible({ timeout: 2000 })
        .then(() => true, () => false);
    }
    expect(found, 'the audit row for this edit is listed, with the admin as the user').toBe(true);
  } finally {
    await prisma.$disconnect();
  }
});
