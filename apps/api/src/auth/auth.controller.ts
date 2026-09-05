import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Post,
  Req,
  Res,
  UnauthorizedException,
  UseGuards,
} from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { Request, Response } from 'express';
import { createZodDto } from 'nestjs-zod';
import {
  loginSchema,
  totpVerifySchema,
  changePasswordSchema,
  forceChangePasswordSchema,
  passwordResetConfirmSchema,
} from '@openestate/shared';
import type { JwtPayload } from '@openestate/shared';
import { AuthService } from './auth.service';
import { Public } from './guards/jwt-auth.guard';
import { randomUUID } from 'node:crypto';
import { STAFF_CSRF_COOKIE } from './csrf-cookie-names';
import { PasswordChangeThrottlerGuard } from './guards/password-change-throttler.guard';

class LoginDto extends createZodDto(loginSchema) {}
class TotpVerifyDto extends createZodDto(totpVerifySchema) {}
class ChangePasswordDto extends createZodDto(changePasswordSchema) {}
class ForceChangePasswordDto extends createZodDto(forceChangePasswordSchema) {}
class PasswordResetConfirmDto extends createZodDto(passwordResetConfirmSchema) {}

const REFRESH_COOKIE = 'openestate_refresh';
const CSRF_COOKIE = STAFF_CSRF_COOKIE;

function setRefreshCookie(res: Response, token: string, expiresAt: Date) {
  res.cookie(REFRESH_COOKIE, token, {
    httpOnly: true,
    // req.secure reflects the CLIENT's real scheme via X-Forwarded-Proto
    // (see main.ts's `trust proxy` setting) — NOT NODE_ENV, which is
    // 'production' on every real native install regardless of whether
    // TLS is actually configured in front of it (it isn't, by default).
    // A Secure cookie is silently never stored by any real browser over
    // plain HTTP, which broke CSRF and session persistence outright on
    // any install without its own TLS-terminating proxy.
    secure: res.req.secure,
    sameSite: 'strict',
    path: '/api/v1/auth',
    expires: expiresAt,
  });
}

function setCsrfCookie(res: Response) {
  const csrfToken = randomUUID();
  res.cookie(CSRF_COOKIE, csrfToken, {
    httpOnly: false,
    // req.secure reflects the CLIENT's real scheme via X-Forwarded-Proto
    // (see main.ts's `trust proxy` setting) — NOT NODE_ENV, which is
    // 'production' on every real native install regardless of whether
    // TLS is actually configured in front of it (it isn't, by default).
    // A Secure cookie is silently never stored by any real browser over
    // plain HTTP, which broke CSRF and session persistence outright on
    // any install without its own TLS-terminating proxy.
    secure: res.req.secure,
    sameSite: 'strict',
    path: '/',
  });
}

function clearAuthCookies(res: Response) {
  res.clearCookie(REFRESH_COOKIE, { path: '/api/v1/auth' });
  res.clearCookie(CSRF_COOKIE, { path: '/' });
}

@ApiTags('Auth')
@Controller('auth')
export class AuthController {
  constructor(private readonly authService: AuthService) {}

  @Public()
  @Post('login')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Login with email and password' })
  async login(
    @Body() dto: LoginDto,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ) {
    const ip = req.ip ?? req.socket.remoteAddress;
    const result = await this.authService.login(dto, ip);

    // Set before either branch: totp/verify is CSRF-guarded like any other
    // mutation (CsrfGuard applies globally to non-GET/@Public() routes),
    // but this response is the ONLY place a 2FA-pending session ever gets
    // a chance to receive the cookie — the previous early-return skipped
    // it entirely, so every 2FA-enabled account's totp/verify call 403'd
    // with "CSRF token mismatch" and could never actually complete login.
    setCsrfCookie(res);

    if (result.requiresTwoFactor) {
      return {
        requiresTwoFactor: true,
        tempToken: result.tempToken,
      };
    }

    setRefreshCookie(res, result.refreshRaw, result.expiresAt);
    return { accessToken: result.accessToken };
  }

