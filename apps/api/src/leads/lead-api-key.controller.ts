import { Body, Controller, Delete, Get, Param, Post, Req } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { Request } from 'express';
import { createZodDto } from 'nestjs-zod';
import { createLeadApiKeySchema, PERMISSIONS } from '@openestate/shared';
import type { JwtPayload } from '@openestate/shared';
import { RequirePermissions } from '../auth/guards/permissions.guard';
import { LeadApiKeyService } from './lead-api-key.service';

class CreateLeadApiKeyDto extends createZodDto(createLeadApiKeySchema) {}

@ApiTags('Admin Lead API Keys')
@Controller('admin/lead-api-keys')
export class LeadApiKeyController {
  constructor(private readonly keys: LeadApiKeyService) {}

  @Get()
  @RequirePermissions(PERMISSIONS.ADMIN_LEAD_API_KEY_READ)
  @ApiOperation({ summary: "List this company's inbound-lead API keys (raw key never returned)" })
  list(@Req() req: Request) {
    const user = req.user as JwtPayload;
    return this.keys.list(user.companyId);
  }

  @Post()
  @RequirePermissions(PERMISSIONS.ADMIN_LEAD_API_KEY_MANAGE)
  @ApiOperation({ summary: 'Create an inbound-lead API key — the raw key is returned ONLY in this response' })
  create(@Body() dto: CreateLeadApiKeyDto, @Req() req: Request) {
    const user = req.user as JwtPayload;
    return this.keys.create(user.companyId, dto, user.sub);
  }

  @Post(':id/disable')
  @RequirePermissions(PERMISSIONS.ADMIN_LEAD_API_KEY_MANAGE)
  @ApiOperation({ summary: 'Disable an inbound-lead API key' })
  disable(@Param('id') id: string, @Req() req: Request) {
    const user = req.user as JwtPayload;
    return this.keys.disable(user.companyId, id);
  }

  @Delete(':id')
  @RequirePermissions(PERMISSIONS.ADMIN_LEAD_API_KEY_MANAGE)
  @ApiOperation({ summary: 'Delete an inbound-lead API key' })
  remove(@Param('id') id: string, @Req() req: Request) {
    const user = req.user as JwtPayload;
    return this.keys.remove(user.companyId, id);
  }
}
