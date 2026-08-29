import { Inject, Injectable } from '@nestjs/common';
import { PrismaClient } from '@openestate/db';
import { SYSTEM_PRISMA } from '../database/database.module';
import { computeAgeingBucket, AGEING_BUCKETS, type Clock } from '@openestate/shared';
import { CLOCK } from '../common/clock.provider';
import { TeamScopeService } from '../team-scope/team-scope.service';

export interface ReportScope {
  /**
   * `null` = admin-tier caller, no restriction. A finite array restricts
   * every report to inquiries assigned to one of these user ids — the
   * caller's own id plus their full reporting subtree
   * (`TeamScopeService.getVisibleUserIds`).
   */
  visibleUserIds: string[] | null;
}

export interface DateRange {
  from?: Date;
  to?: Date;
}

const BUDGET_BANDS: Array<{ label: string; minPaise: bigint; maxPaise: bigint | null }> = [
  { label: '< 50L', minPaise: 0n, maxPaise: 5_000_000_00n },
  { label: '50L - 1Cr', minPaise: 5_000_000_00n, maxPaise: 10_000_000_00n },
  { label: '1Cr - 2Cr', minPaise: 10_000_000_00n, maxPaise: 20_000_000_00n },
  { label: '2Cr+', minPaise: 20_000_000_00n, maxPaise: null },
];

@Injectable()
export class ReportsService {
  constructor(
    @Inject(SYSTEM_PRISMA)
    private readonly systemPrisma: PrismaClient,
    @Inject(CLOCK)
    private readonly clock: Clock,
    private readonly teamScope: TeamScopeService,
  ) {}

  // ── shared helpers ──────────────────────────────────────────────

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private scopedWhere(companyId: string, scope: ReportScope, projectId?: string): any {
    return {
      companyId,
      ...(scope.visibleUserIds ? { assignedToId: { in: scope.visibleUserIds } } : {}),
      ...(projectId ? { projectId } : {}),
    };
  }

  private startOfDay(d: Date): Date {
    const x = new Date(d);
    x.setHours(0, 0, 0, 0);
    return x;
  }

  private endOfDay(d: Date): Date {
    const x = new Date(d);
    x.setHours(23, 59, 59, 999);
    return x;
  }

  private startOfMonth(d: Date): Date {
    return new Date(d.getFullYear(), d.getMonth(), 1);
  }

  private startOfWeek(d: Date): Date {
    const x = new Date(d);
    const day = x.getDay();
    const diff = (day === 0 ? -6 : 1) - day; // Monday-start week
    x.setDate(x.getDate() + diff);
    x.setHours(0, 0, 0, 0);
    return x;
  }

  /** Resolves a caller-supplied date range, falling back to a per-report default when neither bound was given. */
  private resolveRange(
    from: Date | undefined,
    to: Date | undefined,
    fallback: 'today' | 'week' | 'month' | 'all',
  ): DateRange {
    if (from || to) return { from, to };
    const now = this.clock.now();
    switch (fallback) {
      case 'today':
        return { from: this.startOfDay(now), to: this.endOfDay(now) };
      case 'week':
        return { from: this.startOfWeek(now), to: this.endOfDay(now) };
      case 'month':
        return { from: this.startOfMonth(now), to: this.endOfDay(now) };
      case 'all':
        return {};
    }
  }

  private dateFilter(range: DateRange): { gte?: Date; lte?: Date } | undefined {
    if (!range.from && !range.to) return undefined;
    const filter: { gte?: Date; lte?: Date } = {};
    if (range.from) filter.gte = range.from;
    if (range.to) filter.lte = range.to;
    return filter;
  }

  /** Every inquiry id (company-wide) with a linked booking — `Booking.sourceInquiryId` is unique per booking, so a plain count is a distinct-inquiry count. */
  private async bookedInquiryIdSet(companyId: string): Promise<Set<string>> {
    const rows = await this.systemPrisma.booking.findMany({
      where: { companyId, sourceInquiryId: { not: null } },
      select: { sourceInquiryId: true },
    });
    return new Set(rows.map((r: { sourceInquiryId: string | null }) => r.sourceInquiryId as string));
  }

  /**
   * Records an export or print action on the audit log — the control 4QT
   * had as "Print/Download Track," the right one for PII leaving the
   * system in a portable form. Called BEFORE a streamed CSV response
   * starts writing (row count is computed via a separate cheap `count()`
   * ahead of the stream) and before a buffered response is sent, per the
   * approved "audit-before-response" ordering.
   */
  async auditReportAction(
    companyId: string,
    userId: string,
    reportKey: string,
    action: 'EXPORT' | 'PRINT',
    filters: object,
    rowCount: number,
    ipAddress?: string,
  ): Promise<void> {
    await this.systemPrisma.auditLog.create({
      data: {
        companyId,
        userId,
        entityType: 'PresalesReport',
        entityId: reportKey,
        action,
        // Filters come from a caller-supplied query DTO (arbitrary shape,
        // already zod-validated at the API boundary) — Prisma's JSON input
        // type requires JSON-value types, not `object`, hence the cast.
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        after: { filters, rowCount } as any,
        ipAddress,
      },
    });
  }

