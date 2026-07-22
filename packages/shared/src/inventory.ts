import { z } from 'zod';

// ── Unit Status ─────────────────────────────────────────────

export const UNIT_STATUS = {
  AVAILABLE: 'AVAILABLE',
  HELD: 'HELD',
  BLOCKED: 'BLOCKED',
  BOOKED: 'BOOKED',
  ALLOTTED: 'ALLOTTED',
  REGISTERED: 'REGISTERED',
  CANCELLED: 'CANCELLED',
} as const;

export type UnitStatus = (typeof UNIT_STATUS)[keyof typeof UNIT_STATUS];

export const UNIT_TRANSITIONS: Record<UnitStatus, readonly UnitStatus[]> = {
  AVAILABLE: ['HELD', 'BLOCKED', 'BOOKED'],
  HELD: ['BOOKED', 'AVAILABLE'],
  BLOCKED: ['AVAILABLE'],
  BOOKED: ['ALLOTTED', 'CANCELLED'],
  ALLOTTED: ['REGISTERED', 'CANCELLED'],
  REGISTERED: [],
  CANCELLED: ['AVAILABLE'],
};

export type ActorType = 'user' | 'system';

export function isValidTransition(from: UnitStatus, to: UnitStatus): boolean {
  return UNIT_TRANSITIONS[from].includes(to);
}

export const REASON_REQUIRED_STATUSES: readonly UnitStatus[] = ['BLOCKED', 'CANCELLED'];

/**
 * Statuses that may ONLY be reached by a system actor (the Phase 4 booking
 * lifecycle), never by the manual transition endpoint. BOOKED/ALLOTTED/
 * REGISTERED and the booking-driven CANCELLED are all driven exclusively by
 * BookingService (actorType 'system'). Manual holds/blocks
 * (AVAILABLE↔HELD, AVAILABLE→BLOCKED, BLOCKED→AVAILABLE, CANCELLED→AVAILABLE)
 * remain available to users. (Implements the Phase 2 Decisions-log note.)
 */
export const SYSTEM_ONLY_TARGET_STATUSES: readonly UnitStatus[] = [
  'BOOKED',
  'ALLOTTED',
  'REGISTERED',
  'CANCELLED',
];

export function isSystemOnlyTarget(toStatus: UnitStatus): boolean {
  return SYSTEM_ONLY_TARGET_STATUSES.includes(toStatus);
}

// ── Upload Categories ───────────────────────────────────────

export const UPLOAD_CATEGORIES = ['layout_plan', 'brochure', 'photo', 'document', 'construction_progress'] as const;
export type UploadCategory = (typeof UPLOAD_CATEGORIES)[number];

export const uploadCategorySchema = z.enum(UPLOAD_CATEGORIES);

// ── Zod Schemas: Project ────────────────────────────────────

export const createProjectSchema = z
  .object({
    name: z.string().min(1).max(255),
    code: z.string().min(1).max(50).regex(/^[A-Za-z0-9_-]+$/, 'Code must be alphanumeric with dashes/underscores'),
    projectTypeId: z.string().uuid().optional(),
    reraNumber: z.string().max(100).optional(),
    areaLocationId: z.string().uuid().optional(),
    address: z.string().optional(),
    description: z.string().optional(),
    startDate: z.coerce.date().optional(),
    expectedEndDate: z.coerce.date().optional(),
    isActive: z.boolean().default(true),
  })
  .strict();

export type CreateProjectDto = z.infer<typeof createProjectSchema>;

export const updateProjectSchema = createProjectSchema.partial().strict();
export type UpdateProjectDto = z.infer<typeof updateProjectSchema>;

// ── Zod Schemas: Tower ──────────────────────────────────────

export const createTowerSchema = z
  .object({
    name: z.string().min(1).max(255),
    code: z.string().min(1).max(50).regex(/^[A-Za-z0-9_-]+$/, 'Code must be alphanumeric with dashes/underscores'),
    totalFloors: z.number().int().min(0).default(0),
    isActive: z.boolean().default(true),
  })
  .strict();

export type CreateTowerDto = z.infer<typeof createTowerSchema>;

