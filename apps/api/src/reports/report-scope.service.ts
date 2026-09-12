import { ForbiddenException, Injectable } from '@nestjs/common';

import {
  permissionsForReport,
  SCOPE_DESCRIPTIONS,
  type ReportDefinition,
  type ReportScope,
  type ScopeKind,
} from '@uboss/types';

import { AuthorizationService } from '../authorization/authorization.service.js';
import { OrganizationRepository } from '../persistence/organization.repository.js';
import { PrismaService } from '../persistence/prisma.service.js';
import type { TenantScope } from '../persistence/tenant-context.js';

/**
 * Who a report may be about — Prompt 37.
 *
 * ## One resolver, called by every report
 *
 * The prompt's requirement is *"Managers/Admins see only allowed scope"*, and the way that goes
 * wrong is not a missing check — it is **ten** checks, nine of which are right. So the scope is
 * resolved here once, returned as a set of user ids, and every query in `ReportsService` applies
 * it the same way. A report that forgot to would return an unfiltered list, which is why the
 * service takes the scope as a parameter rather than resolving it per method.
 *
 * ## `null` means everybody, and an empty list means nobody
 *
 * The most dangerous default a reporting layer can have is "an empty filter means no filter". A
 * manager with nobody reporting to them resolves to `[]`, and every report must then be empty —
 * not unfiltered. `null` is produced **only** by a `WholeCompany` grant, deliberately and in one
 * place, so a bug that produced an empty list narrows rather than widens.
 *
 * ## A client cannot widen this
 *
 * `narrow` is the only way a caller influences it, and it intersects. A filter arriving from a
 * screen can ask for less; nothing it can send asks for more.
 */
