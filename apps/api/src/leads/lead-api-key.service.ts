import { createHash, randomBytes } from 'node:crypto';
import { Inject, Injectable, NotFoundException } from '@nestjs/common';
import type { PrismaClient } from '@openestate/db';
import type { CreateLeadApiKeyDto } from '@openestate/shared';
import { SYSTEM_PRISMA } from '../database/database.module';

/** Same hashing discipline as RefreshToken.tokenHash (TokenService) — raw
 * key is shown to the admin exactly once, at creation; only the SHA-256
 * hash is ever stored. */
function generateKey(): { raw: string; keyPrefix: string; keyHash: string } {
  const raw = `oe_live_${randomBytes(24).toString('hex')}`;
  return { raw, keyPrefix: raw.slice(0, 12), keyHash: createHash('sha256').update(raw).digest('hex') };
}

@Injectable()
export class LeadApiKeyService {
  constructor(@Inject(SYSTEM_PRISMA) private readonly systemPrisma: PrismaClient) {}

  async list(companyId: string) {
    const rows = await this.systemPrisma.leadSourceApiKey.findMany({ where: { companyId }, orderBy: { createdAt: 'desc' } });
    return rows.map((r) => this.strip(r));
  }

  /** The only call site that ever returns the raw key — the response to
   * THIS request, never again. GET/list responses always strip it. */
  async create(companyId: string, dto: CreateLeadApiKeyDto, actorId: string | null) {
    const { raw, keyPrefix, keyHash } = generateKey();
    const row = await this.systemPrisma.leadSourceApiKey.create({
      data: {
        companyId,
        name: dto.name,
        keyPrefix,
        keyHash,
        scopes: ['leads:create'],
        fieldMapping: dto.fieldMapping as never,
        rateLimitPerMinute: dto.rateLimitPerMinute,
        createdById: actorId,
      },
    });
    return { ...this.strip(row), rawKey: raw };
  }

  async disable(companyId: string, id: string) {
    await this.requireOwned(companyId, id);
    const row = await this.systemPrisma.leadSourceApiKey.update({ where: { id }, data: { isActive: false } });
    return this.strip(row);
  }

  async remove(companyId: string, id: string) {
    await this.requireOwned(companyId, id);
    await this.systemPrisma.leadSourceApiKey.delete({ where: { id } });
    return { id, deleted: true };
  }

  private async requireOwned(companyId: string, id: string) {
    const row = await this.systemPrisma.leadSourceApiKey.findFirst({ where: { id, companyId } });
    if (!row) throw new NotFoundException('Lead API key not found');
    return row;
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private strip(row: any) {
    const out: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(row)) {
      if (key === 'keyHash') continue;
      out[key] = value;
    }
    return out;
  }
}
