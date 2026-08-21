import { Inject, Injectable, NotFoundException } from '@nestjs/common';
import * as fs from 'node:fs';
import { withTenantTx } from '@openestate/db';
import type { UploadCategory } from '@openestate/shared';
import { TENANT_PRISMA } from '../database/database.module';
import { UploadService } from '../inventory/upload.service';

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
    private readonly uploadService: UploadService,
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
              project: true,
              // Nullable for a LAND_BASED unit — every read below must
              // check b.unit.floor before touching .tower, not assume it.
              floor: { include: { tower: true } },
              // Nullable — a LAND_BASED unit may have no group at all
              // (§9: "InventoryGroup list, or 'all units' if the project
              // uses no groups"). null renders as bare "Plot {number}".
              inventoryGroup: { select: { name: true } },
            },
          },
        },
        orderBy: { createdAt: 'desc' },
      });

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const properties = await Promise.all((bookings as any[]).map(async (b) => {
        // Unit.projectId (direct scalar, Phase A) — always set, for both
        // shapes. Reading it off b.unit.floor.tower.project.id here would
        // throw for a LAND_BASED unit (floor is null): that was the bug.
        const projectId = b.unit.projectId;
        const [updates, projectMedia] = await Promise.all([
          tx.constructionUpdate.findMany({
            where: { projectId },
            include: { media: { orderBy: { sortOrder: 'asc' } } },
            orderBy: { publishedAt: 'desc' },
          }),
          tx.projectMedia.findMany({
            where: { projectId },
            orderBy: [{ category: 'asc' }, { sortOrder: 'asc' }],
          }),
        ]);
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
            // LAND_BASED only — null on HIGH_RISE. Both the client's own
            // entered (value, unit) pair AND the derived canonical sqft —
            // Property.tsx displays land area in the PROJECT's default
            // unit (Phase D §14), which needs landAreaSqft to convert
            // from; landAreaEntered/landAreaEnteredUnit stay available
            // too, for the (rare) case a project has no default unit set.
            landAreaEntered: b.unit.landAreaEntered,
            landAreaEnteredUnit: b.unit.landAreaEnteredUnit,
            landAreaSqft: b.unit.landAreaSqft,
          },
          // null for a LAND_BASED booking — no tower/floor exists.
          tower: b.unit.floor ? { name: b.unit.floor.tower.name } : null,
          floor: b.unit.floor ? { name: b.unit.floor.name } : null,
          // LAND_BASED only, and only when the plot is grouped — null
          // otherwise (§9: ungrouped LAND_BASED projects are valid).
          inventoryGroup: b.unit.inventoryGroup ? { name: b.unit.inventoryGroup.name } : null,
          project: {
            id: projectId,
            name: b.unit.project.name,
            address: b.unit.project.address,
            expectedEndDate: b.unit.project.expectedEndDate,
            // LAND_BASED only — null on HIGH_RISE and on any LAND_BASED
            // project that never set one. Drives which unit the portal
            // displays land area in.
            landAreaDefaultUnit: b.unit.project.landAreaDefaultUnit,
          },
          constructionUpdates: updates,
          projectMedia,
        };
      }));

      return properties;
    });
  }

  /**
   * Portal counterpart to ProjectMediaService.getBytes() — RLS
   * (project_media_portal_scope) is the sole enforcement, same
   * discipline as DocumentService.getDocumentBytesForPortal.
   */
  async getProjectMediaBytesForPortal(
    companyId: string,
    mediaId: string,
  ): Promise<{ buffer: Buffer; mimeType: string; originalName: string }> {
    const media = await withTenantTx(this.tenantPrisma, companyId, (tx) =>
      tx.projectMedia.findFirst({ where: { id: mediaId } }),
    );
    if (!media) throw new NotFoundException('Media not found');
    const filePath = this.uploadService.pathFor(media.category as UploadCategory, media.storedName);
    const buffer = await fs.promises.readFile(filePath);
    return { buffer, mimeType: media.mimeType, originalName: media.originalName };
  }
}
