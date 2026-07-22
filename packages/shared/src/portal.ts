import { z } from 'zod';
import { createApplicantSchema } from './presales';

// ── Change requests (Phase 6) ────────────────────────────────
// Whitelisted fields ONLY — primaryPhone/name/PAN/dateOfBirth are NOT
// portal-editable in Phase 6 (staff edits those directly in apps/web).
// Field validators are reused from Applicant's own create schema, not
// re-derived, so a change request can't contain a shape the staff-side
// form itself would reject. .strict() means an unlisted field 400s at
// the boundary rather than being silently dropped or accepted.
export const submitChangeRequestSchema = z
  .object({
    // .removeDefault() strips createApplicantSchema's `.default([])` so an
    // omitted field here means "not part of this request", not "clear to
    // an empty array" — the two must stay distinguishable for the
    // at-least-one-field .refine() below to mean what it says.
    alternatePhones: createApplicantSchema.shape.alternatePhones.removeDefault().optional(),
    email: createApplicantSchema.shape.email,
  })
  .strict()
  .refine((d) => d.alternatePhones !== undefined || d.email !== undefined, {
    message: 'At least one field (alternatePhones or email) must be provided',
  });
export type SubmitChangeRequestDto = z.infer<typeof submitChangeRequestSchema>;

export const CHANGE_REQUEST_STATUS = {
  PENDING: 'PENDING',
  APPROVED: 'APPROVED',
  REJECTED: 'REJECTED',
} as const;
export type ChangeRequestStatusValue = (typeof CHANGE_REQUEST_STATUS)[keyof typeof CHANGE_REQUEST_STATUS];

export const rejectChangeRequestSchema = z
  .object({
    reviewNote: z.string().min(1).max(500),
  })
  .strict();
export type RejectChangeRequestDto = z.infer<typeof rejectChangeRequestSchema>;

// ── Tickets (Phase 6) ─────────────────────────────────────────

export const createTicketSchema = z
  .object({
    categoryId: z.string().uuid(),
    subject: z.string().min(1).max(255),
    body: z.string().min(1).max(5000),
  })
  .strict();
export type CreateTicketDto = z.infer<typeof createTicketSchema>;

export const addTicketMessageSchema = z
  .object({
    body: z.string().min(1).max(5000),
  })
  .strict();
export type AddTicketMessageDto = z.infer<typeof addTicketMessageSchema>;

export const TICKET_STATUS = {
  OPEN: 'OPEN',
  IN_PROGRESS: 'IN_PROGRESS',
  RESOLVED: 'RESOLVED',
  CLOSED: 'CLOSED',
} as const;
export type TicketStatusValue = (typeof TICKET_STATUS)[keyof typeof TICKET_STATUS];

export const updateTicketStatusSchema = z
  .object({
    status: z.nativeEnum(TICKET_STATUS),
  })
  .strict();
export type UpdateTicketStatusDto = z.infer<typeof updateTicketStatusSchema>;

// ── Construction updates (Phase 6) ───────────────────────────

export const createConstructionUpdateSchema = z
  .object({
    projectId: z.string().uuid(),
    title: z.string().min(1).max(255),
    description: z.string().max(2000).optional(),
    publishedAt: z.coerce.date(),
  })
  .strict();
export type CreateConstructionUpdateDto = z.infer<typeof createConstructionUpdateSchema>;

// ── Notification preferences (Phase 6) ───────────────────────
// The five trigger events wired in Phase 6 (Phase 3 dev provider);
// real provider plugins land in Phase 7.

export const NOTIFICATION_EVENT = {
  RECEIPT_CONFIRMED: 'RECEIPT_CONFIRMED',
  DEMAND_LETTER_ISSUED: 'DEMAND_LETTER_ISSUED',
  CONSTRUCTION_UPDATE_PUBLISHED: 'CONSTRUCTION_UPDATE_PUBLISHED',
  QUERY_REPLIED: 'QUERY_REPLIED',
  COMMISSION_PAID: 'COMMISSION_PAID',
} as const;
export type NotificationEventValue = (typeof NOTIFICATION_EVENT)[keyof typeof NOTIFICATION_EVENT];

const notificationChannelPrefSchema = z.object({ email: z.boolean(), sms: z.boolean() }).strict();

export const notificationPrefsSchema = z
  .object({
    RECEIPT_CONFIRMED: notificationChannelPrefSchema,
    DEMAND_LETTER_ISSUED: notificationChannelPrefSchema,
    CONSTRUCTION_UPDATE_PUBLISHED: notificationChannelPrefSchema,
    QUERY_REPLIED: notificationChannelPrefSchema,
    COMMISSION_PAID: notificationChannelPrefSchema,
  })
  .partial()
  .strict();
export type NotificationPrefs = z.infer<typeof notificationPrefsSchema>;

export const DEFAULT_NOTIFICATION_PREFS: Required<NotificationPrefs> = {
  RECEIPT_CONFIRMED: { email: true, sms: true },
  DEMAND_LETTER_ISSUED: { email: true, sms: true },
  CONSTRUCTION_UPDATE_PUBLISHED: { email: true, sms: false },
  QUERY_REPLIED: { email: true, sms: true },
  COMMISSION_PAID: { email: true, sms: true },
};
