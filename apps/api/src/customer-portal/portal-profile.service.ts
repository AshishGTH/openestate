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

/**
 * v0.2.3 SECURITY: `customFields` is withheld from every portal
 * response, for the caller AND their co-applicants.
 *
 * Custom fields are admin-defined and admin-populated — staff routinely
 * use them for internal notes ("negotiation margin", "credit risk",
 * "do not call before 11am"). Nothing in the definition model marks a
 * field as customer-safe, so the only defensible default is to withhold
 * all of them; per-field opt-in visibility is a deliberate future
 * feature, not something to approximate by guessing from a label.
 *
 * This is a real fix, not a precaution: `getProfile` returned the whole
 * applicant row with only PAN omitted, so any value staff had already
 * written was being served to the customer.
 *
 * Kept as a named constant used by every portal applicant read rather
 * than inline, so a new portal read can't quietly omit it — the same
 * discipline `panCiphertext`/`panKeyVersion` already get here.
 */
const PORTAL_APPLICANT_OMIT = {
  panCiphertext: true,
  panKeyVersion: true,
  customFields: true,
} as const;
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
        omit: PORTAL_APPLICANT_OMIT,
      });

      const bookings = await tx.booking.findMany({
        where: {
          OR: [{ primaryApplicantId: applicantId }, { coApplicants: { some: { applicantId } } }],
        },
        include: {
          primaryApplicant: { omit: PORTAL_APPLICANT_OMIT },
          coApplicants: { include: { applicant: { omit: PORTAL_APPLICANT_OMIT } } },
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
