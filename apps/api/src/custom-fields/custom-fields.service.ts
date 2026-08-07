import {
  BadRequestException,
  Inject,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { PrismaClient, withTenantTx, runWithTenant } from '@openestate/db';
import {
  buildCustomFieldValueSchema,
  validateCustomFieldValues,
  supportsCustomFieldValues,
  CUSTOM_FIELD_VALUE_ENTITIES,
  type CustomFieldDefinitionLike,
} from '@openestate/shared';
import { TENANT_PRISMA, SYSTEM_PRISMA } from '../database/database.module';
import type {
  CreateCustomFieldDto,
  UpdateCustomFieldDto,
  CustomFieldEntity,
} from '@openestate/shared';

/**
 * Which physical table/column each value-bearing entity type maps to.
 * Raw table names are only used by the hard-purge path (a set-based
 * JSONB key strip that Prisma can't express); everything else goes
 * through Prisma models.
 */
const VALUE_TABLES: Record<string, string> = {
  APPLICANT: 'applicants',
  INQUIRY: 'inquiries',
  UNIT: 'units',
  PROJECT: 'projects',
};

@Injectable()
export class CustomFieldsService {
  constructor(
    @Inject(TENANT_PRISMA)
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    private readonly tenantPrisma: any,
    @Inject(SYSTEM_PRISMA)
    private readonly systemPrisma: PrismaClient,
  ) {}

  async findByEntity(companyId: string, entityType: CustomFieldEntity) {
    return this.systemPrisma.customFieldDefinition.findMany({
      where: { companyId, entityType },
      orderBy: { sortOrder: 'asc' },
    });
  }

  /**
   * Active definitions only — the set that value validation enforces.
   * A deactivated (soft-deleted) field stops being enforced while its
   * already-stored values are left completely untouched.
   */
  async findActiveByEntity(companyId: string, entityType: string): Promise<CustomFieldDefinitionLike[]> {
    if (!supportsCustomFieldValues(entityType)) return [];
    const defs = await this.systemPrisma.customFieldDefinition.findMany({
      where: { companyId, entityType, isActive: true },
      orderBy: { sortOrder: 'asc' },
    });
    return defs.map((d) => ({
      key: d.key,
      fieldType: d.fieldType,
      isRequired: d.isRequired,
      options: d.options,
    }));
  }

  async findOne(companyId: string, id: string) {
    const field = await this.systemPrisma.customFieldDefinition.findFirst({
      where: { id, companyId },
    });
    if (!field) throw new NotFoundException('Custom field not found');
    return field;
  }

  async create(companyId: string, dto: CreateCustomFieldDto) {
    // Refuse to create a definition for an entity that has nowhere to
    // put a value. Silently accepting it is exactly the bug this
    // release closes — an admin defines a field and nothing anywhere
    // ever captures it.
    if (!supportsCustomFieldValues(dto.entityType)) {
      throw new BadRequestException(
        `Custom fields are not supported for ${dto.entityType} yet. ` +
          `Supported entity types: ${CUSTOM_FIELD_VALUE_ENTITIES.join(', ')}.`,
      );
    }

    const existing = await this.systemPrisma.customFieldDefinition.findFirst({
      where: { companyId, entityType: dto.entityType, key: dto.key },
    });
    if (existing) {
      throw new BadRequestException(
        `Custom field "${dto.key}" already exists for ${dto.entityType}`,
      );
    }

    if (
      (dto.fieldType === 'SELECT' || dto.fieldType === 'MULTI_SELECT') &&
      (!dto.options || dto.options.length === 0)
    ) {
      throw new BadRequestException(
        'SELECT/MULTI_SELECT fields require at least one option',
      );
    }

    return runWithTenant({ companyId }, () =>
      withTenantTx(this.tenantPrisma, companyId, (tx) =>
        tx.customFieldDefinition.create({
          data: { ...dto, companyId },
        }),
      ),
    );
  }

  async update(companyId: string, id: string, dto: UpdateCustomFieldDto) {
    const existing = await this.findOne(companyId, id);

    // `key`, `fieldType` and `entityType` are absent from
    // updateCustomFieldSchema by design and stay that way: values are
    // keyed by the immutable `key`, so a label rename can never orphan
    // one, and a type change would mean silently coercing (or
    // discarding) every already-stored value.
    //
    // Options CAN change. Emptying them on a SELECT/MULTI_SELECT would
    // leave a field that rejects every possible value, so refuse it —
    // deactivate the field instead if it's no longer wanted.
    if (
      dto.options !== undefined &&
      dto.options.length === 0 &&
      (existing.fieldType === 'SELECT' || existing.fieldType === 'MULTI_SELECT')
    ) {
      throw new BadRequestException(
        'SELECT/MULTI_SELECT fields require at least one option. ' +
          'Deactivate the field instead if it is no longer in use.',
      );
    }

    return runWithTenant({ companyId }, () =>
      withTenantTx(this.tenantPrisma, companyId, (tx) =>
        tx.customFieldDefinition.update({
          where: { id },
          data: dto,
        }),
      ),
    );
  }

  /**
   * Default delete action: SOFT. The definition stops being offered on
   * forms and stops being enforced, but every already-stored value is
   * preserved untouched and still renders on detail screens.
   *
   * A hard delete used to run here, which orphaned the JSONB keys
   * invisibly — the data stayed on the row forever with nothing left to
   * explain what it meant. Destroying values is now a separate,
   * explicitly-confirmed operation (see `purge`).
   */
  async remove(companyId: string, id: string) {
    await this.findOne(companyId, id);
    return runWithTenant({ companyId }, () =>
      withTenantTx(this.tenantPrisma, companyId, (tx) =>
        tx.customFieldDefinition.update({
          where: { id },
          data: { isActive: false },
        }),
      ),
    );
  }

  /** How many rows currently carry a value for this field — shown before a purge. */
  async countValues(companyId: string, id: string): Promise<{ key: string; entityType: string; affectedRows: number }> {
    const def = await this.findOne(companyId, id);
    const table = VALUE_TABLES[def.entityType];
    if (!table) return { key: def.key, entityType: def.entityType, affectedRows: 0 };

    const rows = await this.systemPrisma.$queryRawUnsafe<Array<{ n: bigint }>>(
      `SELECT count(*)::bigint AS n FROM ${table}
        WHERE company_id = $1::uuid AND custom_fields ? $2`,
      companyId,
      def.key,
    );
    return { key: def.key, entityType: def.entityType, affectedRows: Number(rows[0].n) };
  }

  /**
   * Hard purge: removes the definition AND strips its key from every
   * row of that entity. Irreversible.
   *
   * Guarded by typed confirmation of the field's own key rather than by
   * a row count alone — a count is a number the admin has no way to
   * verify before agreeing to it, so confirming against it isn't really
   * consent. Typing the key makes the confirmation about the thing
   * being destroyed. The affected row count is written to the audit log
   * so the size of what happened is recoverable afterwards even though
   * the values themselves are not.
   */
  async purge(companyId: string, id: string, confirmKey: string, userId: string) {
    const def = await this.findOne(companyId, id);

    if (confirmKey !== def.key) {
      throw new BadRequestException(
        `Confirmation does not match. Type the field key "${def.key}" exactly to permanently delete it and all of its stored values.`,
      );
    }

    const table = VALUE_TABLES[def.entityType];
    let affectedRows = 0;

    await runWithTenant({ companyId }, () =>
      withTenantTx(this.tenantPrisma, companyId, async (tx) => {
        if (table) {
          // Set-based JSONB key removal — Prisma has no expression for
          // "delete this key from a JSONB column", so raw SQL with the
          // ::uuid cast this codebase's raw call sites always use.
          // RLS still applies (tenant client), and company_id is
          // filtered explicitly as well.
          affectedRows = await (tx as unknown as {
            $executeRawUnsafe: (q: string, ...a: unknown[]) => Promise<number>;
          }).$executeRawUnsafe(
            `UPDATE ${table}
                SET custom_fields = custom_fields - $2
              WHERE company_id = $1::uuid AND custom_fields ? $2`,
            companyId,
            def.key,
          );
        }
        await tx.customFieldDefinition.delete({ where: { id } });
      }),
    );

    // Explicit audit row: the auto-audit extension covers the
    // definition delete, but nothing would otherwise record that N
    // rows' values were destroyed along with it.
    await this.systemPrisma.auditLog.create({
      data: {
        companyId,
        userId,
        entityType: 'CustomFieldDefinition',
        entityId: id,
        action: 'PURGE',
        before: { key: def.key, entityType: def.entityType, label: def.label },
        after: { purgedValueRows: affectedRows },
      },
    });

    return { id, key: def.key, entityType: def.entityType, purgedValueRows: affectedRows };
  }

  // ── Value validation (delegates to @openestate/shared) ──────
  //
  // The builder lives in packages/shared so the API and its tests use
  // ONE implementation. It previously lived here and was re-implemented
  // by a copy inside packages/db's test file, which meant the real
  // function had no coverage at all — the test only ever proved its own
  // duplicate worked.

  buildValidationSchema(definitions: CustomFieldDefinitionLike[]) {
    return buildCustomFieldValueSchema(definitions);
  }

  validateCustomFields(
    definitions: CustomFieldDefinitionLike[],
    data: Record<string, unknown>,
  ): Record<string, unknown> {
    return validateCustomFieldValues(definitions, data);
  }

  /**
   * The one entry point every entity service uses. Loads the active
   * definitions itself (never trusting anything client-supplied),
   * merges a PATCH over the stored values so a partial update can't
   * bypass a required field by omission, and returns the value object
   * to persist.
   *
   * Returns `undefined` when there is nothing to write, so callers can
   * leave the column untouched rather than overwriting it with {}.
   */
  async resolveValuesForWrite(
    companyId: string,
    entityType: string,
    incoming: Record<string, unknown> | undefined,
    stored?: Record<string, unknown> | null,
  ): Promise<Record<string, unknown> | undefined> {
    const definitions = await this.findActiveByEntity(companyId, entityType);
    const definedKeys = new Set(definitions.map((d) => d.key));
    const storedValues = (stored ?? {}) as Record<string, unknown>;

    // Keys already on the row that no active definition covers: legacy
    // junk written before validation existed (customFields accepted
    // anything from Phase 3 until v0.2.3), values belonging to a
    // deactivated field, or server-written keys like `leadNote` /
    // `importNotes`.
    //
    // These are PRESERVED untouched and excluded from validation. The
    // alternative — validating the whole merged object strictly —
    // would make every such record permanently uneditable, since a
    // stored key with no definition can never be made valid. Rejecting
    // bad WRITES while preserving existing DATA is the policy; silently
    // dropping the row's history is the failure mode being avoided.
    const preserved: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(storedValues)) {
      if (!definedKeys.has(k)) preserved[k] = v;
    }

    // Unknown keys arriving from the CLIENT are still refused — that's
    // the hole this release closes. Reported before the merge so the
    // error names the offending key rather than a confusing merged shape.
    if (incoming) {
      const unknown = Object.keys(incoming).filter((k) => !definedKeys.has(k));
      if (unknown.length > 0) {
        throw new BadRequestException(
          definitions.length === 0
            ? `No active custom fields are defined for ${entityType}`
            : `Unrecognized custom field(s) for ${entityType}: ${unknown.join(', ')}`,
        );
      }
    }

    if (definitions.length === 0) {
      // Nothing to validate; hand back whatever was already there so a
      // save doesn't wipe it.
      return Object.keys(preserved).length > 0 ? preserved : undefined;
    }

    // Merge only the DEFINED keys, so required checks run against the
    // post-patch state rather than the patch alone.
    const mergedDefined: Record<string, unknown> = {};
    for (const k of definedKeys) {
      if (incoming && k in incoming) mergedDefined[k] = incoming[k];
      else if (k in storedValues) mergedDefined[k] = storedValues[k];
    }

    if (
      Object.keys(mergedDefined).length === 0 &&
      Object.keys(preserved).length === 0 &&
      !definitions.some((d) => d.isRequired)
    ) {
      return undefined;
    }

    let validated: Record<string, unknown>;
    try {
      validated = validateCustomFieldValues(definitions, mergedDefined);
    } catch (e) {
      throw new BadRequestException(formatCustomFieldError(e));
    }

    return { ...preserved, ...validated };
  }
}

/** Turns a ZodError into the same `path: message; path: message` shape the global ZodValidationPipe produces. */
function formatCustomFieldError(e: unknown): string {
  const issues = (e as { issues?: Array<{ path: (string | number)[]; message: string }> }).issues;
  if (!issues) return (e as Error).message;
  return issues
    .map((i) => `customFields.${i.path.join('.') || '(root)'}: ${i.message}`)
    .join('; ');
}
