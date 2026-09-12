import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';

import {
  AGING_BUCKET_LABELS,
  AGING_BUCKET_TONES,
  agingBucketFor,
  APPROVAL_DECISION_LABELS,
  APPROVAL_DECISIONS,
  APPROVAL_REQUEST_TYPE_LABELS,
  APPROVAL_REQUEST_TYPES,
  APPROVAL_TYPE_MODULE,
  approvalEscalationDue,
  DECISION_RESULT,
  DEFAULT_APPROVAL_AGING_HOURS,
  decisionNeedsReason,
  decisionSettlesRequest,
  delegationCovers,
  isAddressedTo,
  requiredSodRule,
  routingFor,
  validateDelegation,
  type AgingBucket,
  type ApprovalDecision,
  type ApprovalRequestType,
  type ApprovalRouting,
  type ResourceDescriptor,
  type SodPolicy,
} from '@uboss/types';

import { AuditEventService } from '../audit/audit-event.service.js';
import {
  AuthorizationService,
  type AuthorizationContext,
} from '../authorization/authorization.service.js';
import { NotificationService } from '../notifications/notification.service.js';
import { OrganizationRepository } from '../persistence/organization.repository.js';
import { PrismaService } from '../persistence/prisma.service.js';
import {
  tenantScopeForPlatformOperation,
  type TenantScope,
} from '../persistence/tenant-context.js';

/** One thing somebody did to a request, as the drawer shows it. */
export interface ApprovalDecisionView {
  id: string;
  decision: ApprovalDecision;
  decisionLabel: string;
  actorUserId: string;
  onBehalfOfUserId: string | null;
  note: string;
  occurredAt: string;
}

/** One request in the queue. */
export interface ApprovalSummary {
  id: string;
  type: ApprovalRequestType;
  typeLabel: string;
  status: string;
  title: string;
  subjectType: string;
  subjectId: string | null;
  objectiveId: string | null;
  requestedByUserId: string;
  namedApproverUserId: string | null;
  approverRoleKind: string | null;
  /** Which module's `Approve` permission governs it. */
  module: string;
  submittedAt: string;
  dueAt: string | null;
  bucket: AgingBucket;
  bucketLabel: string;
  bucketTone: string;
  hoursOpen: number;
  escalatedAt: string | null;
  escalatedToUserId: string | null;
}

/** One request in full. */
export interface ApprovalView extends ApprovalSummary {
  detail: string;
  decidedByUserId: string | null;
  decidedOnBehalfOfUserId: string | null;
  decidedAt: string | null;
  decisionNote: string | null;
  supersedesId: string | null;
  supersededById: string | null;
  history: ApprovalDecisionView[];
  /**
   * What this actor may actually do, each with the reason when they may not.
   *
   * Computed here rather than left to the screen, so a disabled button and a refused request
   * always agree — and so the reason shown is the one the server would give.
   */
  available: { decision: ApprovalDecision; label: string; allowed: boolean; reason: string }[];
  /** Set when this actor is standing in for the named approver right now. */
  actingUnderDelegationFrom: string | null;
  version: number;
}

export interface DelegationView {
  id: string;
  fromUserId: string;
  toUserId: string;
  types: ApprovalRequestType[];
  startsAt: string;
  endsAt: string;
  reason: string;
  revokedAt: string | null;
  revokedByUserId: string | null;
  active: boolean;
}

/**
 * The Approval Engine.
 *
 * ## One engine, one table, every domain
 *
 * The client's constraint is explicit: approvals must work "without duplicating separate approval
 * tables per module". So there is one `approval_requests` table — created at Prompt 23 with all
 * eight `APPROVAL_REQUEST_TYPES` already in its vocabulary — one queue screen, and this one
 * service. Objective review, workflow publish, agent activation, high-risk actions, output
 * approval, budget override and guest access differ only in `type` and in which module's
 * `Approve` permission governs them, which is what `APPROVAL_TYPE_MODULE` records.
 *
 * ## What this service does not decide
 *
 * **Whether the actor may approve.** That is `AuthorizationService.authorize`, and it is not
 * re-litigated here. This service loads the row, works out what the row implies, and hands the
 * engine a `ResourceDescriptor`:
 *
 *   * `createdByUserId` — the requester, which is what makes the mandatory platform-wide
 *     `NoSelfApproval` control bite. That control was seeded at Prompt 7; nothing about it is
 *     restated in this file.
 *   * `priorActorUserIds` — everybody in the decision history, which is what makes a `FourEyes`
 *     control bite. Four eyes means two distinct people, and the engine already knows how to
 *     check that.
 *
 * A four-eyes gate declared by a workflow step travels as `additionalSodPolicies` rather than as
 * a second implementation of the rule.
 *
 * ## Nothing here ever decides on its own
 *
 * Escalation raises visibility and notifies a manager. It does not approve, reject, or expire
 * anything, and there is no code path that settles a request without a person's decision — an
 * approval that happens because nobody looked is not an approval. That is the same locked rule
 * the Executor Agent lives under, and it is the reason `escalateAged` writes only `escalated_at`.
 */
@Injectable()
export class ApprovalService {
  private readonly logger = new Logger(ApprovalService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly authorization: AuthorizationService,
    private readonly auditEvents: AuditEventService,
    private readonly notifications: NotificationService,
    private readonly organization: OrganizationRepository,
  ) {}

  // -------------------------------------------------------------------------
  // Raising a request
  // -------------------------------------------------------------------------

