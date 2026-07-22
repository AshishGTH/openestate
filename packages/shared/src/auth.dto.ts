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
    code: z.string().length(6).regex(/^\d+$/),
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
