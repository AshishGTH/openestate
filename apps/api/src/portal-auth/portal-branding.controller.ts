import { Controller, Get, Inject, Req, UseGuards } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { Request } from 'express';
import type { PrismaClient } from '@openestate/db';
import type { JwtPayload } from '@openestate/shared';
import { SYSTEM_PRISMA } from '../database/database.module';
import { PortalReadThrottlerGuard } from './portal-throttler.guard';

/**
 * Read-only, no `@RequirePermissions()` — every authenticated portal
 * session (customer or broker) may see its own company's logo/accent
 * color; there is nothing sensitive here worth gating further. Lives in
 * PortalAuthModule (not customer-portal or brokers-portal) because both
 * portal principals' `AppShell` need it, and it's auth-adjacent — fetched
 * once right after login, same lifecycle as the session itself.
 */
@ApiTags('Portal Branding')
@Controller('portal/branding')
@UseGuards(PortalReadThrottlerGuard)
export class PortalBrandingController {
  constructor(@Inject(SYSTEM_PRISMA) private readonly systemPrisma: PrismaClient) {}

  @Get()
  @ApiOperation({ summary: "Company branding (logo, accent color) for the caller's own portal session" })
  async getBranding(@Req() req: Request) {
    const user = req.user as JwtPayload;
    const config = await this.systemPrisma.companyConfig.findUnique({
      where: { companyId: user.companyId },
      select: { logoUrl: true, primaryColorHex: true },
    });
    return { logoUrl: config?.logoUrl ?? null, primaryColorHex: config?.primaryColorHex ?? null };
  }
}