export const updateTowerSchema = createTowerSchema.partial().strict();
export type UpdateTowerDto = z.infer<typeof updateTowerSchema>;

// ── Zod Schemas: Floor ──────────────────────────────────────

export const createFloorSchema = z
  .object({
    name: z.string().min(1).max(100),
    floorNumber: z.number().int(),
    isActive: z.boolean().default(true),
  })
  .strict();

export type CreateFloorDto = z.infer<typeof createFloorSchema>;

export const updateFloorSchema = createFloorSchema.partial().strict();
export type UpdateFloorDto = z.infer<typeof updateFloorSchema>;

// ── Zod Schemas: Unit ───────────────────────────────────────

export const createUnitSchema = z
  .object({
    number: z.string().min(1).max(50),
    unitTypeId: z.string().uuid().optional(),
    carpetAreaSqft: z.number().positive().optional(),
    builtUpAreaSqft: z.number().positive().optional(),
    superBuiltUpSqft: z.number().positive().optional(),
    baseRatePaise: z.coerce.bigint().min(0n).default(0n),
    isActive: z.boolean().default(true),
  })
  .strict();

export type CreateUnitDto = z.infer<typeof createUnitSchema>;

export const updateUnitSchema = z
  .object({
    unitTypeId: z.string().uuid().optional(),
    carpetAreaSqft: z.number().positive().optional(),
    builtUpAreaSqft: z.number().positive().optional(),
    superBuiltUpSqft: z.number().positive().optional(),
    isActive: z.boolean().optional(),
  })
  .strict();

export type UpdateUnitDto = z.infer<typeof updateUnitSchema>;

// ── Zod Schemas: Bulk Unit Generation ───────────────────────

export const bulkGenerateUnitsSchema = z
  .object({
    towerId: z.string().uuid(),
    floorStart: z.number().int().min(-10),
    floorEnd: z.number().int(),
    unitsPerFloor: z.number().int().min(1).max(100),
    unitPrefix: z.string().max(10).default(''),
    unitTypeId: z.string().uuid().optional(),
    carpetAreaSqft: z.number().positive().optional(),
    builtUpAreaSqft: z.number().positive().optional(),
    superBuiltUpSqft: z.number().positive().optional(),
    baseRatePaise: z.coerce.bigint().min(0n).default(0n),
  })
  .strict()
  .refine((d) => d.floorEnd >= d.floorStart, {
    message: 'floorEnd must be >= floorStart',
    path: ['floorEnd'],
  });

export type BulkGenerateUnitsDto = z.infer<typeof bulkGenerateUnitsSchema>;

// ── Zod Schemas: Unit Status Transition ─────────────────────

export const unitStatusTransitionSchema = z
  .object({
    toStatus: z.nativeEnum(UNIT_STATUS),
    reason: z.string().max(500).optional(),
  })
  .strict();

export type UnitStatusTransitionDto = z.infer<typeof unitStatusTransitionSchema>;

// ── Zod Schemas: Rate Revision ──────────────────────────────

export const changeRateSchema = z
  .object({
    unitIds: z.array(z.string().uuid()).min(1).max(500),
    ratePaise: z.coerce.bigint().min(0n),
    effectiveFrom: z.coerce.date(),
    reason: z.string().min(1).max(500),
  })
  .strict();

export type ChangeRateDto = z.infer<typeof changeRateSchema>;

// ── Zod Schemas: Import Row ─────────────────────────────────

export const importUnitRowSchema = z.object({
  towerName: z.string().min(1).max(255),
  towerCode: z.string().min(1).max(50),
  floorName: z.string().min(1).max(100),
  floorNumber: z.coerce.number().int(),
  unitNumber: z.string().min(1).max(50),
  unitType: z.string().max(255).optional(),
  carpetAreaSqft: z.coerce.number().positive().optional(),
  builtUpAreaSqft: z.coerce.number().positive().optional(),
  superBuiltUpSqft: z.coerce.number().positive().optional(),
  baseRatePaise: z.coerce.number().int().min(0).optional(),
});

export type ImportUnitRow = z.infer<typeof importUnitRowSchema>;
