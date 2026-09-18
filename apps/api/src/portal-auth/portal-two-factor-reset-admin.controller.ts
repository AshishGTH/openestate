import { Body, Controller, HttpCode, HttpStatus, Post, Req } from '@nestjs/common';
import { ApiOkResponse, ApiOperation, ApiTags } from '@nestjs/swagger';
import { Request } from 'express';
import { createZodDto } from 'nestjs-zod';
import { portalPrincipalRefSchema, PERMISSIONS } from '@openestate/shared';
import type { JwtPayload } from '@openestate/shared';
import { PortalAuthService } from './portal-auth.service';
import { RequirePermissions } from '../auth/guards/permissions.guard';

class PortalPrincipalRefDto extends createZodDto(portalPrincipalRefSchema) {}

/**
 * Staff-facing: clear the 2FA on a customer's or broker's portal account.
 *
 * The permission is on the CLASS, not the method. PermissionsGuard lets any
 * route without @RequirePermissions through to any signed-in token
 * (docs/todo.md), so a route added here later without its own decorator
 * would otherwise be open to every staff and portal session. Deliberately
 * ADMIN_USER_UPDATE, not the ADMIN_PORTAL_INVITE_SEND its password-reset
 * sibling uses — see PortalAuthService.adminResetTotp.
 */
@ApiTags('Portal 2FA Resets (Admin)')
@RequirePermissions(PERMISSIONS.ADMIN_USER_UPDATE)
@Controller('admin/portal-2fa-resets')
export class PortalTwoFactorResetAdminController {
  constructor(private readonly portalAuthService: PortalAuthService) {}

  @Post()
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: "Clear the two-factor authentication on a customer's or broker's portal account",
    description:
      'For someone who has lost both their authenticator and their recovery codes. Clears the TOTP ' +
      'secret, recovery codes and 2FA lockout, and revokes every refresh token; the password is ' +
      'unchanged. An access token already issued stays valid until it expires (up to 15 minutes by ' +
      'default). Audited as TOTP_RESET_BY_ADMIN, including when 2FA was already off. Deactivated ' +
      'accounts are allowed. Body: exactly one of applicantId or brokerId (400 otherwise). 404 if not ' +
      'in your company; 409 with code NO_PORTAL_ACCOUNT if the person has no portal account.',
  })
  @ApiOkResponse({ description: '`{ wasEnabled }` — whether 2FA was on before the reset.' })
  reset(@Body() dto: PortalPrincipalRefDto, @Req() req: Request) {
    const user = req.user as JwtPayload;
    return this.portalAuthService.adminResetTotp(user.companyId, user.sub, dto);
  }
}
