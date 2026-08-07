import { Inject, Injectable } from '@nestjs/common';
import { PrismaClient } from '@openestate/db';
import { SYSTEM_PRISMA } from '../database/database.module';
import { computeAgeingBucket, AGEING_BUCKETS, type Clock } from '@openestate/shared';
import { CLOCK } from '../common/clock.provider';

export interface ReportScope {
  /** sales_executive: restrict every report to this user's own numbers. */
  scopeToUserId?: string;
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
  ) {}

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private scopedWhere(companyId: string, scope: ReportScope): any {
    return scope.scopeToUserId
      ? { companyId, assignedToId: scope.scopeToUserId }
      : { companyId };
  }

  async dailyInquiriesStaffWise(companyId: string, date: Date, scope: ReportScope) {
    const start = new Date(date);
    start.setHours(0, 0, 0, 0);
    const end = new Date(date);
    end.setHours(23, 59, 59, 999);

    const inquiries = await this.systemPrisma.inquiry.findMany({
      where: { ...this.scopedWhere(companyId, scope), createdAt: { gte: start, lte: end } },
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

  async funnelByStatus(companyId: string, scope: ReportScope) {
    const rows = await this.systemPrisma.inquiry.groupBy({
      by: ['status'],
      where: this.scopedWhere(companyId, scope),
      _count: { _all: true },
    });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    return rows.map((r: any) => ({ status: r.status, count: r._count._all }));
  }

  async sourceWiseConversion(companyId: string, scope: ReportScope) {
    const inquiries = await this.systemPrisma.inquiry.findMany({
      where: this.scopedWhere(companyId, scope),
      select: { sourceId: true, source: { select: { name: true } }, status: true },
    });

    const bySource = new Map<string, { sourceName: string; total: number; successful: number }>();
    for (const inq of inquiries) {
      const key = inq.sourceId ?? 'unknown';
      const name = inq.source?.name ?? 'Unknown';
      const row = bySource.get(key) ?? { sourceName: name, total: 0, successful: 0 };
      row.total++;
      if (inq.status === 'SUCCESSFUL') row.successful++;
      bySource.set(key, row);
    }

    return Array.from(bySource.entries()).map(([sourceId, v]) => ({
      sourceId,
      sourceName: v.sourceName,
      total: v.total,
      successful: v.successful,
      conversionPercent: v.total > 0 ? Math.round((v.successful / v.total) * 10000) / 100 : 0,
    }));
  }

  async budgetBandAnalysis(companyId: string, scope: ReportScope) {
    const inquiries = await this.systemPrisma.inquiry.findMany({
      where: { ...this.scopedWhere(companyId, scope), budgetMinPaise: { not: null } },
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

  async ageingBuckets(companyId: string, scope: ReportScope) {
    const now = this.clock.now();
    const inquiries = await this.systemPrisma.inquiry.findMany({
      where: { ...this.scopedWhere(companyId, scope), status: { in: ['OPEN', 'CONTINUED'] } },
      select: { createdAt: true },
    });

    const counts = new Map<string, number>(AGEING_BUCKETS.map((b) => [b, 0]));
    for (const inq of inquiries) {
      const bucket = computeAgeingBucket(inq.createdAt, now);
      counts.set(bucket, (counts.get(bucket) ?? 0) + 1);
    }

    return AGEING_BUCKETS.map((bucket) => ({ bucket, count: counts.get(bucket) ?? 0 }));
  }

  async staffPerformance(companyId: string, scope: ReportScope) {
    const inquiries = await this.systemPrisma.inquiry.findMany({
      where: this.scopedWhere(companyId, scope),
      select: { assignedToId: true, assignedTo: { select: { name: true } }, status: true },
    });

    const byStaff = new Map<
      string,
      { staffName: string; totalAssigned: number; successful: number; dumped: number }
    >();
    for (const inq of inquiries) {
      if (!inq.assignedToId) continue;
      const row = byStaff.get(inq.assignedToId) ?? {
        staffName: inq.assignedTo?.name ?? 'Unknown',
        totalAssigned: 0,
        successful: 0,
        dumped: 0,
      };
      row.totalAssigned++;
      if (inq.status === 'SUCCESSFUL') row.successful++;
      if (inq.status === 'DUMPED') row.dumped++;
      byStaff.set(inq.assignedToId, row);
    }

    return Array.from(byStaff.entries()).map(([userId, v]) => ({
      userId,
      ...v,
      conversionPercent:
        v.totalAssigned > 0 ? Math.round((v.successful / v.totalAssigned) * 10000) / 100 : 0,
    }));
  }

  /**
   * Manager-wise interaction counts. No project->manager mapping exists yet
   * (see CLAUDE.md Phase 3 decisions), so this reports each active
   * sales_manager's OWN directly-logged follow-up interactions, not a
   * team roll-up. Revisit once a manager hierarchy field exists.
   */
  async managerWiseInteractions(companyId: string) {
    const managers = await this.systemPrisma.user.findMany({
      where: { companyId, isActive: true, role: { slug: 'sales_manager' } },
      select: { id: true, name: true },
    });

    const followUps = await this.systemPrisma.followUp.findMany({
      where: { companyId, createdById: { in: managers.map((m: { id: string }) => m.id) } },
      select: { createdById: true },
    });

    const counts = new Map<string, number>();
    for (const f of followUps) {
      if (!f.createdById) continue;
      counts.set(f.createdById, (counts.get(f.createdById) ?? 0) + 1);
    }

    return managers.map((m: { id: string; name: string }) => ({
      managerId: m.id,
      managerName: m.name,
      interactionCount: counts.get(m.id) ?? 0,
    }));
  }

  /**
   * v0.2.3: per-inquiry row export, with one column per ACTIVE custom
   * field definition appended after the fixed columns.
   *
   * Every other report here is an aggregate (funnel, ageing,
   * staff-performance) where a custom field value has no meaning — this
   * is the row-level export that makes "custom fields appear in
   * exports" real. Columns are computed from the definitions, so a
   * newly-defined field shows up with no code change.
   *
   * Column keys are prefixed (`inquiry.` / `applicant.`) because the
   * two entity types can legitimately define the SAME key, and an
   * unprefixed collision would silently drop one of them from every
   * exported row.
   */
  async inquiriesExport(companyId: string, scope: ReportScope) {
    const [inquiries, definitions] = await Promise.all([
      this.systemPrisma.inquiry.findMany({
        where: this.scopedWhere(companyId, scope),
        include: {
          applicant: { select: { name: true, primaryPhone: true, email: true, customFields: true } },
          project: { select: { name: true } },
          source: { select: { name: true } },
          temperature: { select: { name: true } },
          assignedTo: { select: { name: true } },
        },
        orderBy: { createdAt: 'desc' },
      }),
      this.systemPrisma.customFieldDefinition.findMany({
        where: { companyId, entityType: { in: ['INQUIRY', 'APPLICANT'] }, isActive: true },
        orderBy: { sortOrder: 'asc' },
      }),
    ]);

    const flatten = (v: unknown): string => {
      if (v === undefined || v === null) return '';
      if (Array.isArray(v)) return v.join(', ');
      if (typeof v === 'boolean') return v ? 'Yes' : 'No';
      return String(v);
    };

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    return (inquiries as any[]).map((i) => {
      const row: Record<string, unknown> = {
        inquiryId: i.id,
        createdAt: i.createdAt.toISOString().slice(0, 10),
        status: i.status,
        applicantName: i.applicant?.name ?? '',
        applicantPhone: i.applicant?.primaryPhone ?? '',
        applicantEmail: i.applicant?.email ?? '',
        project: i.project?.name ?? '',
        source: i.source?.name ?? '',
        temperature: i.temperature?.name ?? '',
        assignedTo: i.assignedTo?.name ?? '',
      };
      for (const def of definitions) {
        const bag = (def.entityType === 'APPLICANT' ? i.applicant?.customFields : i.customFields) as
          | Record<string, unknown>
          | null
          | undefined;
        const prefix = def.entityType === 'APPLICANT' ? 'applicant' : 'inquiry';
        row[`${prefix}.${def.label}`] = flatten(bag?.[def.key]);
      }
      return row;
    });
  }
}
