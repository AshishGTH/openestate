import { Inject, Injectable, NotFoundException } from '@nestjs/common';
import { PrismaClient, withTenantTx } from '@openestate/db';
import { NOTIFICATION_EVENT, TICKET_STATUS, type CreateTicketDto, type TicketStatusValue } from '@openestate/shared';
import { TENANT_PRISMA, SYSTEM_PRISMA } from '../database/database.module';
import { NotificationService } from '../notifications/notification.service';

interface PortalScope {
  applicantId?: string;
  brokerId?: string;
}

/**
 * tickets_portal_scope RLS (Phase 6) plus tenantExtension's PORTAL_SCOPED_MODELS
 * JS-level guard (Ticket is a direct-column model) both restrict every read
 * here to the caller's own tickets — this service adds no separate
 * ownership filter of its own for reads, only for writes that need an
 * explicit actor identity (create/addMessage).
 */
@Injectable()
export class TicketService {
  constructor(
    @Inject(TENANT_PRISMA)
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    private readonly tenantPrisma: any,
    @Inject(SYSTEM_PRISMA)
    private readonly systemPrisma: PrismaClient,
    private readonly notifications: NotificationService,
  ) {}

  /** Category picklist for the portal's "raise a query" form — TicketCategory is
   * a plain master (staff-managed via the masters factory), not portal-scoped. */
  async listCategories(companyId: string) {
    return this.systemPrisma.ticketCategory.findMany({
      where: { companyId, isActive: true },
      orderBy: { sortOrder: 'asc' },
      select: { id: true, name: true },
    });
  }

  async create(companyId: string, raisedById: string, scope: PortalScope, dto: CreateTicketDto) {
    return withTenantTx(this.tenantPrisma, companyId, async (tx) => {
      const ticket = await tx.ticket.create({
        data: {
          companyId,
          raisedById,
          applicantId: scope.applicantId,
          brokerId: scope.brokerId,
          categoryId: dto.categoryId,
          subject: dto.subject,
          status: TICKET_STATUS.OPEN,
        },
      });
      await tx.ticketMessage.create({
        data: { companyId, ticketId: ticket.id, authorId: raisedById, authorIsStaff: false, body: dto.body },
      });
      return ticket;
    });
  }

  async listMine(companyId: string) {
    return withTenantTx(this.tenantPrisma, companyId, (tx) =>
      tx.ticket.findMany({ orderBy: { createdAt: 'desc' } }),
    );
  }

  /** Shared by both the portal and staff controllers — same reasoning as listQueue for why the raiser/category names need resolving here too. */
  async getOne(companyId: string, ticketId: string) {
    const ticket = await withTenantTx(this.tenantPrisma, companyId, async (tx) => {
      const t = await tx.ticket.findFirst({
        where: { id: ticketId },
        include: { messages: { orderBy: { createdAt: 'asc' } } },
      });
      if (!t) throw new NotFoundException('Ticket not found');
      return t;
    });

    const [applicant, broker, category] = await Promise.all([
      ticket.applicantId
        ? this.systemPrisma.applicant.findUnique({ where: { id: ticket.applicantId }, select: { name: true } })
        : null,
      ticket.brokerId
        ? this.systemPrisma.broker.findUnique({ where: { id: ticket.brokerId }, select: { name: true } })
        : null,
      this.systemPrisma.ticketCategory.findUnique({ where: { id: ticket.categoryId }, select: { name: true } }),
    ]);

    return {
      ...ticket,
      raisedByName: applicant?.name ?? broker?.name ?? null,
      categoryName: category?.name ?? null,
    };
  }

