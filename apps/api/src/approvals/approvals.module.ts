import { Global, Module } from '@nestjs/common';

import { ApprovalController } from './approval.controller.js';
import { ApprovalService } from './approval.service.js';

/**
 * The Approval Engine.
 *
 * `@Global` because approvals are asked for from everywhere: the Executor Agent's
 * `RequestApproval`, an Engine Agent version activation that needs sign-off, a workflow gate, a
 * budget override. Every one of those calls `ApprovalService.raise` rather than writing its own
 * row, which is what keeps "one approval table" true in practice and not merely in the schema.
 */
@Global()
@Module({
  controllers: [ApprovalController],
  providers: [ApprovalService],
  exports: [ApprovalService],
})
export class ApprovalsModule {}
