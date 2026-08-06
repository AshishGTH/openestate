import { BadRequestException } from '@nestjs/common';

const DEFAULT_MAX_FILES = 50;
const DEFAULT_MAX_BYTES = 500 * 1024 * 1024;

/**
 * Shared cap for BOTH ProjectMedia (layout plan/brochure/photo) and
 * ConstructionUpdateMedia (construction gallery) — both roll up disk
 * usage under the same project, and an unbounded self-hosted install
 * fills its disk the same way regardless of which table the row lands
 * in. Configurable via CompanyConfig (Company Config screen), defaults
 * chosen to comfortably fit a real project's documents without inviting
 * abuse. Must run inside the caller's own withTenantTx (reads via `tx`).
 */
export async function assertProjectMediaCapacity(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  tx: any,
  companyId: string,
  projectId: string,
  incomingBytes: number,
): Promise<void> {
  const config = await tx.companyConfig.findUnique({ where: { companyId } });
  const maxFiles = config?.projectMediaMaxFiles ?? DEFAULT_MAX_FILES;
  const maxBytes = config?.projectMediaMaxBytes ?? DEFAULT_MAX_BYTES;

  const [projectMedia, constructionMedia] = await Promise.all([
    tx.projectMedia.aggregate({ where: { projectId }, _count: { _all: true }, _sum: { sizeBytes: true } }),
    tx.constructionUpdateMedia.aggregate({
      where: { update: { projectId } },
      _count: { _all: true },
      _sum: { sizeBytes: true },
    }),
  ]);

  const currentFiles = projectMedia._count._all + constructionMedia._count._all;
  const currentBytes = (projectMedia._sum.sizeBytes ?? 0) + (constructionMedia._sum.sizeBytes ?? 0);

  if (currentFiles + 1 > maxFiles) {
    throw new BadRequestException(
      `This project has reached its file limit of ${maxFiles}. Delete unused files, or raise the limit in Company Config.`,
    );
  }
  if (currentBytes + incomingBytes > maxBytes) {
    throw new BadRequestException(
      `This project has reached its storage limit of ${Math.round(maxBytes / (1024 * 1024))}MB. Delete unused files, or raise the limit in Company Config.`,
    );
  }
}
