import { test, expect } from '@playwright/test';
import { createSystemPrismaClient } from '@openestate/db';
import { readFixture } from '../fixtures/state';
import { login, controlAfterLabel } from '../fixtures/actions';
import { DATABASE_URL_SYSTEM } from '../playwright.config';

// Project edit: the last must-fix-before-pilot gap (CLAUDE.md's known-gaps
// list — "you cannot edit a project once created"). Reuses the 'mastersCrud'
// fixture for its plain admin+project login, not for anything masters-related.

test('editing a project through the real UI persists after reload', async ({ page }) => {
  const fixture = readFixture('mastersCrud');
  const newName = `${fixture.projectName} (Renamed)`;
  const newRera = `RERA/E2E/${Date.now()}`;

  await login(page, fixture);
  await page.goto('/inventory/projects');
  await page.getByRole('link', { name: fixture.projectName }).click();

  await page.getByRole('button', { name: 'Edit Project' }).click();
  await controlAfterLabel(page, 'Name').fill(newName);
  await controlAfterLabel(page, 'RERA Number').fill(newRera);
  await controlAfterLabel(page, 'Address').fill('221B Baker Street');

  const [patchResponse] = await Promise.all([
    page.waitForResponse((r) => r.url().includes(`/projects/`) && r.request().method() === 'PATCH'),
    page.getByRole('button', { name: 'Save' }).click(),
  ]);
  expect(patchResponse.ok()).toBe(true);

  await expect(page.getByRole('heading', { name: newName })).toBeVisible();
  await expect(page.getByText(new RegExp(`RERA: ${newRera}`))).toBeVisible();

  await page.reload();
  await expect(page.getByRole('heading', { name: newName })).toBeVisible();
  await expect(page.getByText(new RegExp(`RERA: ${newRera}`))).toBeVisible();
  await expect(page.getByText('221B Baker Street')).toBeVisible();
});

test('changing a project\'s area/location with existing bookings shows the GST-consequence confirmation, and leaves the booking untouched', async ({ page }) => {
  const fixture = readFixture('mastersCrud');
  const prisma = createSystemPrismaClient(DATABASE_URL_SYSTEM);

  let bookingId: string;
  let newAreaName: string;
  try {
    const applicant = await prisma.applicant.create({
      data: {
        companyId: fixture.companyId,
        name: `E2E Project-Edit Applicant ${Date.now()}`,
        primaryPhone: `9${String(Date.now()).slice(-9)}`,
        primaryPhoneNormalized: `9${String(Date.now()).slice(-9)}`,
      },
    });
    const floor = await prisma.floor.findFirst({ where: { tower: { projectId: fixture.projectId } } });
    const unit = await prisma.unit.create({
      data: { companyId: fixture.companyId, floorId: floor!.id, number: `PE-${Date.now()}`, status: 'AVAILABLE' },
    });
    const booking = await prisma.booking.create({
      data: {
        companyId: fixture.companyId,
        unitId: unit.id,
        primaryApplicantId: applicant.id,
        bookingNumber: `PE-BOOKING-${Date.now()}`,
        agreedPricePaise: BigInt(50_00_000_00),
        bookingDate: new Date(),
        placeOfSupplyStateCode: '09',
      },
    });
    bookingId = booking.id;

    const newArea = await prisma.areaLocation.create({
      data: { companyId: fixture.companyId, name: `E2E New Area ${Date.now()}`, stateCode: '27' },
    });
    newAreaName = newArea.name;
  } finally {
    await prisma.$disconnect();
  }

  await login(page, fixture);
  await page.goto('/inventory/projects');
  await page.getByRole('link', { name: fixture.projectName }).click();

  const [countResponse] = await Promise.all([
    page.waitForResponse((r) => r.url().includes('/booking-count')),
    page.getByRole('button', { name: 'Edit Project' }).click(),
  ]);
  expect(countResponse.ok()).toBe(true);

  await page
    .locator('select')
    .filter({ has: page.locator('option', { hasText: newAreaName }) })
    .selectOption({ label: newAreaName });
  await page.getByRole('button', { name: 'Save' }).click();

  await expect(page.getByText(/This project has \d+ existing booking/)).toBeVisible();
  await expect(page.getByText(/will not change/)).toBeVisible();

  const [patchResponse] = await Promise.all([
    page.waitForResponse((r) => r.url().includes(`/projects/`) && r.request().method() === 'PATCH'),
    page.getByRole('button', { name: 'Yes, save' }).click(),
  ]);
  expect(patchResponse.ok()).toBe(true);

  const verifyPrisma = createSystemPrismaClient(DATABASE_URL_SYSTEM);
  try {
    const bookingAfter = await verifyPrisma.booking.findFirst({ where: { id: bookingId! } });
    expect(bookingAfter!.placeOfSupplyStateCode).toBe('09');
  } finally {
    await verifyPrisma.$disconnect();
  }
});
