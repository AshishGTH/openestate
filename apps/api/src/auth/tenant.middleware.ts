import { Injectable, NestMiddleware } from '@nestjs/common';
import { Request, Response, NextFunction } from 'express';
import { runWithTenant } from '@openestate/db';
import type { JwtPayload } from '@openestate/shared';

@Injectable()
export class TenantMiddleware implements NestMiddleware {
  use(req: Request, _res: Response, next: NextFunction) {
    const user = (req as Request & { user?: JwtPayload }).user;
    if (user?.companyId) {
      runWithTenant(
        {
          companyId: user.companyId,
          userId: user.sub,
          ipAddress: req.ip ?? req.socket.remoteAddress,
        },
        () => next(),
      );
    } else {
      next();
    }
  }
}
