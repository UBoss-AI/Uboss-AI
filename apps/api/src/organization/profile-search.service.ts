import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';

import {
  decideProfileSearch,
  DEFAULT_PERFORMANCE_SHARING,
  onTimePercent,
  PERFORMANCE_SHARING_MODES,
  APPROVED_REWARD_STATES,
  shareablePerformance,
  TERMINAL_HUMAN_TASK_STATUSES,
  type PerformanceSharingMode,
  type PortableEmployment,
  type PortableProfile,
} from '@uboss/types';

import { AuditEventService } from '../audit/audit-event.service.js';
import { AuthorizationService } from '../authorization/authorization.service.js';
import { isUbossUniqueId } from '../persistence/uboss-unique-id.js';
import { PrismaService } from '../persistence/prisma.service.js';
import type { TenantScope } from '../persistence/tenant-context.js';
import { tenantScopeForPlatformOperation } from '../persistence/tenant-context.js';
import { CompanySettingsService } from '../settings/company-settings.service.js';

/**
 * Portable UBoss Profile Search — Prompt 37A.
 *
 * ## The one read in this product that deliberately crosses tenancies
 *
 * Everything else is confined by Row-Level Security to one company. A portable profile is the
 * exception UBoss exists to provide: a person's employment history belongs to the person, not to
 * whichever company holds a row about them.
 *
 * That makes it the highest-risk read in the product, so it is built the other way round from
 * every other query here — **nothing is fetched and then filtered**. Each step below narrows
 * before the next one runs:
 *
 * 1. **The caller's own tenant decides whether they may search at all.** Permission and company
 *    policy are both evaluated inside the searching company's scope, before anything else.
 * 2. **The input is validated as a UBoss Unique ID.** Not an email, not a name, not a partial —
 *    a search that accepted those would be an enumeration tool rather than a verification one.
 * 3. **The cross-tenant read is a platform operation over a narrow `select`.** Not a row with
 *    fields deleted afterwards: a `select` that never names a column cannot leak it when somebody
 *    adds one.
 * 4. **Each source company's own policy decides whether its performance travels.**
 * 5. **The lookup is audited in the searching company's trail**, whether or not it found anybody.
 *
 * ## Why "not found" and "found" look the same to an attacker, and why that is enough
 *
 * A lookup for an unknown id 404s and a lookup for a known one returns a profile, so the endpoint
 * does confirm that an id exists. That is acceptable because a UBoss Unique ID is not a secret —
 * `uboss-unique-id.ts` says so, and it is printed on screens and read aloud — and because the id
 * space is 32^8 with an unambiguous alphabet, which is not guessable. What would matter is
 * enumeration by *name or email*, and there is no route that accepts either.
 */