@Injectable()
export class ReportScopeService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly authorization: AuthorizationService,
    private readonly organization: OrganizationRepository,
  ) {}

  /**
   * Check both permissions and resolve the scope, in that order.
   *
   * **Both** permissions: `reports:View` says this person may open the Reports section, and the
   * source module's `View` says they may see this particular data. Gating on the first alone
   * would make Reports a way around every other module's permissions — the single most likely
   * leak in an enterprise reporting feature, and the reason `permissionsForReport` returns a list
   * rather than one entry.
   */
  async forReport(input: {
    scope: TenantScope;
    actorUserId: string;
    report: ReportDefinition;
  }): Promise<ReportScope> {
    const context = await this.authorization.contextFor(input.scope, input.actorUserId);

    for (const permission of permissionsForReport(input.report)) {
      await this.authorization.assertCan(context, permission);
    }

    return this.resolve({
      scope: input.scope,
      actorUserId: input.actorUserId,
      scopeKind: ReportScopeService.widestScope(context.roleSummary.map((role) => role.scopeKind)),
    });
  }

  /** The dashboard's counts use the same resolution, without a report definition. */
  async forDashboard(input: { scope: TenantScope; actorUserId: string }): Promise<ReportScope> {
    const context = await this.authorization.contextFor(input.scope, input.actorUserId);
    // No permission assertion here: the dashboard is the landing screen for every signed-in
    // member, and the counts are already confined to what this scope permits. What a person may
    // *do* with an agent or a task is checked when they open it.
    return this.resolve({
      scope: input.scope,
      actorUserId: input.actorUserId,
      scopeKind: ReportScopeService.widestScope(context.roleSummary.map((role) => role.scopeKind)),
    });
  }

  /** Whether this person may take a report out of UBoss. A different act from reading it. */
  async assertMayExport(scope: TenantScope, actorUserId: string): Promise<void> {
    const context = await this.authorization.contextFor(scope, actorUserId);
    const decision = await this.authorization.authorize(context, {
      module: 'reports',
      action: 'Export',
    });

    if (!decision.allowed) {
      throw new ForbiddenException(
        'You can read this report but not export it. Taking a company’s data out of UBoss is a ' +
          'separate permission from reading it on screen.',
      );
    }
  }

  // -------------------------------------------------------------------------
  // Internals
  // -------------------------------------------------------------------------

  /**
   * The widest scope any of this person's roles grants.
   *
   * Two roles mean the union of what they permit, which is how the authorization engine already
   * treats them — a person who is both an Employee and a Manager is a manager. Taking the
   * *narrowest* would make adding a role reduce somebody's reach, which nobody expects.
   */
  private static widestScope(kinds: readonly ScopeKind[]): ScopeKind {
    const order: ScopeKind[] = [
      'SelectedResource',
      'OwnWork',
      'TeamSubtree',
      'Department',
      'MultipleDepartments',
      'WholeCompany',
    ];

    let widest: ScopeKind = 'OwnWork';
    for (const kind of kinds) {
      if (order.indexOf(kind) > order.indexOf(widest)) {
        widest = kind;
      }
    }
    return widest;
  }

  private async resolve(input: {
    scope: TenantScope;
    actorUserId: string;
    scopeKind: ScopeKind;
  }): Promise<ReportScope> {
    const description = SCOPE_DESCRIPTIONS[input.scopeKind];

    switch (input.scopeKind) {
      case 'WholeCompany':
        // The one place `null` is produced. Everything else returns a list, so a bug elsewhere
        // narrows a report rather than widening it.
        return {
          kind: input.scopeKind,
          userIds: null,
          departmentIds: null,
          description,
        };

      case 'Department':
      case 'MultipleDepartments': {
        const departments = await this.departmentsOf(input.scope, input.actorUserId);
        const userIds = await this.usersInDepartments(input.scope, departments);
        return { kind: input.scopeKind, userIds, departmentIds: departments, description };
      }

      case 'TeamSubtree': {
        const userIds = await this.organization.reportingSubtreeUserIds({
          tenantId: input.scope.tenantId,
          managerUserId: input.actorUserId,
        });
        return {
          kind: input.scopeKind,
          // A manager is inside their own subtree — the resolver already treats it that way, and a
          // manager who could see their team's work but not their own would be strange.
          userIds,
          departmentIds: null,
          description,
        };
      }

      case 'OwnWork':
      case 'SelectedResource':
      default:
        // `SelectedResource` grants named records rather than a set of people, and a report is a
        // set. Treating it as `OwnWork` is the conservative reading: it shows this person their
        // own rows rather than guessing which named records a report should include.
        return {
          kind: input.scopeKind,
          userIds: [input.actorUserId],
          departmentIds: null,
          description,
        };
    }
  }

  private async departmentsOf(scope: TenantScope, userId: string): Promise<string[]> {
    const records = await this.prisma.runInTenantTransaction(scope, () =>
      this.prisma.client.employmentRecord.findMany({
        where: { tenantId: scope.tenantId, userId },
        select: { departmentId: true },
      }),
    );
    return [...new Set(records.map((record) => record.departmentId))];
  }

  private async usersInDepartments(
    scope: TenantScope,
    departmentIds: readonly string[],
  ): Promise<string[]> {
    if (departmentIds.length === 0) {
      // Nobody, not everybody. A person with a department grant and no department is a
      // configuration mistake, and the safe reading of it is an empty report.
      return [];
    }

    const records = await this.prisma.runInTenantTransaction(scope, () =>
      this.prisma.client.employmentRecord.findMany({
        where: { tenantId: scope.tenantId, departmentId: { in: [...departmentIds] } },
        select: { userId: true },
      }),
    );
    return [...new Set(records.map((record) => record.userId))];
  }

  /**
   * Apply a scope to a Prisma `where` fragment on a user column.
   *
   * One helper rather than the same ternary in ten queries — which is how nine of them end up
   * right and one does not.
   */
  static userFilter(scope: ReportScope, column: string): Record<string, unknown> {
    if (scope.userIds === null) return {};
    return { [column]: { in: [...scope.userIds] } };
  }
}
