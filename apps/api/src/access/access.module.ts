import { Global, Module } from '@nestjs/common';

import { AccessRepository } from '../persistence/access.repository.js';
import { AccessController } from './access.controller.js';
import { CapabilityService } from './capability.service.js';
import { BulkOperationService } from './bulk-operation.service.js';
import { InvitationAccessService } from './invitation-access.service.js';
import { OffboardingService } from './offboarding.service.js';
import { KnowledgeModule } from '../knowledge/knowledge.module.js';
import { OrganizationModule } from '../organization/organization.module.js';
import { ReportsModule } from '../reports/reports.module.js';
import { UserAccessService } from './user-access.service.js';

/**
 * Users & Access: activation, account lifecycle, guests and bulk administration.
 *
 * ## Where this sits between the other modules
 *
 * It depends on three that came before and adds no new authority model of its own:
 *
 *   * **`AuthModule`** for the Prompt 5 invitation flow. This module does not reimplement
 *     invitations — it adds a userId-keyed entry point so inviting somebody already in the
 *     hierarchy cannot duplicate their identity.
 *   * **`CommercialModule`** for `SeatService`. Inviting is the path that actually consumes a
 *     seat, so this is where the Prompt 11 enforcement finally gets called.
 *   * **`OrganizationModule`** for employment records and departments. A guest has none of
 *     either, by definition and by database trigger.
 *
 * `ReportsModule` is imported for `ReportScopeService`, which decides which people a roster may
 * contain. The other three are `@Global`, so nothing else is imported here — and this module is `@Global` too,
 * because the bulk engine will be reached from the Settings shell at Prompt 14.
 */
@Global()
@Module({
  /*
   * KnowledgeModule and OrganizationModule are here for one feature: a photograph pasted into the
   * import spreadsheet -- PRD 3.1. `BulkOperationService` takes the file store and the photo
   * service as `@Optional()` so that tests need not provide a storage adapter and a malware
   * scanner, which means nothing fails at startup when they are absent. What fails instead is
   * every photograph in every import, silently. `global-guard-order.spec.ts` asserts these two
   * imports are here, so the optional marker cannot hide a real misconfiguration.
   */
  imports: [ReportsModule, KnowledgeModule, OrganizationModule],
  controllers: [AccessController],
  providers: [
    AccessRepository,
    CapabilityService,
    UserAccessService,
    InvitationAccessService,
    OffboardingService,
    BulkOperationService,
  ],
  exports: [
    AccessRepository,
    CapabilityService,
    UserAccessService,
    InvitationAccessService,
    OffboardingService,
    BulkOperationService,
  ],
})
export class AccessModule {}
