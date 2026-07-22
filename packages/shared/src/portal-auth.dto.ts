import { z } from 'zod';

// ── Portal auth (Phase 6) ────────────────────────────────────
// Separate from auth.dto.ts's staff schemas deliberately — portal auth
// is its own realm (see CLAUDE.md Phase 6 decisions): different login
// identifier shape, different flows (invite-consume, self-service
// reset) staff accounts never have.

export const portalLoginSchema = z
  .object({
    // Phone or email — Applicant.primaryPhone is required, email is
    // optional, so login can't be email-only.
    identifier: z.string().min(1).max(255),
    password: z.string().min(1).max(128),
  })
  .strict();
export type PortalLoginDto = z.infer<typeof portalLoginSchema>;

export const portalInviteConsumeSchema = z
  .object({
    token: z.string().min(1),
    password: z.string().min(8).max(128),
  })
  .strict();
export type PortalInviteConsumeDto = z.infer<typeof portalInviteConsumeSchema>;

export const portalPasswordResetRequestSchema = z
  .object({
    identifier: z.string().min(1).max(255),
  })
  .strict();
export type PortalPasswordResetRequestDto = z.infer<typeof portalPasswordResetRequestSchema>;

export const portalPasswordResetConfirmSchema = z
  .object({
    token: z.string().min(1),
    newPassword: z.string().min(8).max(128),
  })
  .strict();
export type PortalPasswordResetConfirmDto = z.infer<typeof portalPasswordResetConfirmSchema>;

export const portalChangePasswordSchema = z
  .object({
    currentPassword: z.string().min(1).max(128),
    newPassword: z.string().min(8).max(128),
  })
  .strict();
export type PortalChangePasswordDto = z.infer<typeof portalChangePasswordSchema>;

// Staff side: trigger an invite for a specific applicant or broker.
export const sendPortalInviteSchema = z
  .object({
    applicantId: z.string().uuid().optional(),
    brokerId: z.string().uuid().optional(),
    channel: z.enum(['EMAIL', 'SMS']),
  })
  .strict()
  .refine((d) => (d.applicantId ? !d.brokerId : !!d.brokerId), {
    message: 'Exactly one of applicantId or brokerId is required',
  });
export type SendPortalInviteDto = z.infer<typeof sendPortalInviteSchema>;
