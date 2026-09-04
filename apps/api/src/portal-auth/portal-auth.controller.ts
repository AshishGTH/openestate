import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Post,
  Req,
  Res,
  UnauthorizedException,
  UseGuards,
} from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { Request, Response } from 'express';
import { randomUUID } from 'node:crypto';
import { createZodDto } from 'nestjs-zod';
import {
  portalLoginSchema,
  portalInviteConsumeSchema,
  portalPasswordResetRequestSchema,
  portalPasswordResetConfirmSchema,
  portalChangePasswordSchema,
  totpVerifySchema,
} from '@openestate/shared';
import type { JwtPayload } from '@openestate/shared';
import { PortalAuthService } from './portal-auth.service';
import { Public } from '../auth/guards/jwt-auth.guard';
import { PORTAL_CSRF_COOKIE } from '../auth/csrf-cookie-names';
import { PortalAuthThrottlerGuard } from './portal-throttler.guard';
import { PasswordChangeThrottlerGuard } from '../auth/guards/password-change-throttler.guard';

class PortalLoginDto extends createZodDto(portalLoginSchema) {}
class PortalInviteConsumeDto extends createZodDto(portalInviteConsumeSchema) {}
class PortalPasswordResetRequestDto extends createZodDto(portalPasswordResetRequestSchema) {}
class PortalPasswordResetConfirmDto extends createZodDto(portalPasswordResetConfirmSchema) {}
class PortalChangePasswordDto extends createZodDto(portalChangePasswordSchema) {}
class TotpVerifyDto extends createZodDto(totpVerifySchema) {}

const PORTAL_REFRESH_COOKIE = 'openestate_portal_refresh';
const PORTAL_REFRESH_PATH = '/api/v1/portal/auth';

function setPortalRefreshCookie(res: Response, token: string, expiresAt: Date) {
  res.cookie(PORTAL_REFRESH_COOKIE, token, {
    httpOnly: true,
    // See auth.controller.ts's identical fix — req.secure (via main.ts's
    // `trust proxy`), not NODE_ENV, which is 'production' on every real
    // native install regardless of whether TLS is actually in front of it.
    secure: res.req.secure,
    sameSite: 'strict',
    path: PORTAL_REFRESH_PATH,
    expires: expiresAt,
  });
}

function setPortalCsrfCookie(res: Response) {
  const csrfToken = randomUUID();
  res.cookie(PORTAL_CSRF_COOKIE, csrfToken, {
    httpOnly: false,
    // See auth.controller.ts's identical fix — req.secure (via main.ts's
    // `trust proxy`), not NODE_ENV, which is 'production' on every real
    // native install regardless of whether TLS is actually in front of it.
    secure: res.req.secure,
    sameSite: 'strict',
    path: '/',
  });
}

function clearPortalAuthCookies(res: Response) {
  res.clearCookie(PORTAL_REFRESH_COOKIE, { path: PORTAL_REFRESH_PATH });
  res.clearCookie(PORTAL_CSRF_COOKIE, { path: '/' });
}

@ApiTags('Portal Auth')
@Controller('portal/auth')
export class PortalAuthController {
  constructor(private readonly portalAuthService: PortalAuthService) {}

  @Public()
  @UseGuards(PortalAuthThrottlerGuard)
  @Post('login')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Portal login by phone or email' })
  async login(@Body() dto: PortalLoginDto, @Res({ passthrough: true }) res: Response) {
    const result = await this.portalAuthService.login(dto);

    // Set before either branch — same defect, same fix, as the staff-side
    // AuthController.login() (see its own comment): totp/verify is
    // CSRF-guarded like any other mutation, but this response is the only
    // place a 2FA-pending portal session ever gets a chance to receive the
    // cookie. The early return here skipped it entirely, so every
    // 2FA-enabled portal account (customer or broker) has 403'd with
    // "CSRF token mismatch" on totp/verify and could never actually
    // complete login — never fixed on this side when the staff bug was
    // fixed last session.
    setPortalCsrfCookie(res);

    if (result.requiresTwoFactor) {
      return { requiresTwoFactor: true, tempToken: result.tempToken };
    }

    setPortalRefreshCookie(res, result.refreshRaw!, result.expiresAt!);
    return { accessToken: result.accessToken };
  }

  @UseGuards(PortalAuthThrottlerGuard)
  @Post('totp/verify')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Verify TOTP code after portal login' })
  async verifyTotp(
    @Body() dto: TotpVerifyDto,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ) {
    const user = req.user as JwtPayload;
    const result = await this.portalAuthService.verifyTotp(user.sub, dto.code);
    setPortalRefreshCookie(res, result.refreshRaw, result.expiresAt);
    setPortalCsrfCookie(res);
    return { accessToken: result.accessToken };
  }

