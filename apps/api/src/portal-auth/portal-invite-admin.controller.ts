import { Body, Controller, HttpCode, HttpStatus, Post, Req } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { Request } from 'express';
import { createZodDto } from 'nestjs-zod';
import { sendPortalInviteSchema, PERMISSIONS } from '@openestate/shared';
import type { JwtPayload } from '@openestate/shared';
import { PortalAuthService } from './portal-auth.service';
import { RequirePermissions } from '../auth/guards/permissions.guard';

class SendPortalInviteDto extends createZodDto(sendPortalInviteSchema) {}

/**
 * Staff-facing trigger for the customer/broker onboarding flow. Lives in
 * the portal-auth module because it's what CREATES the PortalInvite rows
 * PortalAuthController.consumeInvite() consumes — same auth realm, opposite
 * end of the same flow.
 */
@ApiTags('Portal Invites (Admin)')
@Controller('admin/portal-invites')
export class PortalInviteAdminController {
  constructor(private readonly portalAuthService: PortalAuthService) {}

  @RequirePermissions(PERMISSIONS.ADMIN_PORTAL_INVITE_SEND)
  @Post()
  @HttpCode(HttpStatus.CREATED)
  @ApiOperation({ summary: 'Send a customer/broker portal invite' })
  async sendInvite(@Body() dto: SendPortalInviteDto, @Req() req: Request) {
    const user = req.user as JwtPayload;
    const result = await this.portalAuthService.sendInvite(user.companyId, user.sub, dto);
    // The raw token is returned only here, once, to the staff caller who
    // relays it via the chosen channel — never persisted anywhere in
    // cleartext (PortalInvite stores only tokenHash).
    return { inviteId: result.inviteId, token: result.token, expiresAt: result.expiresAt };
  }
}
