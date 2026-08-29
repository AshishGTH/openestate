import { BadRequestException, Inject, Injectable } from '@nestjs/common';
import { withTenantTx, runWithTenant } from '@openestate/db';
import { TENANT_PRISMA } from '../database/database.module';
import { importInquiryRowSchema, normalizePhone, normalizeEmail } from '@openestate/shared';
import * as ExcelJS from 'exceljs';
import { AssignmentService } from './assignment.service';
import { LeadStageTransitionService } from './lead-stage-transition.service';
import { InquiryDispositionTransitionService } from './inquiry-disposition-transition.service';

export interface ImportRowError {
  row: number;
  field: string;
  message: string;
}

export interface InquiryImportResult {
  success: boolean;
  createdCount: number;
  linkedCount: number;
  flaggedCount: number;
  errorCount: number;
  errors: ImportRowError[];
  linked: Array<{ row: number; applicantName: string; applicantId: string }>;
  // Item 7: populated only when CompanyConfig.presalesPhoneDedupAutoLink
  // is false — a phone/email match was found but NOT auto-linked; a new
  // applicant was created instead and flagged against the match for a
  // human to review later (via GET /applicants/:id/duplicates).
  flagged: Array<{
    row: number;
    applicantName: string;
    applicantId: string;
    possibleDuplicateOfApplicantId: string;
  }>;
}

const HEADER_MAP: Record<string, string> = {
  'Applicant Name': 'applicantName',
  'Primary Phone': 'primaryPhone',
  Email: 'email',
  'Project Code': 'projectCode',
  'Source Name': 'sourceName',
  'Inquiry Type Name': 'inquiryTypeName',
  'Budget Min (paise)': 'budgetMinPaise',
  'Budget Max (paise)': 'budgetMaxPaise',
  Notes: 'notes',
};

@Injectable()
export class InquiryImportService {
  constructor(
    @Inject(TENANT_PRISMA)
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    private readonly tenantPrisma: any,
    private readonly assignmentService: AssignmentService,
    private readonly leadStageTransition: LeadStageTransitionService,
    private readonly dispositionTransition: InquiryDispositionTransitionService,
  ) {}

  /**
   * Header row only, no data — HEADER_MAP is the single source of truth
   * for what importInquiries() actually parses, so the downloadable
   * template can never drift from what a real upload requires.
   */
  async buildImportTemplate(): Promise<Buffer> {
    const workbook = new ExcelJS.Workbook();
    const sheet = workbook.addWorksheet('Inquiries');
    sheet.columns = Object.keys(HEADER_MAP).map((header) => ({ header, width: 22 }));
    const buffer = await workbook.xlsx.writeBuffer();
    return Buffer.from(buffer);
  }