  @Get('me')
  @ApiOperation({ summary: 'Current portal user (for Security settings)' })
  async me(@Req() req: Request) {
    const user = req.user as JwtPayload;
    return this.portalAuthService.getMe(user.sub);
  }

  @Post('totp/setup')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Begin portal TOTP 2FA setup' })
  async setupTotp(@Req() req: Request) {
    const user = req.user as JwtPayload;
    return this.portalAuthService.setupTotp(user.sub);
  }

  @Post('totp/confirm')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Confirm portal TOTP setup with a code' })
  async confirmTotp(@Body() dto: TotpVerifyDto, @Req() req: Request) {
    const user = req.user as JwtPayload;
    return this.portalAuthService.confirmTotp(user.sub, dto.code);
  }

  @Post('totp/disable')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({ summary: 'Disable portal TOTP 2FA' })
  async disableTotp(@Req() req: Request) {
    const user = req.user as JwtPayload;
    await this.portalAuthService.disableTotp(user.sub);
  }

  @Public()
  @Post('refresh')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Rotate portal refresh token' })
  async refresh(@Req() req: Request, @Res({ passthrough: true }) res: Response) {
    const rawToken = req.cookies?.[PORTAL_REFRESH_COOKIE];
    if (!rawToken) throw new UnauthorizedException('No refresh token');

    const result = await this.portalAuthService.refreshTokens(rawToken);
    if (!result) {
      clearPortalAuthCookies(res);
      throw new UnauthorizedException('Invalid refresh token');
    }

    // E5: exhaustive kind check — see apps/api/src/auth/auth.controller.ts's
    // identical block. TokenService is shared between staff and portal
    // (portal-auth.service.ts:14 imports it directly), and the mirrored-
    // auth standing rule requires the two controllers to handle the
    // discriminated result the same way. Replays return the accessToken
    // with no cookie mutation; the winner's response already delivered
    // the rotated cookies to the same browser.
    if (result.kind === 'rotated') {
      setPortalRefreshCookie(res, result.refreshRaw, result.expiresAt);
      setPortalCsrfCookie(res);
    }
    return { accessToken: result.accessToken };
  }

  @Post('logout')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({ summary: 'Portal logout (revoke refresh token family)' })
  async logout(@Req() req: Request, @Res({ passthrough: true }) res: Response) {
    const rawToken = req.cookies?.[PORTAL_REFRESH_COOKIE];
    if (rawToken) await this.portalAuthService.logout(rawToken);
    clearPortalAuthCookies(res);
  }

  @Post('logout-all')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({ summary: 'Portal logout from all devices' })
  async logoutAll(@Req() req: Request, @Res({ passthrough: true }) res: Response) {
    const user = req.user as JwtPayload;
    await this.portalAuthService.logoutAll(user.sub);
    clearPortalAuthCookies(res);
  }

  @Post('change-password')
  @UseGuards(PasswordChangeThrottlerGuard)
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({ summary: 'Change portal password' })
  async changePassword(@Body() dto: PortalChangePasswordDto, @Req() req: Request) {
    const user = req.user as JwtPayload;
    const currentRefreshToken = req.cookies?.[PORTAL_REFRESH_COOKIE];
    await this.portalAuthService.changePassword(
      user.sub,
      dto.currentPassword,
      dto.newPassword,
      currentRefreshToken,
    );
  }

  @Public()
  @UseGuards(PortalAuthThrottlerGuard)
  @Post('invite/:inviteId/consume')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Consume a portal invite and set a password' })
  async consumeInvite(
    @Param('inviteId') inviteId: string,
    @Body() dto: PortalInviteConsumeDto,
    @Res({ passthrough: true }) res: Response,
  ) {
    const result = await this.portalAuthService.consumeInvite(inviteId, dto);
    setPortalRefreshCookie(res, result.refreshRaw, result.expiresAt);
    setPortalCsrfCookie(res);
    return { accessToken: result.accessToken };
  }

  @Public()
  @UseGuards(PortalAuthThrottlerGuard)
  @Post('password-reset/request')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Request a portal password reset' })
  async requestPasswordReset(@Body() dto: PortalPasswordResetRequestDto) {
    await this.portalAuthService.requestPasswordReset(dto);
    return { message: 'If that account exists, a reset link has been sent.' };
  }

  @Public()
  @UseGuards(PortalAuthThrottlerGuard)
  @Post('password-reset/confirm')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({ summary: 'Confirm a portal password reset' })
  async confirmPasswordReset(@Body() dto: PortalPasswordResetConfirmDto) {
    await this.portalAuthService.confirmPasswordReset(dto);
  }
}
