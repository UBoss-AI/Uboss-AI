import {
  BadRequestException,
  ConflictException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';

import { AuditEventService } from '../audit/audit-event.service.js';
import { SECURITY_ACTIONS, SecurityEventPublisher } from '../auth/security-event.publisher.js';
import type { TenantLifecycleState } from '../generated/prisma/client.js';
import { PrismaService } from '../persistence/prisma.service.js';
import { TenantRepository } from '../persistence/tenant.repository.js';
import { lifecycleCapability } from '../tenancy/tenant-lifecycle.js';

/**
 * Which lifecycle transitions are permitted, and why the others are not.
 *
 * A closed adjacency table rather than a free `setState`, because the illegal transitions are
 * the interesting ones. `Closed → Active` is the clearest: reopening a closed company by
 * flipping a column would restore access to data whose retention decision has already been made,
 * and would do it without any of the checks a re-provisioning would apply. Closed is terminal
 * *through this service*; genuinely bringing a company back is a deliberate operation with its
 * own review.
 */
export const ALLOWED_LIFECYCLE_TRANSITIONS: Record<
  TenantLifecycleState,
  readonly TenantLifecycleState[]
> = {
  /** Provisioning ends when the administrator activates, or the platform abandons it. */
  Provisioning: ['PendingActivation', 'Active', 'Closed'],
  PendingActivation: ['Active', 'Suspended', 'Closed'],
  /** The normal operating state. Everything else is reachable from here. */
  Active: ['Suspended', 'ReadOnly', 'Closed'],
  /** A suspended company can come back, go read-only, or be closed. */
  Suspended: ['Active', 'ReadOnly', 'Closed'],
  /** Read-only is a holding state — usually end-of-term or a payment dispute. */
  ReadOnly: ['Active', 'Suspended', 'Closed'],
  /** Terminal. See the table comment. */
  Closed: [],
};

export interface LifecycleView {
  state: TenantLifecycleState;
  /** What this state permits, from the Prompt 4 capability model — one source, not two. */
  capability: { canAccess: boolean; canWrite: boolean; reason: string };
  allowedNext: readonly TenantLifecycleState[];
  history: {
    fromState: string;
    toState: string;
    reason: string;
    effectiveAt: string;
    appliedAt: string | null;
    actorUserId: string | null;
  }[];
  /** A transition dated in the future and not yet applied. */
  scheduled: { toState: string; effectiveAt: string; reason: string } | null;
}

/**
 * Company lifecycle transitions, and the exact behaviour of each state.
 *
 * ## Where "exact behaviour" actually lives
 *
 * In `tenant-lifecycle.ts`, since Prompt 4, as `LIFECYCLE_CAPABILITIES` — a table of
 * `canAccess` / `canWrite` / `reason` per state, consulted by `TenantGuard` on **every request**.
 * This service does not restate it, and that is deliberate: two tables describing what
 * `Suspended` means would eventually disagree, and the one the guard reads would win silently.
 *
 * What this service adds is what Prompt 4 had no need for:
 *
 *   * **which transitions are legal** — a closed adjacency table, so `Closed → Active` is
 *     impossible rather than merely unusual;
 *   * **a durable history**, so "what state was this company in on the 14th" is a query rather
 *     than a replay of an append-only trail;
 *   * **scheduled transitions**, so a suspension at the end of a grace period exists as a record
 *     before it happens.
 *
 * ## Nothing here deletes anything
 *
 * A company moving to `Closed` keeps every row it ever had. The client's rule about seat
 * reduction — no deleting users, employment history, tasks, Agent history or audit history —
 * applies with more force to closure, and there is no delete path in this service either.
 * Retention and erasure are a separate, explicitly-authorised operation with its own audit.
 */
@Injectable()
export class CompanyLifecycleService {
  private readonly logger = new Logger(CompanyLifecycleService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly tenants: TenantRepository,
    private readonly auditEvents: AuditEventService,
    private readonly securityEvents: SecurityEventPublisher,
  ) {}

  /** One company's lifecycle position, what it permits, and its history. */
  async viewFor(tenantId: string): Promise<LifecycleView> {
    return this.prisma.runAsPlatformOperation(async () => {
      const tenant = await this.tenants.findByIdForPlatform(tenantId);
      if (!tenant) {
        throw new NotFoundException('No such company.');
      }

      const history = await this.prisma.client.tenantLifecycleTransition.findMany({
        where: { tenantId },
        orderBy: { effectiveAt: 'desc' },
        take: 50,
      });

      const scheduled = history.find(
        (row) => row.appliedAt === null && row.effectiveAt.getTime() > Date.now(),
      );

      const capability = lifecycleCapability(tenant.lifecycleState);

      return {
        state: tenant.lifecycleState,
        capability: {
          canAccess: capability.canAccess,
          canWrite: capability.canWrite,
          reason: capability.reason,
        },
        allowedNext: ALLOWED_LIFECYCLE_TRANSITIONS[tenant.lifecycleState],
        history: history.map((row) => ({
          fromState: row.fromState,
          toState: row.toState,
          reason: row.reason,
          effectiveAt: row.effectiveAt.toISOString(),
          appliedAt: row.appliedAt?.toISOString() ?? null,
          actorUserId: row.actorUserId,
        })),
        scheduled: scheduled
          ? {
              toState: scheduled.toState,
              effectiveAt: scheduled.effectiveAt.toISOString(),
              reason: scheduled.reason,
            }
          : null,
      };
    });
  }

  /**
   * Move a company to a new lifecycle state, now or on a date.
   *
   * A **reason is mandatory**. A suspension with no recorded reason is the one a customer
   * disputes and nobody can explain six months later, and the check constraint behind this
   * requires it too.
   */
  async transition(input: {
    tenantId: string;
    toState: TenantLifecycleState;
    reason: string;
    actorUserId: string;
    /** Omit to apply now. A future date records the intent without applying it. */
    effectiveAt?: Date | undefined;
  }): Promise<LifecycleView> {
    if (!input.reason.trim()) {
      throw new BadRequestException(
        'A lifecycle change requires a reason. Suspending or closing a customer without a ' +
          'recorded reason is the change nobody can account for later.',
      );
    }

    await this.prisma.runAsPlatformOperation(async () => {
      const tenant = await this.tenants.findByIdForPlatform(input.tenantId);
      if (!tenant) {
        throw new NotFoundException('No such company.');
      }

      if (tenant.lifecycleState === input.toState) {
        throw new ConflictException(`This company is already ${input.toState}.`);
      }

      const allowed = ALLOWED_LIFECYCLE_TRANSITIONS[tenant.lifecycleState];
      if (!allowed.includes(input.toState)) {
        throw new ConflictException(
          `A company cannot move from ${tenant.lifecycleState} to ${input.toState}. ` +
            (allowed.length === 0
              ? `${tenant.lifecycleState} is terminal through this route: bringing a closed ` +
                'company back would restore access to data whose retention decision has already ' +
                'been made, so it is a deliberate operation with its own review.'
              : `Permitted from here: ${allowed.join(', ')}.`),
        );
      }

      const future = input.effectiveAt !== undefined && input.effectiveAt.getTime() > Date.now();

      const transition = await this.prisma.client.tenantLifecycleTransition.create({
        data: {
          tenantId: input.tenantId,
          fromState: tenant.lifecycleState,
          toState: input.toState,
          reason: input.reason.trim(),
          effectiveAt: input.effectiveAt ?? new Date(),
          // A future transition is recorded and NOT applied. That is the point of scheduling:
          // the record exists so the customer and the platform can both see what is coming,
          // before it lands.
          appliedAt: future ? null : new Date(),
          actorUserId: input.actorUserId,
        },
      });

      if (!future) {
        const changed = await this.tenants.setLifecycleStateForPlatform(
          input.tenantId,
          input.toState,
          tenant.version,
        );
        if (changed !== 1) {
          // Optimistic concurrency: somebody else moved this company while we were deciding.
          // Refused rather than overwritten, because their change had its own reason.
          throw new ConflictException(
            'This company changed state while you were acting on it. Re-read it and try again.',
          );
        }
      }

      // Into the company's **own** trail: a customer is entitled to see that their workspace was
      // suspended, when, and why.
      await this.auditEvents.appendWithinCurrentScope(input.tenantId, {
        action: future ? 'company.lifecycle_scheduled' : 'company.lifecycle_changed',
        resourceType: 'tenant',
        resourceId: input.tenantId,
        resourceRef: tenant.code ?? tenant.slug,
        resourceVersion: tenant.version,
        actorUserId: input.actorUserId,
        summary: future
          ? `Scheduled ${tenant.lifecycleState} → ${input.toState} for ${input.effectiveAt?.toISOString()}.`
          : `${tenant.lifecycleState} → ${input.toState}.`,
        reason: input.reason.trim(),
        metadata: {
          from: tenant.lifecycleState,
          to: input.toState,
          scheduled: future,
          transitionId: transition.id,
          // Stated in the record, because it is the question a customer asks first.
          nothingDeleted: true,
        },
      });

      await this.securityEvents.recordWithinCurrentScope({
        action: SECURITY_ACTIONS.companyLifecycleChanged,
        tenantId: input.tenantId,
        actorUserId: input.actorUserId,
        resourceType: 'tenant',
        resourceId: input.tenantId,
        summary: `${tenant.lifecycleState} → ${input.toState}${future ? ' (scheduled)' : ''}.`,
        metadata: { from: tenant.lifecycleState, to: input.toState, scheduled: future },
      });
    });

    return this.viewFor(input.tenantId);
  }

  /**
   * Apply lifecycle transitions whose date has arrived.
   *
   * Intended for a scheduler; called directly by tests. Deliberately **not** the enforcement of
   * anything — a scheduled suspension that has not been applied still shows the old state, and
   * that is correct: the company has not been suspended yet.
   *
   * That is the opposite of the seat-grace and break-glass rules, where expiry is evaluated on
   * read. The difference is which way the error falls: an unapplied *restriction* is generous
   * for a few minutes, while an unapplied *expiry of access* would leave authority nobody
   * granted. Being generous briefly is acceptable; the other is not.
   */
  async applyDueTransitions(): Promise<number> {
    return this.prisma.runAsPlatformOperation(async () => {
      const due = await this.prisma.client.tenantLifecycleTransition.findMany({
        where: { appliedAt: null, effectiveAt: { lte: new Date() } },
        orderBy: { effectiveAt: 'asc' },
      });

      let applied = 0;
      for (const transition of due) {
        const tenant = await this.tenants.findByIdForPlatform(transition.tenantId);
        if (!tenant) {
          continue;
        }
        // Re-check legality at apply time: the company may have moved elsewhere since the
        // transition was scheduled, and applying a stale plan would be worse than skipping it.
        if (!ALLOWED_LIFECYCLE_TRANSITIONS[tenant.lifecycleState].includes(transition.toState)) {
          this.logger.warn(
            `Skipping scheduled transition ${transition.id}: the company is now ` +
              `${tenant.lifecycleState}, from which ${transition.toState} is not reachable.`,
          );
          continue;
        }

        await this.tenants.setLifecycleStateForPlatform(
          transition.tenantId,
          transition.toState,
          tenant.version,
        );
        await this.prisma.client.tenantLifecycleTransition.update({
          where: { id: transition.id },
          data: { appliedAt: new Date(), version: { increment: 1 } },
        });

        await this.auditEvents.appendWithinCurrentScope(transition.tenantId, {
          action: 'company.lifecycle_changed',
          resourceType: 'tenant',
          resourceId: transition.tenantId,
          summary: `${tenant.lifecycleState} → ${transition.toState}, as scheduled.`,
          reason: transition.reason,
          // No actor: the schedule fired, not a person. Recorded as such rather than attributed
          // to whoever scheduled it, because they made a different decision at a different time.
          metadata: { from: tenant.lifecycleState, to: transition.toState, byScheduler: true },
        });

        applied += 1;
      }
      return applied;
    });
  }
}