  // ── existing reports (upgraded: date range + optional project filter) ──

  async dailyInquiriesStaffWise(companyId: string, scope: ReportScope, range: DateRange, projectId?: string) {
    const resolved = this.resolveRange(range.from, range.to, 'today');
    const createdAt = this.dateFilter(resolved);

    const inquiries = await this.systemPrisma.inquiry.findMany({
      where: { ...this.scopedWhere(companyId, scope, projectId), ...(createdAt ? { createdAt } : {}) },
      select: { assignedToId: true, assignedTo: { select: { name: true } } },
    });

    const byStaff = new Map<string, { staffName: string; count: number }>();
    for (const inq of inquiries) {
      const key = inq.assignedToId ?? 'unassigned';
      const name = inq.assignedTo?.name ?? 'Unassigned';
      const row = byStaff.get(key) ?? { staffName: name, count: 0 };
      row.count++;
      byStaff.set(key, row);
    }
    return Array.from(byStaff.entries()).map(([userId, v]) => ({ userId, ...v }));
  }

  async funnelByStatus(companyId: string, scope: ReportScope, range: DateRange, projectId?: string) {
    const createdAt = this.dateFilter(range);
    const rows = await this.systemPrisma.inquiry.groupBy({
      by: ['status'],
      where: { ...this.scopedWhere(companyId, scope, projectId), ...(createdAt ? { createdAt } : {}) },
      _count: { _all: true },
    });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    return rows.map((r: any) => ({ status: r.status, count: r._count._all }));
  }

  /**
   * `conversionPercent` (status === SUCCESSFUL) and `bookingLinkedConversionPercent`
   * (`Booking.sourceInquiryId`) are shown SIDE BY SIDE, deliberately never merged —
   * the gap between the two is itself the signal: a source with a high status-based
   * rate but a much lower booking-linked one means reps are flipping status without a
   * real booking behind it. See CLAUDE.md's presales reporting suite decisions.
   */
  async sourceWiseConversion(companyId: string, scope: ReportScope, range: DateRange, projectId?: string) {
    const createdAt = this.dateFilter(range);
    const [inquiries, bookedIds] = await Promise.all([
      this.systemPrisma.inquiry.findMany({
        where: { ...this.scopedWhere(companyId, scope, projectId), ...(createdAt ? { createdAt } : {}) },
        select: { id: true, sourceId: true, source: { select: { name: true } }, status: true },
      }),
      this.bookedInquiryIdSet(companyId),
    ]);

    const bySource = new Map<
      string,
      { sourceName: string; total: number; successful: number; bookingLinked: number }
    >();
    for (const inq of inquiries) {
      const key = inq.sourceId ?? 'unknown';
      const name = inq.source?.name ?? 'Unknown';
      const row = bySource.get(key) ?? { sourceName: name, total: 0, successful: 0, bookingLinked: 0 };
      row.total++;
      if (inq.status === 'SUCCESSFUL') row.successful++;
      if (bookedIds.has(inq.id)) row.bookingLinked++;
      bySource.set(key, row);
    }

    return Array.from(bySource.entries()).map(([sourceId, v]) => ({
      sourceId,
      sourceName: v.sourceName,
      total: v.total,
      successful: v.successful,
      conversionPercent: v.total > 0 ? Math.round((v.successful / v.total) * 10000) / 100 : 0,
      bookingLinked: v.bookingLinked,
      bookingLinkedConversionPercent: v.total > 0 ? Math.round((v.bookingLinked / v.total) * 10000) / 100 : 0,
    }));
  }

  async budgetBandAnalysis(companyId: string, scope: ReportScope, range: DateRange, projectId?: string) {
    const createdAt = this.dateFilter(range);
    const inquiries = await this.systemPrisma.inquiry.findMany({
      where: {
        ...this.scopedWhere(companyId, scope, projectId),
        budgetMinPaise: { not: null },
        ...(createdAt ? { createdAt } : {}),
      },
      select: { budgetMinPaise: true },
    });

    const counts = new Map<string, number>(BUDGET_BANDS.map((b) => [b.label, 0]));
    for (const inq of inquiries) {
      const value = inq.budgetMinPaise as bigint;
      const band = BUDGET_BANDS.find(
        (b) => value >= b.minPaise && (b.maxPaise === null || value < b.maxPaise),
      );
      if (band) counts.set(band.label, (counts.get(band.label) ?? 0) + 1);
    }

    return BUDGET_BANDS.map((b) => ({ band: b.label, count: counts.get(b.label) ?? 0 }));
  }

