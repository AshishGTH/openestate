import {
  Body,
  Controller,
  HttpCode,
  HttpStatus,
  Post,
  Req,
  Res,
  UnauthorizedException,
} from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { Request, Response } from 'express';
import { createZodDto } from 'nestjs-zod';
import {
  loginSchema,
  totpVerifySchema,
  changePasswordSchema,
  forceChangePasswordSchema,
} from '@openestate/shared';
import type { JwtPayload } from '@openestate/shared';
import { AuthService } from './auth.service';
import { Public } from './guards/jwt-auth.guard';

class LoginDto extends createZodDto(loginSchema) {}
class TotpVerifyDto extends createZodDto(totpVerifySchema) {}
class ChangePasswordDto extends createZodDto(changePasswordSchema) {}
class ForceChangePasswordDto extends createZodDto(forceChangePasswordSchema) {}

const REFRESH_COOKIE = 'openestate_refresh';
const CSRF_COOKIE = 'openestate_csrf';

function setRefreshCookie(res: Response, token: string, expiresAt: Date) {
  res.cookie(REFRESH_COOKIE, token, {
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    sameSite: 'strict',
    path: '/api/v1/auth',
    expires: expiresAt,
  });
}

function setCsrfCookie(res: Response) {
  const csrfToken = crypto.randomUUID();
  res.cookie(CSRF_COOKIE, csrfToken, {
    httpOnly: false,
    secure: process.env.NODE_ENV === 'production',
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

    if (result.requiresTwoFactor) {
      return {
        requiresTwoFactor: true,
        tempToken: result.tempToken,
      };
    }

    setRefreshCookie(res, result.refreshRaw, result.expiresAt);
    setCsrfCookie(res);
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

    setRefreshCookie(res, result.refreshRaw, result.expiresAt);
    setCsrfCookie(res);
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
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({ summary: 'Change password' })
  async changePassword(@Body() dto: ChangePasswordDto, @Req() req: Request) {
    const user = req.user as JwtPayload;
    await this.authService.changePassword(
      user.sub,
      dto.currentPassword,
      dto.newPassword,
    );
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
