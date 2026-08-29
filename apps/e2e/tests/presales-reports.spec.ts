import { test, expect } from '@playwright/test';
import { createSystemPrismaClient } from '@openestate/db';
import { ALL_PERMISSIONS, PERMISSIONS } from '@openestate/shared';
import * as argon2 from '@node-rs/argon2';
import { readFixture } from '../fixtures/state';
import { login } from '../fixtures/actions';
import { DATABASE_URL_SYSTEM } from '../playwright.config';

/**
 * The pre-sales reporting suite's shell, through a real browser: the
 * REPORT_CATALOGUE-driven picker, a real filter/table render, the
 * hand-rolled SVG chart toggle, and a real CSV download through the
 * actual Export CSV button (proving requireExport()'s permission check
 * and the audit-log write sit behind a button a real user can click, not
 * just a route a supertest can hit directly). See CLAUDE.md's
 * reporting-suite entry.
 */
test('an admin browses the report catalogue, toggles the chart view, and exports a real CSV', async ({ page }) => {
  const fixture = readFixture('mastersCrud');
  const prisma = createSystemPrismaClient(DATABASE_URL_SYSTEM);
  const tag = Date.now();

  try {
    const phone = `9${String(tag).slice(-9)}`;
    const applicant = await prisma.applicant.create({
      data: { companyId: fixture.companyId, name: `E2E Report Applicant ${tag}`, primaryPhone: phone, primaryPhoneNormalized: phone },
    });
    await prisma.inquiry.create({
      data: { companyId: fixture.companyId, applicantId: applicant.id, projectId: fixture.projectId, status: 'OPEN' },
    });

    await login(page, fixture);
    await page.goto('/presales/reports');
    await expect(page.getByRole('heading', { name: 'Pre-Sales Reports' })).toBeVisible();

    // Switch to Funnel — no date-range default to fight, and it must show
    // the OPEN inquiry seeded above.
    await page.getByLabel('Report').selectOption({ label: 'Funnel by Status' });
    await expect(page.getByRole('cell', { name: 'OPEN', exact: true })).toBeVisible();

    // Chart toggle — Funnel declares a donut chart in the catalogue.
    await page.getByRole('button', { name: 'Chart', exact: true }).click();
    await expect(page.locator('svg[aria-label="Donut chart"]')).toBeVisible();
    await page.getByRole('button', { name: 'Table', exact: true }).click();

    // Real CSV export through the real button — a super_admin has both
    // presales.report.view and .export, so this must succeed and produce
    // a real downloaded file with the catalogue's own filename.
    const [download] = await Promise.all([
      page.waitForEvent('download'),
      page.getByRole('button', { name: 'Export CSV' }).click(),
    ]);
    expect(download.suggestedFilename()).toBe('funnel.csv');

    // The export must have written an audit row before the response
    // completed — the control 4QT had as "Print/Download Track".
    const auditRow = await prisma.auditLog.findFirst({
      where: { companyId: fixture.companyId, entityType: 'PresalesReport', entityId: 'funnel', action: 'EXPORT' },
      orderBy: { createdAt: 'desc' },
    });
    expect(auditRow).not.toBeNull();
  } finally {
    await prisma.$disconnect();
  }
});

/**
 * presales.report.export/.print are separate permissions from .view, kept
 * that way specifically so a role can read a report on-screen without
 * being able to take customer PII out of the system as a portable CSV or
 * printout. A backend 403 proves the API enforces it; this proves the
 * BUTTONS a real view-only user would actually see never offer the
 * action in the first place.
 */
test('a view-only role sees reports but never the export or print buttons', async ({ page }) => {
  const fixture = readFixture('mastersCrud');
  const prisma = createSystemPrismaClient(DATABASE_URL_SYSTEM);
  const tag = Date.now();
  const staffPassword = 'ReportViewerPass123';

  try {
    // Seeded directly via Prisma, not through Admin -> Add User — that
    // form's own real-form-submission behavior is already covered by
    // user-role-edit.spec.ts; driving it again here just adds concurrent
    // load against /admin/users on the SAME shared mastersCrud fixture
    // that spec (and team-scope.spec.ts) already exercise, which is what
    // pushed both of them past their 30s timeout under real CI
    // concurrency — confirmed by comparing against master's own last
    // clean Playwright run (zero retries) before this file existed.
    for (const key of ALL_PERMISSIONS) {
      await prisma.permission.upsert({ where: { key }, update: {}, create: { key } });
    }
    const allPerms = await prisma.permission.findMany();
    const permByKey = new Map(allPerms.map((p) => [p.key, p.id]));

    const viewerRole = await prisma.role.create({
      data: { companyId: fixture.companyId, name: `E2E Report Viewer ${tag}`, slug: `e2e-report-viewer-${tag}`, isSystem: false },
    });
    const viewPermId = permByKey.get(PERMISSIONS.PRESALES_REPORT_VIEW);
    if (!viewPermId) throw new Error('presales.report.view permission not found');
    await prisma.rolePermission.create({ data: { roleId: viewerRole.id, permissionId: viewPermId } });

    const viewerEmail = `e2e-report-viewer-${tag}@test.com`;
    await prisma.user.create({
      data: {
        companyId: fixture.companyId,
        email: viewerEmail,
        passwordHash: await argon2.hash(staffPassword, { algorithm: argon2.Algorithm.Argon2id }),
        name: 'E2E Report Viewer',
        roleId: viewerRole.id,
        forcePasswordChange: false,
      },
    });

    await page.goto('/login');
    await page.locator('#email').fill(viewerEmail);
    await page.locator('#password').fill(staffPassword);
    await page.getByRole('button', { name: 'Sign in' }).click();
    await expect(page).toHaveURL(/\/$/);

    await page.goto('/presales/reports');
    await expect(page.getByRole('heading', { name: 'Pre-Sales Reports' })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Export CSV' })).not.toBeVisible();
    await expect(page.getByRole('button', { name: 'Print' })).not.toBeVisible();
  } finally {
    await prisma.$disconnect();
  }
});
