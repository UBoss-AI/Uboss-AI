import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';

import { AuditEventService } from '../audit/audit-event.service.js';
import { SECURITY_ACTIONS, SecurityEventPublisher } from '../auth/security-event.publisher.js';
import { AuthorizationService } from '../authorization/authorization.service.js';
import type { Offboarding } from '../generated/prisma/client.js';
import { AccessRepository } from '../persistence/access.repository.js';
import { OrganizationRepository } from '../persistence/organization.repository.js';
import { PerformanceService } from '../performance/performance.service.js';
import { MemoryService } from '../agents/memory.service.js';
import { PrismaService } from '../persistence/prisma.service.js';
import { TERMINAL_HUMAN_TASK_STATUSES } from '@uboss/types';

import type { TenantScope } from '../persistence/tenant-context.js';

/**
 * What an offboarding has to hand over, and where each thing stands.
 *
 * A declared registry rather than an implicit list, because the honest answer today is that most
 * of it **does not exist yet** — and the difference between "moved nothing because there was
 * nothing" and "moved nothing because we forgot" is the whole point of writing it down.
 *
 * A later prompt that adds one of these domains changes its entry here and implements the
 * transfer. Nothing else has to change, and nothing can be silently forgotten: the offboarding
 * record carries every entry's outcome.
 */
export const HANDOVER_DOMAINS = [
  {
    key: 'roleAssignments',
    label: 'Company roles and scopes',
    /** Revoked rather than transferred — see the class comment. */
    status: 'implemented' as const,
  },
  {
    key: 'reportingLine',
    label: 'Direct reports',
    status: 'implemented' as const,
  },
  {
    key: 'performanceHistory',
    label: 'Performance score and badge history',
    /**
     * Preserved and snapshotted, never moved. A performance record belongs to the person and the
     * company that employed them — handing it to a successor would credit somebody with work they
     * did not do, and deleting it would destroy the record a rehire or a dispute needs.
     */
    status: 'implemented' as const,
  },
  {
    key: 'openWork',
    label: 'Open Human To-do tasks',
    status: 'not-implemented' as const,
    arrivesWith: 'the Approve & Assign / Human To-do prompt',
  },
  {
    key: 'engineAgents',
    label: 'Engine Agent ownership',
    status: 'not-implemented' as const,
    arrivesWith: 'the Engine Agent lifecycle prompt',
  },
  {
    key: 'connections',
    label: 'Integrations and connections',
    /**
     * **Personal connections are disabled, never transferred.** The credential is that person's
     * own account, so handing it to a successor would give somebody access to a mailbox that is
     * not theirs. Company connections they *owned* are left in place and reported, because a
     * live integration with an ended owner needs a decision, not an automatic reassignment to
     * whoever happened to be named successor.
     */
    status: 'implemented' as const,
  },
] as const;

export interface OffboardingOutcome {
  offboardingId: string;
  subjectUserId: string;
  successorUserId: string | null;
  /** Per-domain: what moved, or why nothing did. */
  handover: Record<string, { status: string; detail: string; moved?: number }>;
  /** Always true. Offboarding preserves everything. */
  nothingDeleted: true;
}

/**
 * Offboarding: revoke access, end employment, **preserve history**, hand over what can be moved.
 *
 * ## What is destroyed: nothing
 *
 * The client's rule is explicit — offboarding must "preserve history". So:
 *
 *   * the **membership row stays**, with `accountState = Offboarded`;
 *   * the **employment record stays**, with `state = Ended` and a date;
 *   * every **audit event** the person ever caused stays, unchanged and unchangeable;
 *   * their **UBoss Unique ID** is untouched — it is theirs, not the company's, and it follows
 *     them to their next employer.
 *
 * What *is* removed is their **authority**: role assignments are revoked, because a role is
 * permission to act and somebody who has left must not hold one. That is a deletion of a grant,
 * not of history — the audit trail records who held what and when it was revoked.
 *
 * ## Why roles are revoked and not transferred
 *
 * A successor already has their own roles. Copying a departing person's grants onto them would
 * silently widen the successor's authority, which is exactly the escalation the Prompt 7
 * engine's granting gates exist to prevent — and it would happen without anybody choosing it.
 * The successor inherits **work**, not permissions.
 *
 * ## Direct reports must go somewhere
 *
 * Ending the employment of somebody with direct reports would leave those people pointing at an
 * ended manager. So the successor becomes their manager, which is the one transfer that is
 * genuinely mechanical — and if no successor is named, the offboarding is refused with the count.
 */