  async importInquiries(companyId: string, buffer: Buffer): Promise<InquiryImportResult> {
    const header = buffer.subarray(0, 4);
    if (header[0] !== 0x50 || header[1] !== 0x4b || header[2] !== 0x03 || header[3] !== 0x04) {
      throw new BadRequestException('Invalid file: expected XLSX format');
    }

    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.load(buffer as unknown as ArrayBuffer);
    const sheet = workbook.worksheets[0];
    if (!sheet) throw new BadRequestException('Workbook has no worksheets');

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
        const key = HEADER_MAP[headers[colNum]];
        if (key) data[key] = cell.value;
      });
      if (Object.keys(data).length > 0) rows.push({ rowNum: rowNumber, data });
    });

    if (rows.length === 0) {
      throw new BadRequestException('No data rows found in the worksheet');
    }

    const errors: ImportRowError[] = [];
    const validRows: Array<{ rowNum: number; data: ReturnType<typeof importInquiryRowSchema.parse> }> = [];

    for (const { rowNum, data } of rows) {
      const result = importInquiryRowSchema.safeParse(data);
      if (!result.success) {
        for (const issue of result.error.issues) {
          errors.push({ row: rowNum, field: issue.path.join('.'), message: issue.message });
        }
      } else {
        validRows.push({ rowNum, data: result.data });
      }
    }

    if (errors.length > 0) {
      return {
        success: false,
        createdCount: 0,
        linkedCount: 0,
        flaggedCount: 0,
        errorCount: errors.length,
        errors,
        linked: [],
        flagged: [],
      };
    }

    return runWithTenant({ companyId }, () =>
      withTenantTx(this.tenantPrisma, companyId, async (tx) => {
        let createdCount = 0;
        const linked: Array<{ row: number; applicantName: string; applicantId: string }> = [];
        const flagged: InquiryImportResult['flagged'] = [];

        const config = await tx.companyConfig.findFirst({ where: { companyId } });
        const autoLink = config?.presalesPhoneDedupAutoLink ?? true;

        const projectCache = new Map<string, string | null>();
        const sourceCache = new Map<string, string | null>();
        const inquiryTypeCache = new Map<string, string | null>();
        // Same for every row in this import — resolved once, not per row,
        // same reasoning as the three caches above.
        const resolvedStageId = await this.leadStageTransition.resolveInitialStage(tx, companyId, undefined);

        for (const { rowNum, data } of validRows) {
          const primaryPhoneNormalized = normalizePhone(data.primaryPhone);
          const emailNormalized = data.email ? normalizeEmail(data.email) : null;

          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          const or: any[] = [{ primaryPhoneNormalized }];
          if (emailNormalized) or.push({ emailNormalized });

          const existingApplicant = await tx.applicant.findFirst({
            where: { companyId, mergedIntoId: null, OR: or },
          });

          let applicantId: string;
          if (existingApplicant && autoLink) {
            applicantId = existingApplicant.id;
            linked.push({ row: rowNum, applicantName: data.applicantName, applicantId });
          } else {
            const created = await tx.applicant.create({
              data: {
                companyId,
                name: data.applicantName,
                primaryPhone: data.primaryPhone.trim(),
                primaryPhoneNormalized,
                alternatePhones: [],
                email: data.email,
                emailNormalized,
              },
            });
            applicantId = created.id;
            if (existingApplicant) {
              flagged.push({
                row: rowNum,
                applicantName: data.applicantName,
                applicantId,
                possibleDuplicateOfApplicantId: existingApplicant.id,
              });
            }
          }

          let projectId: string | null | undefined = undefined;
          if (data.projectCode) {
            if (!projectCache.has(data.projectCode)) {
              const p = await tx.project.findFirst({ where: { companyId, code: data.projectCode } });
              projectCache.set(data.projectCode, p?.id ?? null);
            }
            projectId = projectCache.get(data.projectCode);
          }

          let sourceId: string | null | undefined = undefined;
          if (data.sourceName) {
            if (!sourceCache.has(data.sourceName)) {
              const s = await tx.inquirySource.findFirst({ where: { companyId, name: data.sourceName } });
              sourceCache.set(data.sourceName, s?.id ?? null);
            }
            sourceId = sourceCache.get(data.sourceName);
          }

          let inquiryTypeId: string | null | undefined = undefined;
          if (data.inquiryTypeName) {
            if (!inquiryTypeCache.has(data.inquiryTypeName)) {
              const it = await tx.inquiryType.findFirst({ where: { companyId, name: data.inquiryTypeName } });
              inquiryTypeCache.set(data.inquiryTypeName, it?.id ?? null);
            }
            inquiryTypeId = inquiryTypeCache.get(data.inquiryTypeName);
          }

          const importedInquiry = await tx.inquiry.create({
            data: {
              companyId,
              applicantId,
              projectId: projectId ?? null,
              sourceId: sourceId ?? null,
              inquiryTypeId: inquiryTypeId ?? null,
              budgetMinPaise: data.budgetMinPaise != null ? BigInt(data.budgetMinPaise) : null,
              budgetMaxPaise: data.budgetMaxPaise != null ? BigInt(data.budgetMaxPaise) : null,
              stageId: resolvedStageId,
              customFields: data.notes ? { importNotes: data.notes } : undefined,
              // No human creator for a batch-imported row — no creator to
              // retain ownership for, so this always goes through
              // round-robin, same as inbound-lead intake.
            },
          });
          // No human actor for a batch-imported row — same reasoning as
          // the round-robin assignment below.
          await this.leadStageTransition.writeStageTransition(
            tx,
            companyId,
            importedInquiry.id,
            null,
            resolvedStageId,
            null,
          );
          await this.dispositionTransition.writeDispositionTransition(
            tx,
            companyId,
            importedInquiry.id,
            null,
            importedInquiry.status,
            null,
          );

          if (projectId) {
            const assignedToId = await this.assignmentService.autoAssign(tx, companyId, projectId);
            if (assignedToId) {
              await tx.inquiry.update({ where: { id: importedInquiry.id }, data: { assignedToId } });
              await tx.inquiryAssignment.create({
                data: {
                  companyId,
                  inquiryId: importedInquiry.id,
                  toUserId: assignedToId,
                  assignmentType: 'auto',
                  actorId: null,
                },
              });
            }
          }

          createdCount++;
        }

        return {
          success: true,
          createdCount,
          linkedCount: linked.length,
          flaggedCount: flagged.length,
          errorCount: 0,
          errors: [],
          linked,
          flagged,
        };
      }),
    );
  }
}
