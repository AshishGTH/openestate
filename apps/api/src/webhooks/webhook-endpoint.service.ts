import { Inject, Injectable, NotFoundException } from '@nestjs/common';
import type { PrismaClient } from '@openestate/db';
import type { CreateWebhookEndpointDto, UpdateWebhookEndpointDto } from '@openestate/shared';
import { SYSTEM_PRISMA } from '../database/database.module';
import { PluginSecretEncryptionService } from '../plugins/plugin-secret-encryption.service';

/**
 * Admin CRUD for webhook endpoints — same SYSTEM_PRISMA + explicit
 * companyId-filter shape as PluginAdminService (Phase 7 commit 1):
 * straightforward staff-only CRUD, no portal-scoping concerns, so a
 * withTenantTx/runWithTenant wrap would add ceremony without adding
 * safety. Signing secrets are encrypted via PluginSecretEncryptionService
 * — reused, not a new key domain (a webhook signing secret and a plugin
 * config secret are both "a value only this server should ever see in
 * plaintext," the same trust boundary).
 */
@Injectable()
export class WebhookEndpointService {
  constructor(
    @Inject(SYSTEM_PRISMA) private readonly systemPrisma: PrismaClient,
    private readonly secretEncryption: PluginSecretEncryptionService,
  ) {}

  async list(companyId: string) {
    const rows = await this.systemPrisma.webhookEndpoint.findMany({ where: { companyId }, orderBy: { createdAt: 'desc' } });
    return rows.map((r) => this.strip(r));
  }

  async getOne(companyId: string, id: string) {
    const row = await this.requireOwned(companyId, id);
    return this.strip(row);
  }

  async create(companyId: string, dto: CreateWebhookEndpointDto, actorId: string | null) {
    const { ciphertext, keyVersion } = this.secretEncryption.encrypt(dto.secret);
    const row = await this.systemPrisma.webhookEndpoint.create({
      data: {
        companyId,
        name: dto.name,
        url: dto.url,
        secretCiphertext: ciphertext,
        secretKeyVersion: keyVersion,
        eventTypes: dto.eventTypes,
        createdById: actorId,
      },
    });
    return this.strip(row);
  }

  async update(companyId: string, id: string, dto: UpdateWebhookEndpointDto) {
    await this.requireOwned(companyId, id);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const data: any = {};
    if (dto.name !== undefined) data.name = dto.name;
    if (dto.url !== undefined) data.url = dto.url;
    if (dto.eventTypes !== undefined) data.eventTypes = dto.eventTypes;
    if (dto.secret !== undefined) {
      const { ciphertext, keyVersion } = this.secretEncryption.encrypt(dto.secret);
      data.secretCiphertext = ciphertext;
      data.secretKeyVersion = keyVersion;
    }
    const row = await this.systemPrisma.webhookEndpoint.update({ where: { id }, data });
    return this.strip(row);
  }

  /** Manual re-enable resets the failure counter — a fresh start, not a resumed count. */
  async enable(companyId: string, id: string) {
    await this.requireOwned(companyId, id);
    const row = await this.systemPrisma.webhookEndpoint.update({
      where: { id },
      data: { isActive: true, consecutiveFailures: 0, disabledAt: null, disabledReason: null },
    });
    return this.strip(row);
  }

  async disable(companyId: string, id: string) {
    await this.requireOwned(companyId, id);
    const row = await this.systemPrisma.webhookEndpoint.update({
      where: { id },
      data: { isActive: false, disabledAt: new Date(), disabledReason: 'Manually disabled by admin' },
    });
    return this.strip(row);
  }

  async remove(companyId: string, id: string) {
    await this.requireOwned(companyId, id);
    await this.systemPrisma.webhookEndpoint.delete({ where: { id } });
    return { id, deleted: true };
  }

  private async requireOwned(companyId: string, id: string) {
    const row = await this.systemPrisma.webhookEndpoint.findFirst({ where: { id, companyId } });
    if (!row) throw new NotFoundException('Webhook endpoint not found');
    return row;
  }

  /** Never returns the secret ciphertext or key version — same "absent, not masked" discipline as plugin config secrets. */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private strip(row: any) {
    const out: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(row)) {
      if (key === 'secretCiphertext' || key === 'secretKeyVersion') continue;
      out[key] = value;
    }
    return out;
  }
}
