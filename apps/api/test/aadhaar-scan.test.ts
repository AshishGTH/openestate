/**
 * v0.8.0: the read-only Aadhaar-like value scanner (scripts/aadhaar-scan.ts,
 * run on a server via deploy/native/find-aadhaar-like-values.sh).
 *
 * Seeds rows directly — the way data stored before the guard existed sits in
 * the database — and asserts the report names the right keys and counts, skips
 * exempted fields, and never contains a value. No 12-digit literal: values are
 * computed (see helpers/aadhaar-like.ts).
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { makeClients, seedCompany, cleanupCompany, makeApplicant, type CompanyFixture } from './helpers/postsales-harness';
import { aadhaarLike, withWrongCheckDigit, spaced } from './helpers/aadhaar-like';
import { scanAadhaarLike, renderReport } from '../scripts/aadhaar-scan';

const APP_URL = process.env.DATABASE_URL_TEST;
const SYSTEM_URL = process.env.DATABASE_URL_TEST_SYSTEM;
const describeIf = APP_URL && SYSTEM_URL ? describe : describe.skip;

describeIf('Aadhaar-like value scanner', () => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let systemPrisma: any;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let tenantPrisma: any;
  let fx: CompanyFixture;
  const valid = aadhaarLike();
  const validSpaced = spaced(aadhaarLike());
  const wrong = withWrongCheckDigit(aadhaarLike());
  const exemptValue = aadhaarLike();
  const stamp = Date.now();

  beforeAll(async () => {
    ({ systemPrisma, tenantPrisma } = makeClients());
    fx = await seedCompany(systemPrisma);
    const def = (key: string, label: string, extra: Record<string, unknown> = {}) =>
      systemPrisma.customFieldDefinition.create({
        data: { companyId: fx.companyId, entityType: 'APPLICANT', key, label, fieldType: 'TEXT', ...extra },
      });
    await def(`ref_${stamp}`, 'Reference');
    await def(`bank_${stamp}`, 'Bank account', { allowsTwelveDigitValues: true });
    await def(`aadhaar_${stamp}`, 'Identity'); // pre-guard definition named after Aadhaar
    await def(`pick_${stamp}`, 'Pick', { fieldType: 'SELECT', options: ['a', valid] });

    for (const bag of [
      { [`ref_${stamp}`]: valid, [`bank_${stamp}`]: exemptValue },
      { [`ref_${stamp}`]: validSpaced, importNotes: `card ${valid}` },
      { [`ref_${stamp}`]: wrong },
    ]) {
      const id = await makeApplicant(systemPrisma, fx.companyId);
      await systemPrisma.applicant.update({ where: { id }, data: { customFields: bag } });
    }
  });

  afterAll(async () => {
    await cleanupCompany(systemPrisma, fx.companyId);
    await systemPrisma.$disconnect();
    await tenantPrisma.$disconnect();
  });

  it('counts rows per field, skips exempted fields, and names Aadhaar-named and option-bearing definitions', async () => {
    const report = await scanAadhaarLike(systemPrisma);
    const mine = report.stored.filter((f) => f.companyId === fx.companyId);
    const rows = (key: string) => mine.find((f) => f.key === key)?.rows;
    expect(rows(`ref_${stamp}`)).toBe(2); // plain and spaced; the wrong-check-digit row is not counted
    expect(rows('importNotes')).toBe(1); // machine-written keys with no definition are scanned too
    expect(rows(`bank_${stamp}`)).toBeUndefined(); // exempted
    expect(report.namedDefinitions.filter((d) => d.companyId === fx.companyId).map((d) => d.key)).toEqual([`aadhaar_${stamp}`]);
    expect(report.definitionValues.filter((d) => d.companyId === fx.companyId)).toEqual([
      { companyId: fx.companyId, entityType: 'APPLICANT', key: `pick_${stamp}`, where: 'options' },
    ]);
    expect(report.exemptFields).toBeGreaterThanOrEqual(1);
  });

  it('the rendered report contains no value — not the number, not its first eight digits — and ids only on request', async () => {
    const report = await scanAadhaarLike(systemPrisma);
    const text = renderReport(report);
    for (const v of [valid, validSpaced, exemptValue]) {
      expect(text).not.toContain(v);
      expect(text).not.toContain(v.replace(/\s/g, '').slice(0, 8));
    }
    expect(text).toContain(`APPLICANT.ref_${stamp}`);
    expect(text).not.toContain('ids:');

    const withIds = await scanAadhaarLike(systemPrisma, { showIds: true });
    const f = withIds.stored.find((x) => x.companyId === fx.companyId && x.key === `ref_${stamp}`)!;
    expect(f.rowIds).toHaveLength(2);
    expect(renderReport(withIds)).toContain('ids:');
  });

  it('changes nothing', async () => {
    const before = await systemPrisma.applicant.count({ where: { companyId: fx.companyId } });
    await scanAadhaarLike(systemPrisma);
    expect(await systemPrisma.applicant.count({ where: { companyId: fx.companyId } })).toBe(before);
    expect(await systemPrisma.auditLog.count({ where: { companyId: fx.companyId, entityType: 'Applicant', action: 'UPDATE' } })).toBe(0);
  });
});
