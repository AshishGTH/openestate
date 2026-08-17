import { describe, it, expect } from 'vitest';
import { z } from 'zod';
import { pickForSchema } from '../src/dto-utils';
import { updateUserSchema, createUserSchema } from '../src/user.dto';
import { payCommissionPaymentSchema } from '../src/commission';

describe('pickForSchema', () => {
  const updateSchema = z.object({
    name: z.string().optional(),
    logoUrl: z.string().nullable().optional(),
  }).strict();

  it('picks only keys the schema declares, from a superset object', () => {
    const data = { name: 'Alice', email: 'a@test.com', password: 'secret', roleId: 'x' };
    expect(pickForSchema(updateUserSchema, data)).toEqual({ name: 'Alice', roleId: 'x' });
  });

  it('preserves an explicit null (a clear) but drops undefined (an omission)', () => {
    const data = { name: undefined, logoUrl: null };
    expect(pickForSchema(updateSchema, data)).toEqual({ logoUrl: null });
  });

  it('produces a payload the schema itself validates', () => {
    const data = { email: 'a@test.com', name: 'Bob', password: 'x', roleId: '00000000-0000-0000-0000-000000000000', phone: '999' };
    const picked = pickForSchema(updateUserSchema, data);
    expect(updateUserSchema.safeParse(picked).success).toBe(true);
  });

  it('regression: a real create-shaped payload sent through pickForSchema never trips the update schema strict() check', () => {
    // This is the exact shape of bug that hit UserForm.tsx three times
    // (here, BrokerDetail's Pay, Masters' PATCH) — a create-shaped object
    // (with required fields the update schema doesn't declare, like
    // `email`/`password`) reaching a `.strict()` update endpoint directly.
    const createShaped = createUserSchema.parse({
      email: 'new@test.com',
      name: 'New User',
      password: 'password123',
      roleId: '00000000-0000-0000-0000-000000000000',
    });
    const picked = pickForSchema(updateUserSchema, createShaped);
    expect('email' in picked).toBe(false);
    expect('password' in picked).toBe(false);
    expect(updateUserSchema.safeParse(picked).success).toBe(true);
  });

  it('BrokerDetail.tsx Pay: an already-minimal hand-built object round-trips unchanged (the refactor from a hand-picked body to pickForSchema is behavior-preserving)', () => {
    const body = { mode: 'NEFT', paymentDate: '2026-01-15' };
    expect(pickForSchema(payCommissionPaymentSchema, body)).toEqual(body);
  });
});
