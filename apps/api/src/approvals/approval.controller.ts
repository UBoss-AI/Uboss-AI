import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  ParseUUIDPipe,
  Post,
  Query,
  UnauthorizedException,
} from '@nestjs/common';

import {
  AGING_BUCKET_LABELS,
  AGING_BUCKET_TONES,
  AGING_BUCKETS,
  APPROVAL_DECISION_LABELS,
  APPROVAL_DECISIONS,
  APPROVAL_REQUEST_STATUS_LABELS,
  APPROVAL_REQUEST_STATUSES,
  APPROVAL_REQUEST_TYPE_LABELS,
  APPROVAL_REQUEST_TYPES,
  APPROVAL_TYPE_MODULE,
  decisionNeedsReason,
  decisionSettlesRequest,
  MAX_DELEGATION_DAYS,
  SOD_RULE_LABELS,
  SOD_RULES,
} from '@uboss/types';

import { RequirePermission } from '../authorization/authorization.decorators.js';
import { actorUserId } from '../request-context/authenticated-actor.js';
import { getActor } from '../request-context/request-context.js';
import { TenantScoped } from '../tenancy/tenancy.decorators.js';
import { TenantContextService } from '../tenancy/tenant-context.service.js';
import { CreateDelegationDto, DecideApprovalDto, ListApprovalsDto } from './approval.dto.js';
import { ApprovalService } from './approval.service.js';

/**
 * The Approvals queue — Prompt 28.
 *
 * ## One queue, not one per module
 *
 * There is no `/objectives/:id/approve`, no `/agents/:id/approve` and no per-module approval
 * route, and that is the client's constraint rather than a routing preference: every approval in
 * the product is a row in one table decided through `POST :approvalId/decide`. Which module's
 * `Approve` permission governs a given request comes from its type, published in `meta` so a
 * screen can show it.
 *
 * ## There is no route that approves without a person
 *
 * No endpoint expires a request, auto-approves on a deadline, or lets a caller act "as the
 * Executor Agent". Escalation is a sweep that writes `escalated_at` and notifies a manager;
 * `POST escalate` triggers it, and it cannot decide anything. An approval that happens because
 * nobody looked is not an approval, and the absence of that route is how the rule is kept.
 *
 * ## Permissions
 *
 * `approvals:View` to read the queue and open a request. The *decision* is authorized against the
 * governing module rather than against `approvals` — a workflow publish needs `objective:Approve`
 * — so the route-level guard here is deliberately the weaker check and the service does the real
 * one against the loaded row. `approvals:ManageAccess` to arrange cover for somebody else.
 */
@TenantScoped()
@Controller('tenants/:tenantId/approvals')
export class ApprovalController {
  constructor(
    private readonly approvals: ApprovalService,
    private readonly tenantContext: TenantContextService,
  ) {}

  /** The queue's vocabulary: types, statuses, decisions, aging buckets, SoD rules. */
  @Get('meta')
  @RequirePermission({ module: 'approvals', action: 'View' })
  meta(): unknown {
    return {
      types: APPROVAL_REQUEST_TYPES.map((type) => ({
        type,
        label: APPROVAL_REQUEST_TYPE_LABELS[type],
        // Which permission actually decides it. Published so a screen can explain why a person
        // who can see the queue still cannot decide one particular row.
        module: APPROVAL_TYPE_MODULE[type],
      })),
      statuses: APPROVAL_REQUEST_STATUSES.map((status) => ({
        status,
        label: APPROVAL_REQUEST_STATUS_LABELS[status],
      })),
      decisions: APPROVAL_DECISIONS.map((decision) => ({
        decision,
        label: APPROVAL_DECISION_LABELS[decision],
        settles: decisionSettlesRequest(decision),
        needsReason: decisionNeedsReason(decision),
      })),
      buckets: AGING_BUCKETS.map((bucket) => ({
        bucket,
        label: AGING_BUCKET_LABELS[bucket],
        tone: AGING_BUCKET_TONES[bucket],
      })),
      separationOfDuties: SOD_RULES.map((rule) => ({ rule, label: SOD_RULE_LABELS[rule] })),
      agingAfterHours: this.approvals.agingAfterHours,
      maxDelegationDays: MAX_DELEGATION_DAYS,
      note:
        'Approvals are one table across every module. Nothing approves on a timer: an overdue ' +
        'request escalates to a manager and keeps waiting for a person.',
    };
  }

