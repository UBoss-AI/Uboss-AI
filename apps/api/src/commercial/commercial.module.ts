import { Global, Module } from '@nestjs/common';

import {
  CompanyCommercialController,
  PlatformCommercialController,
} from './commercial.controller.js';
import { BudgetAlertService } from './budget-alert.service.js';
import { CommercialService } from './commercial.service.js';
import { CompanyExitController } from './company-exit.controller.js';
import { CompanyExitService } from './company-exit.service.js';
import { CompanyLifecycleService } from './company-lifecycle.service.js';
import { SeatService } from './seat.service.js';

/**
 * The commercial plane: plans, entitlements, seats, allowance and company lifecycle.
 *
 * `@Global` for one specific reason: `SeatService.claimSeat` has to be callable from anything
 * that moves a membership into a counted state — invitations today, bulk import at Prompt 13 —
 * and threading it through imports would mean every one of those modules declaring a dependency
 * on the commercial plane. The seat ceiling is a cross-cutting invariant, so the service that
 * enforces it is available everywhere.
 *
 * What is deliberately **not** global is any notion of authorization. Nothing in this module
 * reads or writes a role, and `CommercialService` injects `AuthorizationService` only to check
 * whether a caller may *see* commercial data.
 */
@Global()
@Module({
  // Prompt 38. Company exit lives here rather than in its own module: it drives
  // CompanyLifecycleService, which this module already owns, and a separate module would have
  // been a second place that knows how a company moves between Active, ReadOnly and Closed.
  controllers: [CompanyCommercialController, PlatformCommercialController, CompanyExitController],
  providers: [
    SeatService,
    CommercialService,
    CompanyLifecycleService,
    CompanyExitService,
    BudgetAlertService,
  ],
  exports: [
    SeatService,
    CommercialService,
    CompanyLifecycleService,
    CompanyExitService,
    BudgetAlertService,
  ],
})
export class CommercialModule {}
