/** Resolves a simple dot-path ("lead.mobile") against an arbitrary JSON
 * body — no JSONPath library needed for v1 (CLAUDE.md Phase 7 decisions
 * §5). Returns undefined for any missing/non-object intermediate step,
 * never throws — callers decide what "missing" means for their field. */
export function resolveFieldPath(body: unknown, path: string): unknown {
  return path.split('.').reduce<unknown>((acc, key) => {
    if (acc === null || acc === undefined || typeof acc !== 'object') return undefined;
    return (acc as Record<string, unknown>)[key];
  }, body);
}