@Injectable()
export class ProfileSearchService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly authorization: AuthorizationService,
    private readonly auditEvents: AuditEventService,
    private readonly companySettings: CompanySettingsService,
  ) {}

  /**
   * Look a person up by their UBoss Unique ID.
   *
   * `profile-search:View` **and** `users:Administer` — the module grant, and HR/Admin authority
   * over employment records. The source documents say *"Authorized HR/Admin"*, and
   * `profile-search:View` alone is on every role template, so it cannot be the whole control: it
   * governs whether the nav item appears, not whether a person may read another company's
   * employment history.
   */
  async search(input: {
    scope: TenantScope;
    actorUserId: string;
    ubossUniqueId: string;
  }): Promise<PortableProfile> {
    // ---- 1. May this person search, in their own company? ----
    const context = await this.authorization.contextFor(input.scope, input.actorUserId);
    await this.authorization.assertCan(context, { module: 'profile-search', action: 'View' });
    await this.authorization.assertCan(context, { module: 'users', action: 'Administer' });

    const enabled = await this.searchEnabledFor(input.scope);
    const policy = decideProfileSearch({ enabledForSearcher: enabled });
    if (!policy.permitted) {
      throw new ForbiddenException(policy.reason);
    }

    // ---- 2. Is the input a UBoss Unique ID? ----
    const query = input.ubossUniqueId.trim().toUpperCase();
    if (!isUbossUniqueId(query)) {
      throw new BadRequestException(
        'That is not a UBoss Unique ID. A portable profile is found by UBoss Unique ID and by ' +
          'nothing else — not a name, an email or an Aadhaar number.',
      );
    }

    // ---- 5, first half. Audited whether or not it finds anybody. ----
    //
    // Written before the read rather than after it, so a lookup that throws is still on the
    // record. "Who did this person search for" is the question this trail exists to answer, and a
    // search that failed is as interesting as one that succeeded.
    await this.auditEvents.recordForTenant(input.scope, {
      action: 'profile_search.performed',
      resourceType: 'uboss-profile',
      resourceId: query,
      actorUserId: input.actorUserId,
      summary: `Portable profile search for ${query}.`,
      metadata: { ubossUniqueId: query },
    });

    // ---- 3. The cross-tenant read. ----
    const profile = await this.readPortableProfile(query);
    if (profile === null) {
      throw new NotFoundException(
        'No UBoss profile has that ID. Check it with the person — a UBoss Unique ID is printed ' +
          'on their profile screen.',
      );
    }

    return profile;
  }

  // -------------------------------------------------------------------------
  // The cross-tenant read
  // -------------------------------------------------------------------------

  /**
   * Assemble the profile.
   *
   * A platform operation, deliberately and with the reason stated: this is the one query that must
   * see rows from companies the caller does not belong to. Every `select` below is a whitelist,
   * and the shape returned is `PortableProfile` — which a test asserts field-by-field and then
   * greps for forbidden words.
   */
  private async readPortableProfile(ubossUniqueId: string): Promise<PortableProfile | null> {
    return this.prisma.runAsPlatformOperation(async () => {
      const person = await this.prisma.client.user.findUnique({
        where: { ubossUniqueId },
        // Two columns. The row also carries an email, a platform-actor flag and authentication
        // state, none of which belongs to another company.
        select: { id: true, ubossUniqueId: true, displayName: true },
      });
      if (person === null) return null;

      const records = await this.prisma.client.employmentRecord.findMany({
        where: { userId: person.id },
        orderBy: [{ joinedOn: 'desc' }, { createdAt: 'desc' }],
        select: {
          tenantId: true,
          designation: true,
          joinedOn: true,
          endedAt: true,
          // Deliberately absent: `employeeId` is the *other company's* internal numbering,
          // `departmentId` is their org structure, `workEmail` and `workPhone` are contact details
          // they hold, and `reportingManagerUserId` names a third person who did not consent to
          // appear in somebody else's verification.
          tenant: { select: { name: true } },
        },
      });

      const employments: PortableEmployment[] = [];
      for (const record of records) {
        employments.push({
          companyName: record.tenant.name,
          designation: record.designation,
          joinedOn: record.joinedOn?.toISOString() ?? null,
          endedAt: record.endedAt?.toISOString() ?? null,
          isCurrent: record.endedAt === null,
          performance: await this.performanceFor({
            tenantId: record.tenantId,
            userId: person.id,
          }),
        });
      }

      return {
        ubossUniqueId: person.ubossUniqueId,
        displayName: person.displayName,
        employments,
        searchedAt: new Date().toISOString(),
      };
    });
  }

  /**
   * One company's performance summary, or nothing.
   *
   * **The source company's own setting decides**, read from that company's settings rather than
   * the searcher's. `shareablePerformance` then builds the shape, so `BadgeOnly` cannot return a
   * score however this method is edited later.
   */
  private async performanceFor(input: {
    tenantId: string;
    userId: string;
  }): Promise<PortableEmployment['performance']> {
    const mode = await this.sharingModeFor(input.tenantId);
    if (mode === 'Nothing') return null;

    const [events, badge, tasks, rewards] = await Promise.all([
      this.prisma.client.performanceEvent.aggregate({
        where: { tenantId: input.tenantId, subjectUserId: input.userId },
        _sum: { points: true },
      }),
      this.prisma.client.badgeHistory.findFirst({
        where: { tenantId: input.tenantId, subjectUserId: input.userId },
        // The exit snapshot when there is one, otherwise the live badge. A person who has left
        // should be described by the badge they left with, not by a row that never ended.
        orderBy: [{ isExitSnapshot: 'desc' }, { startedAt: 'desc' }],
        select: { level: true },
      }),
      this.prisma.client.humanTask.findMany({
        where: {
          tenantId: input.tenantId,
          assignedToUserId: input.userId,
          status: { in: [...TERMINAL_HUMAN_TASK_STATUSES] },
          dueAt: { not: null },
        },
        // Two dates and nothing else. **Not the title, not the objective, not the evidence** —
        // the task's contents are the other company's work, and the prompt forbids them by name.
        select: { dueAt: true, completedAt: true },
        take: 5000,
      }),
      // `RewardAward` is the per-person record; `ObjectiveReward` is the rule on the objective
      // and has no recipient. **Two columns and no title**: a reward's only human-readable label
      // is its Objective, which a portable profile must never carry.
      this.prisma.client.rewardAward.findMany({
        where: {
          tenantId: input.tenantId,
          subjectUserId: input.userId,
          status: { in: APPROVED_REWARD_STATES as never },
        },
        orderBy: [{ createdAt: 'desc' }],
        select: { createdAt: true },
        take: 1,
      }),
    ]);

    const withDueDate = tasks.filter((task) => task.completedAt !== null).length;
    const onTime = tasks.filter(
      (task) =>
        task.completedAt !== null &&
        task.dueAt !== null &&
        task.completedAt.getTime() <= task.dueAt.getTime(),
    ).length;

    const approvedCount = await this.prisma.client.rewardAward.count({
      where: {
        tenantId: input.tenantId,
        subjectUserId: input.userId,
        status: { in: APPROVED_REWARD_STATES as never },
      },
    });

    return shareablePerformance({
      mode,
      score: events._sum.points ?? 0,
      badge: badge?.level ?? null,
      onTimePercent: onTimePercent({ onTime, withDueDate }),
      achievements: {
        count: approvedCount,
        mostRecentAt: rewards[0]?.createdAt.toISOString() ?? null,
      },
    });
  }

  // -------------------------------------------------------------------------
  // Policy
  // -------------------------------------------------------------------------

  /** Whether the *searching* company has switched portable search on. */
  async searchEnabledFor(scope: TenantScope): Promise<boolean> {
    try {
      const value = await this.companySettings.effectiveValue(
        scope,
        'security.portable_profile_search_enabled',
      );
      return value === true || value === 'true';
    } catch {
      // Off. A settings read that failed must never make a cross-company lookup *more* available
      // than the company configured.
      return false;
    }
  }

  /** Whether the *source* company shares its performance record, and how much. */
  private async sharingModeFor(tenantId: string): Promise<PerformanceSharingMode> {
    try {
      const value = await this.companySettings.effectiveValue(
        tenantScopeForPlatformOperation(tenantId),
        'security.portable_performance_sharing',
      );
      return PERFORMANCE_SHARING_MODES.includes(value as PerformanceSharingMode)
        ? (value as PerformanceSharingMode)
        : DEFAULT_PERFORMANCE_SHARING;
    } catch {
      return DEFAULT_PERFORMANCE_SHARING;
    }
  }
}
