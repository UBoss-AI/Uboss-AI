import { createHash } from 'node:crypto';

import { ConflictException, Injectable, Logger } from '@nestjs/common';

import type { AccountState, SeatCountingRule } from '../generated/prisma/client.js';
import { PrismaService } from '../persistence/prisma.service.js';
import type { TenantScope } from '../persistence/tenant-context.js';

/** Fraction of the ceiling at which a company is warned. */
export const SEAT_WARNING_FRACTION = 0.9;

/**
 * Which account states each rule counts as a consumed seat.
 *
 * A pure lookup, so the counting rule is one table rather than a condition repeated at every
 * call site — and so the whole of "what counts as a seat" is auditable by reading eight lines.
 */
export const COUNTED_ACCOUNT_STATES: Record<SeatCountingRule, readonly AccountState[]> = {
  /** Only somebody who can actually sign in. Invitations are free. */
  ActiveOnly: ['Active'],
  /** The safer default: an outstanding invitation is a committed seat. */
  ActiveAndInvited: ['Active', 'InvitePending'],
  /** For per-provisioned-person contracts: suspending somebody does not free their seat. */
  ActiveInvitedAndSuspended: ['Active', 'InvitePending', 'Suspended'],
};

export interface SeatPosition {
  /** The contracted ceiling actually in force right now, grace included. */
  ceiling: number | null;
  /** The contracted ceiling on the subscription, ignoring any grace window. */
  contractedCeiling: number | null;
  used: number;
  available: number | null;
  rule: SeatCountingRule;
  /** Which account states this company's rule counts. Shown, so the number is explicable. */
  countedStates: readonly AccountState[];
  /** Per-state counts, so "why is used 31 when 28 people work here" has an answer. */
  breakdown: Record<string, number>;
  /** True at or above {@link SEAT_WARNING_FRACTION} of the ceiling. */
  nearCeiling: boolean;
  atCeiling: boolean;
  /** Set while a downgrade grace window holds the old, higher ceiling. */
  grace: { until: string; heldCeiling: number; contractedCeiling: number } | null;
  /** Whether this company may request more seats, or is simply blocked at the ceiling. */
  mayRequestMore: boolean;
}

/**
 * Seat counting and enforcement.
 *
 * ## The rule that matters
 *
 * **Nothing may silently exceed the contracted ceiling.** The client says so directly, and it is
 * the reason this is a service with a claim step rather than a number rendered on a screen: a
 * count that is only *displayed* gets exceeded by two concurrent invitations, and nobody notices
 * until the invoice.
 *
 * ## Why the check and the write must be one transaction
 *
 * Two administrators inviting the last seat at the same moment both read `used = 24` against a
 * ceiling of 25, both decide there is room, and both write. The company ends up at 26 seats on a
 * 25-seat contract, and no error was raised anywhere.
 *
 * `claimSeat` takes a **transaction-scoped advisory lock keyed on the tenant** before counting,
 * so the two attempts queue and the second sees 25. Same mechanism as the audit chain (ADR-046),
 * for the same reason: a read-then-write invariant needs the read and the write inside one
 * serialised unit. `seats-lifecycle.e2e.spec.ts` runs the race.
 *
 * ## Reducing seats deletes nothing
 *
 * The client is explicit: reducing contracted seats must never delete users, employment history,
 * tasks, Agent history or audit history. This service has **no delete path at all**. A downgrade
 * sets a grace window that holds the old ceiling, so a company at 30 people dropping to 25 seats
 * keeps working while it decides who to offboard — and offboarding is a separate, deliberate act
 * that itself preserves history.
 *
 * ## Seats are not permissions
 *
 * A seat is a commercial unit. Whether the person in it may do anything is the Prompt 7 engine's
 * question, and these two never consult each other. Buying more seats grants nobody any
 * authority.
 */
@Injectable()
export class SeatService {
  private readonly logger = new Logger(SeatService.name);

  constructor(private readonly prisma: PrismaService) {}

  /**
   * The company's current seat position.
   *
   * Read-only and safe to call from a screen. It reports the same numbers `claimSeat` enforces,
   * computed by the same code — so a screen showing "1 seat available" cannot disagree with the
   * refusal a moment later.
   */
  async positionFor(scope: TenantScope): Promise<SeatPosition> {
    return this.prisma.runInTenantTransaction(scope, () => this.computePosition(scope.tenantId));
  }

