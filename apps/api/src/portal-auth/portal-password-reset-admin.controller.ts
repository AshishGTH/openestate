import { Body, Controller, HttpCode, HttpStatus, Post, Req } from '@nestjs/common';
import { ApiOkResponse, ApiOperation, ApiTags } from '@nestjs/swagger';
import { Request } from 'express';
import { createZodDto } from 'nestjs-zod';
import { adminPortalPasswordResetSchema, PERMISSIONS } from '@openestate/shared';
import type { JwtPayload } from '@openestate/shared';
import { PortalAuthService } from './portal-auth.service';
import { RequirePermissions } from '../auth/guards/permissions.guard';

class AdminPortalPasswordResetDto extends createZodDto(adminPortalPasswordResetSchema) {}

/**
 * Staff-facing: issue a one-time password-reset link for an applicant's or
 * broker's existing portal account. Its own controller rather than a route on
 * PortalInviteAdminController because Nest binds the path prefix per class
 * ('admin/portal-invites' there); same module, service, and permission.
 */
@ApiTags('Portal Password Resets (Admin)')
@Controller('admin/portal-password-resets')
export class PortalPasswordResetAdminController {
  constructor(private readonly portalAuthService: PortalAuthService) {}

  @RequirePermissions(PERMISSIONS.ADMIN_PORTAL_INVITE_SEND)
  @Post()
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Issue a one-time password-reset link for a customer or broker portal account',
    description:
      'Returns the raw reset token to the caller exactly once, for manual out-of-band delivery ' +
      '(WhatsApp, phone, in person) — it is stored only as a hash, cannot be retrieved again, and ' +
      'the server sends nothing. Issuing a new token invalidates any outstanding one for that account. ' +
      'Body: exactly one of applicantId or brokerId (400 otherwise). 404 if it is not in your company; ' +
      '409 with code NO_PORTAL_ACCOUNT if the person has never accepted a portal invite (send one ' +
      'instead); 409 if the portal account is deactivated.',
  })
  @ApiOkResponse({
    description: '`{ token, expiresAt }` — the reset URL is `<origin>/portal/reset-password?token=<token>`.',
  })
  issue(@Body() dto: AdminPortalPasswordResetDto, @Req() req: Request) {
    const user = req.user as JwtPayload;
    return this.portalAuthService.issueAdminPasswordReset(user.companyId, user.sub, dto);
  }
}