  @Get()
  @RequirePermission({ module: 'approvals', action: 'View' })
  async list(@Query() query: ListApprovalsDto): Promise<unknown> {
    return this.approvals.list({
      scope: this.tenantContext.requireScope(),
      actorUserId: this.currentUserId(),
      ...(query.status === undefined ? {} : { status: query.status }),
      ...(query.type === undefined ? {} : { type: query.type }),
      ...(query.mineOnly === undefined ? {} : { mineOnly: query.mineOnly === 'true' }),
    });
  }

  @Get('delegations')
  @RequirePermission({ module: 'approvals', action: 'View' })
  async listDelegations(@Query('userId') userId?: string): Promise<unknown> {
    return this.approvals.listDelegations({
      scope: this.tenantContext.requireScope(),
      actorUserId: this.currentUserId(),
      ...(userId === undefined ? {} : { userId }),
    });
  }

  @Post('delegations')
  @RequirePermission({ module: 'approvals', action: 'View' })
  async delegate(@Body() body: CreateDelegationDto): Promise<unknown> {
    const actor = this.currentUserId();
    return this.approvals.delegate({
      scope: this.tenantContext.requireScope(),
      actorUserId: actor,
      fromUserId: body.fromUserId ?? actor,
      toUserId: body.toUserId,
      types: body.types,
      startsAt: new Date(body.startsAt),
      endsAt: new Date(body.endsAt),
      reason: body.reason,
    });
  }

  @Delete('delegations/:delegationId')
  @RequirePermission({ module: 'approvals', action: 'View' })
  async revokeDelegation(
    @Param('delegationId', ParseUUIDPipe) delegationId: string,
  ): Promise<unknown> {
    return this.approvals.revokeDelegation({
      scope: this.tenantContext.requireScope(),
      actorUserId: this.currentUserId(),
      delegationId,
    });
  }

  /**
   * Run the escalation sweep for this company.
   *
   * `Pause` rather than `Approve`, deliberately: triggering a sweep is an operational act that
   * moves nothing but attention. Gating it behind `Approve` would mean only people who can decide
   * approvals could ask the system to notice overdue ones, which is backwards.
   */
  @Post('escalate')
  @RequirePermission({ module: 'approvals', action: 'Pause' })
  async escalate(): Promise<unknown> {
    return this.approvals.escalateAged({ scope: this.tenantContext.requireScope() });
  }

  @Get(':approvalId')
  @RequirePermission({ module: 'approvals', action: 'View' })
  async view(@Param('approvalId', ParseUUIDPipe) approvalId: string): Promise<unknown> {
    return this.approvals.view({
      scope: this.tenantContext.requireScope(),
      actorUserId: this.currentUserId(),
      approvalId,
    });
  }

  /**
   * Approve, reject, send back or comment.
   *
   * One route for all four. The guard checks only that the caller may see the queue; the decision
   * itself is authorized inside the service against the governing module *and* the loaded row,
   * because separation of duties depends on who raised this particular request and who has
   * already acted on it — neither of which a route-level guard can know.
   */
  @Post(':approvalId/decide')
  @RequirePermission({ module: 'approvals', action: 'View' })
  async decide(
    @Param('approvalId', ParseUUIDPipe) approvalId: string,
    @Body() body: DecideApprovalDto,
  ): Promise<unknown> {
    return this.approvals.decide({
      scope: this.tenantContext.requireScope(),
      actorUserId: this.currentUserId(),
      approvalId,
      decision: body.decision,
      note: body.note,
    });
  }

  private currentUserId(): string {
    const userId = actorUserId(getActor());
    if (!userId) {
      throw new UnauthorizedException('This requires an identified user.');
    }
    return userId;
  }
}
