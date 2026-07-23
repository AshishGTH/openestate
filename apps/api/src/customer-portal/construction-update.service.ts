import { Inject, Injectable, NotFoundException } from '@nestjs/common';
import { withTenantTx, type PrismaClient } from '@openestate/db';
import { NOTIFICATION_EVENT, type CreateConstructionUpdateDto } from '@openestate/shared';
import { TENANT_PRISMA, SYSTEM_PRISMA } from '../database/database.module';
import { UploadService } from '../inventory/upload.service';
import { NotificationService } from '../notifications/notification.service';

@Injectable()
export class ConstructionUpdateService {
  constructor(
    @Inject(TENANT_PRISMA)
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    private readonly tenantPrisma: any,
    @Inject(SYSTEM_PRISMA)
    private readonly systemPrisma: PrismaClient,
    private readonly uploadService: UploadService,
    private readonly notifications: NotificationService,
  ) {}

  async create(companyId: string, createdById: string, dto: CreateConstructionUpdateDto) {
    const update = await withTenantTx(this.tenantPrisma, companyId, (tx) =>
      tx.constructionUpdate.create({
        data: {
          companyId,
          projectId: dto.projectId,
          title: dto.title,
          description: dto.description,
          publishedAt: dto.publishedAt,
          createdById,
        },
      }),
    );

    // Fired AFTER the transaction commits. Primary applicants only —
    // matches the sole notification-audience convention already used
    // everywhere else in this codebase (DocumentService's letters,
    // DispatchService); co-applicant expansion is new scope, not a
    // precedent, and stays out of this trigger.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const bookings: any[] = await this.systemPrisma.booking.findMany({
      where: { companyId, unit: { floor: { tower: { projectId: dto.projectId } } } },
      select: { primaryApplicantId: true },
    });
    const applicantIds = [...new Set(bookings.map((b) => b.primaryApplicantId as string))];
    for (const applicantId of applicantIds) {
      await this.notifications.notify(
        companyId,
        NOTIFICATION_EVENT.CONSTRUCTION_UPDATE_PUBLISHED,
        { applicantId },
        `New update: ${update.title}`,
        update.description ?? update.title,
      );
    }

    return update;
  }

  async addMedia(companyId: string, updateId: string, file: { buffer: Buffer; originalname: string; size: number }) {
    return withTenantTx(this.tenantPrisma, companyId, async (tx) => {
      const update = await tx.constructionUpdate.findFirst({ where: { id: updateId } });
      if (!update) throw new NotFoundException('Construction update not found');

      const uploaded = await this.uploadService.validateAndStore(file, 'construction_progress');
      const count = await tx.constructionUpdateMedia.count({ where: { constructionUpdateId: updateId } });

      return tx.constructionUpdateMedia.create({
        data: {
          companyId,
          constructionUpdateId: updateId,
          storedName: uploaded.storageName,
          originalName: uploaded.originalName,
          mimeType: uploaded.mimeType,
          sizeBytes: uploaded.size,
          sortOrder: count,
        },
      });
    });
  }

  async listForProject(companyId: string, projectId: string) {
    return withTenantTx(this.tenantPrisma, companyId, (tx) =>
      tx.constructionUpdate.findMany({
        where: { projectId },
        include: { media: { orderBy: { sortOrder: 'asc' } } },
        orderBy: { publishedAt: 'desc' },
      }),
    );
  }
}
