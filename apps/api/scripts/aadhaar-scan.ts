/**
 * Read-only scan for Aadhaar-like values already stored in custom fields.
 * The logic behind scripts/find-aadhaar-like-values.ts; kept apart so a test
 * can import it without running the CLI.
 *
 * Reports KEYS and COUNTS, never values. A number pulled out of the database
 * into a terminal, a saved log or a ticket is exactly the exposure this
 * release exists to reduce. Row ids are printed only on request.
 *
 * Imports only workspace packages (never ../src), so it runs from a deployed
 * release tree as well as from the repo.
 */
import { CUSTOM_FIELD_VALUE_ENTITIES, containsAadhaarKeyword, isAadhaarLikeValue } from '@openestate/shared';

// Delegate name on the Prisma client for each entity that carries custom_fields.
const MODEL_FOR_ENTITY = { INQUIRY: 'inquiry', UNIT: 'unit', PROJECT: 'project', APPLICANT: 'applicant' } as const;
const BATCH = 1000;
const MAX_IDS_PER_KEY = 20;

export interface ScanFinding {
  companyId: string;
  entityType: string;
  key: string;
  rows: number;
  /** Only filled when showIds is set; capped. */
  rowIds: string[];
}

export interface ScanReport {
  /** Field definitions whose key or label names Aadhaar (layer a). */
  namedDefinitions: Array<{ companyId: string; entityType: string; key: string; matched: string }>;
  /** Definitions whose options or default value look like an Aadhaar number (layer b). */
  definitionValues: Array<{ companyId: string; entityType: string; key: string; where: 'options' | 'defaultValue' }>;
  /** Stored row values that look like an Aadhaar number, per company / entity / key. */
  stored: ScanFinding[];
  /** Fields skipped because an admin exempted them. */
  exemptFields: number;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- the system client's delegates are indexed by name
export async function scanAadhaarLike(prisma: any, opts: { showIds?: boolean } = {}): Promise<ScanReport> {
  const report: ScanReport = { namedDefinitions: [], definitionValues: [], stored: [], exemptFields: 0 };

  const definitions = await prisma.customFieldDefinition.findMany({
    where: { entityType: { in: [...CUSTOM_FIELD_VALUE_ENTITIES] } },
  });
  const exempt = new Set<string>();
  for (const d of definitions) {
    const matched = containsAadhaarKeyword(d.key) ?? containsAadhaarKeyword(d.label ?? '');
    if (matched) report.namedDefinitions.push({ companyId: d.companyId, entityType: d.entityType, key: d.key, matched });
    if (d.allowsTwelveDigitValues) {
      exempt.add(`${d.companyId}|${d.entityType}|${d.key}`);
      report.exemptFields++;
      continue;
    }
    if (Array.isArray(d.options) && d.options.some((o: unknown) => isAadhaarLikeValue(o))) {
      report.definitionValues.push({ companyId: d.companyId, entityType: d.entityType, key: d.key, where: 'options' });
    }
    if (isAadhaarLikeValue(d.defaultValue)) {
      report.definitionValues.push({ companyId: d.companyId, entityType: d.entityType, key: d.key, where: 'defaultValue' });
    }
  }

  const tally = new Map<string, ScanFinding>();
  for (const [entityType, model] of Object.entries(MODEL_FOR_ENTITY)) {
    let cursor: string | undefined;
    for (;;) {
      const rows: Array<{ id: string; companyId: string; customFields: unknown }> = await prisma[model].findMany({
        where: { customFields: { not: null } },
        select: { id: true, companyId: true, customFields: true },
        orderBy: { id: 'asc' },
        take: BATCH,
        ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
      });
      if (rows.length === 0) break;
      cursor = rows[rows.length - 1].id;
      for (const row of rows) {
        const bag = row.customFields;
        if (!bag || typeof bag !== 'object' || Array.isArray(bag)) continue;
        for (const [key, value] of Object.entries(bag as Record<string, unknown>)) {
          if (exempt.has(`${row.companyId}|${entityType}|${key}`)) continue;
          if (!isAadhaarLikeValue(value)) continue;
          const id = `${row.companyId}|${entityType}|${key}`;
          const f = tally.get(id) ?? { companyId: row.companyId, entityType, key, rows: 0, rowIds: [] };
          f.rows++;
          if (opts.showIds && f.rowIds.length < MAX_IDS_PER_KEY) f.rowIds.push(row.id);
          tally.set(id, f);
        }
      }
    }
  }
  report.stored = [...tally.values()].sort((a, b) => b.rows - a.rows);
  return report;
}

export function renderReport(r: ScanReport): string {
  const out: string[] = [];
  out.push('Aadhaar-like value scan (read-only; keys and counts only, never values)');
  out.push('');
  out.push(`Field definitions whose name or label refers to Aadhaar: ${r.namedDefinitions.length}`);
  for (const d of r.namedDefinitions) out.push(`  company ${d.companyId}  ${d.entityType}.${d.key}  (matched "${d.matched}")`);
  out.push('');
  out.push(`Definitions whose options or default look like an Aadhaar number: ${r.definitionValues.length}`);
  for (const d of r.definitionValues) out.push(`  company ${d.companyId}  ${d.entityType}.${d.key}  (${d.where})`);
  out.push('');
  const total = r.stored.reduce((n, f) => n + f.rows, 0);
  out.push(`Stored values that look like an Aadhaar number: ${total} across ${r.stored.length} field(s)`);
  for (const f of r.stored) {
    out.push(`  company ${f.companyId}  ${f.entityType}.${f.key}  ${f.rows} row(s)`);
    if (f.rowIds.length) out.push(`    ids: ${f.rowIds.join(', ')}`);
  }
  out.push('');
  out.push(`Exempted fields skipped: ${r.exemptFields}`);
  out.push('');
  out.push('This check is a safety net, not a guarantee: about 1 in 10 random 12-digit numbers look valid, and a');
  out.push('number with a typo or other separators is not found. It covers custom-field values only — not names,');
  out.push('addresses, notes or other free text. Nothing was changed.');
  return out.join('\n');
}