  /**
   * Raise an approval request.
   *
   * The entry point every other module uses — the Executor Agent's `RequestApproval`, an Engine
   * Agent version activation that needs sign-off, a budget override. It exists so those callers
   * do not each write their own row with their own conventions, which is how a single table still
   * ends up with per-module approval semantics.
   *
   * `actorUserId` may be null for the Executor Agent. An automated requester is fine — asking for
   * a decision is not making one — and it is exactly what the locked rule requires of the
   * Executor: escalate rather than proceed.
   */
  async raise(input: {
    scope: TenantScope;
    type: ApprovalRequestType;
    title: string;
    detail: string;
    subjectType: string;
    subjectId?: string | undefined;
    objectiveId?: string | undefined;
    objectiveVersionId?: string | undefined;
    workflowNodeId?: string | undefined;
    /** Null when the Executor Agent is asking. */
    requestedByUserId: string;
    namedApproverUserId?: string | undefined;
    approverRoleKind?: string | undefined;
    dueAt?: Date | undefined;
    supersedesId?: string | undefined;
    byExecutor?: boolean | undefined;
  }): Promise<ApprovalSummary> {
    if (!APPROVAL_REQUEST_TYPES.includes(input.type)) {
      throw new BadRequestException(`Unknown approval type: ${input.type}`);
    }

    if (input.title.trim() === '') {
      throw new BadRequestException(
        'An approval request needs a title. "Approve this" in a queue of forty is not a request.',
      );
    }

    const routing = routingFor({
      namedApproverUserId: input.namedApproverUserId ?? null,
      approverRoleKind: input.approverRoleKind ?? null,
    });

    if (routing.kind === 'Unaddressed') {
      throw new BadRequestException(
        'An approval request must name an approver, a role, or a four-eyes gate. A request ' +
          'addressed to nobody sits in the queue forever, which is worse than refusing to ' +
          'create it.',
      );
    }

    return this.prisma.runInTenantTransaction(input.scope, async () => {
      if (input.supersedesId !== undefined) {
        const previous = await this.prisma.client.approvalRequest.findFirst({
          where: { tenantId: input.scope.tenantId, id: input.supersedesId },
        });
        if (!previous) {
          throw new NotFoundException('The request this one replaces does not exist.');
        }
        if (previous.status !== 'SentBack') {
          throw new ConflictException(
            `Only a sent-back request can be resubmitted. That one is ${previous.status}.`,
          );
        }
      }

      const created = await this.prisma.client.approvalRequest.create({
        data: {
          tenantId: input.scope.tenantId,
          type: input.type,
          status: 'Pending',
          title: input.title,
          detail: input.detail,
          subjectType: input.subjectType,
          requestedByUserId: input.requestedByUserId,
          ...(input.subjectId === undefined ? {} : { subjectId: input.subjectId }),
          ...(input.objectiveId === undefined ? {} : { objectiveId: input.objectiveId }),
          ...(input.objectiveVersionId === undefined
            ? {}
            : { objectiveVersionId: input.objectiveVersionId }),
          ...(input.workflowNodeId === undefined ? {} : { workflowNodeId: input.workflowNodeId }),
          ...(input.namedApproverUserId === undefined
            ? {}
            : { namedApproverUserId: input.namedApproverUserId }),
          ...(input.approverRoleKind === undefined
            ? {}
            : { approverRoleKind: input.approverRoleKind }),
          ...(input.dueAt === undefined ? {} : { dueAt: input.dueAt }),
          ...(input.supersedesId === undefined ? {} : { supersedesId: input.supersedesId }),
        },
      });

      await this.auditEvents.appendWithinCurrentScope(input.scope.tenantId, {
        action: 'approvals.requested',
        resourceType: 'approval-request',
        resourceId: created.id,
        actorUserId: input.requestedByUserId,
        resourceRef: created.title,
        resourceVersion: created.version,
        summary:
          `Raised a ${APPROVAL_REQUEST_TYPE_LABELS[input.type]} request: ${input.title}` +
          (input.byExecutor === true ? ' (raised by the Executor Agent).' : '.'),
        metadata: {
          approvalType: input.type,
          module: APPROVAL_TYPE_MODULE[input.type],
          routing: routing.kind,
          byExecutor: input.byExecutor === true,
        },
      });

      await this.notifyApprover(input.scope, created);

      return this.toSummary(created, new Date());
    });
  }

  // -------------------------------------------------------------------------
  // Deciding
  // -------------------------------------------------------------------------

