import {
  BadRequestException,
  Inject,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { PrismaClient, withTenantTx, runWithTenant } from '@openestate/db';
import { TENANT_PRISMA, SYSTEM_PRISMA } from '../database/database.module';
import { importUnitRowSchema, importLandBasedUnitRowSchema, toAreaScaled, convertToSqftScaled, fromAreaScaled } from '@openestate/shared';
import * as ExcelJS from 'exceljs';

const HIGH_RISE_HEADER_MAP: Record<string, string> = {
  'Tower Name': 'towerName',
  'Tower Code': 'towerCode',
  'Floor Name': 'floorName',
  'Floor Number': 'floorNumber',
  'Unit Number': 'unitNumber',
  'Unit Type': 'unitType',
  'Carpet Area (sqft)': 'carpetAreaSqft',
  'Built-up Area (sqft)': 'builtUpAreaSqft',
  'Super Built-up Area (sqft)': 'superBuiltUpSqft',
  'Base Rate (paise)': 'baseRatePaise',
};

// LAND_BASED counterpart — no tower/floor columns, an optional group
// code plus the entered-area pair instead. Column choice is
// schema-derived (see importLandBasedUnitRowSchema's own comment) —
// flag this needs validating against a real client sheet before a
// pilot import.
const LAND_BASED_HEADER_MAP: Record<string, string> = {
  'Group Code': 'groupCode',
  'Unit Number': 'unitNumber',
  'Unit Type': 'unitType',
  'Land Area Entered': 'landAreaEntered',
  'Land Area Unit (SQFT/SQYD/SQM/ACRE/GUNTA)': 'landAreaEnteredUnit',
  'Rate Unit (SQFT/SQYD/SQM/ACRE/GUNTA)': 'rateUnit',
  'Base Rate (paise, per Rate Unit)': 'baseRatePaise',
  'Built-up Area (sqft)': 'builtUpAreaSqft',
  'Built-up Rate (paise per sqft)': 'builtUpRatePaise',
  'Land Record Ref': 'landRecordRef',
  Facing: 'facing',
  'Length (feet)': 'lengthFeet',
  'Breadth (feet)': 'breadthFeet',
};

export interface ImportError {
  row: number;
  field: string;
  message: string;
}

export interface ImportResult {
  success: boolean;
  createdCount: number;
  skippedCount: number;
  errorCount: number;
  errors: ImportError[];
  skipped: Array<{ row: number; unitNumber: string; reason: string }>;
}

@Injectable()
export class ImportExportService {
  constructor(
    @Inject(TENANT_PRISMA)
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    private readonly tenantPrisma: any,
    @Inject(SYSTEM_PRISMA)
    private readonly systemPrisma: PrismaClient,
  ) {}

  private async loadWorkbookSheet(buffer: Buffer) {
    const header = buffer.subarray(0, 4);
    if (header[0] !== 0x50 || header[1] !== 0x4b || header[2] !== 0x03 || header[3] !== 0x04) {
      throw new BadRequestException('Invalid file: expected XLSX format');
    }

    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.load(buffer as unknown as ArrayBuffer);
    const sheet = workbook.worksheets[0];
    if (!sheet) throw new BadRequestException('Workbook has no worksheets');
    return sheet;
  }

  async importUnits(
    companyId: string,
    projectId: string,
    buffer: Buffer,
  ): Promise<ImportResult> {
    const project = await this.systemPrisma.project.findFirst({ where: { id: projectId, companyId } });
    if (!project) throw new NotFoundException('Project not found');
    if (project.shape === 'LAND_BASED') {
      return this.importLandBasedUnits(companyId, projectId, buffer);
    }

    const sheet = await this.loadWorkbookSheet(buffer);

    const rows: Array<{ rowNum: number; data: Record<string, unknown> }> = [];
    const headerRow = sheet.getRow(1);
    const headers: string[] = [];
    headerRow.eachCell((cell, colNum) => {
      headers[colNum] = String(cell.value ?? '').trim();
    });

    const headerMap = HIGH_RISE_HEADER_MAP;

    sheet.eachRow((row, rowNumber) => {
      if (rowNumber === 1) return;
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const data: Record<string, any> = {};
      row.eachCell((cell, colNum) => {
        const header = headers[colNum];
        const key = headerMap[header];
        if (key) {
          data[key] = cell.value;
        }
      });
      if (Object.keys(data).length > 0) {
        rows.push({ rowNum: rowNumber, data });
      }
    });

    if (rows.length === 0) {
      throw new BadRequestException('No data rows found in the worksheet');
    }

    const errors: ImportError[] = [];
    const validRows: Array<{ rowNum: number; data: ReturnType<typeof importUnitRowSchema.parse> }> = [];

    for (const { rowNum, data } of rows) {
      const result = importUnitRowSchema.safeParse(data);
      if (!result.success) {
        for (const issue of result.error.issues) {
          errors.push({
            row: rowNum,
            field: issue.path.join('.'),
            message: issue.message,
          });
        }
      } else {
        validRows.push({ rowNum, data: result.data });
      }
    }

    if (errors.length > 0) {
      return {
        success: false,
        createdCount: 0,
        skippedCount: 0,
        errorCount: errors.length,
        errors,
        skipped: [],
      };
    }

    const towerFloorUnits = new Map<string, Map<string, Set<string>>>();
    for (const { rowNum, data } of validRows) {
      const towerKey = data.towerCode;
      if (!towerFloorUnits.has(towerKey)) towerFloorUnits.set(towerKey, new Map());
      const floorMap = towerFloorUnits.get(towerKey)!;
      const floorKey = String(data.floorNumber);
      if (!floorMap.has(floorKey)) floorMap.set(floorKey, new Set());
      const unitSet = floorMap.get(floorKey)!;
      if (unitSet.has(data.unitNumber)) {
        errors.push({
          row: rowNum,
          field: 'unitNumber',
          message: `Duplicate unit number '${data.unitNumber}' on floor ${data.floorNumber} in tower ${towerKey}`,
        });
      }
      unitSet.add(data.unitNumber);
    }

    if (errors.length > 0) {
      return {
        success: false,
        createdCount: 0,
        skippedCount: 0,
        errorCount: errors.length,
        errors,
        skipped: [],
      };
    }

    return runWithTenant({ companyId }, () =>
      withTenantTx(this.tenantPrisma, companyId, async (tx) => {
        const project = await tx.project.findFirst({ where: { id: projectId, companyId } });
        if (!project) throw new NotFoundException('Project not found');

        const unitTypeCache = new Map<string, string>();
        const towerCache = new Map<string, string>();
        const floorCache = new Map<string, string>();

        let createdCount = 0;
        const skipped: Array<{ row: number; unitNumber: string; reason: string }> = [];

        for (const { rowNum, data } of validRows) {
          if (data.unitType && !unitTypeCache.has(data.unitType)) {
            const ut = await tx.unitType.findFirst({
              where: { companyId, name: data.unitType },
            });
            if (ut) unitTypeCache.set(data.unitType, ut.id);
          }

          const towerKey = data.towerCode;
          if (!towerCache.has(towerKey)) {
            let tower = await tx.tower.findFirst({
              where: { projectId, code: towerKey, companyId },
            });
            if (!tower) {
              tower = await tx.tower.create({
                data: {
                  companyId,
                  projectId,
                  name: data.towerName,
                  code: data.towerCode,
                },
              });
            }
            towerCache.set(towerKey, tower.id);
          }
          const towerId = towerCache.get(towerKey)!;

          const floorKey = `${towerId}:${data.floorNumber}`;
          if (!floorCache.has(floorKey)) {
            const floor = await tx.floor.upsert({
              where: {
                towerId_floorNumber: { towerId, floorNumber: data.floorNumber },
              },
              update: {},
              create: {
                companyId,
                towerId,
                name: data.floorName,
                floorNumber: data.floorNumber,
              },
            });
            floorCache.set(floorKey, floor.id);
          }
          const floorId = floorCache.get(floorKey)!;

          const existing = await tx.unit.findFirst({
            where: { floorId, number: data.unitNumber, companyId },
          });
          if (existing) {
            skipped.push({
              row: rowNum,
              unitNumber: data.unitNumber,
              reason: 'Unit already exists on this floor',
            });
            continue;
          }

          // Tower-scoped uniqueness check
          const towerDupe = await tx.unit.findFirst({
            where: {
              companyId,
              floor: { towerId },
              number: data.unitNumber,
            },
          });
          if (towerDupe) {
            skipped.push({
              row: rowNum,
              unitNumber: data.unitNumber,
              reason: `Unit number already exists on another floor in tower ${towerKey}`,
            });
            continue;
          }

          await tx.unit.create({
            data: {
              companyId,
              projectId,
              shape: 'HIGH_RISE',
              floorId,
              number: data.unitNumber,
              unitTypeId: data.unitType ? unitTypeCache.get(data.unitType) ?? null : null,
              carpetAreaSqft: data.carpetAreaSqft ?? null,
              builtUpAreaSqft: data.builtUpAreaSqft ?? null,
              superBuiltUpSqft: data.superBuiltUpSqft ?? null,
              baseRatePaise: data.baseRatePaise ? BigInt(data.baseRatePaise) : 0n,
            },
          });
          createdCount++;
        }

        return {
          success: true,
          createdCount,
          skippedCount: skipped.length,
          errorCount: 0,
          errors: [],
          skipped,
        };
      }),
    );
  }

  /** LAND_BASED sibling to importUnits() above — group code instead of
   * tower/floor, entered-area pair instead of carpet/built-up sqft.
   * Reuses UnitService.createLandBased's own derivation logic (never
   * trust a client-supplied landAreaSqft). */
  async importLandBasedUnits(companyId: string, projectId: string, buffer: Buffer): Promise<ImportResult> {
    const sheet = await this.loadWorkbookSheet(buffer);

    const rows: Array<{ rowNum: number; data: Record<string, unknown> }> = [];
    const headerRow = sheet.getRow(1);
    const headers: string[] = [];
    headerRow.eachCell((cell, colNum) => {
      headers[colNum] = String(cell.value ?? '').trim();
    });

    sheet.eachRow((row, rowNumber) => {
      if (rowNumber === 1) return;
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const data: Record<string, any> = {};
      row.eachCell((cell, colNum) => {
        const header = headers[colNum];
        const key = LAND_BASED_HEADER_MAP[header];
        if (key) data[key] = cell.value;
      });
      if (Object.keys(data).length > 0) rows.push({ rowNum: rowNumber, data });
    });

    if (rows.length === 0) {
      throw new BadRequestException('No data rows found in the worksheet');
    }

    const errors: ImportError[] = [];
    const validRows: Array<{ rowNum: number; data: ReturnType<typeof importLandBasedUnitRowSchema.parse> }> = [];

    for (const { rowNum, data } of rows) {
      const result = importLandBasedUnitRowSchema.safeParse(data);
      if (!result.success) {
        for (const issue of result.error.issues) {
          errors.push({ row: rowNum, field: issue.path.join('.'), message: issue.message });
        }
      } else {
        validRows.push({ rowNum, data: result.data });
      }
    }

    const seen = new Set<string>();
    for (const { rowNum, data } of validRows) {
      if (seen.has(data.unitNumber)) {
        errors.push({ row: rowNum, field: 'unitNumber', message: `Duplicate unit number '${data.unitNumber}' in file` });
      }
      seen.add(data.unitNumber);
    }

    if (errors.length > 0) {
      return { success: false, createdCount: 0, skippedCount: 0, errorCount: errors.length, errors, skipped: [] };
    }

    return runWithTenant({ companyId }, () =>
      withTenantTx(this.tenantPrisma, companyId, async (tx) => {
        const project = await tx.project.findFirst({ where: { id: projectId, companyId } });
        if (!project) throw new NotFoundException('Project not found');
        if (project.shape !== 'LAND_BASED') {
          throw new BadRequestException('This project is HIGH_RISE — use the tower/floor import template instead.');
        }

        const unitTypeCache = new Map<string, string>();
        const groupCache = new Map<string, string>();

        let createdCount = 0;
        const skipped: Array<{ row: number; unitNumber: string; reason: string }> = [];

        for (const { rowNum, data } of validRows) {
          if (data.unitType && !unitTypeCache.has(data.unitType)) {
            const ut = await tx.unitType.findFirst({ where: { companyId, name: data.unitType } });
            if (ut) unitTypeCache.set(data.unitType, ut.id);
          }

          let groupId: string | null = null;
          if (data.groupCode) {
            if (!groupCache.has(data.groupCode)) {
              const group = await tx.inventoryGroup.findFirst({ where: { companyId, projectId, code: data.groupCode } });
              if (!group) {
                skipped.push({ row: rowNum, unitNumber: data.unitNumber, reason: `Inventory group '${data.groupCode}' not found in this project` });
                continue;
              }
              groupCache.set(data.groupCode, group.id);
            }
            groupId = groupCache.get(data.groupCode)!;
          }

          const numberTaken = await tx.unit.findFirst({ where: { companyId, projectId, number: data.unitNumber } });
          if (numberTaken) {
            skipped.push({ row: rowNum, unitNumber: data.unitNumber, reason: 'Unit number already exists in this project' });
            continue;
          }

          const enteredScaled = toAreaScaled(data.landAreaEntered);
          const sqftScaled = convertToSqftScaled(enteredScaled, data.landAreaEnteredUnit);

          await tx.unit.create({
            data: {
              companyId,
              projectId,
              shape: 'LAND_BASED',
              floorId: null,
              inventoryGroupId: groupId,
              number: data.unitNumber,
              unitTypeId: data.unitType ? unitTypeCache.get(data.unitType) ?? null : null,
              landAreaEntered: data.landAreaEntered,
              landAreaEnteredUnit: data.landAreaEnteredUnit,
              landAreaSqft: fromAreaScaled(sqftScaled),
              rateUnit: data.rateUnit,
              baseRatePaise: data.baseRatePaise ? BigInt(data.baseRatePaise) : 0n,
              builtUpAreaSqft: data.builtUpAreaSqft ?? null,
              builtUpRatePaise: data.builtUpRatePaise ? BigInt(data.builtUpRatePaise) : null,
              landRecordRef: data.landRecordRef ?? null,
              facing: data.facing ?? null,
              lengthFeet: data.lengthFeet ?? null,
              breadthFeet: data.breadthFeet ?? null,
            },
          });
          createdCount++;
        }

        return { success: true, createdCount, skippedCount: skipped.length, errorCount: 0, errors: [], skipped };
      }),
    );
  }

  /** Header-only XLSX matching whichever HEADER_MAP importUnits() (or its
   * LAND_BASED sibling) actually reads, so the template can never drift
   * from what a real upload requires — same discipline as
   * inquiry-import's GET /inquiries/import-template. */
  async getImportTemplate(companyId: string, projectId: string): Promise<Buffer> {
    const project = await this.systemPrisma.project.findFirst({ where: { id: projectId, companyId } });
    if (!project) throw new NotFoundException('Project not found');

    const headers = project.shape === 'LAND_BASED' ? Object.keys(LAND_BASED_HEADER_MAP) : Object.keys(HIGH_RISE_HEADER_MAP);
    const workbook = new ExcelJS.Workbook();
    const sheet = workbook.addWorksheet('Units');
    sheet.addRow(headers);
    const buffer = await workbook.xlsx.writeBuffer();
    return Buffer.from(buffer);
  }

  async exportUnits(companyId: string, projectId: string): Promise<Buffer> {
    const project = await this.systemPrisma.project.findFirst({ where: { id: projectId, companyId } });
    if (!project) throw new NotFoundException('Project not found');
    if (project.shape === 'LAND_BASED') {
      return this.exportLandBasedUnits(projectId);
    }

    const units = await this.systemPrisma.unit.findMany({
      where: {
        companyId,
        // Unit.projectId (Phase A scalar) — the old floor.tower.projectId
        // traversal exported an EMPTY workbook for a LAND_BASED project.
        // See plotted-farmhouse-inventory.md §13.1.
        projectId,
      },
      include: {
        unitType: true,
        floor: {
          include: { tower: { select: { name: true, code: true } } },
        },
      },
      // Sorting by tower/floor is still HIGH_RISE-shaped — a LAND_BASED
      // export's own column layout is Phase C scope (§14 Phase C item 7,
      // "moved here from Phase B per reviewer"), not fixed here. Units
      // with no floor just sort per Postgres's NULLS LAST default, which
      // is harmless, not silently wrong, for the where-clause bug this
      // commit actually fixes.
      orderBy: [
        { floor: { tower: { code: 'asc' } } },
        { floor: { floorNumber: 'asc' } },
        { number: 'asc' },
      ],
    });

    const workbook = new ExcelJS.Workbook();
    const sheet = workbook.addWorksheet('Units');

    sheet.columns = [
      { header: 'Tower Name', key: 'towerName', width: 15 },
      { header: 'Tower Code', key: 'towerCode', width: 12 },
      { header: 'Floor Name', key: 'floorName', width: 15 },
      { header: 'Floor Number', key: 'floorNumber', width: 12 },
      { header: 'Unit Number', key: 'unitNumber', width: 15 },
      { header: 'Unit Type', key: 'unitType', width: 15 },
      { header: 'Status', key: 'status', width: 12 },
      { header: 'Carpet Area (sqft)', key: 'carpetAreaSqft', width: 18 },
      { header: 'Built-up Area (sqft)', key: 'builtUpAreaSqft', width: 18 },
      { header: 'Super Built-up Area (sqft)', key: 'superBuiltUpSqft', width: 22 },
      { header: 'Base Rate (paise)', key: 'baseRatePaise', width: 18 },
    ];

    for (const unit of units) {
      sheet.addRow({
        towerName: unit.floor?.tower.name ?? '',
        towerCode: unit.floor?.tower.code ?? '',
        floorName: unit.floor?.name ?? '',
        floorNumber: unit.floor?.floorNumber ?? '',
        unitNumber: unit.number,
        unitType: unit.unitType?.name ?? '',
        status: unit.status,
        carpetAreaSqft: unit.carpetAreaSqft ? Number(unit.carpetAreaSqft) : '',
        builtUpAreaSqft: unit.builtUpAreaSqft ? Number(unit.builtUpAreaSqft) : '',
        superBuiltUpSqft: unit.superBuiltUpSqft ? Number(unit.superBuiltUpSqft) : '',
        baseRatePaise: unit.baseRatePaise.toString(),
      });
    }

    const buffer = await workbook.xlsx.writeBuffer();
    return Buffer.from(buffer);
  }

  private async exportLandBasedUnits(projectId: string): Promise<Buffer> {
    const units = await this.systemPrisma.unit.findMany({
      where: { projectId },
      include: { unitType: true, inventoryGroup: { select: { code: true } } },
      orderBy: [{ number: 'asc' }],
    });

    const workbook = new ExcelJS.Workbook();
    const sheet = workbook.addWorksheet('Units');
    sheet.columns = [
      { header: 'Group Code', key: 'groupCode', width: 14 },
      { header: 'Unit Number', key: 'unitNumber', width: 15 },
      { header: 'Unit Type', key: 'unitType', width: 15 },
      { header: 'Status', key: 'status', width: 12 },
      { header: 'Land Area Entered', key: 'landAreaEntered', width: 16 },
      { header: 'Land Area Unit', key: 'landAreaEnteredUnit', width: 14 },
      { header: 'Land Area (sqft)', key: 'landAreaSqft', width: 16 },
      { header: 'Rate Unit', key: 'rateUnit', width: 12 },
      { header: 'Base Rate (paise)', key: 'baseRatePaise', width: 18 },
      { header: 'Built-up Area (sqft)', key: 'builtUpAreaSqft', width: 18 },
      { header: 'Land Record Ref', key: 'landRecordRef', width: 18 },
      { header: 'Facing', key: 'facing', width: 12 },
    ];

    for (const unit of units) {
      sheet.addRow({
        groupCode: unit.inventoryGroup?.code ?? '',
        unitNumber: unit.number,
        unitType: unit.unitType?.name ?? '',
        status: unit.status,
        landAreaEntered: unit.landAreaEntered ? Number(unit.landAreaEntered) : '',
        landAreaEnteredUnit: unit.landAreaEnteredUnit ?? '',
        landAreaSqft: unit.landAreaSqft ? Number(unit.landAreaSqft) : '',
        rateUnit: unit.rateUnit ?? '',
        baseRatePaise: unit.baseRatePaise.toString(),
        builtUpAreaSqft: unit.builtUpAreaSqft ? Number(unit.builtUpAreaSqft) : '',
        landRecordRef: unit.landRecordRef ?? '',
        facing: unit.facing ?? '',
      });
    }

    const buffer = await workbook.xlsx.writeBuffer();
    return Buffer.from(buffer);
  }
}
