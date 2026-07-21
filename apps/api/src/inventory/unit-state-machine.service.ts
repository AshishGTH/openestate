import {
  BadRequestException,
  Inject,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { withTenantTx, runWithTenant } from '@openestate/db';
import { TENANT_PRISMA } from '../database/database.module';
import {
  isValidTransition,
  REASON_REQUIRED_STATUSES,
} from '@openestate/shared';
import type { UnitStatus, ActorType } from '@openestate/shared';

@Injectable()
export class UnitStateMachineService {
  constructor(
    @Inject(TENANT_PRISMA)
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    private readonly tenantPrisma: any,
  ) {}

  async transition(
    companyId: string,
    unitId: string,
    toStatus: UnitStatus,
    actorType: ActorType,
    actorId: string | null,
    reason: string | undefined,
  ) {
    if (REASON_REQUIRED_STATUSES.includes(toStatus) && !reason) {
      throw new BadRequestException(
        `Reason is mandatory when transitioning to ${toStatus}`,
      );
    }

    return runWithTenant({ companyId }, () =>
      withTenantTx(this.tenantPrisma, companyId, async (tx) => {
        const unit = await tx.unit.findFirst({ where: { id: unitId, companyId } });
        if (!unit) throw new NotFoundException('Unit not found');

        const fromStatus = unit.status as UnitStatus;

        if (!isValidTransition(fromStatus, toStatus)) {
          throw new BadRequestException(
            `Invalid transition from ${fromStatus} to ${toStatus}`,
          );
        }

        await tx.unit.update({
          where: { id: unitId },
          data: { status: toStatus },
        });

        await tx.unitStatusChange.create({
          data: {
            companyId,
            unitId,
            fromStatus,
            toStatus,
            reason: reason ?? null,
            actorType,
            actorId,
          },
        });

        return { unitId, fromStatus, toStatus };
      }),
    );
  }
}