  /**
   * Approve, reject, send back, or comment.
   *
   * The order of the checks is the point:
   *
   *   1. **Is the request open, and addressed to this person?** Routing only — `isAddressedTo`
   *      has no opinion on permissions.
   *   2. **May this person exercise this action on this module, on this row?** The authorization
   *      engine, including scope and every separation-of-duties control.
   *   3. **Write the history row, then settle the request.** In that order and in one
   *      transaction, so a settled request without its decision row cannot exist.
   *
   * A comment takes a different path deliberately: it needs `Comment` rather than `Approve`, it
   * is not routed, and no separation-of-duties control applies to it. The requester commenting on
   * their own request is participating in the discussion, not approving their own work, and
   * refusing it would suppress exactly the questions that make an approval queue useful.
   */
  async decide(input: {
    scope: TenantScope;
    actorUserId: string;
    approvalId: string;
    decision: ApprovalDecision;
    note: string;
  }): Promise<ApprovalView> {
    if (!APPROVAL_DECISIONS.includes(input.decision)) {
      throw new BadRequestException(`Unknown decision: ${input.decision}`);
    }

    if (decisionNeedsReason(input.decision) && input.note.trim() === '') {
      throw new BadRequestException(
        `A ${APPROVAL_DECISION_LABELS[input.decision].toLowerCase()} has to say why. The person ` +
          'who submitted the work cannot act on "no".',
      );
    }

    const context = await this.authorization.contextFor(input.scope, input.actorUserId);

    // ---- Load ----
    const loaded = await this.prisma.runInTenantTransaction(input.scope, async () => {
      const request = await this.load(input.scope, input.approvalId);
      const history = await this.prisma.client.approvalDecisionRecord.findMany({
        where: { tenantId: input.scope.tenantId, approvalRequestId: request.id },
        orderBy: { occurredAt: 'asc' },
      });
      const delegation = await this.coveringDelegation(input.scope, {
        toUserId: input.actorUserId,
        fromUserId: request.namedApproverUserId,
        type: request.type as ApprovalRequestType,
      });
      const departmentId = await this.departmentOfRequester(input.scope, request.requestedByUserId);
      return { request, history, delegation, departmentId };
    });

    const { request, history, delegation, departmentId } = loaded;
    const type = request.type as ApprovalRequestType;
    const module = APPROVAL_TYPE_MODULE[type];

    if (module === undefined) {
      throw new BadRequestException(
        `Approval type ${request.type} has no governing module, so there is no permission that ` +
          'decides it. That is a data problem, not a decision this request can make.',
      );
    }

    // ---- Authorize, outside any transaction ----
    if (input.decision === 'Comment') {
      await this.authorization.assertCan(context, { module, action: 'Comment' });
    } else {
      const addressed = isAddressedTo({
        status: request.status,
        namedApproverUserId: request.namedApproverUserId,
        approverRoleKind: request.approverRoleKind,
        actorUserId: input.actorUserId,
        actorRoleKinds: context.roleSummary.map((r) => r.roleKind),
        delegatedFromUserId: delegation?.fromUserId ?? null,
      });

      if (!addressed.addressed) {
        throw request.status === 'Pending'
          ? new ForbiddenException(addressed.reason)
          : new ConflictException(addressed.reason);
      }

      const additional = this.sodPoliciesFor(request);
      await this.authorization.assertCan(context, {
        module,
        action: 'Approve',
        resource: this.resourceFor({
          row: request,
          departmentId,
          priorActorUserIds: this.priorDecidersOf(history),
        }),
        ...(additional.length === 0 ? {} : { additionalSodPolicies: additional }),
      });
    }

    // ---- Write ----
    await this.prisma.runInTenantTransaction(input.scope, async () => {
      if (input.decision === 'Comment') {
        await this.appendDecision(input.scope.tenantId, request.id, {
          decision: 'Comment',
          actorUserId: input.actorUserId,
          note: input.note,
        });
        await this.auditEvents.appendWithinCurrentScope(input.scope.tenantId, {
          action: 'approvals.commented',
          resourceType: 'approval-request',
          resourceId: request.id,
          actorUserId: input.actorUserId,
          resourceRef: request.title,
          summary: `Commented on "${request.title}".`,
          metadata: { approvalType: request.type },
        });
        return;
      }

      const settledStatus = DECISION_RESULT[input.decision];
      if (settledStatus === null) {
        // Unreachable: Comment returned above and every other decision settles. Refused rather
        // than assumed, so adding a fifth decision cannot silently produce a no-op.
        throw new BadRequestException(
          `${input.decision} does not settle a request and is not a comment.`,
        );
      }

      // Re-read inside the write transaction. The authorization above ran outside it, so this is
      // where a race would land — and it is the database trigger that makes it impossible rather
      // than this check, which only turns a raw trigger error into a readable conflict.
      const current = await this.load(input.scope, request.id);
      if (current.status !== 'Pending') {
        throw new ConflictException(
          `This request is already ${current.status}. Its decision record is immutable.`,
        );
      }

      await this.appendDecision(input.scope.tenantId, request.id, {
        decision: input.decision,
        actorUserId: input.actorUserId,
        note: input.note,
        ...(delegation === null
          ? {}
          : { onBehalfOfUserId: delegation.fromUserId, delegationId: delegation.id }),
      });

      const updated = await this.prisma.client.approvalRequest.update({
        where: { id: request.id },
        data: {
          status: settledStatus,
          decidedByUserId: input.actorUserId,
          decidedAt: new Date(),
          decisionNote: input.note,
          ...(delegation === null ? {} : { decidedOnBehalfOfUserId: delegation.fromUserId }),
          version: { increment: 1 },
        },
      });

      await this.auditEvents.appendWithinCurrentScope(input.scope.tenantId, {
        action: `approvals.${input.decision.toLowerCase()}`,
        resourceType: 'approval-request',
        resourceId: request.id,
        actorUserId: input.actorUserId,
        resourceRef: request.title,
        resourceVersion: updated.version,
        summary:
          `${APPROVAL_DECISION_LABELS[input.decision]} on "${request.title}"` +
          (delegation === null ? '' : ' as a delegate') +
          (input.note.trim() === '' ? '.' : `: ${input.note}`),
        metadata: {
          approvalType: request.type,
          module,
          decision: input.decision,
          fourEyesGate: this.sodPoliciesFor(request).length > 0,
          onBehalfOf: delegation?.fromUserId ?? '',
          priorDecisions: this.priorDecidersOf(history).length,
        },
      });

      await this.notifyRequester(input.scope, updated, input.decision, input.note);
    });

    return this.buildView(input.scope, request.id, input.actorUserId, context);
  }

  // -------------------------------------------------------------------------
  // The queue
  // -------------------------------------------------------------------------

