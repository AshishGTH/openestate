/**
 * Regression test (found via a live native-install exercise, not by
 * review): BrokerService.findAll()/findOne() returned the raw
 * panCiphertext/panKeyVersion columns in every API response — not the
 * plaintext PAN, but an unnecessary exposure of the encrypted blob that
 * widens the blast radius of a future key compromise. revealPan() is the
 * only place that legitimately needs the ciphertext, so it now queries
 * it directly instead of going through the (now-omitting) findOne().
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { makeClients, seedCompany, cleanupCompany, type CompanyFixture } from './helpers/postsales-harness';
import { BrokerService } from '../src/brokers/broker.service';
import { PanEncryptionService } from '../src/common/pan-encryption.service';

const APP_URL = process.env.DATABASE_URL_TEST;
const SYSTEM_URL = process.env.DATABASE_URL_TEST_SYSTEM;
const describeIf = APP_URL && SYSTEM_URL ? describe : describe.skip;

process.env.PAN_ENCRYPTION_KEY ??= 'e5f6a7b8'.repeat(8);

describeIf('BrokerService — PAN ciphertext exposure regression', () => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let tenantPrisma: any;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let systemPrisma: any;
  let fx: CompanyFixture;
  let service: BrokerService;

  beforeAll(async () => {
    ({ tenantPrisma, systemPrisma } = makeClients());
    fx = await seedCompany(systemPrisma);
    service = new BrokerService(tenantPrisma, systemPrisma, new PanEncryptionService());
  });

  afterAll(async () => {
    await cleanupCompany(systemPrisma, fx.companyId);
    await systemPrisma.$disconnect();
    await tenantPrisma.$disconnect();
  });

  it('findOne()/findAll() never return panCiphertext/panKeyVersion, only panMasked', async () => {
    const broker = await service.create(fx.companyId, { name: 'PAN Response Test', phone: '9876500001', pan: 'ABCDE1234F' });

    const one = await service.findOne(fx.companyId, broker.id);
    expect(one).not.toHaveProperty('panCiphertext');
    expect(one).not.toHaveProperty('panKeyVersion');
    expect(one.panMasked).toBe('XXXXX1234F');

    const all = await service.findAll(fx.companyId, { page: 1, limit: 50 });
    const listed = all.data.find((b) => b.id === broker.id);
    expect(listed).not.toHaveProperty('panCiphertext');
    expect(listed).not.toHaveProperty('panKeyVersion');
  });

  it('revealPan() still works, reading the ciphertext directly rather than through findOne()', async () => {
    const broker = await service.create(fx.companyId, { name: 'PAN Reveal Test', phone: '9876500002', pan: 'PQRST5678G' });
    const revealed = await service.revealPan(fx.companyId, broker.id);
    expect(revealed).toBe('PQRST5678G');
  });

  it('revealPan() returns null for a broker with no PAN on file, 404s for an unknown id', async () => {
    const broker = await service.create(fx.companyId, { name: 'No PAN Test', phone: '9876500003' });
    expect(await service.revealPan(fx.companyId, broker.id)).toBeNull();
    await expect(service.revealPan(fx.companyId, '00000000-0000-0000-0000-000000000000')).rejects.toMatchObject({ status: 404 });
  });
});