  async ageingBuckets(companyId: string, scope: ReportScope, range: DateRange, projectId?: string) {
    const now = this.clock.now();
    const createdAt = this.dateFilter(range);
    const inquiries = await this.systemPrisma.inquiry.findMany({
      where: {
        ...this.scopedWhere(companyId, scope, projectId),
        status: { in: ['OPEN', 'CONTINUED'] },
        ...(createdAt ? { createdAt } : {}),
      },
      select: { createdAt: true },
    });

    const counts = new Map<string, number>(AGEING_BUCKETS.map((b) => [b, 0]));
    for (const inq of inquiries) {
      const bucket = computeAgeingBucket(inq.createdAt, now);
      counts.set(bucket, (counts.get(bucket) ?? 0) + 1);
    }

    return AGEING_BUCKETS.map((bucket) => ({ bucket, count: counts.get(bucket) ?? 0 }));
  }

  async staffPerformance(companyId: string, scope: ReportScope, range: DateRange, projectId?: string) {
    const createdAt = this.dateFilter(range);
    const [inquiries, bookedIds] = await Promise.all([
      this.systemPrisma.inquiry.findMany({
        where: { ...this.scopedWhere(companyId, scope, projectId), ...(createdAt ? { createdAt } : {}) },
        select: { id: true, assignedToId: true, assignedTo: { select: { name: true } }, status: true },
      }),
      this.bookedInquiryIdSet(companyId),
    ]);

    const byStaff = new Map<
      string,
      { staffName: string; totalAssigned: number; successful: number; dumped: number; bookingLinked: number }
    >();
    for (const inq of inquiries) {
      if (!inq.assignedToId) continue;
      const row = byStaff.get(inq.assignedToId) ?? {
        staffName: inq.assignedTo?.name ?? 'Unknown',
        totalAssigned: 0,
        successful: 0,
        dumped: 0,
        bookingLinked: 0,
      };
      row.totalAssigned++;
      if (inq.status === 'SUCCESSFUL') row.successful++;
      if (inq.status === 'DUMPED') row.dumped++;
      if (bookedIds.has(inq.id)) row.bookingLinked++;
      byStaff.set(inq.assignedToId, row);
    }

    return Array.from(byStaff.entries()).map(([userId, v]) => ({
      userId,
      ...v,
      conversionPercent:
        v.totalAssigned > 0 ? Math.round((v.successful / v.totalAssigned) * 10000) / 100 : 0,
      bookingLinkedConversionPercent:
        v.totalAssigned > 0 ? Math.round((v.bookingLinked / v.totalAssigned) * 10000) / 100 : 0,
    }));
  }

  /**
   * Manager-wise interaction counts — a real team roll-up now that a
   * manager hierarchy exists (v0.4), replacing the old "each manager's
   * own directly-logged interactions only" limitation this method's
   * comment used to document (CLAUDE.md Phase 3 decisions).
   *
   * `role: { slug: 'sales_manager' }` below is a real, team-scope-guard-
   * allowlisted exception, same category as escalation.service.ts's:
   * it SELECTS which users a row exists for (the report's axis), it does
   * not scope what data counts. The actual scoping bug this method used
   * to have — silently counting only a manager's own follow-ups instead
   * of their whole subtree's — is what TeamScopeService.getVisibleUserIds
   * fixes here, called once per manager to get that manager's own
   * subtree (never `null`/company-wide for this purpose, hence the empty
   * permissions array — a manager's team is a data fact about them, not
   * an authorization question about the caller).
   */
  async managerWiseInteractions(companyId: string, scope: ReportScope, range: DateRange) {
    const managers = await this.systemPrisma.user.findMany({
      where: {
        companyId,
        isActive: true,
        role: { slug: 'sales_manager' },
        ...(scope.visibleUserIds ? { id: { in: scope.visibleUserIds } } : {}),
      },
      select: { id: true, name: true },
    });
    const createdAt = this.dateFilter(range);

    const rows = await Promise.all(
      managers.map(async (m: { id: string; name: string }) => {
        const teamUserIds = await this.teamScope.getVisibleUserIds(companyId, m.id, []);
        const interactionCount = await this.systemPrisma.followUp.count({
          where: {
            companyId,
            createdById: { in: teamUserIds ?? [] },
            ...(createdAt ? { interactionAt: createdAt } : {}),
          },
        });
        return { managerId: m.id, managerName: m.name, interactionCount };
      }),
    );
    return rows;
  }