  /**
   * The same seat position, read from the platform plane.
   *
   * A separate method rather than `positionFor(tenantScopeForPlatformOperation(id))`, because
   * that helper must never be handed a value that came out of a request — and a Master Console
   * route's `:tenantId` is exactly that. This reads as a declared platform operation instead, the
   * same shape `assessReduction` already uses, so the rule holds without the caller having to
   * remember it.
   *
   * The numbers are computed by the same code the enforcement uses. A platform screen showing a
   * different count from the one that refuses an invitation would be worse than no screen.
   */
  async positionForPlatform(tenantId: string): Promise<SeatPosition> {
    return this.prisma.runAsPlatformOperation(() => this.computePosition(tenantId));
  }

  /**
   * Take a seat for a person entering a counted state, or refuse.
   *
   * Called by anything that would push a membership into a counted state — issuing an invitation,
   * activating an account, reinstating a suspended one. The caller passes the state being moved
   * **to** so this can tell whether a seat is even consumed: under `ActiveOnly`, issuing an
   * invitation takes nothing.
   *
   * Must be called **inside the caller's transaction**, so the seat claim and the membership
   * change commit together. A claim that committed separately would reserve a seat for a change
   * that then failed.
   */
  async claimSeat(input: {
    tenantId: string;
    /** The account state the membership is moving into. */
    targetState: AccountState;
    /** Set when a person already occupies a counted seat and is moving between counted states. */
    alreadyCounted?: boolean;
  }): Promise<SeatPosition> {
    const position = await this.lockAndCompute(input.tenantId);

    const consumes = position.countedStates.includes(input.targetState);
    if (!consumes || input.alreadyCounted) {
      // Nothing to claim: either this state is free under the company's rule, or the person is
      // already occupying a seat and is only changing which counted state they are in.
      return position;
    }

    if (position.ceiling === null) {
      // No ceiling means no plan yet. Refused rather than treated as unlimited: a company with
      // no subscription has bought nothing, and defaulting to unlimited is how an unbilled
      // company ends up with two hundred users.
      throw new ConflictException(
        'This company has no contracted seat ceiling because it has no plan. A plan has to be ' +
          'assigned before people can be added.',
      );
    }

    if (position.used >= position.ceiling) {
      const suffix = position.mayRequestMore
        ? ' Request more seats from Settings → Billing, and a platform administrator will decide.'
        : ' This plan does not allow seat requests; the plan itself has to change.';

      throw new ConflictException(
        `This company is at its contracted ceiling of ${position.ceiling} seat(s), with ` +
          `${position.used} in use. Adding another person would exceed the contract, so it is ` +
          `refused rather than allowed and billed later.${suffix}`,
      );
    }

    return {
      ...position,
      used: position.used + 1,
      available: position.ceiling - position.used - 1,
    };
  }

  /**
   * Whether a company is at its ceiling, without attempting a claim.
   *
   * For a screen deciding whether to disable an Invite button. A courtesy: `claimSeat` is the
   * enforcement, and this can be stale by the time the click happens — which is exactly why the
   * claim exists.
   */
  async hasRoom(scope: TenantScope, targetState: AccountState): Promise<boolean> {
    const position = await this.positionFor(scope);
    if (!position.countedStates.includes(targetState)) {
      return true;
    }
    return position.ceiling === null ? false : position.used < position.ceiling;
  }

  /**
   * Take the tenant's seat lock, then count.
   *
   * The lock is transaction-scoped, so it releases on commit or rollback with no cleanup path to
   * get wrong, and it is keyed per company, so two companies never wait on each other.
   *
   * `$executeRawUnsafe`, not `$queryRawUnsafe`: `pg_advisory_xact_lock` returns `void`, and the
   * driver adapter cannot deserialize a void column — the lesson from Prompt 8, applied before
   * it could bite again.
   */
  private async lockAndCompute(tenantId: string): Promise<SeatPosition> {
    const lock = SeatService.seatLockKey(tenantId);
    await this.prisma.client.$executeRawUnsafe(`SELECT pg_advisory_xact_lock(${lock.toString()})`);
    return this.computePosition(tenantId);
  }

