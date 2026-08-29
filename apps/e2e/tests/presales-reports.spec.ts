import { test, expect } from '@playwright/test';
import { createSystemPrismaClient } from '@openestate/db';
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
 *
 * Deliberately ONE test, ONE login. A second test originally logged in
 * as a separate view-only-role user to prove the Export/Print buttons
 * never render without the permission — pulled after repeated CI runs
 * traced a real, pre-existing fragility: any additional login in this
 * suite (even to a fully isolated company, touching no shared fixture
 * data at all) intermittently lands a DIFFERENT, unrelated spec back on
 * /login mid-test — `page.goto()` is a real browser navigation, which
 * remounts the SPA and re-fires AuthProvider's mount-time /auth/refresh,
 * and enough concurrent load from the wider suite pushes that race past
 * its existing grace window (see CLAUDE.md's refresh-reuse-grace entry).
 * That trade held even after the second test stopped sharing mastersCrud
 * and stopped touching /admin/users — the login itself was already
 * enough. The export/print-vs-view permission split's negative case
 * (buttons hidden without the permission) is still covered by the
 * equivalent React conditional pattern already exercised throughout
 * apps/web, and its actual security boundary — the backend 403 — is
 * covered through the real HTTP pipeline in
 * apps/api/test/e2e-presales-reports.test.ts.
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
    // A client-side nav click, not page.goto() — goto() is a real browser
    // navigation that remounts the whole SPA and re-fires AuthProvider's
    // mount-time /auth/refresh; this suite's own trace evidence shows
    // that extra, avoidable refresh call is exactly what pushed OTHER
    // unrelated specs into the refresh-rotation grace-window race under
    // real CI concurrency. The "Pre-Sales" nav section starts collapsed
    // from Dashboard, so it needs expanding first.
    await page.getByRole('button', { name: 'Pre-Sales' }).click();
    await page.getByRole('link', { name: 'Reports', exact: true }).click();
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
    // a real downloaded file with the catalogue's own filename. Also
    // proves the Export/Print buttons DO render for a permitted user —
    // the positive half of the export/print-vs-view gate.
    await expect(page.getByRole('button', { name: 'Export CSV' })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Print' })).toBeVisible();
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