  /**
   * v0.2.3: per-inquiry row export, with one column per ACTIVE custom
   * field definition appended after the fixed columns.
   *
   * Row-level, so it streams: `headers`/`rows` are computed separately
   * (`inquiriesExportHeaders` + the `inquiriesExport` generator) so the
   * controller can pass fixed headers to `streamCsv` before iterating.
   */
  async inquiriesExportHeaders(companyId: string) {
    const definitions = await this.systemPrisma.customFieldDefinition.findMany({
      where: { companyId, entityType: { in: ['INQUIRY', 'APPLICANT'] }, isActive: true },
      orderBy: { sortOrder: 'asc' },
    });
    const fixed = [
      'Inquiry ID',
      'Created At',
      'Status',
      'Applicant Name',
      'Applicant Phone',
      'Applicant Email',
      'Project',
      'Source',
      'Temperature',
      'Assigned To',
    ];
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    // Lowercase dotted prefix ("applicant."/"inquiry."), matching the
    // pre-existing export's column-naming convention exactly — this
    // report predates this session's rewrite and apps/e2e's
    // custom-field-values.spec.ts already asserts against this literal
    // format, so it isn't just cosmetic.
    const customLabels = definitions.map((d: any) => `${d.entityType === 'APPLICANT' ? 'applicant' : 'inquiry'}.${d.label}`);
    return { fixed, customLabels, definitions, headers: [...fixed, ...customLabels] };
  }

  async inquiriesExportCount(companyId: string, scope: ReportScope, range: DateRange, projectId?: string) {
    const createdAt = this.dateFilter(range);
    return this.systemPrisma.inquiry.count({
      where: { ...this.scopedWhere(companyId, scope, projectId), ...(createdAt ? { createdAt } : {}) },
    });
  }

  async *inquiriesExport(
    companyId: string,
    scope: ReportScope,
    range: DateRange,
    projectId: string | undefined,
    definitions: Array<{ entityType: string; key: string }>,
  ) {
    const createdAt = this.dateFilter(range);
    const flatten = (v: unknown): string => {
      if (v === undefined || v === null) return '';
      if (Array.isArray(v)) return v.join(', ');
      if (typeof v === 'boolean') return v ? 'Yes' : 'No';
      return String(v);
    };

    const inquiries = await this.systemPrisma.inquiry.findMany({
      where: { ...this.scopedWhere(companyId, scope, projectId), ...(createdAt ? { createdAt } : {}) },
      include: {
        applicant: { select: { name: true, primaryPhone: true, email: true, customFields: true } },
        project: { select: { name: true } },
        source: { select: { name: true } },
        temperature: { select: { name: true } },
        assignedTo: { select: { name: true } },
      },
      orderBy: { createdAt: 'desc' },
    });

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    for (const i of inquiries as any[]) {
      const row: unknown[] = [
        i.id,
        i.createdAt.toISOString().slice(0, 10),
        i.status,
        i.applicant?.name ?? '',
        i.applicant?.primaryPhone ?? '',
        i.applicant?.email ?? '',
        i.project?.name ?? '',
        i.source?.name ?? '',
        i.temperature?.name ?? '',
        i.assignedTo?.name ?? '',
      ];
      for (const def of definitions) {
        const bag = (def.entityType === 'APPLICANT' ? i.applicant?.customFields : i.customFields) as
          | Record<string, unknown>
          | null
          | undefined;
        row.push(flatten(bag?.[def.key]));
      }
      yield row;
    }
  }

  // ── new reports ──────────────────────────────────────────────────

  /** Leads by stage — mirrors funnelByStatus, grouped by LeadStage instead of InquiryStatus. */
  async leadsByStage(companyId: string, scope: ReportScope, range: DateRange, projectId?: string) {
    const createdAt = this.dateFilter(range);
    const [inquiries, stages] = await Promise.all([
      this.systemPrisma.inquiry.findMany({
        where: { ...this.scopedWhere(companyId, scope, projectId), ...(createdAt ? { createdAt } : {}) },
        select: { stageId: true },
      }),
      this.systemPrisma.leadStage.findMany({ where: { companyId }, select: { id: true, name: true } }),
    ]);
    const stageNames = new Map(stages.map((s: { id: string; name: string }) => [s.id, s.name]));
    const counts = new Map<string, number>();
    for (const inq of inquiries) {
      const key = inq.stageId ?? 'unassigned';
      counts.set(key, (counts.get(key) ?? 0) + 1);
    }
    return Array.from(counts.entries()).map(([stageId, count]) => ({
      stageId,
      stageName: stageId === 'unassigned' ? 'No Stage' : (stageNames.get(stageId) ?? 'Unknown'),
      count,
    }));
  }

