import { ConflictException, Injectable } from '@nestjs/common';

import {
  ACCESS_LEVELS,
  COMPANY_MODULES,
  COMPANY_MODULE_LABELS,
  SECTION_LEVELS,
  accessLevelRank,
  actionsForLevel,
  levelGrantProblem,
  sectionLevelLine,
  type AccessLevel,
  type Action,
  type CompanyModuleKey,
  type PermissionSet,
} from '@uboss/types';

import { AuditEventService } from '../audit/audit-event.service.js';
import { AuthorizationService } from '../authorization/authorization.service.js';
import { PrismaService } from '../persistence/prisma.service.js';
import { SECURITY_ACTIONS, SecurityEventPublisher } from '../auth/security-event.publisher.js';
import type { TenantScope } from '../persistence/tenant-context.js';

/**
 * The prefix a section-and-level role carries, so these can be told from a company's own roles.
 *
 * Deliberately different from `CAPABILITY_ROLE_PREFIX`: the two mechanisms grant through the same
 * table and a company may hold both, and a reader of the roles list has to be able to see which
 * screen produced which.
 */
export const LEVEL_ROLE_PREFIX = 'UBoss access · ';

function levelRoleName(module: CompanyModuleKey, level: AccessLevel): string {
  return `${LEVEL_ROLE_PREFIX}${COMPANY_MODULE_LABELS[module]} · ${level}`;
}

/**
 * Access chosen a section at a time — CR-04.
 *
 * ## Why this is not a second RBAC system
 *
 * A level expands to actions on one module and is written as a shared custom role assigned to the
 * person, which is exactly what `CapabilityService` already does. The authorization engine is
 * untouched and remains the only thing that decides anything; what is new is that an
 * administrator picks "Objective Optimization · Creator" instead of ticking `objective:EditDraft`.
 *
 * ## Why the roles are shared
 *
 * One role per (section, level) for the whole company, rather than one per person. Authority
 * comes from the *assignment*, so removing somebody's access deletes their assignment and leaves
 * the role for everybody else — the arrangement `CapabilityService` arrived at after the
 * one-role-per-grant version stripped a capability from everyone who held it.
 */
