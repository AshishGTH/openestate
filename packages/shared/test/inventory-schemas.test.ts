import { describe, it, expect } from 'vitest';
import {
  changeRateSchema,
  importUnitRowSchema,
  createProjectSchema,
  bulkGenerateUnitsSchema,
  uploadCategorySchema,
} from '../src/inventory';

describe('Inventory zod schemas', () => {
  describe('changeRateSchema', () => {
    it('accepts valid change-rate payload', () => {
      const result = changeRateSchema.safeParse({
        unitIds: ['00000000-0000-0000-0000-000000000001'],
        ratePaise: '500000',
        effectiveFrom: '2025-06-01',
        reason: 'Market correction',
      });
      expect(result.success).toBe(true);
    });

    it('rejects empty reason', () => {
      const result = changeRateSchema.safeParse({
        unitIds: ['00000000-0000-0000-0000-000000000001'],
        ratePaise: '500000',
        effectiveFrom: '2025-06-01',
        reason: '',
      });
      expect(result.success).toBe(false);
    });

    it('rejects empty unitIds', () => {
      const result = changeRateSchema.safeParse({
        unitIds: [],
        ratePaise: '500000',
        effectiveFrom: '2025-06-01',
        reason: 'test',
      });
      expect(result.success).toBe(false);
    });
  });

  describe('importUnitRowSchema', () => {
    it('accepts valid import row', () => {
      const result = importUnitRowSchema.safeParse({
        towerName: 'Tower A',
        towerCode: 'A',
        floorName: 'Floor 1',
        floorNumber: 1,
        unitNumber: 'A-0101',
        carpetAreaSqft: 850,
      });
      expect(result.success).toBe(true);
    });

    it('rejects missing towerName', () => {
      const result = importUnitRowSchema.safeParse({
        towerCode: 'A',
        floorName: 'Floor 1',
        floorNumber: 1,
        unitNumber: 'A-0101',
      });
      expect(result.success).toBe(false);
    });

    it('rejects negative area', () => {
      const result = importUnitRowSchema.safeParse({
        towerName: 'Tower A',
        towerCode: 'A',
        floorName: 'Floor 1',
        floorNumber: 1,
        unitNumber: 'A-0101',
        carpetAreaSqft: -100,
      });
      expect(result.success).toBe(false);
    });
  });

  describe('createProjectSchema', () => {
    it('accepts valid project', () => {
      const result = createProjectSchema.safeParse({
        name: 'Green Valley',
        code: 'GV-001',
      });
      expect(result.success).toBe(true);
    });

    it('rejects code with spaces', () => {
      const result = createProjectSchema.safeParse({
        name: 'Green Valley',
        code: 'GV 001',
      });
      expect(result.success).toBe(false);
    });
  });

  describe('bulkGenerateUnitsSchema', () => {
    it('rejects floorEnd < floorStart', () => {
      const result = bulkGenerateUnitsSchema.safeParse({
        towerId: '00000000-0000-0000-0000-000000000001',
        floorStart: 5,
        floorEnd: 3,
        unitsPerFloor: 4,
      });
      expect(result.success).toBe(false);
    });

    it('accepts valid bulk generation', () => {
      const result = bulkGenerateUnitsSchema.safeParse({
        towerId: '00000000-0000-0000-0000-000000000001',
        floorStart: 1,
        floorEnd: 10,
        unitsPerFloor: 4,
        unitPrefix: 'A',
      });
      expect(result.success).toBe(true);
    });
  });

  describe('uploadCategorySchema', () => {
    it('accepts valid categories', () => {
      expect(uploadCategorySchema.safeParse('layout_plan').success).toBe(true);
      expect(uploadCategorySchema.safeParse('brochure').success).toBe(true);
      expect(uploadCategorySchema.safeParse('photo').success).toBe(true);
      expect(uploadCategorySchema.safeParse('document').success).toBe(true);
    });

    it('rejects invalid category', () => {
      expect(uploadCategorySchema.safeParse('video').success).toBe(false);
      expect(uploadCategorySchema.safeParse('').success).toBe(false);
    });
  });
});
