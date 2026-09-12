import { Module } from '@nestjs/common';

import { PayoutAdapter, UnconfiguredPayoutAdapter } from './payout-adapter.js';
import {
  ObjectiveRewardAwardController,
  SubjectRewardAwardController,
} from './reward.controller.js';
import { RewardService } from './reward.service.js';

/**
 * Reward rules and awards.
 *
 * ## `UnconfiguredPayoutAdapter` is the default on purpose
 *
 * No payroll or payment provider has been approved or integrated, so the adapter that ships
 * refuses to settle and reports `canSettle: false`. Wiring a mock as the default would mean every
 * deployment could "pay" somebody, and somebody would eventually read `Settled` in a report and
 * believe it. Swapping in a real provider is one line here plus one adapter class; nothing else
 * in the lifecycle changes.
 *
 * ## Not `@Global`
 *
 * Unlike `ObjectivesModule` and `SkillsModule`, nothing else in the product needs to ask about a
 * reward. Rewards depend on objectives and performance, not the other way round, and making this
 * global would invite a later prompt to reach into the reward lifecycle from somewhere that has no
 * business doing so.
 */
@Module({
  controllers: [ObjectiveRewardAwardController, SubjectRewardAwardController],
  providers: [RewardService, { provide: PayoutAdapter, useClass: UnconfiguredPayoutAdapter }],
  exports: [RewardService],
})
export class RewardsModule {}