  /**
   * The approval queue, aged.
   *
   * Scoped by the authorization engine's own listing width rather than by a hand-written rule:
   * `scopeForListing` answers how wide this actor's `Approve` grant reaches on the module, and an
   * `OwnWork` approver sees only requests they raised or were named on. Writing that filter by
   * hand here is how the second permission engine gets built.
   */
  async list(input: {
    scope: TenantScope;
    actorUserId: string;
    status?: string | undefined;
    type?: ApprovalRequestType | undefined;
    /** Only the ones this actor is the named approver for, or a delegate of. */
    mineOnly?: boolean | undefined;
  }): Promise<{ requests: ApprovalSummary[]; counts: Record<string, number> }> {
    const context = await this.authorization.contextFor(input.scope, input.actorUserId);
    await this.authorization.assertCan(context, { module: 'approvals', action: 'View' });

    const prepared = await this.prisma.runInTenantTransaction(input.scope, async () => {
      const delegations = await this.activeDelegationsTo(input.scope, input.actorUserId);
      const delegatedFrom = delegations.map((row) => row.fromUserId);

      const rows = await this.prisma.client.approvalRequest.findMany({
        where: {
          tenantId: input.scope.tenantId,
          ...(input.status === undefined ? {} : { status: input.status }),
          ...(input.type === undefined ? {} : { type: input.type }),
          ...(input.mineOnly === true
            ? {
                OR: [
                  { namedApproverUserId: input.actorUserId },
                  ...(delegatedFrom.length === 0
                    ? []
                    : [{ namedApproverUserId: { in: delegatedFrom } }]),
                ],
              }
            : {}),
        },
        orderBy: [{ status: 'asc' }, { dueAt: 'asc' }, { createdAt: 'asc' }],
        take: 300,
      });

      const now = new Date();

      // One employment read per distinct requester rather than one per row: the queue can hold
      // three hundred requests and most of them come from a handful of people.
      const departments = new Map<string, string | null>();
      for (const requesterId of new Set(rows.map((row) => row.requestedByUserId))) {
        departments.set(requesterId, await this.departmentOfRequester(input.scope, requesterId));
      }

      const candidates = rows.map((row) => ({
        row,
        module: APPROVAL_TYPE_MODULE[row.type as ApprovalRequestType],
        resource: this.resourceFor({
          row,
          departmentId: departments.get(row.requestedByUserId) ?? null,
          priorActorUserIds: [],
        }),
      }));

      return { candidates, delegatedFrom, now };
    });

    const visible: ApprovalSummary[] = [];
    for (const candidate of prepared.candidates) {
      if (candidate.module === undefined) continue;

      // The row-level check, so the queue never lists something this actor could not open.
      // Outside the transaction, because a denial can record a security event.
      const decision = await this.authorization.authorize(context, {
        module: candidate.module,
        action: 'View',
        resource: candidate.resource,
      });
      if (!decision.allowed) continue;

      visible.push(this.toSummary(candidate.row, prepared.now));
    }

    const delegatedFrom = prepared.delegatedFrom;
    const counts: Record<string, number> = {
      Pending: 0,
      Overdue: 0,
      Due: 0,
      Aging: 0,
      Mine: 0,
    };
    for (const request of visible) {
      if (request.status === 'Pending') {
        counts.Pending = (counts.Pending ?? 0) + 1;
        counts[request.bucket] = (counts[request.bucket] ?? 0) + 1;
        if (
          request.namedApproverUserId === input.actorUserId ||
          (request.namedApproverUserId !== null &&
            delegatedFrom.includes(request.namedApproverUserId))
        ) {
          counts.Mine = (counts.Mine ?? 0) + 1;
        }
      }
    }

    return { requests: visible, counts };
  }

  /** One request in full, with its history and what this actor may do. */
  async view(input: {
    scope: TenantScope;
    actorUserId: string;
    approvalId: string;
  }): Promise<ApprovalView> {
    const context = await this.authorization.contextFor(input.scope, input.actorUserId);
    await this.authorization.assertCan(context, { module: 'approvals', action: 'View' });

    // No transaction here: buildView opens its own for the reads and deliberately evaluates
    // permissions outside it.
    return this.buildView(input.scope, input.approvalId, input.actorUserId, context);
  }

  // -------------------------------------------------------------------------
  // Delegation
  // -------------------------------------------------------------------------

  /**
   * Delegate your approval routing while you are away.
   *
   * You may only delegate your **own** authority. Somebody with `ManageAccess` can arrange cover
   * for another person, because that is a real administrative need when a manager is unreachable,
   * but it is a different permission and it is audited as one. What nobody can do is delegate
   * authority *to* themselves from somebody else, which would be a self-service promotion.
   */
  async delegate(input: {
    scope: TenantScope;
    actorUserId: string;
    fromUserId: string;
    toUserId: string;
    types: ApprovalRequestType[];
    startsAt: Date;
    endsAt: Date;
    reason: string;
  }): Promise<DelegationView> {
    const context = await this.authorization.contextFor(input.scope, input.actorUserId);

    const onOwnBehalf = input.fromUserId === input.actorUserId;
    if (!onOwnBehalf) {
      // Checked before the permission, because it is refused whatever permission the caller
      // holds. An administrator arranging cover for an unreachable manager is a real need;
      // arranging for that manager's approvals to land on *themselves* is a self-service
      // promotion, and no amount of ManageAccess makes it one of the former.
      if (input.toUserId === input.actorUserId) {
        throw new ForbiddenException(
          'You cannot arrange for somebody else to delegate their approvals to you. Ask them ' +
            'to set it up, or hand it to a third person.',
        );
      }
      await this.authorization.assertCan(context, {
        module: 'approvals',
        action: 'ManageAccess',
      });
    } else {
      await this.authorization.assertCan(context, { module: 'approvals', action: 'View' });
    }

    const validation = validateDelegation({
      fromUserId: input.fromUserId,
      toUserId: input.toUserId,
      startsAt: input.startsAt,
      endsAt: input.endsAt,
      reason: input.reason,
    });
    if (!validation.ok) {
      throw new BadRequestException(validation.reason);
    }

    for (const type of input.types) {
      if (!APPROVAL_REQUEST_TYPES.includes(type)) {
        throw new BadRequestException(`Unknown approval type: ${type}`);
      }
    }

    return this.prisma.runInTenantTransaction(input.scope, async () => {
      const created = await this.prisma.client.approvalDelegation.create({
        data: {
          tenantId: input.scope.tenantId,
          fromUserId: input.fromUserId,
          toUserId: input.toUserId,
          types: input.types,
          startsAt: input.startsAt,
          endsAt: input.endsAt,
          reason: input.reason,
          createdByUserId: input.actorUserId,
        },
      });

      await this.auditEvents.appendWithinCurrentScope(input.scope.tenantId, {
        action: 'approvals.delegated',
        resourceType: 'approval-delegation',
        resourceId: created.id,
        actorUserId: input.actorUserId,
        resourceVersion: created.version,
        summary:
          `Approvals delegated until ${input.endsAt.toISOString()}` +
          (input.types.length === 0 ? ' for every type' : ` for ${input.types.join(', ')}`) +
          `: ${input.reason}`,
        metadata: {
          fromUserId: input.fromUserId,
          toUserId: input.toUserId,
          types: input.types.length === 0 ? 'all' : input.types.join(', '),
          onOwnBehalf,
        },
      });

      return this.toDelegationView(created, new Date());
    });
  }

