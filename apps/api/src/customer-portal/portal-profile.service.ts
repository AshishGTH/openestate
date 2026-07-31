import { Inject, Injectable } from '@nestjs/common';
import { withTenantTx } from '@openestate/db';
import { TENANT_PRISMA } from '../database/database.module';

/**
 * Reads go through the tenant client under withTenantTx, relying on
 * applicants_portal_scope's co-applicant carve-out (Phase 6 RLS) rather
 * than any application-level "who's on this booking" logic — the
 * co-applicant-visibility requirement is RLS's job here, not this
 * service's.
 */
@Injectable()
export class PortalProfileService {
  constructor(
    @Inject(TENANT_PRISMA)
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    private readonly tenantPrisma: any,
  ) {}

  async getProfile(companyId: string, applicantId: string) {
    return withTenantTx(this.tenantPrisma, companyId, async (tx) => {
      const self = await tx.applicant.findFirstOrThrow({
        where: { id: applicantId },
        omit: { panCiphertext: true, panKeyVersion: true },
      });

      const bookings = await tx.booking.findMany({
        where: {
          OR: [{ primaryApplicantId: applicantId }, { coApplicants: { some: { applicantId } } }],
        },
        include: {
          primaryApplicant: { omit: { panCiphertext: true, panKeyVersion: true } },
          coApplicants: { include: { applicant: { omit: { panCiphertext: true, panKeyVersion: true } } } },
        },
      });

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const others = new Map<string, any>();
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      for (const b of bookings as any[]) {
        others.set(b.primaryApplicant.id, b.primaryApplicant);
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        for (const co of b.coApplicants as any[]) others.set(co.applicant.id, co.applicant);
      }
      others.delete(applicantId);

      return { self, coApplicants: [...others.values()] };
    });
  }
}
