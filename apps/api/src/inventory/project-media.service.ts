import { Inject, Injectable, NotFoundException } from '@nestjs/common';
import * as fs from 'node:fs';
import { PrismaClient, withTenantTx } from '@openestate/db';
import type { ProjectMediaCategory, UploadCategory } from '@openestate/shared';
import { TENANT_PRISMA, SYSTEM_PRISMA } from '../database/database.module';
import { UploadService } from './upload.service';
import { assertProjectMediaCapacity } from './project-media-limits';

@Injectable()
export class ProjectMediaService {
  constructor(
    @Inject(TENANT_PRISMA)
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    private readonly tenantPrisma: any,
    @Inject(SYSTEM_PRISMA)
    private readonly systemPrisma: PrismaClient,
    private readonly uploadService: UploadService,
  ) {}

  async upload(
    companyId: string,
    projectId: string,
    category: ProjectMediaCategory,
    file: { buffer: Buffer; originalname: string; size: number },
  ) {
    return withTenantTx(this.tenantPrisma, companyId, async (tx) => {
      const project = await tx.project.findFirst({ where: { id: projectId } });
      if (!project) throw new NotFoundException('Project not found');

      await assertProjectMediaCapacity(tx, companyId, projectId, file.size);

      const uploaded = await this.uploadService.validateAndStore(file, category);
      const count = await tx.projectMedia.count({ where: { projectId } });

      return tx.projectMedia.create({
        data: {
          companyId,
          projectId,
          category,
          storedName: uploaded.storageName,
          originalName: uploaded.originalName,
          mimeType: uploaded.mimeType,
          sizeBytes: uploaded.size,
          sortOrder: count,
        },
      });
    });
  }

  async list(companyId: string, projectId: string) {
    return this.systemPrisma.projectMedia.findMany({
      where: { companyId, projectId },
      orderBy: [{ category: 'asc' }, { sortOrder: 'asc' }],
    });
  }

  async remove(companyId: string, projectId: string, mediaId: string) {
    return withTenantTx(this.tenantPrisma, companyId, async (tx) => {
      const media = await tx.projectMedia.findFirst({ where: { id: mediaId, projectId } });
      if (!media) throw new NotFoundException('Media not found');
      await tx.projectMedia.delete({ where: { id: mediaId } });
      return { id: mediaId };
    });
  }

  /** Staff download — direct company-scoped lookup (staff, not portal — no RLS concern, same shape as DocumentService.getDocumentBytes). */
  async getBytes(companyId: string, mediaId: string): Promise<{ buffer: Buffer; mimeType: string; originalName: string }> {
    const media = await this.systemPrisma.projectMedia.findFirst({ where: { id: mediaId, companyId } });
    if (!media) throw new NotFoundException('Media not found');
    const filePath = this.uploadService.pathFor(media.category as UploadCategory, media.storedName);
    const buffer = await fs.promises.readFile(filePath);
    return { buffer, mimeType: media.mimeType, originalName: media.originalName };
  }
}