  /** Revoke a delegation. Immediate, not at its end date. */
  async revokeDelegation(input: {
    scope: TenantScope;
    actorUserId: string;
    delegationId: string;
  }): Promise<DelegationView> {
    const context = await this.authorization.contextFor(input.scope, input.actorUserId);

    return this.prisma.runInTenantTransaction(input.scope, async () => {
      const row = await this.prisma.client.approvalDelegation.findFirst({
        where: { tenantId: input.scope.tenantId, id: input.delegationId },
      });
      if (!row) {
        throw new NotFoundException('No such delegation.');
      }

      // The person who granted it, and an administrator, may revoke it. The delegate cannot:
      // handing something back is a conversation, and silently dropping cover somebody is
      // relying on is how a queue stops being watched without anybody noticing.
      if (row.fromUserId !== input.actorUserId) {
        await this.authorization.assertCan(context, {
          module: 'approvals',
          action: 'ManageAccess',
        });
      }

      if (row.revokedAt !== null) {
        throw new ConflictException('That delegation is already revoked.');
      }

      const updated = await this.prisma.client.approvalDelegation.update({
        where: { id: row.id },
        data: {
          revokedAt: new Date(),
          revokedByUserId: input.actorUserId,
          version: { increment: 1 },
        },
      });

      await this.auditEvents.appendWithinCurrentScope(input.scope.tenantId, {
        action: 'approvals.delegation_revoked',
        resourceType: 'approval-delegation',
        resourceId: row.id,
        actorUserId: input.actorUserId,
        resourceVersion: updated.version,
        summary: 'Approval delegation revoked.',
        metadata: { fromUserId: row.fromUserId, toUserId: row.toUserId },
      });

      return this.toDelegationView(updated, new Date());
    });
  }

  /** Delegations involving one person, in either direction. */
  async listDelegations(input: {
    scope: TenantScope;
    actorUserId: string;
    userId?: string | undefined;
  }): Promise<DelegationView[]> {
    const context = await this.authorization.contextFor(input.scope, input.actorUserId);
    await this.authorization.assertCan(context, { module: 'approvals', action: 'View' });

    const subject = input.userId ?? input.actorUserId;
    if (subject !== input.actorUserId) {
      await this.authorization.assertCan(context, {
        module: 'approvals',
        action: 'ManageAccess',
      });
    }

    return this.prisma.runInTenantTransaction(input.scope, async () => {
      const rows = await this.prisma.client.approvalDelegation.findMany({
        where: {
          tenantId: input.scope.tenantId,
          OR: [{ fromUserId: subject }, { toUserId: subject }],
        },
        orderBy: { startsAt: 'desc' },
        take: 100,
      });

      const now = new Date();
      return rows.map((row) => this.toDelegationView(row, now));
    });
  }

  // -------------------------------------------------------------------------
  // Escalation
  // -------------------------------------------------------------------------

  /**
   * Escalate overdue requests to the approver's reporting manager.
   *
   * **It raises visibility. It never decides.** Nothing here approves, rejects or expires a
   * request, and there is no configuration that would make it: an approval that happened because
   * a deadline passed and nobody looked is not an approval, and auto-approval is precisely the
   * silent bypass the Executor Agent's locked rule forbids.
   *
   * Only genuinely overdue requests escalate, and only once — `approvalEscalationDue` refuses on
   * age alone, because escalating everything old trains people to ignore escalations.
   *
   * Where it escalates *to* is the gap Prompt 27 left open. The Executor's escalation routed back
   * to the existing owner, which is a loop rather than an escalation. This walks one step up the
   * reporting hierarchy from whoever was expected to decide. When there is no step up — the top
   * of the tree, or an unaddressed request — it escalates to nobody and says so, rather than
   * inventing a recipient.
   */
  async escalateAged(input: {
    scope: TenantScope;
    now?: Date | undefined;
  }): Promise<{ escalated: number; skipped: { id: string; reason: string }[] }> {
    const now = input.now ?? new Date();

    const pending = await this.prisma.runInTenantTransaction(input.scope, () =>
      this.prisma.client.approvalRequest.findMany({
        where: { tenantId: input.scope.tenantId, status: 'Pending', escalatedAt: null },
        take: 200,
      }),
    );

    let escalated = 0;
    const skipped: { id: string; reason: string }[] = [];

    for (const row of pending) {
      const { bucket } = agingBucketFor({
        submittedAt: row.createdAt,
        dueAt: row.dueAt,
        now,
      });

      const due = approvalEscalationDue({
        status: row.status,
        bucket,
        alreadyEscalated: row.escalatedAt !== null,
      });
      if (!due.due) {
        skipped.push({ id: row.id, reason: due.reason });
        continue;
      }

      const expected = row.namedApproverUserId ?? row.requestedByUserId;
      const employment = await this.prisma.runInTenantTransaction(input.scope, () =>
        this.organization.findEmployment(input.scope, expected),
      );
      const manager = employment?.reportingManagerUserId ?? null;

      if (manager === null) {
        skipped.push({
          id: row.id,
          reason:
            'Nobody to escalate to: the expected approver is at the top of the reporting tree, ' +
            'or has no employment record. Escalating to a made-up recipient would be worse.',
        });
        continue;
      }

      await this.prisma.runInTenantTransaction(input.scope, async () => {
        const updated = await this.prisma.client.approvalRequest.update({
          where: { id: row.id },
          data: {
            escalatedAt: now,
            escalatedToUserId: manager,
            version: { increment: 1 },
          },
        });

        await this.auditEvents.appendWithinCurrentScope(input.scope.tenantId, {
          action: 'approvals.escalated',
          resourceType: 'approval-request',
          resourceId: row.id,
          resourceRef: row.title,
          resourceVersion: updated.version,
          summary: `Escalated "${row.title}" — overdue with no decision.`,
          metadata: {
            approvalType: row.type,
            escalatedToUserId: manager,
            expectedApproverUserId: expected,
            // Said explicitly in the trail: escalation moved attention, not the verdict.
            decided: false,
          },
        });

        await this.notifications.raise({
          tenantId: input.scope.tenantId,
          recipientUserId: manager,
          kind: 'Overdue',
          severity: 'Warning',
          title: `Overdue approval: ${row.title}`,
          body:
            `This ${APPROVAL_REQUEST_TYPE_LABELS[row.type as ApprovalRequestType] ?? row.type} ` +
            'request passed its due date with no decision. It has not been approved — it is ' +
            'waiting for somebody.',
          deepLink: `/approvals/${row.id}`,
          resourceType: 'approval-request',
          resourceId: row.id,
          dedupeKey: `approval-escalation:${row.id}`,
        });
      });

      escalated += 1;
    }

    return { escalated, skipped };
  }

