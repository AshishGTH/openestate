import { Injectable, NestMiddleware } from '@nestjs/common';
import { Request, Response, NextFunction } from 'express';
import { runWithTenant } from '@openestate/db';
import type { JwtPayload } from '@openestate/shared';

/**
 * Portal counterpart to TenantMiddleware — populates portalApplicantId/
 * portalBrokerId from the portal JWT so withTenantTx's unconditional GUC
 * write (see CLAUDE.md Phase 6 decisions) carries the real scope instead
 * of the staff empty-string default. Applied only to portal routes
 * (app.module.ts), never to staff routes.
 */
@Injectable()
export class PortalTenantMiddleware implements NestMiddleware {
  use(req: Request, _res: Response, next: NextFunction) {
    const user = (req as Request & { user?: JwtPayload }).user;
    if (user?.companyId) {
      runWithTenant(
        {
          companyId: user.companyId,
          userId: user.sub,
          ipAddress: req.ip ?? req.socket.remoteAddress,
          portalApplicantId: user.applicantId,
          portalBrokerId: user.brokerId,
        },
        () => next(),
      );
    } else {
      next();
    }
  }
}
