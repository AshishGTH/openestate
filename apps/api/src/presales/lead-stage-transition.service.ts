import { Injectable, NotFoundException } from '@nestjs/common';

/**
 * Shared by every inquiry-creation path — InquiryService.create(),
 * InquiryService.createFromLead(), and InquiryImportService's own raw
 * tx.inquiry.create() (verified by grep before this was built: all
 * three call tx.inquiry.create() independently, none delegates to the
 * others) — and by InquiryService.update() whenever stageId changes.
 * A standalone service rather than a private method on InquiryService
 * so InquiryImportService can reach it without depending on
 * InquiryService's whole dependency graph (ApplicantService,
 * AssignmentService, CustomFieldsService, ...) just for two methods.
 */
@Injectable()
export class LeadStageTransitionService {
  /** Explicit id (validated against the caller's own company — see
   *  assertStageBelongsToCompany), or the company's isDefault LeadStage,
   *  or null if neither — never throws for a company with no stages
   *  configured. */
  async resolveInitialStage(
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    tx: any,
    companyId: string,
    requestedStageId: string | undefined,
  ): Promise<string | null> {
    if (requestedStageId) {
      await this.assertStageBelongsToCompany(tx, companyId, requestedStageId);
      return requestedStageId;
    }
    const defaultStage = await tx.leadStage.findFirst({ where: { companyId, isDefault: true } });
    return defaultStage?.id ?? null;
  }

  /**
   * RLS scopes what a query can READ, but it doesn't validate a
   * client-supplied foreign key on WRITE — the inquiries_stage_id_fkey
   * constraint only proves the id exists SOMEWHERE in lead_stages, not
   * that it belongs to this company. Without this check, a caller could
   * set an inquiry's stageId to another company's LeadStage.id and the
   * write would silently succeed. Called from every path that persists a
   * client-supplied stageId: resolveInitialStage (create/createFromLead)
   * and InquiryService.update() directly.
   */
  async assertStageBelongsToCompany(
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    tx: any,
    companyId: string,
    stageId: string,
  ): Promise<void> {
    const stage = await tx.leadStage.findFirst({ where: { id: stageId, companyId } });
    if (!stage) throw new NotFoundException('Lead stage not found');
  }

  /** Writes one InquiryStageHistory row, including the initial
   *  null -> default transition at creation — so history is gap-free
   *  from row one, not just from the first edit. No-ops when toStageId
   *  is null (a company with no stages configured has nothing to log).
   *  Every call site through this method is a real sales-pipeline
   *  movement (initial assignment or the InquiryDetail stage picker),
   *  so isAdministrative always writes false here — the only writer of
   *  a true row is LeadStageService.reassignOccupants' own bulk
   *  createMany, which this method is deliberately not used for. */
  async writeStageTransition(
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    tx: any,
    companyId: string,
    inquiryId: string,
    fromStageId: string | null,
    toStageId: string | null,
    changedById: string | null,
  ): Promise<void> {
    if (!toStageId) return;
    await tx.inquiryStageHistory.create({
      data: { companyId, inquiryId, fromStageId, toStageId, changedById, isAdministrative: false },
    });
  }
}
