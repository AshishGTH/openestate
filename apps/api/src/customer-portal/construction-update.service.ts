import { Inject, Injectable, NotFoundException } from '@nestjs/common';
import { withTenantTx } from '@openestate/db';
import type { CreateConstructionUpdateDto } from '@openestate/shared';
import { TENANT_PRISMA } from '../database/database.module';
import { UploadService } from '../inventory/upload.service';

@Injectable()
export class ConstructionUpdateService {
  constructor(
    @Inject(TENANT_PRISMA)
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    private readonly tenantPrisma: any,
    private readonly uploadService: UploadService,
  ) {}

  async create(companyId: string, createdById: string, dto: CreateConstructionUpdateDto) {
    return withTenantTx(this.tenantPrisma, companyId, (tx) =>
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
