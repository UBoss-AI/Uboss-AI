import { Global, Module } from '@nestjs/common';

import { PlatformAlertService } from './platform-alert.service.js';

/**
 * Raising a service alert, from anywhere.
 *
 * `@Global`, and for the same reason the audit and authorization modules are: the things worth
 * alerting on are spread across the product — mail that cannot be delivered, a provider that
 * cannot be reached, a sweep that keeps failing — and a module each of them had to remember to
 * import is one somebody eventually forgets. The failure mode there is silence, which is exactly
 * what this exists to end.
 *
 * Separate from `PlatformModule`, which is deliberately **not** global: reading a plan or
 * changing a feature flag is Master Console work and should stay behind its own door. Raising an
 * alert is not.
 */
@Global()
@Module({
  providers: [PlatformAlertService],
  exports: [PlatformAlertService],
})
export class PlatformAlertModule {}
