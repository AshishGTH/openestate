import { Inject, Injectable, NotFoundException } from '@nestjs/common';
import { PrismaClient, withTenantTx } from '@openestate/db';
import { TICKET_STATUS, type CreateTicketDto, type TicketStatusValue } from '@openestate/shared';
import { TENANT_PRISMA, SYSTEM_PRISMA } from '../database/database.module';

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

  async getOne(companyId: string, ticketId: string) {
    return withTenantTx(this.tenantPrisma, companyId, async (tx) => {
      const ticket = await tx.ticket.findFirst({
        where: { id: ticketId },
        include: { messages: { orderBy: { createdAt: 'asc' } } },
      });
      if (!ticket) throw new NotFoundException('Ticket not found');
      return ticket;
    });
  }

  async addMessage(companyId: string, ticketId: string, authorId: string, authorIsStaff: boolean, body: string) {
    return withTenantTx(this.tenantPrisma, companyId, async (tx) => {
      const ticket = await tx.ticket.findFirst({ where: { id: ticketId } });
      if (!ticket) throw new NotFoundException('Ticket not found');
      return tx.ticketMessage.create({ data: { companyId, ticketId, authorId, authorIsStaff, body } });
    });
  }

  /** Staff queue — system client, unscoped within the company. */
  async listQueue(companyId: string, status?: TicketStatusValue) {
    return this.systemPrisma.ticket.findMany({
      where: { companyId, ...(status ? { status } : {}) },
      orderBy: { createdAt: 'asc' },
    });
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
