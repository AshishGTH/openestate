import { z } from 'zod';

export const loginSchema = z
  .object({
    email: z.string().email().max(255),
    password: z.string().min(1).max(128),
  })
  .strict();

export type LoginDto = z.infer<typeof loginSchema>;

export const totpVerifySchema = z
  .object({
    // Either a 6-digit TOTP code or an XXXXX-XXXXX recovery code
    // (TotpService.generateRecoveryCodes()'s exact format). Recovery
    // codes exist specifically for "lost my authenticator" — a
    // digits-only schema here rejected every one of them with a 400
    // before AuthService.verifyTotp()'s recovery-code check (which
    // already handles this format correctly) ever ran, making the
    // whole recovery path unusable through the real API.
    code: z.string().regex(/^(\d{6}|[0-9A-F]{5}-[0-9A-F]{5})$/, 'Invalid code format'),
  })
  .strict();

export type TotpVerifyDto = z.infer<typeof totpVerifySchema>;

export const changePasswordSchema = z
  .object({
    currentPassword: z.string().min(1).max(128),
    newPassword: z.string().min(8).max(128),
  })
  .strict();

export type ChangePasswordDto = z.infer<typeof changePasswordSchema>;

export const forceChangePasswordSchema = z
  .object({
    newPassword: z.string().min(8).max(128),
  })
  .strict();

export type ForceChangePasswordDto = z.infer<typeof forceChangePasswordSchema>;

export const passwordResetConfirmSchema = z
  .object({
    token: z.string().min(1),
    newPassword: z.string().min(8).max(128),
  })
  .strict();

export type PasswordResetConfirmDto = z.infer<typeof passwordResetConfirmSchema>;

export const tokenResponseSchema = z.object({
  accessToken: z.string(),
  expiresIn: z.number(),
});

export type TokenResponse = z.infer<typeof tokenResponseSchema>;

export const totpSetupResponseSchema = z.object({
  secret: z.string(),
  otpauthUrl: z.string(),
  qrDataUrl: z.string(),
});

export type TotpSetupResponse = z.infer<typeof totpSetupResponseSchema>;

export interface JwtPayload {
  sub: string;
  companyId: string;
  // Nullable because a phone-only portal user (Phase 6) may have no
  // email on file at all — never a synthesized placeholder address.
  email: string | null;
  roleSlug: string;
  permissions: string[];
  // Staff-only — portal users are always created via invite-consume,
  // which sets a real password immediately, so this never applies to a
  // portal session and is omitted there entirely (same "portal-only /
  // staff-only field, omitted rather than false" convention as
  // applicantId/brokerId below, just inverted).
  forcePasswordChange?: boolean;
  // Phase 6: set only on a portal (customer/broker) token — a superset
  // field, never present on a staff token. Exactly one is set when
  // either is set.
  applicantId?: string;
  brokerId?: string;
  iat?: number;
  exp?: number;
}

export interface RefreshPayload {
  sub: string;
  family: string;
  jti: string;
  iat?: number;
  exp?: number;
}
