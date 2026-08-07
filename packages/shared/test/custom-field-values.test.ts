/**
 * v0.2.3: value validation for admin-defined custom fields.
 *
 * This file replaces `packages/db/test/custom-fields-validation.test.ts`,
 * which re-implemented its OWN local copy of the schema builder and
 * therefore proved nothing about the function the API actually calls —
 * `packages/db` has no dependency on `@openestate/shared`, which is why
 * the copy existed. Moving the builder into `packages/shared` and the
 * test alongside it means there is now exactly one implementation, and
 * this file imports it.
 */
import { describe, it, expect } from 'vitest';
import {
  buildCustomFieldValueSchema,
  validateCustomFieldValues,
  supportsCustomFieldValues,
  CUSTOM_FIELD_VALUE_ENTITIES,
  purgeCustomFieldSchema,
  type CustomFieldDefinitionLike,
} from '../src/custom-field.dto';

const def = (over: Partial<CustomFieldDefinitionLike> = {}): CustomFieldDefinitionLike => ({
  key: 'notes',
  fieldType: 'TEXT',
  isRequired: false,
  options: null,
  ...over,
});

describe('buildCustomFieldValueSchema — types', () => {
  it('accepts a valid value of each type', () => {
    const schema = buildCustomFieldValueSchema([
      def({ key: 'note', fieldType: 'TEXT' }),
      def({ key: 'floor_pref', fieldType: 'NUMBER' }),
      def({ key: 'possession', fieldType: 'DATE' }),
      def({ key: 'nri', fieldType: 'BOOLEAN' }),
      def({ key: 'facing', fieldType: 'SELECT', options: ['North', 'South'] }),
      def({ key: 'amenities', fieldType: 'MULTI_SELECT', options: ['Gym', 'Pool'] }),
    ]);
    const parsed = schema.parse({
      note: 'hello',
      floor_pref: 7,
      possession: '2027-03-01',
      nri: true,
      facing: 'North',
      amenities: ['Gym'],
    });
    expect(parsed).toMatchObject({ note: 'hello', floor_pref: 7, nri: true, facing: 'North' });
  });

  it('rejects a wrong-typed value rather than coercing it', () => {
    const schema = buildCustomFieldValueSchema([def({ key: 'floor_pref', fieldType: 'NUMBER' })]);
    expect(schema.safeParse({ floor_pref: 'seven' }).success).toBe(false);
    // A numeric STRING is still not a number — coercing here would also
    // make "" parse as 0, which would silently satisfy a required field.
    expect(schema.safeParse({ floor_pref: '7' }).success).toBe(false);
  });

  it('rejects a SELECT value outside its options', () => {
    const schema = buildCustomFieldValueSchema([
      def({ key: 'facing', fieldType: 'SELECT', options: ['North', 'South'] }),
    ]);
    expect(schema.safeParse({ facing: 'North' }).success).toBe(true);
    expect(schema.safeParse({ facing: 'East' }).success).toBe(false);
  });

  it('rejects a MULTI_SELECT array containing any invalid option', () => {
    const schema = buildCustomFieldValueSchema([
      def({ key: 'amenities', fieldType: 'MULTI_SELECT', options: ['Gym', 'Pool'] }),
    ]);
    expect(schema.safeParse({ amenities: ['Gym', 'Pool'] }).success).toBe(true);
    expect(schema.safeParse({ amenities: ['Gym', 'Helipad'] }).success).toBe(false);
  });

  it('does not throw at construction when a SELECT has no options left', () => {
    // An update that empties `options` used to make z.enum([]) throw at
    // BUILD time, which would crash every save on that entity rather
    // than reject one field. The service refuses to empty them; this is
    // the second layer.
    expect(() =>
      buildCustomFieldValueSchema([def({ key: 'facing', fieldType: 'SELECT', options: [] })]),
    ).not.toThrow();
    const schema = buildCustomFieldValueSchema([
      def({ key: 'facing', fieldType: 'SELECT', options: [] }),
    ]);
    expect(schema.safeParse({ facing: 'anything' }).success).toBe(false);
  });
});

describe('buildCustomFieldValueSchema — required and unknown keys', () => {
  it('rejects a missing required field', () => {
    const schema = buildCustomFieldValueSchema([def({ key: 'pan_no', isRequired: true })]);
    expect(schema.safeParse({}).success).toBe(false);
    expect(schema.safeParse({ pan_no: 'ABCDE1234F' }).success).toBe(true);
  });

  it('rejects an empty string for a required TEXT field', () => {
    const schema = buildCustomFieldValueSchema([def({ key: 'pan_no', isRequired: true })]);
    // Without .min(1) a blank input would silently satisfy "required".
    expect(schema.safeParse({ pan_no: '' }).success).toBe(false);
  });

  it('allows a missing optional field', () => {
    const schema = buildCustomFieldValueSchema([def({ key: 'note', isRequired: false })]);
    expect(schema.safeParse({}).success).toBe(true);
  });

  it('REJECTS an unknown key rather than silently stripping it', () => {
    // zod's default is strip, which would let a client write arbitrary
    // junk that simply vanishes. This is the integrity hole v0.2.3
    // closes — customFields accepted any key at all since Phase 3.
    const schema = buildCustomFieldValueSchema([def({ key: 'note' })]);
    const res = schema.safeParse({ note: 'ok', not_a_field: 'junk' });
    expect(res.success).toBe(false);
  });
});

describe('DATE canonical storage', () => {
  it('normalises to YYYY-MM-DD', () => {
    const out = validateCustomFieldValues([def({ key: 'd', fieldType: 'DATE' })], {
      d: '2027-03-01T18:30:00.000Z',
    });
    expect(out.d).toBe('2027-03-01');
  });

  it('accepts a plain date string unchanged', () => {
    const out = validateCustomFieldValues([def({ key: 'd', fieldType: 'DATE' })], { d: '2027-03-01' });
    expect(out.d).toBe('2027-03-01');
  });

  it('rejects a non-ISO string instead of leaning on new Date() coercion', () => {
    const schema = buildCustomFieldValueSchema([def({ key: 'd', fieldType: 'DATE' })]);
    // new Date("5") is a real date in V8 — accepting that would be nonsense.
    expect(schema.safeParse({ d: '5' }).success).toBe(false);
    expect(schema.safeParse({ d: '01-03-2027' }).success).toBe(false);
    expect(schema.safeParse({ d: '2027-13-45' }).success).toBe(false);
  });
});

describe('entity support map', () => {
  it('excludes BOOKING, which has nowhere to store a value', () => {
    expect(supportsCustomFieldValues('BOOKING')).toBe(false);
    expect(CUSTOM_FIELD_VALUE_ENTITIES).not.toContain('BOOKING');
  });

  it('includes the four entities that do have a custom_fields column', () => {
    for (const e of ['APPLICANT', 'INQUIRY', 'UNIT', 'PROJECT']) {
      expect(supportsCustomFieldValues(e)).toBe(true);
    }
  });
});

describe('purge confirmation DTO', () => {
  it('requires a non-empty confirmKey and rejects extra keys', () => {
    expect(purgeCustomFieldSchema.safeParse({ confirmKey: 'aadhaar_number' }).success).toBe(true);
    expect(purgeCustomFieldSchema.safeParse({ confirmKey: '' }).success).toBe(false);
    expect(purgeCustomFieldSchema.safeParse({}).success).toBe(false);
    expect(
      purgeCustomFieldSchema.safeParse({ confirmKey: 'x', force: true }).success,
    ).toBe(false);
  });
});