@Injectable()
export class OffboardingService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly access: AccessRepository,
    private readonly organization: OrganizationRepository,
    private readonly authorization: AuthorizationService,
    private readonly auditEvents: AuditEventService,
    private readonly securityEvents: SecurityEventPublisher,
    private readonly performance: PerformanceService,
    private readonly memory: MemoryService,
  ) {}

  /** What an offboarding would need to move, asked before committing to it. */
  async assess(input: { scope: TenantScope; actorUserId: string; subjectUserId: string }): Promise<{
    directReports: number;
    roleAssignments: number;
    /** Work assigned to them that has not finished. Somebody has to pick it up. */
    openTasks: number;
    /** Objectives they own. An objective with no owner has nobody to answer for it. */
    objectivesOwned: number;
    /** Engine Agents they are accountable for. */
    agentsOwned: number;
    /** Approvals waiting on this person by name, which would otherwise wait forever. */
    approvalsPending: number;
    successorRequired: boolean;
    domains: typeof HANDOVER_DOMAINS;
    note: string;
  }> {
    const context = await this.authorization.contextFor(input.scope, input.actorUserId);
    await this.authorization.assertCan(context, { module: 'users', action: 'ManageAccess' });

    const counts = await this.prisma.runInTenantTransaction(input.scope, async () => ({
      directReports: await this.prisma.client.employmentRecord.count({
        where: {
          tenantId: input.scope.tenantId,
          reportingManagerUserId: input.subjectUserId,
          state: 'Active',
        },
      }),
      roleAssignments: await this.prisma.client.roleAssignment.count({
        where: { tenantId: input.scope.tenantId, userId: input.subjectUserId },
      }),

      /*
       * What else stops when this person does.
       *
       * The client's rule is that an administrator sees what will be affected **before** they
       * confirm. Direct reports and roles were the only two things counted, which made the
       * preview answer "who reports to them" when the question is "what happens to their work".
       * Each of these is something that has an owner today and would have none tomorrow.
       *
       * Counted, not listed: a count is what a decision needs, and the detail is on the tabs of
       * the panel this is shown in.
       */
      openTasks: await this.prisma.client.humanTask.count({
        where: {
          tenantId: input.scope.tenantId,
          assignedToUserId: input.subjectUserId,
          status: { notIn: [...TERMINAL_HUMAN_TASK_STATUSES] },
        },
      }),
      objectivesOwned: await this.prisma.client.objectiveVersion.count({
        where: {
          tenantId: input.scope.tenantId,
          objectiveOwnerUserId: input.subjectUserId,
          status: { not: 'Archived' },
        },
      }),
      agentsOwned: await this.prisma.client.engineAgent.count({
        where: {
          tenantId: input.scope.tenantId,
          ownerUserId: input.subjectUserId,
          status: { not: 'Archived' },
        },
      }),
      approvalsPending: await this.prisma.client.approvalRequest.count({
        where: {
          tenantId: input.scope.tenantId,
          namedApproverUserId: input.subjectUserId,
          status: 'Pending',
        },
      }),
    }));

    return {
      ...counts,
      successorRequired: counts.directReports > 0,
      domains: HANDOVER_DOMAINS,
      note:
        `Nothing is deleted. The membership, the employment record and every audit event are ` +
        `kept — the account state becomes Offboarded and the employment is marked Ended with a ` +
        `date. ${counts.roleAssignments} role assignment(s) are revoked, because a role is ` +
        `permission to act. ` +
        (counts.directReports > 0
          ? `${counts.directReports} direct report(s) move to the successor, who must be named.`
          : 'There are no direct reports to move.') +
        /*
         * Said plainly, because these are the ones that do **not** move.
         *
         * Transferring an objective's ownership or an agent's accountability to whoever happens
         * to be the successor would be inventing a business decision — somebody has to choose,
         * and the choice is per item. Saying so here is the difference between an administrator
         * who knows there is follow-up work and one who finds out when an approval never arrives.
         */
        (counts.openTasks + counts.objectivesOwned + counts.agentsOwned + counts.approvalsPending >
        0
          ? ` Still needing a decision afterwards: ${counts.openTasks} unfinished task(s), ` +
            `${counts.objectivesOwned} objective(s) they own, ${counts.agentsOwned} agent(s) they ` +
            `own and ${counts.approvalsPending} approval(s) waiting on them by name. None of ` +
            'these is reassigned automatically — each is a decision somebody has to make.'
          : ' They hold no unfinished work, objectives, agents or approvals.'),
    };
  }

  /**
   * Offboard somebody.
   *
   * One transaction: access revoked, employment ended, reports moved and the record written
   * together. A half-applied offboarding is somebody who cannot sign in but still owns a team.
   */
  async offboard(input: {
    scope: TenantScope;
    actorUserId: string;
    subjectUserId: string;
    successorUserId?: string | undefined;
    reason: string;
    /**
     * How long they keep working before their last day.
     *
     * Zero, or absent, ends it today — which is what this method always did and what a dismissal
     * needs. Anything more starts a notice period: their access and employment continue, the
     * successor takes the reporting line straight away so the two can hand over, and the rest
     * happens on the day itself.
     */
    noticeDays?: number | undefined;
  }): Promise<OffboardingOutcome> {
    const context = await this.authorization.contextFor(input.scope, input.actorUserId);
    await this.authorization.assertCan(context, { module: 'users', action: 'ManageAccess' });

    if (!input.reason.trim()) {
      throw new BadRequestException('Offboarding somebody requires a reason.');
    }
    if (input.subjectUserId === input.actorUserId) {
      throw new BadRequestException(
        'You cannot offboard yourself. Somebody else has to do it, so a company cannot be left ' +
          'with nobody able to administer it.',
      );
    }
    if (input.successorUserId === input.subjectUserId) {
      throw new BadRequestException('The successor has to be somebody else.');
    }

    const noticeDays = Math.trunc(input.noticeDays ?? 0);
    if (noticeDays < 0 || noticeDays > 365) {
      throw new BadRequestException(
        'A notice period is between 0 and 365 days. Zero ends the employment today.',
      );
    }

    const open = await this.access.findOpenOffboarding(input.scope, input.subjectUserId);
    if (open) {
      throw new ConflictException(
        'That person already has an offboarding in progress. Two would race each other to move ' +
          'the same work.',
      );
    }

    return this.prisma.runInTenantTransaction(input.scope, async () => {
      const membership = await this.prisma.client.tenantMembership.findFirst({
        where: { tenantId: input.scope.tenantId, userId: input.subjectUserId },
      });
      if (!membership) {
        throw new NotFoundException('That person is not a member of this company.');
      }
      if (membership.accountState === 'Offboarded') {
        throw new ConflictException('That person has already been offboarded.');
      }

      const directReports = await this.prisma.client.employmentRecord.findMany({
        where: {
          tenantId: input.scope.tenantId,
          reportingManagerUserId: input.subjectUserId,
          state: 'Active',
        },
        select: { id: true },
      });

      if (directReports.length > 0 && input.successorUserId === undefined) {
        throw new BadRequestException(
          `This person has ${directReports.length} direct report(s). Name a successor — ` +
            'offboarding them without one would leave those people reporting to somebody whose ' +
            'employment has ended.',
        );
      }

      if (input.successorUserId !== undefined) {
        const successor = await this.organization.findEmployment(
          input.scope,
          input.successorUserId,
        );
        if (!successor || successor.state !== 'Active') {
          throw new BadRequestException(
            'The successor must be somebody currently employed by this company.',
          );
        }
      }

      const handover: OffboardingOutcome['handover'] = {};

      // 1. Direct reports move to the successor. The composite foreign key guarantees the
      //    successor is employed here, and the cycle trigger guarantees the result is still a
      //    tree — both without this code having to check.
      if (directReports.length > 0) {
        await this.prisma.client.employmentRecord.updateMany({
          where: { id: { in: directReports.map((report) => report.id) } },
          data: {
            reportingManagerUserId: input.successorUserId as string,
            version: { increment: 1 },
          },
        });
      }
      handover['reportingLine'] = {
        status: 'moved',
        detail:
          directReports.length === 0
            ? 'No direct reports.'
            : `${directReports.length} direct report(s) now report to the successor.`,
        moved: directReports.length,
      };

      /*
       * A notice period, if one was given.
       *
       * Nothing else happens today. Their roles stay, their employment stays Active, and they
       * keep working — which is what a notice period is. The direct reports moved to the
       * successor above, so the successor sees the work from now rather than from the day the
       * person disappears.
       *
       * `effectiveAt` is their last day. `completeDue` finishes it when that day arrives, and
       * the authorization path refuses them once it has passed whether or not the tick has run
       * — a sweep that has not fired must never be the thing standing between somebody who has
       * left and the company.
       */
      if (noticeDays > 0) {
        const lastDay = new Date(Date.now() + noticeDays * 24 * 60 * 60 * 1000);

        /*
         * Their access is given an end date, and that is what actually ends it.
         *
         * Not the tick below. `listLiveAssignments` already refuses an assignment whose
         * `expiresAt` has passed — every authorization call in the product goes through it — so
         * on the morning after their last day they have no permissions, whether or not anybody
         * swept the table. The tick then tidies the rows; it is bookkeeping rather than the
         * boundary.
         *
         * An assignment that already expires sooner is left alone: notice extends nothing.
         */
        await this.prisma.client.roleAssignment.updateMany({
          where: {
            tenantId: input.scope.tenantId,
            userId: input.subjectUserId,
            OR: [{ expiresAt: null }, { expiresAt: { gt: lastDay } }],
          },
          data: { expiresAt: lastDay, version: { increment: 1 } },
        });

        handover['noticePeriod'] = {
          status: 'serving',
          detail:
            `${noticeDays} day(s) of notice. Their access and employment continue until ` +
            `${lastDay.toDateString()}, and the handover is finished on that day.`,
          moved: 0,
        };

        const pending = await this.prisma.client.offboarding.create({
          data: {
            tenantId: input.scope.tenantId,
            subjectUserId: input.subjectUserId,
            ...(input.successorUserId === undefined
              ? {}
              : { successorUserId: input.successorUserId }),
            state: 'Requested',
            reason: input.reason.trim(),
            handover: handover as never,
            requestedByUserId: input.actorUserId,
            effectiveAt: lastDay,
          },
        });

        await this.auditEvents.appendWithinCurrentScope(input.scope.tenantId, {
          action: 'access.offboarding_notice_started',
          resourceType: 'offboarding',
          resourceId: pending.id,
          actorUserId: input.actorUserId,
          summary: 'Started a notice period and moved the reporting line to the successor.',
          reason: input.reason.trim(),
          metadata: {
            subjectUserId: input.subjectUserId,
            successorUserId: input.successorUserId ?? null,
            directReportsMoved: directReports.length,
            lastDay: lastDay.toISOString(),
            noticeDays,
            nothingDeleted: true,
          },
        });

        return {
          offboardingId: pending.id,
          subjectUserId: input.subjectUserId,
          successorUserId: input.successorUserId ?? null,
          handover,
          nothingDeleted: true as const,
        };
      }

      // 2. Roles are revoked, not transferred — see the class comment.
      const revoked = await this.prisma.client.roleAssignment.deleteMany({
        where: { tenantId: input.scope.tenantId, userId: input.subjectUserId },
      });
      handover['roleAssignments'] = {
        status: 'revoked',
        detail:
          `${revoked.count} role assignment(s) revoked. Roles are not transferred: copying them ` +
          'onto a successor would silently widen their authority.',
        moved: 0,
      };

      // 3. Everything that does not exist yet, named rather than omitted.
      for (const domain of HANDOVER_DOMAINS) {
        if (domain.status === 'not-implemented') {
          handover[domain.key] = {
            status: 'not-implemented',
            detail:
              `${domain.label} cannot be transferred yet — it arrives with ` +
              `${domain.arrivesWith}. Nothing of this kind exists to move, and this record says ` +
              'so rather than implying it was handled.',
          };
        }
      }

      // 4. Access revoked and employment ended. Both rows are kept.
      await this.prisma.client.tenantMembership.updateMany({
        where: { id: membership.id },
        data: { accountState: 'Offboarded', version: { increment: 1 } },
      });

      await this.prisma.client.employmentRecord.updateMany({
        where: { tenantId: input.scope.tenantId, userId: input.subjectUserId },
        data: { state: 'Ended', endedAt: new Date(), version: { increment: 1 } },
      });

      // 5. The performance record is frozen where it stands. Without a snapshot the history
      //    would keep re-deriving against a policy that changes after the person has left, so
      //    the level they are recorded as having held could move years later.
      const snapshot = await this.performance.snapshotOnExitWithinCurrentScope(
        input.scope,
        input.subjectUserId,
      );
      handover['performanceHistory'] = {
        status: snapshot === null ? 'nothing-to-snapshot' : 'snapshotted',
        detail:
          snapshot === null
            ? 'No performance events were recorded for this person, so there is no level to ' +
              'snapshot. Writing one would imply a standing they never held.'
            : `Final snapshot taken: ${snapshot.level} at ${snapshot.score} points. The history ` +
              'is preserved and is not transferred — a successor did not earn it.',
        moved: 0,
      };

      /*
       * 6. Connections.
       *
       * Their **personal** connections are disabled: the credential is their own account, and
       * `ConnectionService.transferOwner` refuses to move one for exactly that reason.
       *
       * Written through Prisma rather than by calling `ConnectionService.disable`, deliberately.
       * That method opens its own transaction and checks that the **caller** may administer the
       * connection — and an administrator legitimately cannot rotate somebody else's personal
       * credential. This is the system ending an employment, not a person reaching into an
       * account, and it has to commit with the rest of the offboarding.
       *
       * **Company** connections they owned are counted and reported, not reassigned. A live
       * integration whose accountable owner has left needs somebody to decide who takes it —
       * silently making the named successor the owner of an ERP credential is the kind of
       * automatic escalation of access this system exists to avoid.
       */
      const personalConnections = await this.prisma.client.connection.findMany({
        where: {
          tenantId: input.scope.tenantId,
          ownerUserId: input.subjectUserId,
          scope: 'User',
          disabledAt: null,
        },
        select: { id: true },
      });

      if (personalConnections.length > 0) {
        await this.prisma.client.connection.updateMany({
          where: { id: { in: personalConnections.map((row) => row.id) } },
          data: {
            disabledAt: new Date(),
            disabledReason:
              'The owner was offboarded. A personal connection is never transferred: the ' +
              'credential is their own account.',
            version: { increment: 1 },
          },
        });
      }

      const ownedCompanyConnections = await this.prisma.client.connection.count({
        where: {
          tenantId: input.scope.tenantId,
          ownerUserId: input.subjectUserId,
          scope: 'Company',
          disabledAt: null,
        },
      });

      handover['connections'] = {
        status: 'disabled-and-reported',
        detail:
          `${personalConnections.length} personal connection(s) disabled — a credential that is ` +
          "somebody's own account is never handed over. " +
          (ownedCompanyConnections === 0
            ? 'They owned no company connections.'
            : `${ownedCompanyConnections} company connection(s) they owned are still live and ` +
              'need a new owner named deliberately; they were not reassigned automatically.'),
        moved: 0,
      };

      // 7. Any outstanding invitation is cancelled: an activation link for somebody who has left
      //    is a live way into the company.
      await this.prisma.client.invitation.updateMany({
        where: {
          tenantId: input.scope.tenantId,
          userId: input.subjectUserId,
          acceptedAt: null,
          cancelledAt: null,
        },
        data: { cancelledAt: new Date() },
      });

      // 8. What the company's agents remember about this person's work (Prompt 33).
      //
      //    Inside this transaction rather than after it, because "roles revoked, memory still
      //    owned by a departed person" is a state nobody would notice and nobody would fix. Each
      //    record follows the policy for its own memory mode, so a company can delete personal
      //    ephemeral context and keep anonymised agent knowledge in the same offboarding — and
      //    a `TransferToSuccessor` policy with no successor deletes rather than leaving the
      //    record owned by somebody who has gone.
      const memoryOutcome = await this.memory.applyOffboarding({
        scope: input.scope,
        subjectUserId: input.subjectUserId,
        successorUserId: input.successorUserId ?? null,
        actorUserId: input.actorUserId,
      });

      handover['agentMemory'] = {
        status:
          memoryOutcome.deleted + memoryOutcome.transferred + memoryOutcome.anonymised === 0
            ? 'nothing-held'
            : 'handled-by-policy',
        detail:
          memoryOutcome.deleted + memoryOutcome.transferred + memoryOutcome.anonymised === 0
            ? 'No Engine Agent held memory owned by this person.'
            : `${memoryOutcome.deleted} memory record(s) deleted, ` +
              `${memoryOutcome.transferred} transferred to the successor and ` +
              `${memoryOutcome.anonymised} kept without an owner, each under the policy for its ` +
              'own memory mode.',
        moved: memoryOutcome.transferred,
      };

      const record = await this.prisma.client.offboarding.create({
        data: {
          tenantId: input.scope.tenantId,
          subjectUserId: input.subjectUserId,
          ...(input.successorUserId === undefined
            ? {}
            : { successorUserId: input.successorUserId }),
          state: 'Completed',
          reason: input.reason.trim(),
          handover: handover as never,
          requestedByUserId: input.actorUserId,
          completedAt: new Date(),
        },
      });

      await this.auditEvents.appendWithinCurrentScope(input.scope.tenantId, {
        action: 'access.offboarded',
        resourceType: 'offboarding',
        resourceId: record.id,
        actorUserId: input.actorUserId,
        summary: 'Offboarded this person and handed over what could be transferred.',
        reason: input.reason.trim(),
        metadata: {
          subjectUserId: input.subjectUserId,
          successorUserId: input.successorUserId ?? null,
          directReportsMoved: directReports.length,
          rolesRevoked: revoked.count,
          // The client's rule, on the record.
          nothingDeleted: true,
        },
      });

      await this.securityEvents.recordWithinCurrentScope({
        action: SECURITY_ACTIONS.accountOffboarded,
        tenantId: input.scope.tenantId,
        actorUserId: input.actorUserId,
        subjectUserId: input.subjectUserId,
        resourceType: 'offboarding',
        resourceId: record.id,
        summary: `Offboarded; ${revoked.count} role assignment(s) revoked.`,
      });

      return {
        offboardingId: record.id,
        subjectUserId: input.subjectUserId,
        successorUserId: input.successorUserId ?? null,
        handover,
        nothingDeleted: true as const,
      };
    });
  }

  /**
   * Finish every notice period whose last day has arrived.
   *
   * ## Why a tick rather than a timer
   *
   * The same shape the run scheduler uses: a route somebody calls, rather than a process holding
   * a clock. Two instances ticking at once cannot double-finish anybody, because each completion
   * only touches an offboarding that is still `Requested` and the update is conditional on that.
   *
   * ## The tick is not what ends their access
   *
   * If nobody calls this for a week, somebody who left a week ago must still not be able to work.
   * So the authorization path refuses a person whose last day has passed, and this only tidies the
   * rows behind that decision. A sweep that has not run is never the thing standing between
   * somebody who has left and the company.
   *
   * What it does on the day is what an immediate offboarding does at once: revoke the roles, mark
   * the account Offboarded, end the employment, and freeze the performance record where it stands.
   */
  async completeDue(input: {
    scope: TenantScope;
    actorUserId: string;
    now?: Date | undefined;
  }): Promise<{ completed: string[]; note: string }> {
    const context = await this.authorization.contextFor(input.scope, input.actorUserId);
    await this.authorization.assertCan(context, { module: 'users', action: 'ManageAccess' });

    const now = input.now ?? new Date();

    const due = await this.prisma.runInTenantTransaction(input.scope, () =>
      this.prisma.client.offboarding.findMany({
        where: {
          tenantId: input.scope.tenantId,
          state: 'Requested',
          effectiveAt: { lte: now },
        },
        select: { id: true, subjectUserId: true },
      }),
    );

    const completed: string[] = [];

    for (const row of due) {
      await this.prisma.runInTenantTransaction(input.scope, async () => {
        /*
         * Claimed before anything is done to the person.
         *
         * `updateMany` with the state in the filter is the claim: a second tick running at the
         * same moment updates nothing and skips the row, so nobody is offboarded twice and no
         * second audit entry is written for one departure.
         */
        const claimed = await this.prisma.client.offboarding.updateMany({
          where: { id: row.id, state: 'Requested' },
          data: { state: 'Completed', completedAt: now, version: { increment: 1 } },
        });
        if (claimed.count === 0) return;

        const revoked = await this.prisma.client.roleAssignment.deleteMany({
          where: { tenantId: input.scope.tenantId, userId: row.subjectUserId },
        });

        await this.prisma.client.tenantMembership.updateMany({
          where: { tenantId: input.scope.tenantId, userId: row.subjectUserId },
          data: { accountState: 'Offboarded', version: { increment: 1 } },
        });

        await this.prisma.client.employmentRecord.updateMany({
          where: { tenantId: input.scope.tenantId, userId: row.subjectUserId },
          // `employment_end_state_and_date_agree`: the state and the date are written together,
          // because a record that says Ended without saying when is not an employment history.
          data: { state: 'Ended', endedAt: now, version: { increment: 1 } },
        });

        // Frozen where it stands. Without this the history would keep re-deriving against a
        // policy that changes after they have gone, so the level they are recorded as having
        // held could move years later.
        await this.performance.snapshotOnExitWithinCurrentScope(input.scope, row.subjectUserId);

        await this.auditEvents.appendWithinCurrentScope(input.scope.tenantId, {
          action: 'access.offboarded',
          resourceType: 'offboarding',
          resourceId: row.id,
          actorUserId: input.actorUserId,
          summary: 'The notice period ended; access was revoked and the employment closed.',
          reason: 'The last day recorded when the notice period began has arrived.',
          metadata: {
            subjectUserId: row.subjectUserId,
            rolesRevoked: revoked.count,
            completedOnNotice: true,
            nothingDeleted: true,
          },
        });

        await this.securityEvents.recordWithinCurrentScope({
          action: SECURITY_ACTIONS.accountOffboarded,
          tenantId: input.scope.tenantId,
          actorUserId: input.actorUserId,
          subjectUserId: row.subjectUserId,
          resourceType: 'offboarding',
          resourceId: row.id,
          summary: `Notice period ended; ${revoked.count} role assignment(s) revoked.`,
        });

        completed.push(row.id);
      });
    }

    return {
      completed,
      note:
        'Only notice periods whose last day has passed are finished. Nothing is deleted: the ' +
        'membership, the employment record and the audit trail all remain.',
    };
  }

  async list(scope: TenantScope, actorUserId: string): Promise<Offboarding[]> {
    const context = await this.authorization.contextFor(scope, actorUserId);
    await this.authorization.assertCan(context, { module: 'users', action: 'View' });
    return this.access.listOffboardings(scope);
  }
}