  /**
   * Count the seats.
   *
   * One grouped query rather than one count per state: five round trips to produce five integers
   * is the kind of thing that looks harmless and shows up as latency on every invitation.
   */
  private async computePosition(tenantId: string): Promise<SeatPosition> {
    const [subscription, grouped] = await Promise.all([
      this.prisma.client.tenantSubscription.findUnique({
        where: { tenantId },
        include: { plan: true },
      }),
      this.prisma.client.tenantMembership.groupBy({
        by: ['accountState'],
        where: { tenantId },
        _count: { _all: true },
      }),
    ]);

    const breakdown: Record<string, number> = {};
    for (const row of grouped) {
      breakdown[row.accountState] = row._count._all;
    }

    // The override is the exception that exists because negotiated contracts exist; the plan's
    // rule is the norm. `ActiveAndInvited` is the fallback when there is no plan at all, so the
    // *reported* counting rule is never undefined even for an unsubscribed company.
    const rule: SeatCountingRule =
      subscription?.seatCountingOverride ??
      subscription?.plan.seatCountingRule ??
      'ActiveAndInvited';
    const countedStates = COUNTED_ACCOUNT_STATES[rule];

    const used = countedStates.reduce((sum, state) => sum + (breakdown[state] ?? 0), 0);

    const contractedCeiling = subscription?.seatsLicensed ?? subscription?.plan.seatLimit ?? null;

    // A live grace window holds the OLD, higher ceiling. This is what makes a downgrade
    // non-destructive: the company keeps working while it gets under the new number.
    const graceLive =
      subscription?.seatGraceUntil !== null &&
      subscription?.seatGraceUntil !== undefined &&
      subscription.seatGraceUntil.getTime() > Date.now() &&
      subscription.seatGraceCeiling !== null;

    const ceiling = graceLive ? (subscription.seatGraceCeiling as number) : contractedCeiling;

    return {
      ceiling,
      contractedCeiling,
      used,
      available: ceiling === null ? null : Math.max(0, ceiling - used),
      rule,
      countedStates,
      breakdown,
      nearCeiling: ceiling !== null && ceiling > 0 && used / ceiling >= SEAT_WARNING_FRACTION,
      atCeiling: ceiling !== null && used >= ceiling,
      grace:
        graceLive && subscription
          ? {
              until: (subscription.seatGraceUntil as Date).toISOString(),
              heldCeiling: subscription.seatGraceCeiling as number,
              contractedCeiling: contractedCeiling ?? 0,
            }
          : null,
      mayRequestMore: subscription?.plan.allowSeatRequests ?? false,
    };
  }

  /**
   * A stable positive 63-bit advisory-lock key for one tenant's seat count.
   *
   * Namespaced with `seat:` so it cannot collide with the audit chain's locks, which use the same
   * mechanism on the same database. A collision would only mean two unrelated operations
   * serialising — slower, never incorrect — but keeping the namespaces distinct means that never
   * has to be reasoned about.
   */
  static seatLockKey(tenantId: string): bigint {
    const digest = createHash('sha256').update(`seat:${tenantId}`, 'utf8').digest();
    return BigInt(`0x${digest.subarray(0, 8).toString('hex')}`) & 0x7fff_ffff_ffff_ffffn;
  }

  /**
   * Refuse a seat reduction that would be destructive, and explain the alternative.
   *
   * Not called by the reduction path — reducing seats is *always* allowed, because the platform
   * must be able to record a contract change it has agreed. This exists so the platform sees the
   * consequence before agreeing: "this company has 31 counted seats and you are proposing 25".
   *
   * The reduction then applies with a grace window rather than by removing anybody.
   */
  async assessReduction(input: { tenantId: string; newCeiling: number }): Promise<{
    used: number;
    newCeiling: number;
    overBy: number;
    needsGrace: boolean;
    /** What the platform must understand before agreeing. */
    note: string;
  }> {
    const position = await this.prisma.runAsPlatformOperation(() =>
      this.computePosition(input.tenantId),
    );
    const overBy = Math.max(0, position.used - input.newCeiling);

    return {
      used: position.used,
      newCeiling: input.newCeiling,
      overBy,
      needsGrace: overBy > 0,
      note:
        overBy > 0
          ? `This company has ${position.used} counted seat(s) and would be ${overBy} over a ` +
            `ceiling of ${input.newCeiling}. Nobody is removed: a grace window holds the ` +
            `current ceiling while the company offboards, and no user, employment record, task, ` +
            `Agent history or audit row is deleted by this change.`
          : `This company has ${position.used} counted seat(s), which is within a ceiling of ` +
            `${input.newCeiling}. No grace window is needed.`,
    };
  }
}