  @Post('totp/verify')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Verify TOTP code after login' })
  async verifyTotp(
    @Body() dto: TotpVerifyDto,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ) {
    const user = req.user as JwtPayload;
    const result = await this.authService.verifyTotp(user.sub, dto.code);

    setRefreshCookie(res, result.refreshRaw, result.expiresAt);
    setCsrfCookie(res);
    return { accessToken: result.accessToken };
  }

  @Get('me')
  @ApiOperation({ summary: 'Current staff user (for Security settings)' })
  async me(@Req() req: Request) {
    const user = req.user as JwtPayload;
    return this.authService.getMe(user.sub);
  }

  @Post('totp/setup')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Begin TOTP 2FA setup' })
  async setupTotp(@Req() req: Request) {
    const user = req.user as JwtPayload;
    return this.authService.setupTotp(user.sub);
  }

  @Post('totp/confirm')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Confirm TOTP setup with a code' })
  async confirmTotp(@Body() dto: TotpVerifyDto, @Req() req: Request) {
    const user = req.user as JwtPayload;
    return this.authService.confirmTotp(user.sub, dto.code);
  }

  @Post('totp/disable')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({ summary: 'Disable TOTP 2FA' })
  async disableTotp(@Req() req: Request) {
    const user = req.user as JwtPayload;
    await this.authService.disableTotp(user.sub);
  }

  @Public()
  @Post('refresh')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Rotate refresh token' })
  async refresh(
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ) {
    const rawToken = req.cookies?.[REFRESH_COOKIE];
    if (!rawToken) {
      throw new UnauthorizedException('No refresh token');
    }

    const result = await this.authService.refreshTokens(rawToken);
    if (!result) {
      clearAuthCookies(res);
      throw new UnauthorizedException('Invalid refresh token');
    }

    // E5: replays carry only an accessToken (see TokenService's
    // RotateRefreshTokenResult doc comment). The winner's response
    // already carries the rotated refresh + CSRF cookies to the same
    // browser; the loser stays silent on cookies so the client's jar
    // converges deterministically on the winner's tokens regardless
    // of response-arrival order. Exhaustive `kind` check — omitting
    // this branch would be a TypeScript error because
    // result.refreshRaw doesn't exist on kind: 'replayed'.
    if (result.kind === 'rotated') {
      setRefreshCookie(res, result.refreshRaw, result.expiresAt);
      setCsrfCookie(res);
    }
    return { accessToken: result.accessToken };
  }

  @Post('logout')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({ summary: 'Logout (revoke refresh token family)' })
  async logout(
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ) {
    const rawToken = req.cookies?.[REFRESH_COOKIE];
    if (rawToken) {
      await this.authService.logout(rawToken);
    }
    clearAuthCookies(res);
  }

  @Post('logout-all')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({ summary: 'Logout from all devices' })
  async logoutAll(
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ) {
    const user = req.user as JwtPayload;
    await this.authService.logoutAll(user.sub);
    clearAuthCookies(res);
  }

  @Post('change-password')
  @UseGuards(PasswordChangeThrottlerGuard)
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({ summary: 'Change password' })
  async changePassword(@Body() dto: ChangePasswordDto, @Req() req: Request) {
    const user = req.user as JwtPayload;
    const currentRefreshToken = req.cookies?.[REFRESH_COOKIE];
    await this.authService.changePassword(
      user.sub,
      dto.currentPassword,
      dto.newPassword,
      currentRefreshToken,
    );
  }

  @Public()
  @UseGuards(PasswordChangeThrottlerGuard)
  @Post('password-reset/confirm')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({ summary: 'Confirm an admin-issued password reset link' })
  async confirmPasswordReset(@Body() dto: PasswordResetConfirmDto) {
    await this.authService.confirmPasswordReset(dto);
  }

  @Post('force-change-password')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({ summary: 'Forced password change (first login)' })
  async forceChangePassword(
    @Body() dto: ForceChangePasswordDto,
    @Req() req: Request,
  ) {
    const user = req.user as JwtPayload;
    await this.authService.forceChangePassword(user.sub, dto.newPassword);
  }
}
