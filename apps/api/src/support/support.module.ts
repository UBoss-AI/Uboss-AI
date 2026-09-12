import { Global, Module } from '@nestjs/common';

import { HealthModule } from '../health/health.module.js';
import { PlatformModule } from '../platform/platform.module.js';
import {
  PlatformSupportController,
  ServiceStatusController,
  SupportController,
} from './support.controller.js';
import { SupportTicketService } from './support-ticket.service.js';
import { SystemHealthService } from './system-health.service.js';

/**
 * Support & Operations and System Health — Prompt 36.
 *
 * ## What this module does not contain
 *
 * **No support-session service.** Break-glass is the support session, and it has been since
 * Prompt 8: a written reason, identity verification, approval by a second person, an explicit
 * module/action scope, a hard expiry, revocation, usage counting and customer notification. This
 * prompt added the one thing it lacked — the company's own authorization — to that service rather
 * than building a parallel one (ADR-205).
 *
 * **No incident table.** `service_alerts` already answers "what is wrong with UBoss right now" and
 * is already counted on the Master Console dashboard, so a declared incident is an alert with a
 * severity, an owner and customer wording (ADR-203). Two tables would have let the dashboard count
 * and the System Health list disagree.
 *
 * **No monitoring probes of its own.** `SystemHealthService` composes: the health endpoint for the
 * API and database, `RunQueue.health()` for the queue, the provider adapters for reachability, and
 * the connections table for tool health. Re-probing any of them here would be a second answer to a
 * question the product already answers.
 *
 * `@Global` because the Master Console dashboard and the company Settings screen both read from
 * it, and importing it in two places is how a second copy eventually appears.
 */
@Global()
@Module({
  // PlatformModule is deliberately not @Global, so the incident lifecycle it owns is imported
  // rather than assumed.
  imports: [HealthModule, PlatformModule],
  controllers: [SupportController, PlatformSupportController, ServiceStatusController],
  providers: [SupportTicketService, SystemHealthService],
  exports: [SupportTicketService, SystemHealthService],
})
export class SupportModule {}
