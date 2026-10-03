import {
  BadRequestException,
  ConflictException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';

import { AuditEventService } from '../audit/audit-event.service.js';
import { SECURITY_ACTIONS, SecurityEventPublisher } from '../auth/security-event.publisher.js';
// A value import, not a type-only one: `applyBillingEntitlement` compares against the members.
import { TenantLifecycleState } from '../generated/prisma/enums.js';
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
 * What a payment event did, or deliberately did not do, to a company's lifecycle.
 *
 * `moved: false` is the normal, uninteresting answer — the company was already where the payment
 * says it should be. It is returned rather than thrown because the caller is a webhook, and the
 * provider redelivers: an exception here would be a retry for three days over nothing.
 *
 * `why` is kept for the delivery record. When a payment arrives and a company's access does not
 * change, the question asked afterwards is always "why not", and this is the sentence that
 * answers it.
 */
export interface BillingEntitlementOutcome {
  moved: boolean;
  from: TenantLifecycleState | null;
  to: TenantLifecycleState | null;
  why: string;
  /**
   * The transition row this created, when it moved anything.
   *
   * Returned so the notice that follows can key its dedupe on the episode rather than on the
   * company: keyed on the company, a business that lapsed, paid, and lapsed again next month
   * would be told once and then never again.
   */
  transitionId: string | null;
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

        /*
         * A person's move clears the billing code.
         *
         * This transition is explained by the reason they just wrote, which is recorded against
         * their name. Leaving a stale `PaymentOverdue` behind would make the next refusal tell
         * the company its subscription is unpaid when the real cause was whatever this operator
         * decided — the product confidently blaming the wrong thing.
         */
        await this.prisma.client.tenant.update({
          where: { id: input.tenantId },
          data: { accessReasonCode: null },
        });
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
   * Move a company in or out of read-only because the payment provider said so.
   *
   * ## The gap this closes
   *
   * The billing webhook has always translated the provider's status into a `SubscriptionState`,
   * including `Suspended` when the provider gives up collecting. That value is read by three
   * screens and by **no guard**: what the guard enforces is `Tenant.lifecycleState`, a different
   * column set by a different service. So until this existed, a company whose card failed was
   * marked unpaid and carried on working exactly as before.
   *
   * ## Why read-only and not suspended
   *
   * `Suspended` means nobody can open the workspace at all — including the one person who wants
   * to pay, on the one screen where they could. Locking a customer out of the room containing the
   * Pay button is not a collection strategy. `ReadOnly` lets them in, shows them their own data,
   * refuses every write, and the billing routes carry `@AllowedWhenReadOnly` so the way back is
   * open. `Suspended` stays what it has always been: something a person at UBoss decides.
   *
   * ## Why this is not `transition`
   *
   * Three differences, each of which would be a bug if this went through that method.
   *
   * **It must be idempotent.** `transition` throws when the company is already in the target
   * state, which is correct for a human pressing a button and wrong for a webhook: the provider
   * redelivers, and a 409 would make it redeliver for three more days.
   *
   * **It must never overrule a person.** A company a platform administrator suspended or closed
   * deliberately must not be quietly reopened by a payment succeeding, and a company they put
   * into read-only for their own reason must not be let out by one either. So this moves only
   * `Active → ReadOnly` and `ReadOnly → Active`, and the second only when the read-only was
   * system-made — which is exactly what a null `actorUserId` on the transition row records.
   *
   * **It has no actor.** A webhook is not a person. The transition row's `actorUserId` is
   * nullable for precisely this case, and the column's own comment says so.
   */
  async applyBillingEntitlement(input: {
    tenantId: string;
    entitled: boolean;
    /** The provider's own status word, for the reason line somebody will read later. */
    providerStatus: string;
  }): Promise<BillingEntitlementOutcome> {
    return this.prisma.runAsPlatformOperation(async () => {
      const tenant = await this.tenants.findByIdForPlatform(input.tenantId);
      if (!tenant) {
        return { moved: false, from: null, to: null, why: 'No such company.', transitionId: null };
      }

      const from = tenant.lifecycleState;
      const to = input.entitled ? TenantLifecycleState.Active : TenantLifecycleState.ReadOnly;

      if (from === to) {
        return { moved: false, from, to, why: 'Already ' + to + '.', transitionId: null };
      }

      if (!input.entitled) {
        // Only a working company is put into read-only. A company still being provisioned, or
        // one a person has already suspended or closed, is left exactly as it is: billing has
        // nothing to say about any of those, and saying something would overwrite a decision
        // somebody else made for a reason of their own.
        if (from !== TenantLifecycleState.Active) {
          return {
            moved: false,
            from,
            to,
            why: `Left alone: this company is ${from}.`,
            transitionId: null,
          };
        }
      } else {
        if (from !== TenantLifecycleState.ReadOnly) {
          return {
            moved: false,
            from,
            to,
            why: `Left alone: this company is ${from}.`,
            transitionId: null,
          };
        }
        if (!(await this.readOnlyWasSystemMade(input.tenantId))) {
          // A person put this company into read-only. A payment arriving does not undo that —
          // they had a reason, it is recorded against their name, and it is theirs to lift.
          return {
            moved: false,
            from,
            to,
            why: 'Left alone: a person put this company into read-only, so a payment does not lift it.',
            transitionId: null,
          };
        }
      }

      const reason = input.entitled
        ? `The payment provider reports "${input.providerStatus}". This company is paid up again.`
        : `The payment provider reports "${input.providerStatus}" and has stopped collecting. ` +
          'Work is paused until it is paid; nothing has been deleted and the company can still ' +
          'read its own data and settle.';

      const transition = await this.prisma.client.tenantLifecycleTransition.create({
        data: {
          tenantId: input.tenantId,
          fromState: from,
          toState: to,
          reason,
          effectiveAt: new Date(),
          appliedAt: new Date(),
          // Null, and that is the record that this was the system rather than a person. The
          // restore path above reads exactly this.
          actorUserId: null,
        },
      });

      const changed = await this.tenants.setLifecycleStateForPlatform(
        input.tenantId,
        to,
        tenant.version,
      );
      if (changed !== 1) {
        // Somebody moved this company while the delivery was being applied. Refused rather than
        // overwritten — and the webhook turns this into a retry, which re-reads the state.
        throw new ConflictException(
          'This company changed state while a payment event was being applied.',
        );
      }

      /*
       * And why, so the refusal can say it.
       *
       * Without this the company is told "read-only mode, changes cannot be saved" — true, and
       * useless: it does not say the cause is money or where to fix it, so the person reading it
       * raises a ticket instead of paying. A code rather than the reason above, because that
       * sentence is shown to everybody in the company on every blocked request and a platform
       * operator's wording is not written for that audience.
       */
      await this.prisma.client.tenant.update({
        where: { id: input.tenantId },
        data: { accessReasonCode: input.entitled ? null : 'PaymentOverdue' },
      });

      await this.auditEvents.appendWithinCurrentScope(input.tenantId, {
        action: 'company.lifecycle_changed',
        resourceType: 'tenant',
        resourceId: input.tenantId,
        resourceRef: tenant.code ?? tenant.slug,
        resourceVersion: tenant.version,
        summary: `${from} → ${to}.`,
        reason,
        metadata: {
          from,
          to,
          scheduled: false,
          transitionId: transition.id,
          providerStatus: input.providerStatus,
          drivenBy: 'billing',
          nothingDeleted: true,
        },
      });

      await this.securityEvents.recordWithinCurrentScope({
        action: SECURITY_ACTIONS.companyLifecycleChanged,
        tenantId: input.tenantId,
        resourceType: 'tenant',
        resourceId: input.tenantId,
        summary: `${from} → ${to}, because the payment provider reports "${input.providerStatus}".`,
        metadata: { from, to, scheduled: false, drivenBy: 'billing' },
      });

      this.logger.log(
        `Company ${input.tenantId}: ${from} → ${to} on provider status "${input.providerStatus}".`,
      );

      return { moved: true, from, to, why: reason, transitionId: transition.id };
    });
  }

  /**
   * Whether this company's current read-only was the system's doing rather than a person's.
   *
   * Read from the most recent applied transition into `ReadOnly`: a null `actorUserId` is the
   * system, a set one is somebody who decided it. Null when there is no such row at all, which
   * means the state was set some other way and is not this service's to undo.
   */
  private async readOnlyWasSystemMade(tenantId: string): Promise<boolean> {
    const latest = await this.prisma.client.tenantLifecycleTransition.findFirst({
      where: {
        tenantId,
        toState: TenantLifecycleState.ReadOnly,
        appliedAt: { not: null },
      },
      orderBy: { effectiveAt: 'desc' },
      select: { actorUserId: true },
    });
    return latest !== null && latest.actorUserId === null;
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