  /**
   * Escalate across every active company, for the scheduler.
   *
   * One company's failure does not stop the others: a tenant whose hierarchy is mid-import should
   * not silence every other tenant's overdue approvals.
   */
  async escalateAllCompanies(now?: Date): Promise<{ tenants: number; escalated: number }> {
    const tenants = await this.prisma.runAsPlatformOperation(() =>
      this.prisma.client.tenant.findMany({
        where: { lifecycleState: 'Active' },
        select: { id: true },
      }),
    );

    let total = 0;
    for (const tenant of tenants) {
      try {
        const result = await this.escalateAged({
          scope: tenantScopeForPlatformOperation(tenant.id),
          ...(now === undefined ? {} : { now }),
        });
        total += result.escalated;
      } catch (error) {
        this.logger.error(
          `Approval escalation failed for tenant ${tenant.id}: ${String(error)}. Continuing ` +
            'with the remaining companies.',
        );
      }
    }

    return { tenants: tenants.length, escalated: total };
  }

  // -------------------------------------------------------------------------
  // Internals
  // -------------------------------------------------------------------------

  /**
   * The `ResourceDescriptor` the authorization engine judges a decision against.
   *
   * **One place, because there were three and they disagreed.** The first version built this
   * inline in `decide`, `buildView` and `list`, and only `decide` supplied `departmentId` — so a
   * Department-scoped Head could decide a request the queue would not show them and the drawer
   * said was outside their role. The engine was right every time; the three call sites were not
   * asking the same question.
   *
   * Each field earns its place:
   *
   *   * `createdByUserId` — the requester. This is what makes the mandatory platform-wide
   *     `NoSelfApproval` control bite, and it is keyed on the creator rather than the owner
   *     because work is reassigned routinely and the person who *wrote* something is the one who
   *     must not wave it through.
   *   * `ownerUserId` — the named approver, falling back to the requester, so an `OwnWork` grant
   *     reaches the requests a person is actually involved in.
   *   * `departmentId` — the requester's department, so a Department or MultipleDepartments grant
   *     can resolve at all. Without it the engine fails closed, which is the safe direction and
   *     the wrong answer.
   *   * `priorActorUserIds` — the distinct people who have already *decided* (not commented), so
   *     a `FourEyes` control can tell whether a second pair of eyes exists.
   */
  private resourceFor(input: {
    row: {
      id: string;
      requestedByUserId: string;
      namedApproverUserId: string | null;
    };
    departmentId: string | null;
    priorActorUserIds: readonly string[];
  }): ResourceDescriptor {
    return {
      id: input.row.id,
      createdByUserId: input.row.requestedByUserId,
      ownerUserId: input.row.namedApproverUserId ?? input.row.requestedByUserId,
      priorActorUserIds: input.priorActorUserIds,
      ...(input.departmentId === null ? {} : { departmentId: input.departmentId }),
    };
  }

  /**
   * The separation-of-duties control the request carries in its own right.
   *
   * A workflow step that asked for a four-eyes gate gets one whether or not the company also
   * configured a `FourEyes` policy on the module. Passed to the authorization engine as an
   * additional policy rather than checked here, so there is exactly one implementation of the
   * rule and exactly one place that records a security event when it bites.
   */
  private sodPoliciesFor(row: { title: string; approverRoleKind: string | null }): SodPolicy[] {
    return requiredSodRule({ approverRoleKind: row.approverRoleKind }) === null
      ? []
      : [
          {
            action: 'Approve' as const,
            module: null,
            rule: 'FourEyes' as const,
            mandatory: true,
            reason:
              `"${row.title}" is a four-eyes gate: the workflow step asked for two distinct ` +
              'people, so the person who raised it cannot also decide it.',
          },
        ];
  }

  /** The distinct people who have already decided — commenters are not deciders. */
  private priorDecidersOf(history: readonly { decision: string; actorUserId: string }[]): string[] {
    return [
      ...new Set(history.filter((row) => row.decision !== 'Comment').map((row) => row.actorUserId)),
    ];
  }

  /**
   * The department a request belongs to, for scope evaluation.
   *
   * The requester's, because that is whose work is being judged. Returns null when they have no
   * employment record, which leaves a department-scoped grant failing closed — correct, and
   * visible in the refusal rather than silently widened.
   */
  private async departmentOfRequester(
    scope: TenantScope,
    requestedByUserId: string,
  ): Promise<string | null> {
    const employment = await this.organization.findEmployment(scope, requestedByUserId);
    return employment?.departmentId ?? null;
  }

  private async load(scope: TenantScope, approvalId: string) {
    const row = await this.prisma.client.approvalRequest.findFirst({
      where: { tenantId: scope.tenantId, id: approvalId },
    });
    if (!row) {
      throw new NotFoundException('No such approval request.');
    }
    return row;
  }

  private async appendDecision(
    tenantId: string,
    approvalRequestId: string,
    input: {
      decision: ApprovalDecision;
      actorUserId: string;
      note: string;
      onBehalfOfUserId?: string | undefined;
      delegationId?: string | undefined;
    },
  ): Promise<void> {
    await this.prisma.client.approvalDecisionRecord.create({
      data: {
        tenantId,
        approvalRequestId,
        decision: input.decision,
        actorUserId: input.actorUserId,
        note: input.note,
        ...(input.onBehalfOfUserId === undefined
          ? {}
          : { onBehalfOfUserId: input.onBehalfOfUserId }),
        ...(input.delegationId === undefined ? {} : { delegationId: input.delegationId }),
      },
    });
  }

