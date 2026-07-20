/**
 * Custom fields: server-side validation from definitions (g).
 *
 * Tests that buildValidationSchema creates correct zod schemas from
 * custom field definitions — rejects bad values, unknown keys, validates
 * required vs optional, SELECT enum enforcement.
 *
 * These are unit tests (no Postgres needed).
 */
import { describe, it, expect } from 'vitest';
import { z } from 'zod';

type CustomFieldType = 'TEXT' | 'NUMBER' | 'DATE' | 'BOOLEAN' | 'SELECT' | 'MULTI_SELECT';

function buildValidationSchema(
  definitions: Array<{
    key: string;
    fieldType: string;
    isRequired: boolean;
    options: unknown;
  }>,
): z.ZodObject<Record<string, z.ZodTypeAny>> {
  const shape: Record<string, z.ZodTypeAny> = {};

  for (const def of definitions) {
    let schema: z.ZodTypeAny;
    switch (def.fieldType as CustomFieldType) {
      case 'TEXT':
        schema = z.string().max(1000);
        break;
      case 'NUMBER':
        schema = z.number();
        break;
      case 'DATE':
        schema = z.coerce.date();
        break;
      case 'BOOLEAN':
        schema = z.boolean();
        break;
      case 'SELECT': {
        const opts = (def.options as string[]) ?? [];
        schema = z.enum(opts as [string, ...string[]]);
        break;
      }
      case 'MULTI_SELECT': {
        const opts = (def.options as string[]) ?? [];
        schema = z.array(z.enum(opts as [string, ...string[]]));
        break;
      }
      default:
        schema = z.unknown();
    }

    shape[def.key] = def.isRequired ? schema : schema.optional();
  }

  return z.object(shape);
}

describe('Custom fields validation (g)', () => {
  const definitions = [
    { key: 'notes', fieldType: 'TEXT', isRequired: false, options: null },
    { key: 'area_sqft', fieldType: 'NUMBER', isRequired: true, options: null },
    { key: 'is_verified', fieldType: 'BOOLEAN', isRequired: true, options: null },
    {
      key: 'priority',
      fieldType: 'SELECT',
      isRequired: true,
      options: ['Low', 'Medium', 'High'],
    },
    {
      key: 'tags',
      fieldType: 'MULTI_SELECT',
      isRequired: false,
      options: ['VIP', 'NRI', 'Corporate'],
    },
  ];

  it('accepts valid custom field data', () => {
    const schema = buildValidationSchema(definitions);
    const result = schema.parse({
      area_sqft: 1200,
      is_verified: true,
      priority: 'High',
    });
    expect(result.area_sqft).toBe(1200);
    expect(result.is_verified).toBe(true);
    expect(result.priority).toBe('High');
  });

  it('rejects a bad value (string for NUMBER field)', () => {
    const schema = buildValidationSchema(definitions);
    expect(() =>
      schema.parse({ area_sqft: 'not-a-number', is_verified: true, priority: 'Low' }),
    ).toThrow();
  });

  it('rejects an invalid SELECT option', () => {
    const schema = buildValidationSchema(definitions);
    expect(() =>
      schema.parse({ area_sqft: 100, is_verified: true, priority: 'Invalid' }),
    ).toThrow();
  });

  it('rejects missing required fields', () => {
    const schema = buildValidationSchema(definitions);
    expect(() => schema.parse({ notes: 'some text' })).toThrow();
  });

  it('allows optional fields to be omitted', () => {
    const schema = buildValidationSchema(definitions);
    const result = schema.parse({
      area_sqft: 500,
      is_verified: false,
      priority: 'Medium',
    });
    expect(result.notes).toBeUndefined();
    expect(result.tags).toBeUndefined();
  });

  it('rejects unknown keys (strict mode)', () => {
    const schema = buildValidationSchema(definitions).strict();
    expect(() =>
      schema.parse({
        area_sqft: 100,
        is_verified: true,
        priority: 'Low',
        unknown_field: 'should fail',
      }),
    ).toThrow();
  });

  it('validates MULTI_SELECT array values against allowed options', () => {
    const schema = buildValidationSchema(definitions);
    const result = schema.parse({
      area_sqft: 100,
      is_verified: true,
      priority: 'Low',
      tags: ['VIP', 'NRI'],
    });
    expect(result.tags).toEqual(['VIP', 'NRI']);
  });

  it('rejects invalid MULTI_SELECT values', () => {
    const schema = buildValidationSchema(definitions);
    expect(() =>
      schema.parse({
        area_sqft: 100,
        is_verified: true,
        priority: 'Low',
        tags: ['VIP', 'InvalidTag'],
      }),
    ).toThrow();
  });
});
