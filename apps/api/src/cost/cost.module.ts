import { Global, Module } from '@nestjs/common';

import { CostController } from './cost.controller.js';
import { CostEngineService } from './cost-engine.service.js';
import { CreditController } from './credit.controller.js';
import { CreditPlatformController } from './credit-platform.controller.js';
import { CreditService } from './credit.service.js';

/**
 * The Token/Cost Engine — Prompt 30.
 *
 * `@Global` because cost governance has to apply to **every** AI call, and a module each caller
 * had to remember to import is one somebody eventually forgets — producing a code path that
 * spends money without reserving it. In practice there is exactly one caller: the Model Gateway,
 * which is itself the single seam every AI call passes through. The two rules reinforce each
 * other, and that is the whole reason the reserve/settle flow lives in the gateway rather than in
 * five services.
 */
@Global()
@Module({
  // Prompt 31 splits the credit flow across two planes deliberately: the company asks, Finance
  // decides. A company approving its own credit request would be setting its own commercial
  // terms, which is what the review exists to prevent.
  controllers: [CostController, CreditController, CreditPlatformController],
  providers: [CostEngineService, CreditService],
  exports: [CostEngineService, CreditService],
})
export class CostModule {}
