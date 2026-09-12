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
          : 'There are no direct reports to move.'),
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

  async list(scope: TenantScope, actorUserId: string): Promise<Offboarding[]> {
    const context = await this.authorization.contextFor(scope, actorUserId);
    await this.authorization.assertCan(context, { module: 'users', action: 'View' });
    return this.access.listOffboardings(scope);
  }
}
