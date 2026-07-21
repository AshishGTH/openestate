import { Provider } from '@nestjs/common';
import { SYSTEM_CLOCK, type Clock } from '@openestate/shared';

export const CLOCK = 'CLOCK';

/** Real clock in production; tests override this provider with a frozen/injected clock. */
export const ClockProvider: Provider = {
  provide: CLOCK,
  useValue: SYSTEM_CLOCK satisfies Clock,
};
