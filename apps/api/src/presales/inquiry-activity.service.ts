import { Inject, Injectable } from '@nestjs/common';
import { PrismaClient } from '@openestate/db';
import { SYSTEM_PRISMA } from '../database/database.module';
import { INQUIRY_ACTIVITY_TYPES, type InquiryActivityQuery, type InquiryActivityType } from '@openestate/shared';
import { InquiryService, type InquiryScope } from './inquiry.service';

export interface ActivityActor {
  id: string;
  name: string;
}

export interface ActivityItem {
  /** `<type>:<row id>`: unique across kinds, stable between requests. */
  id: string;
  type: InquiryActivityType;
  /** When the event happened (a follow-up's interactionAt, otherwise the row's own timestamp). */
  occurredAt: Date;
  actor: ActivityActor | null;
  details: Record<string, unknown>;
}

const actorSelect = { select: { id: true, name: true } } as const;

/**
 * A lead's activity, merged from the tables that really record it. Offset
 * pagination over the union: each source contributes its newest `page * limit`
 * rows, the union is ordered by (occurredAt desc, id desc) and sliced. The
 * total is the sum of per-source counts. Scope is the inquiry's: a caller who
 * cannot see the lead gets a 404 before any activity is read.
 */
@Injectable()
export class InquiryActivityService {
  constructor(
    @Inject(SYSTEM_PRISMA) private readonly systemPrisma: PrismaClient,
    private readonly inquiryService: InquiryService,
  ) {}

  async list(
    companyId: string,
    inquiryId: string,
    query: InquiryActivityQuery,
    scope: InquiryScope,
    /** Kinds this caller's permissions allow; the rest are silently not part of the feed. */
    allowed: readonly InquiryActivityType[],
  ) {
    await this.inquiryService.assertInScope(companyId, inquiryId, scope);
    const requested = query.type ?? [...INQUIRY_ACTIVITY_TYPES];
    const types = INQUIRY_ACTIVITY_TYPES.filter((t) => requested.includes(t) && allowed.includes(t));
    const window = query.page * query.limit;
    const where = { companyId, inquiryId };

    const per = await Promise.all(types.map((t) => this.source(t, where, window)));
    const items = per.flatMap((p) => p.items).sort(compareActivity);
    const total = per.reduce((n, p) => n + p.total, 0);
    const start = (query.page - 1) * query.limit;
    return {
      data: items.slice(start, start + query.limit),
      meta: { page: query.page, limit: query.limit, total, totalPages: Math.ceil(total / query.limit), types },
    };
  }

  private async source(type: InquiryActivityType, where: { companyId: string; inquiryId: string }, take: number): Promise<{ items: ActivityItem[]; total: number }> {
    const db = this.systemPrisma;
    switch (type) {
      case 'follow_up': {
        const [rows, total] = await Promise.all([
          db.followUp.findMany({
            where,
            orderBy: [{ interactionAt: 'desc' }, { id: 'desc' }],
            take,
            select: {
              id: true, interactionAt: true, notes: true, outcome: true, scheduledAt: true, venue: true, nextActionAt: true,
              type: { select: { id: true, name: true, isSiteVisit: true } },
              createdBy: actorSelect,
            },
          }),
          db.followUp.count({ where }),
        ]);
        return {
          total,
          items: rows.map((r) => ({
            id: `follow_up:${r.id}`, type, occurredAt: r.interactionAt, actor: r.createdBy,
            details: {
              followUpId: r.id,
              followUpType: r.type ? { id: r.type.id, name: r.type.name } : null,
              isSiteVisit: r.type?.isSiteVisit ?? false,
              notes: r.notes, outcome: r.outcome, scheduledAt: r.scheduledAt, venue: r.venue, nextActionAt: r.nextActionAt,
            },
          })),
        };
      }
      case 'stage_change': {
        const [rows, total] = await Promise.all([
          db.inquiryStageHistory.findMany({
            where, orderBy: [{ changedAt: 'desc' }, { id: 'desc' }], take,
            select: { id: true, changedAt: true, isAdministrative: true, fromStage: { select: { id: true, name: true } }, toStage: { select: { id: true, name: true } }, changedBy: actorSelect },
          }),
          db.inquiryStageHistory.count({ where }),
        ]);
        return {
          total,
          items: rows.map((r) => ({
            id: `stage_change:${r.id}`, type, occurredAt: r.changedAt, actor: r.changedBy,
            details: { from: r.fromStage, to: r.toStage, administrative: r.isAdministrative },
          })),
        };
      }
      case 'status_change': {
        const [rows, total] = await Promise.all([
          db.inquiryDispositionHistory.findMany({
            where, orderBy: [{ changedAt: 'desc' }, { id: 'desc' }], take,
            select: { id: true, changedAt: true, fromStatus: true, toStatus: true, remarks: true, reason: { select: { id: true, name: true } }, changedBy: actorSelect },
          }),
          db.inquiryDispositionHistory.count({ where }),
        ]);
        return {
          total,
          items: rows.map((r) => ({
            id: `status_change:${r.id}`, type, occurredAt: r.changedAt, actor: r.changedBy,
            details: { from: r.fromStatus, to: r.toStatus, reason: r.reason, remarks: r.remarks },
          })),
        };
      }
      case 'assignment': {
        const [rows, total] = await Promise.all([
          db.inquiryAssignment.findMany({
            where, orderBy: [{ createdAt: 'desc' }, { id: 'desc' }], take,
            select: { id: true, createdAt: true, assignmentType: true, reason: true, fromUser: actorSelect, toUser: actorSelect, actor: actorSelect },
          }),
          db.inquiryAssignment.count({ where }),
        ]);
        return {
          total,
          items: rows.map((r) => ({
            id: `assignment:${r.id}`, type, occurredAt: r.createdAt, actor: r.actor,
            details: { from: r.fromUser, to: r.toUser, assignmentType: r.assignmentType, reason: r.reason },
          })),
        };
      }
    }
  }
}

export function compareActivity(a: ActivityItem, b: ActivityItem): number {
  const d = b.occurredAt.getTime() - a.occurredAt.getTime();
  if (d !== 0) return d;
  return a.id < b.id ? 1 : a.id > b.id ? -1 : 0;
}
