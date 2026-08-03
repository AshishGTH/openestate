import { z } from 'zod';

export const createRoleSchema = z
  .object({
    name: z.string().min(1).max(255),
    // Frontend hint text has always promised "lowercase letters, numbers,
    // hyphens, underscores" (RoleForm.tsx) but this regex rejected
    // hyphens — every slug containing one 400'd on the very first
    // submission attempt.
    slug: z
      .string()
      .min(1)
      .max(100)
      .regex(/^[a-z][a-z0-9_-]*$/),
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
