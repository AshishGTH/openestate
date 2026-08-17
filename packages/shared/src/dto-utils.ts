import type { z } from 'zod';

/**
 * Derives a payload for a `.strict()` update schema by projecting ONTO the
 * schema's own declared keys, picked from a superset object (typically a
 * create-shaped form value). The correct direction: project TO the update
 * shape, never subtract FROM the create shape.
 *
 * Subtracting is what broke three times in this codebase (a create-shaped
 * `useForm` payload sent to a `.strict()` update endpoint, with only the
 * fields someone remembered to strip removed) — the create schema kept a
 * field the update schema never wanted, and "strip just the ones I
 * remember" silently missed it every time the create schema grew a new
 * field. Picking by the update schema's own declared keys can't drift the
 * same way: it's wrong only if the update schema itself is wrong, which is
 * the one place that's actually supposed to be the source of truth.
 *
 * Preserves explicit `null` (a caller clearing a nullable field) while
 * dropping `undefined` (an omitted/never-set field) — the same
 * omitted-vs-explicit-null distinction this codebase's GST-rate
 * null-coercion fix already established matters at the API boundary.
 */
export function pickForSchema<Shape extends z.ZodRawShape>(
  schema: z.ZodObject<Shape>,
  data: Record<string, unknown>,
): Partial<z.infer<z.ZodObject<Shape>>> {
  const result: Record<string, unknown> = {};
  for (const key of Object.keys(schema.shape)) {
    if (key in data && data[key] !== undefined) {
      result[key] = data[key];
    }
  }
  return result as Partial<z.infer<z.ZodObject<Shape>>>;
}
