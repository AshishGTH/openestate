import { z } from 'zod';

export const createRoleSchema = z
  .object({
    name: z.string().min(1).max(255),
    slug: z
      .string()
      .min(1)
      .max(100)
      .regex(/^[a-z][a-z0-9_]*$/),
    permissionIds: z.array(z.string().uuid()).default([]),
  })
  .strict();

export type CreateRoleDto = z.infer<typeof createRoleSchema>;

export const updateRoleSchema = z
  .object({
    name: z.string().min(1).max(255).optional(),
    permissionIds: z.array(z.string().uuid()).optional(),
  })
  .strict();

export type UpdateRoleDto = z.infer<typeof updateRoleSchema>;
