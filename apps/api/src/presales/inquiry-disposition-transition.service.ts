import { Injectable, NotFoundException } from '@nestjs/common';

/**
 * Mirrors LeadStageTransitionService's shape exactly, for the same
 * reason: shared by every inquiry-creation path (InquiryService.create(),
 * createFromLead(), InquiryImportService's own tx.inquiry.create()) and
 * by InquiryService.update() whenever status changes. A standalone
 * service, not a private method on InquiryService, so InquiryImportService
 * can reach it without depending on InquiryService's whole dependency
 * graph.
 *
 * Closes the one axis of three (stage, ownership, status) that had no
 * dedicated history table — see InquiryDispositionHistory's own schema
 * doc comment. Written on EVERY status transition, not just DUMPED;
 * reasonId/remarks are populated only when the transition needs them
 * (currently: only DUMPED does, per SOP rule 5).
 */
@Injectable()
export class InquiryDispositionTransitionService {
  /** Writes one InquiryDispositionHistory row, including the initial
   *  null -> OPEN transition at creation — gap-free from row one, same
   *  discipline as LeadStageTransitionService.writeStageTransition. */
  async writeDispositionTransition(
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    tx: any,
    companyId: string,
    inquiryId: string,
    fromStatus: string | null,
    toStatus: string,
    changedById: string | null,
    reasonId?: string | null,
    remarks?: string | null,
  ): Promise<void> {
    await tx.inquiryDispositionHistory.create({
      data: {
        companyId,
        inquiryId,
        fromStatus,
        toStatus,
        reasonId: reasonId ?? null,
        remarks: remarks ?? null,
        changedById,
      },
    });
  }

  /**
   * Same "RLS scopes reads, not a client-supplied FK on write" gap this
   * project already closed once for stageId (LeadStageTransitionService.
   * assertStageBelongsToCompany) — a dumpReasonId needs the identical
   * check before being persisted.
   */
  async assertReasonBelongsToCompany(
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    tx: any,
    companyId: string,
    reasonId: string,
  ): Promise<void> {
    const reason = await tx.dumpReason.findFirst({ where: { id: reasonId, companyId } });
    if (!reason) throw new NotFoundException('Dump reason not found');
  }
}
