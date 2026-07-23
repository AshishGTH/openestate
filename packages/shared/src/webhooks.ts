import { z } from 'zod';

export const WEBHOOK_DELIVERY_STATUS = {
  PENDING: 'PENDING',
  SUCCESS: 'SUCCESS',
  EXHAUSTED: 'EXHAUSTED',
} as const;

export const createWebhookEndpointSchema = z
  .object({
    name: z.string().min(1).max(255),
    url: z.string().url().max(500),
    secret: z.string().min(16).max(500),
    eventTypes: z.array(z.string().min(1)).min(1),
  })
  .strict();
export type CreateWebhookEndpointDto = z.infer<typeof createWebhookEndpointSchema>;

export const updateWebhookEndpointSchema = z
  .object({
    name: z.string().min(1).max(255).optional(),
    url: z.string().url().max(500).optional(),
    secret: z.string().min(16).max(500).optional(),
    eventTypes: z.array(z.string().min(1)).min(1).optional(),
  })
  .strict();
export type UpdateWebhookEndpointDto = z.infer<typeof updateWebhookEndpointSchema>;

export const bulkRetryDeliveriesSchema = z
  .object({
    webhookEndpointId: z.string().uuid().optional(),
    from: z.coerce.date().optional(),
    to: z.coerce.date().optional(),
  })
  .strict();
export type BulkRetryDeliveriesDto = z.infer<typeof bulkRetryDeliveriesSchema>;

export const createLeadApiKeySchema = z
  .object({
    name: z.string().min(1).max(255),
    fieldMapping: z
      .record(z.string(), z.string())
      .refine((m) => 'name' in m && 'phone' in m, { message: 'fieldMapping must map at least "name" and "phone"' }),
    rateLimitPerMinute: z.number().int().min(1).max(6000).default(60),
  })
  .strict();
export type CreateLeadApiKeyDto = z.infer<typeof createLeadApiKeySchema>;
