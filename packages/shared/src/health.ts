import { z } from 'zod';

export const healthStatusSchema = z.object({
  status: z.enum(['ok', 'degraded', 'down']),
  db: z.enum(['ok', 'down']),
  redis: z.enum(['ok', 'down']),
  version: z.string(),
  uptimeSeconds: z.number(),
});

export type HealthStatus = z.infer<typeof healthStatusSchema>;
