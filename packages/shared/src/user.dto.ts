import { z } from 'zod';

export const createUserSchema = z
  .object({
    email: z.string().email().max(255),
    name: z.string().min(1).max(255),
    password: z.string().min(8).max(128),
    roleId: z.string().uuid(),
    phone: z.string().max(20).optional(),
    managerId: z.string().uuid().nullable().optional(),
  })
  .strict();

export type CreateUserDto = z.infer<typeof createUserSchema>;

export const updateUserSchema = z
  .object({
    name: z.string().min(1).max(255).optional(),
    roleId: z.string().uuid().optional(),
    phone: z.string().max(20).optional(),
    managerId: z.string().uuid().nullable().optional(),
  })
  .strict();

export type UpdateUserDto = z.infer<typeof updateUserSchema>;

export const deactivateUserSchema = z
  .object({
    reason: z.string().max(500).optional(),
  })
  .strict();

export type DeactivateUserDto = z.infer<typeof deactivateUserSchema>;
