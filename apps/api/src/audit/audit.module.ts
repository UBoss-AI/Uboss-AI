import { Global, Module } from '@nestjs/common';

import { SettingsModule } from '../settings/settings.module.js';

import { AuditChainService } from './audit-chain.service.js';
import { AuditController, PlatformSecurityController } from './audit.controller.js';
import { AuditEventService } from './audit-event.service.js';
import { AuditQueryService } from './audit-query.service.js';
import { BreakGlassController } from './break-glass.controller.js';
import { BreakGlassService } from './break-glass.service.js';
import { SecurityCenterController } from './security-center.controller.js';
import { SecurityCenterService } from './security-center.service.js';
import { SecurityEventService } from './security-event.service.js';

/**
 * Audit and security foundations.
 *
 * `@Global`, and for the same reason as `AuthorizationModule`: every feature module from here on
 * writes audit events, and threading `AuditEventService` through imports would mean every module
 * declaring a dependency on auditing — which is true of all of them, so stating it adds nothing.
 *
 * ## Load order matters
 *
 * `AuthModule` imports `SecurityEventService` (via `SecurityEventPublisher`), so this module must
 * be registered **before** `AuthModule` in `AppModule`. Nest resolves providers lazily enough
 * that it would usually work either way, but a `@Global` module that another module depends on at
 * construction time is a well-known way to get an undefined injection that only shows up at
 * runtime, and ordering it correctly costs nothing.
 */
@Global()
@Module({
  // Declared rather than relying on @Global registration order: BreakGlassService reads the
  // company support-access policy through CompanySettingsService, and this module loads first.
  imports: [SettingsModule],
  controllers: [
    AuditController,
    PlatformSecurityController,
    BreakGlassController,
    SecurityCenterController,
  ],
  providers: [
    AuditEventService,
    SecurityEventService,
    AuditQueryService,
    AuditChainService,
    BreakGlassService,
    SecurityCenterService,
  ],
  exports: [
    AuditEventService,
    SecurityEventService,
    AuditQueryService,
    AuditChainService,
    BreakGlassService,
    SecurityCenterService,
  ],
})
export class AuditModule {}
