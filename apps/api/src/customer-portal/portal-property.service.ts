import { Inject, Injectable } from '@nestjs/common';
import { withTenantTx } from '@openestate/db';
import { TENANT_PRISMA } from '../database/database.module';

/**
 * All reachability (which bookings/units/projects this session can see) is
 * RLS's job (units/floors/towers/projects_portal_scope, Phase 6) — this
 * service just asks tenant-scoped Prisma for "my bookings" and follows the
 * relations; there is no application-level ownership filter to duplicate.
 */
@Injectable()
export class PortalPropertyService {
  constructor(
    @Inject(TENANT_PRISMA)
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    private readonly tenantPrisma: any,
  ) {}

  async getMyProperties(companyId: string, applicantId: string) {
    return withTenantTx(this.tenantPrisma, companyId, async (tx) => {
      const bookings = await tx.booking.findMany({
        where: {
          OR: [{ primaryApplicantId: applicantId }, { coApplicants: { some: { applicantId } } }],
        },
        include: {
          unit: {
            include: {
              unitType: true,
              floor: { include: { tower: { include: { project: true } } } },
            },
          },
        },
        orderBy: { createdAt: 'desc' },
      });

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const properties = await Promise.all((bookings as any[]).map(async (b) => {
        const projectId = b.unit.floor.tower.project.id;
        const updates = await tx.constructionUpdate.findMany({
          where: { projectId },
          include: { media: { orderBy: { sortOrder: 'asc' } } },
          orderBy: { publishedAt: 'desc' },
        });
        return {
          bookingId: b.id,
          bookingNumber: b.bookingNumber,
          status: b.status,
          allotmentDate: b.allotmentDate,
          registrationDate: b.registrationDate,
          unit: {
            number: b.unit.number,
            typeName: b.unit.unitType?.name ?? null,
            carpetAreaSqft: b.unit.carpetAreaSqft,
          },
          tower: { name: b.unit.floor.tower.name },
          floor: { name: b.unit.floor.name },
          project: {
            id: projectId,
            name: b.unit.floor.tower.project.name,
            address: b.unit.floor.tower.project.address,
            expectedEndDate: b.unit.floor.tower.project.expectedEndDate,
          },
          constructionUpdates: updates,
        };
      }));

      return properties;
    });
  }
}