  async addMessage(companyId: string, ticketId: string, authorId: string, authorIsStaff: boolean, body: string) {
    const { message, ticket } = await withTenantTx(this.tenantPrisma, companyId, async (tx) => {
      const t = await tx.ticket.findFirst({ where: { id: ticketId } });
      if (!t) throw new NotFoundException('Ticket not found');
      const m = await tx.ticketMessage.create({ data: { companyId, ticketId, authorId, authorIsStaff, body } });
      return { message: m, ticket: t };
    });

    // Only a STAFF reply notifies the portal user — the portal-side
    // addMessage() call (authorIsStaff=false) is the customer/broker's
    // own message, nothing to notify them about. Fired after the tx
    // commits (CLAUDE.md Phase 1 rule).
    if (authorIsStaff) {
      const recipient = ticket.applicantId
        ? { applicantId: ticket.applicantId as string }
        : ticket.brokerId
          ? { brokerId: ticket.brokerId as string }
          : null;
      if (recipient) {
        await this.notifications.notify(
          companyId,
          NOTIFICATION_EVENT.QUERY_REPLIED,
          recipient,
          `Reply to: ${ticket.subject}`,
          body,
        );
      }
    }

    return message;
  }

  /**
   * Staff queue — system client, unscoped within the company. Oldest
   * first: a triaging staff member works the queue in raised order, not
   * newest-first (which would bury a ticket that's been waiting longest).
   *
   * Ticket has no Prisma relation to Applicant/Broker/TicketCategory
   * (scalar-FK convention — see CLAUDE.md's Phase 4 "Relation policy"
   * decision), so the raiser's name and category name are resolved via
   * follow-up batch queries, the same idiom NocService.listForBroker
   * already uses for booking numbers — not per-row N+1 lookups.
   */
  async listQueue(companyId: string, status?: TicketStatusValue) {
    const tickets = await this.systemPrisma.ticket.findMany({
      where: { companyId, ...(status ? { status } : {}) },
      orderBy: { createdAt: 'asc' },
    });
    if (tickets.length === 0) return [];

    const applicantIds = [...new Set(tickets.map((t) => t.applicantId).filter((id): id is string => !!id))];
    const brokerIds = [...new Set(tickets.map((t) => t.brokerId).filter((id): id is string => !!id))];
    const categoryIds = [...new Set(tickets.map((t) => t.categoryId))];
    const ticketIds = tickets.map((t) => t.id);

    const [applicants, brokers, categories, messageStats] = await Promise.all([
      applicantIds.length
        ? this.systemPrisma.applicant.findMany({ where: { id: { in: applicantIds } }, select: { id: true, name: true } })
        : [],
      brokerIds.length
        ? this.systemPrisma.broker.findMany({ where: { id: { in: brokerIds } }, select: { id: true, name: true } })
        : [],
      this.systemPrisma.ticketCategory.findMany({ where: { id: { in: categoryIds } }, select: { id: true, name: true } }),
      this.systemPrisma.ticketMessage.groupBy({
        by: ['ticketId'],
        where: { ticketId: { in: ticketIds } },
        _count: { _all: true },
        _max: { createdAt: true },
      }),
    ]);

    const applicantNameById = new Map(applicants.map((a) => [a.id, a.name]));
    const brokerNameById = new Map(brokers.map((b) => [b.id, b.name]));
    const categoryNameById = new Map(categories.map((c) => [c.id, c.name]));
    const statsByTicketId = new Map(messageStats.map((m) => [m.ticketId, m]));

    return tickets.map((t) => ({
      ...t,
      // A ticket is only ever raised by a portal user (applicantId or
      // brokerId, never neither — PortalTicketController.create is the
      // only creator); the User.name fallback is defensive, not a real
      // path in this codebase today.
      raisedByName:
        (t.applicantId ? applicantNameById.get(t.applicantId) : undefined) ??
        (t.brokerId ? brokerNameById.get(t.brokerId) : undefined) ??
        null,
      categoryName: categoryNameById.get(t.categoryId) ?? null,
      messageCount: statsByTicketId.get(t.id)?._count._all ?? 0,
      lastMessageAt: statsByTicketId.get(t.id)?._max.createdAt ?? null,
    }));
  }

  async updateStatus(companyId: string, ticketId: string, status: TicketStatusValue) {
    return withTenantTx(this.tenantPrisma, companyId, async (tx) => {
      const ticket = await tx.ticket.findFirst({ where: { id: ticketId } });
      if (!ticket) throw new NotFoundException('Ticket not found');
      return tx.ticket.update({
        where: { id: ticketId },
        data: { status, closedAt: status === TICKET_STATUS.CLOSED ? new Date() : ticket.closedAt },
      });
    });
  }
}