  /**
   * The delegation, if any, letting this actor stand in for the named approver right now.
   *
   * Deterministic when several cover the same moment, and the rule is the specific one wins: a
   * type-scoped delegation beats a blanket one, because "budget overrides to A, everything else
   * to B" is a real arrangement and the narrower instruction is the more deliberate. Ties break on
   * the most recently created, so re-delegating supersedes rather than becoming ambiguous.
   */
  private async coveringDelegation(
    scope: TenantScope,
    input: { toUserId: string; fromUserId: string | null; type: ApprovalRequestType },
  ): Promise<{ id: string; fromUserId: string } | null> {
    if (input.fromUserId === null || input.fromUserId === input.toUserId) {
      return null;
    }

    const rows = await this.prisma.client.approvalDelegation.findMany({
      where: {
        tenantId: scope.tenantId,
        toUserId: input.toUserId,
        fromUserId: input.fromUserId,
        revokedAt: null,
      },
      orderBy: { createdAt: 'desc' },
    });

    const now = new Date();
    const covering = rows.filter((row) =>
      delegationCovers({
        delegation: {
          types: row.types.length === 0 ? null : (row.types as ApprovalRequestType[]),
          startsAt: row.startsAt,
          endsAt: row.endsAt,
          revokedAt: row.revokedAt,
        },
        type: input.type,
        at: now,
      }),
    );

    const specific = covering.find((row) => row.types.length > 0);
    const chosen = specific ?? covering[0];

    return chosen === undefined ? null : { id: chosen.id, fromUserId: chosen.fromUserId };
  }

  private async activeDelegationsTo(
    scope: TenantScope,
    toUserId: string,
  ): Promise<{ fromUserId: string }[]> {
    const now = new Date();
    const rows = await this.prisma.client.approvalDelegation.findMany({
      where: {
        tenantId: scope.tenantId,
        toUserId,
        revokedAt: null,
        startsAt: { lte: now },
        endsAt: { gte: now },
      },
      select: { fromUserId: true },
    });
    return rows;
  }

  private toSummary(
    row: {
      id: string;
      type: string;
      status: string;
      title: string;
      subjectType: string;
      subjectId: string | null;
      objectiveId: string | null;
      requestedByUserId: string;
      namedApproverUserId: string | null;
      approverRoleKind: string | null;
      createdAt: Date;
      dueAt: Date | null;
      escalatedAt: Date | null;
      escalatedToUserId: string | null;
    },
    now: Date,
  ): ApprovalSummary {
    const type = row.type as ApprovalRequestType;
    const aging = agingBucketFor({ submittedAt: row.createdAt, dueAt: row.dueAt, now });

    return {
      id: row.id,
      type,
      typeLabel: APPROVAL_REQUEST_TYPE_LABELS[type] ?? row.type,
      status: row.status,
      title: row.title,
      subjectType: row.subjectType,
      subjectId: row.subjectId,
      objectiveId: row.objectiveId,
      requestedByUserId: row.requestedByUserId,
      namedApproverUserId: row.namedApproverUserId,
      approverRoleKind: row.approverRoleKind,
      module: APPROVAL_TYPE_MODULE[type] ?? 'approvals',
      submittedAt: row.createdAt.toISOString(),
      dueAt: row.dueAt?.toISOString() ?? null,
      bucket: aging.bucket,
      bucketLabel: AGING_BUCKET_LABELS[aging.bucket],
      bucketTone: AGING_BUCKET_TONES[aging.bucket],
      hoursOpen: Math.round(aging.hoursOpen * 10) / 10,
      escalatedAt: row.escalatedAt?.toISOString() ?? null,
      escalatedToUserId: row.escalatedToUserId,
    };
  }

