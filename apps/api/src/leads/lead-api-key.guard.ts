import { createHash } from 'node:crypto';
import { CanActivate, ExecutionContext, Inject, Injectable, UnauthorizedException } from '@nestjs/common';
import type { PrismaClient } from '@openestate/db';
import { SYSTEM_PRISMA } from '../database/database.module';

export interface LeadApiKeyContext {
  id: string;
  companyId: string;
  fieldMapping: Record<string, string>;
  rateLimitPerMinute: number;
}

/**
 * Authenticates POST /leads/inbound via X-Api-Key — a machine endpoint,
 * no JWT, no cookie session. Marked @Public() at the controller (so
 * JwtAuthGuard/CsrfGuard both no-op per their own IS_PUBLIC_KEY check),
 * this guard is the ONLY thing standing between the internet and the
 * route. Hashes the presented key and looks it up by keyHash — same
 * "never store the raw value" discipline as RefreshToken.
 */
@Injectable()
export class LeadApiKeyGuard implements CanActivate {
  constructor(@Inject(SYSTEM_PRISMA) private readonly systemPrisma: PrismaClient) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest();
    const presented = request.headers['x-api-key'];
    if (!presented || typeof presented !== 'string') {
      throw new UnauthorizedException('Missing X-Api-Key header');
    }

    const keyHash = createHash('sha256').update(presented).digest('hex');
    const row = await this.systemPrisma.leadSourceApiKey.findFirst({ where: { keyHash } });
    if (!row || !row.isActive) {
      throw new UnauthorizedException('Invalid or inactive API key');
    }

    request.leadApiKey = {
      id: row.id,
      companyId: row.companyId,
      fieldMapping: row.fieldMapping as Record<string, string>,
      rateLimitPerMinute: row.rateLimitPerMinute,
    } satisfies LeadApiKeyContext;

    // Fire-and-forget last-used tracking — not on the critical auth path.
    this.systemPrisma.leadSourceApiKey.update({ where: { id: row.id }, data: { lastUsedAt: new Date() } }).catch(() => undefined);

    return true;
  }
}
