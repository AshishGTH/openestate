import { z } from 'zod';

export const CUSTOM_FIELD_TYPES = [
  'TEXT',
  'NUMBER',
  'DATE',
  'BOOLEAN',
  'SELECT',
  'MULTI_SELECT',
] as const;

export type CustomFieldType = (typeof CUSTOM_FIELD_TYPES)[number];

export const CUSTOM_FIELD_ENTITIES = [
  'INQUIRY',
  'BOOKING',
  'UNIT',
  'PROJECT',
  'APPLICANT',
] as const;

export type CustomFieldEntity = (typeof CUSTOM_FIELD_ENTITIES)[number];

export const createCustomFieldSchema = z
  .object({
    entityType: z.enum(CUSTOM_FIELD_ENTITIES),
    key: z
      .string()
      .min(1)
      .max(100)
      .regex(/^[a-z][a-z0-9_]*$/, 'Key must be lowercase snake_case'),
    label: z.string().min(1).max(255),
    fieldType: z.enum(CUSTOM_FIELD_TYPES),
    isRequired: z.boolean().default(false),
    options: z.array(z.string().max(255)).optional(),
    defaultValue: z.string().max(500).optional(),
    sortOrder: z.number().int().min(0).default(0),
  })
  .strict();

export type CreateCustomFieldDto = z.infer<typeof createCustomFieldSchema>;

export const updateCustomFieldSchema = z
  .object({
    label: z.string().min(1).max(255).optional(),
    isRequired: z.boolean().optional(),
    options: z.array(z.string().max(255)).optional(),
    defaultValue: z.string().max(500).optional(),
    sortOrder: z.number().int().min(0).optional(),
  })
  .strict();

export type UpdateCustomFieldDto = z.infer<typeof updateCustomFieldSchema>;
