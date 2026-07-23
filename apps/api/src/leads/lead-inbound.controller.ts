import { BadRequestException, Body, Controller, Post, Req, UseGuards } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { Request } from 'express';
import { Public } from '../auth/guards/jwt-auth.guard';
import { InquiryService } from '../presales/inquiry.service';
import { LeadApiKeyGuard, type LeadApiKeyContext } from './lead-api-key.guard';
import { LeadInboundThrottlerGuard } from './lead-inbound-throttler.guard';
import { resolveFieldPath } from './field-mapping';

const REQUIRED_FIELDS = ['name', 'phone'] as const;
const OPTIONAL_FIELDS = ['email', 'projectId', 'note'] as const;

/**
 * Machine endpoint — no JWT, no CSRF (both guards no-op on @Public()
 * routes per their own IS_PUBLIC_KEY check). LeadApiKeyGuard is the
 * entire authn/authz boundary here, and must run before
 * LeadInboundThrottlerGuard (declared first in @UseGuards — guards run
 * in that order), since the throttler's per-key limit resolver
 * (app.module.ts) reads req.leadApiKey, which only exists after
 * LeadApiKeyGuard populates it.
 */
@ApiTags('Inbound Leads')
@Controller('leads')
export class LeadInboundController {
  constructor(private readonly inquiryService: InquiryService) {}

  @Post('inbound')
  @Public()
  @UseGuards(LeadApiKeyGuard, LeadInboundThrottlerGuard)
  @ApiOperation({ summary: 'Inbound lead webhook — authenticated by X-Api-Key, field-mapped per the key\'s own configured mapping' })
  async inbound(@Body() body: Record<string, unknown>, @Req() req: Request) {
    const leadApiKey = (req as Request & { leadApiKey: LeadApiKeyContext }).leadApiKey;
    const mapping = leadApiKey.fieldMapping;

    for (const field of REQUIRED_FIELDS) {
      if (!mapping[field]) {
        throw new BadRequestException(`This API key's field mapping has no path configured for required field '${field}'`);
      }
    }

    const resolved: Record<string, string> = {};
    for (const field of REQUIRED_FIELDS) {
      const path = mapping[field];
      const value = resolveFieldPath(body, path);
      if (value === undefined || value === null || value === '') {
        throw new BadRequestException(`Could not resolve required field '${field}' at path '${path}' in the request body`);
      }
      resolved[field] = String(value);
    }
    for (const field of OPTIONAL_FIELDS) {
      const path = mapping[field];
      if (!path) continue;
      const value = resolveFieldPath(body, path);
      if (value !== undefined && value !== null && value !== '') resolved[field] = String(value);
    }

    return this.inquiryService.createFromLead(leadApiKey.companyId, {
      name: resolved.name,
      phone: resolved.phone,
      email: resolved.email,
      projectId: resolved.projectId,
      note: resolved.note,
    });
  }
}