  /**
   * Build the full view, including what this actor may do and why not.
   *
   * The `available` list runs the *real* checks — the same routing call and the same
   * `authorize` — rather than approximating them, so a greyed-out button and a refused POST can
   * never disagree. The cost is a few extra permission evaluations per drawer open, which is the
   * right trade: the alternative is a screen that offers an action the server will refuse.
   */
  /**
   * Build the full view, including what this actor may do and why not.
   *
   * The `available` list runs the *real* checks — the same routing call, the same resource
   * descriptor, the same `authorize` — rather than approximating them, so a greyed-out button and
   * a refused POST can never disagree, and the reason shown is the one the server would give. The
   * cost is a few permission evaluations per drawer open, which is the right trade: the
   * alternative is a screen that offers an action the server will refuse.
   *
   * Reads happen in a transaction; the permission evaluations happen outside it. Deliberately:
   * `authorize` can record a security event when a separation-of-duties control bites, and that is
   * a platform-plane write which `runAsPlatformOperation` rightly refuses to escalate out of an
   * open tenant transaction. Evaluating inside one silently dropped those events — the log said
   * "the security trail now has a gap" and the table proved it.
   */
  private async buildView(
    scope: TenantScope,
    approvalId: string,
    actorUserId: string,
    /**
     * Resolved by the caller, outside any transaction, for the same reason.
     *
     * `contextFor` reads the platform-layer policy rules through `runAsPlatformOperation`, which
     * refuses to escalate an open tenant transaction — correctly, because a tenant-scoped request
     * must never quietly gain cross-tenant reach.
     */
    context: AuthorizationContext,
  ): Promise<ApprovalView> {
    const read = await this.prisma.runInTenantTransaction(scope, async () => {
      const row = await this.load(scope, approvalId);
      const history = await this.prisma.client.approvalDecisionRecord.findMany({
        where: { tenantId: scope.tenantId, approvalRequestId: row.id },
        orderBy: { occurredAt: 'asc' },
      });
      const successor = await this.prisma.client.approvalRequest.findFirst({
        where: { tenantId: scope.tenantId, supersedesId: row.id },
        select: { id: true },
      });
      const delegation = await this.coveringDelegation(scope, {
        toUserId: actorUserId,
        fromUserId: row.namedApproverUserId,
        type: row.type as ApprovalRequestType,
      });
      const departmentId = await this.departmentOfRequester(scope, row.requestedByUserId);
      return { row, history, successor, delegation, departmentId };
    });

    const { row, history, successor, delegation, departmentId } = read;
    const type = row.type as ApprovalRequestType;
    const module = APPROVAL_TYPE_MODULE[type];
    const now = new Date();

    const addressed = isAddressedTo({
      status: row.status,
      namedApproverUserId: row.namedApproverUserId,
      approverRoleKind: row.approverRoleKind,
      actorUserId,
      actorRoleKinds: context.roleSummary.map((r) => r.roleKind),
      delegatedFromUserId: delegation?.fromUserId ?? null,
    });

    const resource = this.resourceFor({
      row,
      departmentId,
      priorActorUserIds: this.priorDecidersOf(history),
    });
    const additional = this.sodPoliciesFor(row);

    const available: ApprovalView['available'] = [];
    for (const decision of APPROVAL_DECISIONS) {
      const label = APPROVAL_DECISION_LABELS[decision];

      if (module === undefined) {
        available.push({
          decision,
          label,
          allowed: false,
          reason: 'This approval type has no governing module, so no permission decides it.',
        });
        continue;
      }

      if (decision === 'Comment') {
        const outcome = await this.authorization.authorize(context, {
          module,
          action: 'Comment',
          resource,
        });
        available.push({
          decision,
          label,
          allowed: outcome.allowed,
          reason: outcome.allowed ? 'Permitted.' : outcome.message,
        });
        continue;
      }

      if (!addressed.addressed) {
        available.push({ decision, label, allowed: false, reason: addressed.reason });
        continue;
      }

      const outcome = await this.authorization.authorize(context, {
        module,
        action: 'Approve',
        resource,
        ...(additional.length === 0 ? {} : { additionalSodPolicies: additional }),
      });

      available.push({
        decision,
        label,
        allowed: outcome.allowed,
        reason: outcome.allowed ? 'Permitted.' : outcome.message,
      });
    }

    return {
      ...this.toSummary(row, now),
      detail: row.detail,
      decidedByUserId: row.decidedByUserId,
      decidedOnBehalfOfUserId: row.decidedOnBehalfOfUserId,
      decidedAt: row.decidedAt?.toISOString() ?? null,
      decisionNote: row.decisionNote,
      supersedesId: row.supersedesId,
      supersededById: successor?.id ?? null,
      history: history.map((entry) => ({
        id: entry.id,
        decision: entry.decision as ApprovalDecision,
        decisionLabel:
          APPROVAL_DECISION_LABELS[entry.decision as ApprovalDecision] ?? entry.decision,
        actorUserId: entry.actorUserId,
        onBehalfOfUserId: entry.onBehalfOfUserId,
        note: entry.note,
        occurredAt: entry.occurredAt.toISOString(),
      })),
      available,
      actingUnderDelegationFrom: delegation?.fromUserId ?? null,
      version: row.version,
    };
  }

  private toDelegationView(
    row: {
      id: string;
      fromUserId: string;
      toUserId: string;
      types: string[];
      startsAt: Date;
      endsAt: Date;
      reason: string;
      revokedAt: Date | null;
      revokedByUserId: string | null;
    },
    now: Date,
  ): DelegationView {
    return {
      id: row.id,
      fromUserId: row.fromUserId,
      toUserId: row.toUserId,
      types: row.types as ApprovalRequestType[],
      startsAt: row.startsAt.toISOString(),
      endsAt: row.endsAt.toISOString(),
      reason: row.reason,
      revokedAt: row.revokedAt?.toISOString() ?? null,
      revokedByUserId: row.revokedByUserId,
      active:
        row.revokedAt === null &&
        row.startsAt.getTime() <= now.getTime() &&
        row.endsAt.getTime() >= now.getTime(),
    };
  }

  /** Tell whoever is expected to decide that something is waiting. */
  private async notifyApprover(
    scope: TenantScope,
    row: {
      id: string;
      type: string;
      title: string;
      namedApproverUserId: string | null;
      dueAt: Date | null;
    },
  ): Promise<void> {
    if (row.namedApproverUserId === null) {
      // A role-addressed or four-eyes request has no single recipient. It appears in the queue
      // for everybody who may decide it; inventing a recipient here would tell one person it is
      // theirs when it is not.
      return;
    }

    await this.notifications.raise({
      tenantId: scope.tenantId,
      recipientUserId: row.namedApproverUserId,
      kind: 'ApprovalWaiting',
      title: `Approval waiting: ${row.title}`,
      body:
        `A ${APPROVAL_REQUEST_TYPE_LABELS[row.type as ApprovalRequestType] ?? row.type} request ` +
        'needs your decision.',
      deepLink: `/approvals/${row.id}`,
      resourceType: 'approval-request',
      resourceId: row.id,
      isAssignedToRecipient: true,
      dedupeKey: `approval-waiting:${row.id}`,
      ...(row.dueAt === null ? {} : { escalatesAt: row.dueAt }),
    });
  }

  /** Tell the person who asked what was decided. */
  private async notifyRequester(
    scope: TenantScope,
    row: { id: string; title: string; requestedByUserId: string },
    decision: ApprovalDecision,
    note: string,
  ): Promise<void> {
    if (!decisionSettlesRequest(decision)) return;

    await this.notifications.raise({
      tenantId: scope.tenantId,
      recipientUserId: row.requestedByUserId,
      kind: 'ApprovalWaiting',
      severity: decision === 'Approve' ? 'Info' : 'Warning',
      title: `${APPROVAL_DECISION_LABELS[decision]}: ${row.title}`,
      body:
        note.trim() === ''
          ? `Your request was ${APPROVAL_DECISION_LABELS[decision].toLowerCase()}.`
          : note,
      deepLink: `/approvals/${row.id}`,
      resourceType: 'approval-request',
      resourceId: row.id,
      dedupeKey: `approval-decided:${row.id}`,
    });
  }

  /** How long a request may sit before the queue calls it aging. Exposed for the screen. */
  get agingAfterHours(): number {
    return DEFAULT_APPROVAL_AGING_HOURS;
  }

  /** The routing a request carries, for the screen to label it. */
  routing(row: {
    namedApproverUserId: string | null;
    approverRoleKind: string | null;
  }): ApprovalRouting {
    return routingFor(row);
  }
}