  /** Enquiry-type report — grouped by Inquiry.inquiryTypeId (Fresh/Resale/Rental/Commercial), NOT InquirySource. */
  async enquiryTypeReport(companyId: string, scope: ReportScope, range: DateRange, projectId?: string) {
    const createdAt = this.dateFilter(range);
    const inquiries = await this.systemPrisma.inquiry.findMany({
      where: { ...this.scopedWhere(companyId, scope, projectId), ...(createdAt ? { createdAt } : {}) },
      select: { inquiryTypeId: true, inquiryType: { select: { name: true } } },
    });
    const counts = new Map<string, { name: string; count: number }>();
    for (const inq of inquiries) {
      const key = inq.inquiryTypeId ?? 'unknown';
      const name = inq.inquiryType?.name ?? 'Unspecified';
      const row = counts.get(key) ?? { name, count: 0 };
      row.count++;
      counts.set(key, row);
    }
    return Array.from(counts.entries()).map(([inquiryTypeId, v]) => ({ inquiryTypeId, ...v }));
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private dumpReportWhere(companyId: string, scope: ReportScope, range: DateRange, executiveId?: string): any {
    const changedAt = this.dateFilter(range);
    return {
      companyId,
      toStatus: 'DUMPED',
      ...(changedAt ? { changedAt } : {}),
      ...(executiveId ? { changedById: executiveId } : {}),
      ...(scope.visibleUserIds ? { changedById: { in: scope.visibleUserIds } } : {}),
    };
  }

  async dumpReportCount(companyId: string, scope: ReportScope, range: DateRange, executiveId?: string) {
    return this.systemPrisma.inquiryDispositionHistory.count({
      where: this.dumpReportWhere(companyId, scope, range, executiveId),
    });
  }

  /** Dump report — row-level, one row per DUMPED disposition-history event. */
  async *dumpReport(
    companyId: string,
    scope: ReportScope,
    range: DateRange,
    executiveId: string | undefined,
  ) {
    const rows = await this.systemPrisma.inquiryDispositionHistory.findMany({
      where: this.dumpReportWhere(companyId, scope, range, executiveId),
      include: {
        reason: { select: { name: true } },
        changedBy: { select: { name: true } },
        inquiry: { select: { id: true, applicant: { select: { name: true } } } },
      },
      orderBy: { changedAt: 'desc' },
    });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    for (const r of rows as any[]) {
      yield [
        r.changedAt.toISOString().slice(0, 10),
        r.inquiry.applicant?.name ?? '',
        r.changedBy?.name ?? 'Unknown',
        r.reason?.name ?? 'Unspecified',
        r.remarks ?? '',
      ];
    }
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private siteVisitReportWhere(companyId: string, scope: ReportScope, range: DateRange, executiveId?: string): any {
    const interactionAt = this.dateFilter(range);
    return {
      companyId,
      type: { name: 'Site Visit' },
      ...(interactionAt ? { interactionAt } : {}),
      ...(executiveId ? { createdById: executiveId } : {}),
      ...(scope.visibleUserIds ? { createdById: { in: scope.visibleUserIds } } : {}),
    };
  }

  async siteVisitReportCount(companyId: string, scope: ReportScope, range: DateRange, executiveId?: string) {
    return this.systemPrisma.followUp.count({
      where: this.siteVisitReportWhere(companyId, scope, range, executiveId),
    });
  }

  /** Site visit report — row-level, FollowUp rows whose type is "Site Visit". */
  async *siteVisitReport(
    companyId: string,
    scope: ReportScope,
    range: DateRange,
    executiveId: string | undefined,
  ) {
    const rows = await this.systemPrisma.followUp.findMany({
      where: this.siteVisitReportWhere(companyId, scope, range, executiveId),
      include: {
        createdBy: { select: { name: true } },
        inquiry: { select: { applicant: { select: { name: true } }, project: { select: { name: true } } } },
      },
      orderBy: { interactionAt: 'desc' },
    });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    for (const r of rows as any[]) {
      yield [
        r.interactionAt.toISOString().slice(0, 10),
        r.createdBy?.name ?? 'Unknown',
        r.inquiry.applicant?.name ?? '',
        r.inquiry.project?.name ?? '',
        r.venue ?? '',
        r.outcome ?? '',
      ];
    }
  }

  /** Stage transitions — count matrix of fromStage -> toStage, excluding administrative (bulk-reassignment) moves. */
  async stageTransitions(companyId: string, scope: ReportScope, range: DateRange) {
    const changedAt = this.dateFilter(range);
    const [rows, stages] = await Promise.all([
      this.systemPrisma.inquiryStageHistory.findMany({
        where: {
          companyId,
          isAdministrative: false,
          ...(changedAt ? { changedAt } : {}),
          ...(scope.visibleUserIds ? { inquiry: { assignedToId: { in: scope.visibleUserIds } } } : {}),
        },
        select: { fromStageId: true, toStageId: true },
      }),
      this.systemPrisma.leadStage.findMany({ where: { companyId }, select: { id: true, name: true } }),
    ]);
    const names = new Map(stages.map((s: { id: string; name: string }) => [s.id, s.name]));
    const counts = new Map<string, { fromStageId: string | null; toStageId: string; count: number }>();
    for (const r of rows) {
      const key = `${r.fromStageId ?? 'created'}->${r.toStageId}`;
      const row = counts.get(key) ?? { fromStageId: r.fromStageId, toStageId: r.toStageId, count: 0 };
      row.count++;
      counts.set(key, row);
    }
    return Array.from(counts.values()).map((v) => ({
      fromStageName: v.fromStageId ? (names.get(v.fromStageId) ?? 'Unknown') : 'Created',
      toStageName: names.get(v.toStageId) ?? 'Unknown',
      count: v.count,
    }));
  }

  /**
   * Stage velocity — average days spent in each stage. Computed in application
   * code from consecutive `changedAt` timestamps per inquiry (not a raw SQL
   * window function). Only CLOSED stays are counted (a stage the inquiry is
   * still currently in has no end time yet) — an open-ended current stay would
   * either be excluded or understate the average if force-computed against
   * "now"; excluding it is the more honest number.
   */
  async stageVelocity(companyId: string, scope: ReportScope, range: DateRange) {
    const changedAt = this.dateFilter(range);
    const [rows, stages] = await Promise.all([
      this.systemPrisma.inquiryStageHistory.findMany({
        where: {
          companyId,
          isAdministrative: false,
          ...(changedAt ? { changedAt } : {}),
          ...(scope.visibleUserIds ? { inquiry: { assignedToId: { in: scope.visibleUserIds } } } : {}),
        },
        select: { inquiryId: true, toStageId: true, changedAt: true },
        orderBy: { changedAt: 'asc' },
      }),
      this.systemPrisma.leadStage.findMany({ where: { companyId }, select: { id: true, name: true } }),
    ]);
    const names = new Map(stages.map((s: { id: string; name: string }) => [s.id, s.name]));

    const byInquiry = new Map<string, Array<{ toStageId: string; changedAt: Date }>>();
    for (const r of rows) {
      const list = byInquiry.get(r.inquiryId) ?? [];
      list.push({ toStageId: r.toStageId, changedAt: r.changedAt });
      byInquiry.set(r.inquiryId, list);
    }

    const daysByStage = new Map<string, { totalDays: number; count: number }>();
    for (const list of byInquiry.values()) {
      for (let i = 0; i < list.length - 1; i++) {
        const stageId = list[i].toStageId;
        const days = (list[i + 1].changedAt.getTime() - list[i].changedAt.getTime()) / 86_400_000;
        const row = daysByStage.get(stageId) ?? { totalDays: 0, count: 0 };
        row.totalDays += days;
        row.count++;
        daysByStage.set(stageId, row);
      }
    }

    return Array.from(daysByStage.entries()).map(([stageId, v]) => ({
      stageId,
      stageName: names.get(stageId) ?? 'Unknown',
      avgDays: v.count > 0 ? Math.round((v.totalDays / v.count) * 100) / 100 : 0,
      sampleSize: v.count,
    }));
  }

  /**
   * Follow-up overdue count per executive — a live gauge, deliberately
   * IGNORES any date-range filter (there is no "overdue as of a past date"
   * question here — SOP's "no lead idle past follow-up time" rule is about
   * right now). `Inquiry.nextFollowupAt` is the live per-inquiry next-due
   * pointer (kept current by FollowUpService on every new follow-up).
   */
  async followUpOverdue(companyId: string, scope: ReportScope) {
    const now = this.clock.now();
    const inquiries = await this.systemPrisma.inquiry.findMany({
      where: {
        ...this.scopedWhere(companyId, scope),
        status: { in: ['OPEN', 'CONTINUED'] },
        nextFollowupAt: { lt: now },
      },
      select: { assignedToId: true, assignedTo: { select: { name: true } } },
    });
    const counts = new Map<string, { executiveName: string; overdueCount: number }>();
    for (const inq of inquiries) {
      if (!inq.assignedToId) continue;
      const row = counts.get(inq.assignedToId) ?? {
        executiveName: inq.assignedTo?.name ?? 'Unknown',
        overdueCount: 0,
      };
      row.overdueCount++;
      counts.set(inq.assignedToId, row);
    }
    return Array.from(counts.entries()).map(([executiveId, v]) => ({ executiveId, ...v }));
  }

  /**
   * Average delay between a follow-up's `nextActionAt` and the `interactionAt`
   * of the follow-up that actually closed it — computed from consecutive
   * FollowUp rows per inquiry (ordered by `interactionAt`), attributed to
   * whoever logged the CLOSING follow-up. A non-positive gap (closed on time
   * or early) contributes 0, not a negative number — the average measures how
   * late closures run, not how early credit should count.
   */
  async followUpDelay(companyId: string, scope: ReportScope, range: DateRange) {
    const interactionAt = this.dateFilter(range);
    const rows = await this.systemPrisma.followUp.findMany({
      where: {
        companyId,
        ...(scope.visibleUserIds ? { createdById: { in: scope.visibleUserIds } } : {}),
      },
      select: { inquiryId: true, interactionAt: true, nextActionAt: true, createdById: true },
      orderBy: { interactionAt: 'asc' },
    });

    const byInquiry = new Map<string, typeof rows>();
    for (const r of rows) {
      const list = byInquiry.get(r.inquiryId) ?? [];
      list.push(r);
      byInquiry.set(r.inquiryId, list);
    }

    const userIds = await this.systemPrisma.user.findMany({
      where: { companyId },
      select: { id: true, name: true },
    });
    const names = new Map(userIds.map((u: { id: string; name: string }) => [u.id, u.name]));

    const delayByUser = new Map<string, { totalHours: number; count: number }>();
    for (const list of byInquiry.values()) {
      for (let i = 0; i < list.length - 1; i++) {
        const prev = list[i];
        const curr = list[i + 1];
        if (!prev.nextActionAt || !curr.createdById) continue;
        if (interactionAt) {
          const t = curr.interactionAt.getTime();
          if (interactionAt.gte && t < interactionAt.gte.getTime()) continue;
          if (interactionAt.lte && t > interactionAt.lte.getTime()) continue;
        }
        const delayHours = Math.max(0, (curr.interactionAt.getTime() - prev.nextActionAt.getTime()) / 3_600_000);
        const row = delayByUser.get(curr.createdById) ?? { totalHours: 0, count: 0 };
        row.totalHours += delayHours;
        row.count++;
        delayByUser.set(curr.createdById, row);
      }
    }

    return Array.from(delayByUser.entries()).map(([executiveId, v]) => ({
      executiveId,
      executiveName: names.get(executiveId) ?? 'Unknown',
      avgDelayHours: v.count > 0 ? Math.round((v.totalHours / v.count) * 100) / 100 : 0,
      closedCount: v.count,
    }));
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private supervisorTransferWhere(companyId: string, scope: ReportScope, range: DateRange, executiveId?: string): any {
    const createdAt = this.dateFilter(range);
    return {
      companyId,
      assignmentType: 'manual',
      fromUserId: { not: null },
      ...(createdAt ? { createdAt } : {}),
      ...(executiveId ? { fromUserId: executiveId } : {}),
      ...(scope.visibleUserIds ? { fromUserId: { in: scope.visibleUserIds } } : {}),
    };
  }

  async supervisorReviewQueueCount(companyId: string, scope: ReportScope, range: DateRange, executiveId?: string) {
    const [dumps, transfers] = await Promise.all([
      this.systemPrisma.inquiryDispositionHistory.count({
        where: this.dumpReportWhere(companyId, scope, range, executiveId),
      }),
      this.systemPrisma.inquiryAssignment.count({
        where: this.supervisorTransferWhere(companyId, scope, range, executiveId),
      }),
    ]);
    return dumps + transfers;
  }

  /**
   * Supervisor review queue — dumped + transferred leads, for the weekly
   * review the SOP mandates. Row-level, deliberately read-only (no
   * acknowledge/reviewed workflow — that's workspace territory, out of
   * scope for a reports-only build).
   */
  async *supervisorReviewQueue(
    companyId: string,
    scope: ReportScope,
    range: DateRange,
    executiveId: string | undefined,
  ) {
    const [dumps, transfers] = await Promise.all([
      this.systemPrisma.inquiryDispositionHistory.findMany({
        where: this.dumpReportWhere(companyId, scope, range, executiveId),
        include: {
          reason: { select: { name: true } },
          changedBy: { select: { name: true } },
          inquiry: { select: { applicant: { select: { name: true } } } },
        },
        orderBy: { changedAt: 'desc' },
      }),
      this.systemPrisma.inquiryAssignment.findMany({
        where: this.supervisorTransferWhere(companyId, scope, range, executiveId),
        include: {
          fromUser: { select: { name: true } },
          toUser: { select: { name: true } },
          inquiry: { select: { applicant: { select: { name: true } } } },
        },
        orderBy: { createdAt: 'desc' },
      }),
    ]);

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    for (const d of dumps as any[]) {
      yield [
        d.changedAt.toISOString().slice(0, 10),
        'DUMPED',
        d.inquiry.applicant?.name ?? '',
        d.changedBy?.name ?? 'Unknown',
        '',
        d.reason?.name ?? 'Unspecified',
      ];
    }
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    for (const t of transfers as any[]) {
      yield [
        t.createdAt.toISOString().slice(0, 10),
        'TRANSFERRED',
        t.inquiry.applicant?.name ?? '',
        t.fromUser?.name ?? 'Unknown',
        t.toUser?.name ?? '',
        t.reason ?? '',
      ];
    }
  }

  /**
   * Daily work report — per-user activity for a date range: follow-ups
   * logged, distinct leads touched, stage changes made, dispositions set.
   */
  async dailyWorkReport(companyId: string, scope: ReportScope, range: DateRange) {
    const resolved = this.resolveRange(range.from, range.to, 'today');
    const followUpAt = this.dateFilter(resolved);
    const historyAt = this.dateFilter(resolved);

    const userScope = scope.visibleUserIds ? { in: scope.visibleUserIds } : undefined;

    const [followUps, stageChanges, dispositions, users] = await Promise.all([
      this.systemPrisma.followUp.findMany({
        where: {
          companyId,
          ...(userScope ? { createdById: userScope } : {}),
          ...(followUpAt ? { interactionAt: followUpAt } : {}),
        },
        select: { createdById: true, inquiryId: true },
      }),
      this.systemPrisma.inquiryStageHistory.findMany({
        where: {
          companyId,
          isAdministrative: false,
          ...(userScope ? { changedById: userScope } : {}),
          ...(historyAt ? { changedAt: historyAt } : {}),
        },
        select: { changedById: true, inquiryId: true },
      }),
      this.systemPrisma.inquiryDispositionHistory.findMany({
        where: {
          companyId,
          ...(userScope ? { changedById: userScope } : {}),
          ...(historyAt ? { changedAt: historyAt } : {}),
        },
        select: { changedById: true, inquiryId: true },
      }),
      this.systemPrisma.user.findMany({ where: { companyId }, select: { id: true, name: true } }),
    ]);
    const names = new Map(users.map((u: { id: string; name: string }) => [u.id, u.name]));

    interface Row {
      userId: string;
      userName: string;
      followUpsLogged: number;
      stageChanges: number;
      dispositionsSet: number;
      touched: Set<string>;
    }
    const byUser = new Map<string, Row>();
    const get = (userId: string): Row =>
      byUser.get(userId) ??
      (() => {
        const row: Row = {
          userId,
          userName: names.get(userId) ?? 'Unknown',
          followUpsLogged: 0,
          stageChanges: 0,
          dispositionsSet: 0,
          touched: new Set(),
        };
        byUser.set(userId, row);
        return row;
      })();

    for (const f of followUps) {
      if (!f.createdById) continue;
      const row = get(f.createdById);
      row.followUpsLogged++;
      row.touched.add(f.inquiryId);
    }
    for (const s of stageChanges) {
      if (!s.changedById) continue;
      const row = get(s.changedById);
      row.stageChanges++;
      row.touched.add(s.inquiryId);
    }
    for (const d of dispositions) {
      if (!d.changedById) continue;
      const row = get(d.changedById);
      row.dispositionsSet++;
      row.touched.add(d.inquiryId);
    }

    return Array.from(byUser.values()).map((r) => ({
      userId: r.userId,
      userName: r.userName,
      followUpsLogged: r.followUpsLogged,
      leadsTouched: r.touched.size,
      stageChanges: r.stageChanges,
      dispositionsSet: r.dispositionsSet,
    }));
  }

  /**
   * Communication-type breakdown — grouped by FollowUpType (Phone Call/Site
   * Visit/Email/WhatsApp/Meeting/Video Call), NOT CommunicationType (see
   * CLAUDE.md's FollowUpType-vs-CommunicationType disambiguation). Conversion
   * measured the booking-linked way, consistent with sourceWiseConversion's
   * bookingLinkedConversionPercent column — deliberately not the status-based
   * number, since there is no separate status-based figure to preserve here.
   */
  async communicationTypeBreakdown(companyId: string, scope: ReportScope, range: DateRange) {
    const interactionAt = this.dateFilter(range);
    const [followUps, bookedIds] = await Promise.all([
      this.systemPrisma.followUp.findMany({
        where: {
          companyId,
          ...(scope.visibleUserIds ? { createdById: { in: scope.visibleUserIds } } : {}),
          ...(interactionAt ? { interactionAt } : {}),
        },
        select: { typeId: true, type: { select: { name: true } }, inquiryId: true },
      }),
      this.bookedInquiryIdSet(companyId),
    ]);

    const byType = new Map<string, { typeName: string; totalFollowUps: number; inquiries: Set<string> }>();
    for (const f of followUps) {
      const key = f.typeId ?? 'unspecified';
      const name = f.type?.name ?? 'Unspecified';
      const row = byType.get(key) ?? { typeName: name, totalFollowUps: 0, inquiries: new Set<string>() };
      row.totalFollowUps++;
      row.inquiries.add(f.inquiryId);
      byType.set(key, row);
    }

    return Array.from(byType.entries()).map(([typeId, v]) => {
      const distinctInquiries = v.inquiries.size;
      const booked = Array.from(v.inquiries).filter((id) => bookedIds.has(id)).length;
      return {
        typeId,
        typeName: v.typeName,
        totalFollowUps: v.totalFollowUps,
        distinctInquiries,
        bookingLinked: booked,
        bookingLinkedConversionPercent: distinctInquiries > 0 ? Math.round((booked / distinctInquiries) * 10000) / 100 : 0,
      };
    });
  }
}