@Injectable()
export class AccessLevelService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly authorization: AuthorizationService,
    private readonly audit: AuditEventService,
    private readonly securityEvents: SecurityEventPublisher,
  ) {}

  /**
   * Every section, what this person holds on it, and what the administrator may set.
   *
   * Built for one screen, so the refusals travel with the options: a level the granter may not
   * hand out arrives disabled **and** carrying the reason, because a greyed control with no
   * explanation is the thing that generates support tickets.
   */
  async view(input: { scope: TenantScope; actorUserId: string; subjectUserId: string }): Promise<{
    sections: {
      module: CompanyModuleKey;
      label: string;
      levels: {
        level: AccessLevel;
        label: string;
        line: string;
        held: boolean;
        canGrant: boolean;
        whyNot: string | null;
      }[];
    }[];
  }> {
    const context = await this.authorization.contextFor(input.scope, input.actorUserId);
    await this.authorization.assertCan(context, { module: 'users', action: 'ManageAccess' });

    const [subjectHolds, granterHolds, granterIsAdmin] = await Promise.all([
      this.levelsOf(input.scope, input.subjectUserId),
      this.levelsOf(input.scope, input.actorUserId),
      this.isCompanyAdmin(input.scope, input.actorUserId),
    ]);

    return {
      sections: COMPANY_MODULES.map((module) => ({
        module,
        label: COMPANY_MODULE_LABELS[module],
        levels: SECTION_LEVELS[module].map((level) => {
          const whyNot = levelGrantProblem({
            granterLevel: granterHolds.get(module) ?? null,
            requested: level,
            module,
            granterIsCompanyAdmin: granterIsAdmin,
          });

          const held = this.holdsAtLeast(subjectHolds.get(module) ?? null, level);

          return {
            level,
            label: level,
            line: sectionLevelLine(module, level),
            held,
            canGrant: whyNot === null,
            whyNot,
          };
        }),
      })),
    };
  }

  /**
   * Set somebody's level on one section, or clear it.
   *
   * ## Why one call and not a tick per level
   *
   * The screen shows four boxes and a higher one includes the lower ones, so what a person
   * actually has on a section is a single answer — the highest level they hold. Sending that
   * answer, rather than a stream of individual ticks, is what stops two administrators editing
   * one person from leaving them with Approver and no Viewer.
   *
   * Clearing is `null`, which removes every level assignment on that section. "No access" is a
   * real answer and has to be reachable; unticking the last box is how somebody says it.
   */
  async setLevel(input: {
    scope: TenantScope;
    actorUserId: string;
    subjectUserId: string;
    module: CompanyModuleKey;
    level: AccessLevel | null;
  }): Promise<void> {
    const context = await this.authorization.contextFor(input.scope, input.actorUserId);
    await this.authorization.assertCan(context, { module: 'users', action: 'ManageAccess' });

    if (input.level !== null && !SECTION_LEVELS[input.module].includes(input.level)) {
      throw new ConflictException(
        `${COMPANY_MODULE_LABELS[input.module]} does not offer ${input.level}. ` +
          `It offers: ${SECTION_LEVELS[input.module].join(', ')}.`,
      );
    }

    if (input.level !== null) {
      const [granterHolds, granterIsAdmin] = await Promise.all([
        this.levelsOf(input.scope, input.actorUserId),
        this.isCompanyAdmin(input.scope, input.actorUserId),
      ]);

      const problem = levelGrantProblem({
        granterLevel: granterHolds.get(input.module) ?? null,
        requested: input.level,
        module: input.module,
        granterIsCompanyAdmin: granterIsAdmin,
      });

      if (problem !== null) {
        /*
         * Recorded before it is refused, and outside any transaction.
         *
         * A refused escalation is a security event whether or not anything was written, and a
         * rollback would take the record of the attempt with it.
         */
        await this.securityEvents.record({
          action: SECURITY_ACTIONS.permissionDenied,
          actorUserId: input.actorUserId,
          tenantId: input.scope.tenantId,
          subjectUserId: input.subjectUserId,
          resourceType: 'access-level',
          summary: 'Refused an access level beyond the granter’s own authority.',
          metadata: { module: input.module, level: input.level },
        });
        throw new ConflictException(problem);
      }
    }

    await this.clearLevels(input.scope, input.subjectUserId, input.module);

    if (input.level !== null) {
      await this.writeLevel(
        input.scope,
        input.actorUserId,
        input.subjectUserId,
        input.module,
        input.level,
      );
    }

    await this.securityEvents.record({
      action: input.level === null ? SECURITY_ACTIONS.roleRevoked : SECURITY_ACTIONS.roleAssigned,
      actorUserId: input.actorUserId,
      tenantId: input.scope.tenantId,
      subjectUserId: input.subjectUserId,
      resourceType: 'access-level',
      summary:
        input.level === null
          ? `Removed access to ${COMPANY_MODULE_LABELS[input.module]}.`
          : `Set ${COMPANY_MODULE_LABELS[input.module]} to ${input.level}.`,
      metadata: { module: input.module, level: input.level ?? 'none' },
    });
  }

  // -------------------------------------------------------------------------
  // Reading what somebody holds
  // -------------------------------------------------------------------------

  /**
   * The level this person holds on each section, read off their real assignments.
   *
   * Read from the role names rather than re-derived from the permission sets: the name is what
   * this service wrote and is unambiguous, while two different grants can expand to overlapping
   * actions and "which level is that" would become a guess.
   */
  private async levelsOf(
    scope: TenantScope,
    userId: string,
  ): Promise<Map<CompanyModuleKey, AccessLevel>> {
    const assignments = await this.prisma.runInTenantTransaction(scope, () =>
      this.prisma.client.roleAssignment.findMany({
        where: { tenantId: scope.tenantId, userId, roleKind: 'Custom' },
        select: { customRole: { select: { displayName: true } } },
      }),
    );

    const held = new Map<CompanyModuleKey, AccessLevel>();

    for (const module of COMPANY_MODULES) {
      for (const level of SECTION_LEVELS[module]) {
        const name = levelRoleName(module, level);
        if (!assignments.some((row) => row.customRole?.displayName === name)) continue;

        const current = held.get(module);
        if (current === undefined || accessLevelRank(level) > accessLevelRank(current)) {
          held.set(module, level);
        }
      }
    }

    return held;
  }

  /** True when the level somebody holds is this one or above it. */
  private holdsAtLeast(held: AccessLevel | null, level: AccessLevel): boolean {
    return held !== null && accessLevelRank(held) >= accessLevelRank(level);
  }

  private async isCompanyAdmin(scope: TenantScope, userId: string): Promise<boolean> {
    const row = await this.prisma.runInTenantTransaction(scope, () =>
      this.prisma.client.roleAssignment.findFirst({
        where: { tenantId: scope.tenantId, userId, roleKind: 'CompanyAdmin' },
        select: { id: true },
      }),
    );
    return row !== null;
  }

  // -------------------------------------------------------------------------
  // Writing
  // -------------------------------------------------------------------------

  private async clearLevels(
    scope: TenantScope,
    subjectUserId: string,
    module: CompanyModuleKey,
  ): Promise<void> {
    const names = new Set(SECTION_LEVELS[module].map((level) => levelRoleName(module, level)));

    await this.prisma.runInTenantTransaction(scope, async () => {
      const assignments = await this.prisma.client.roleAssignment.findMany({
        where: { tenantId: scope.tenantId, userId: subjectUserId, roleKind: 'Custom' },
        select: { id: true, customRole: { select: { displayName: true } } },
      });

      for (const row of assignments) {
        if (row.customRole === null) continue;
        if (!names.has(row.customRole.displayName)) continue;
        // Only the assignment. The role is shared by everybody at that level in this company.
        await this.prisma.client.roleAssignment.delete({ where: { id: row.id } });
      }
    });
  }

  private async writeLevel(
    scope: TenantScope,
    actorUserId: string,
    subjectUserId: string,
    module: CompanyModuleKey,
    level: AccessLevel,
  ): Promise<void> {
    await this.prisma.runInTenantTransaction(scope, async () => {
      const roleId = await this.levelRole(scope, module, level);

      await this.prisma.client.roleAssignment.create({
        data: {
          tenantId: scope.tenantId,
          userId: subjectUserId,
          roleKind: 'Custom',
          customRoleId: roleId,
          // Never wider than the person's own work, for the same reason a capability is not:
          // choosing what somebody may do must not also choose how far they may reach.
          scopeKind: 'OwnWork',
          grantedByUserId: actorUserId,
        },
      });

      await this.audit.appendWithinCurrentScope(scope.tenantId, {
        action: 'access.level_set',
        actorUserId,
        resourceType: 'access-level',
        resourceId: roleId,
        summary: `Set ${COMPANY_MODULE_LABELS[module]} to ${level}.`,
        metadata: { module, level, subjectUserId },
      });
    });
  }

  /** The shared role for one section and level, created once per company. */
  private async levelRole(
    scope: TenantScope,
    module: CompanyModuleKey,
    level: AccessLevel,
  ): Promise<string> {
    const displayName = levelRoleName(module, level);

    const existing = await this.prisma.client.customRole.findFirst({
      where: { tenantId: scope.tenantId, displayName },
      select: { id: true },
    });
    if (existing !== null) return existing.id;

    /*
     * The actions this level carries, on this section and nowhere else.
     *
     * Narrowed to what the section actually offers: a module with no approvable thing of its own
     * must not be handed `Approve` just because the ladder mentions it, or the permission set
     * would say something the product does not mean.
     */
    const offered = new Set<Action>(
      SECTION_LEVELS[module].flatMap((candidate) => actionsForLevel(candidate)),
    );
    const actions = actionsForLevel(level).filter((action) => offered.has(action));
    const permissions = { [module]: actions } as PermissionSet;

    try {
      const created = await this.prisma.client.customRole.create({
        data: {
          tenantId: scope.tenantId,
          displayName,
          description: 'Granted through Access & Permissions.',
          permissions: permissions as never,
          maxScope: 'OwnWork',
        },
        select: { id: true },
      });
      return created.id;
    } catch (caught: unknown) {
      // Somebody else created it between the read and the write.
      if (
        typeof caught === 'object' &&
        caught !== null &&
        (caught as { code?: unknown }).code === 'P2002'
      ) {
        const won = await this.prisma.client.customRole.findFirst({
          where: { tenantId: scope.tenantId, displayName },
          select: { id: true },
        });
        if (won !== null) return won.id;
      }
      throw caught;
    }
  }

  /** The levels, for a screen that wants to draw them without knowing the ladder. */
  static levels(): readonly AccessLevel[] {
    return ACCESS_LEVELS;
  }
}
