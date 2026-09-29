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

    /*
     * The narrowest of the scopes the required permissions reach.
     *
     * A report sourced from a module you can only see narrowly is a narrow report, whichever
     * permission you hold more widely: `reports:View` across the company plus `settings:View` over
     * one department is a department's worth of rows, not the company's.
     */
    const reaches = permissionsForReport(input.report).map(
      (permission) =>
        this.authorization.reachForPermission(context, permission.module, permission.action) ?? {
          kind: ReportScopeService.heldScope(context),
          departmentIds: [],
        },
    );
    const narrowest = ReportScopeService.narrowestScope(reaches.map((reach) => reach.kind));

    /*
     * A report that cannot be narrowed is for a reader entitled to the whole company.
     *
     * Three reports carry `scoped: false`: their rows are company-wide facts with no person
     * attached — a catalogue of Skill versions, a day-by-day cost ledger, a trail of audit
     * events — so there is no column to filter them by. `ReportsService` therefore ignores the
     * resolved scope for them entirely, and that is correct: there is nothing to apply.
     *
     * Which leaves the question of who may open one. Until now the answer was "anybody holding
     * the source permission", so a reader scoped to their own work who happened to hold
     * `agents:View` was shown every Skill version in the company — narrow everywhere else in
     * the product, and company-wide here. The rule is now the one a reader would assume: if your
     * scope is anything less than the whole company, a report that cannot honour it is not yours
     * to open.
     *
     * Refused here rather than only hidden from the catalogue, because the catalogue is a list
     * and this is the route. Hiding it would leave the URL working.
     */
    if (!input.report.scoped && narrowest !== 'WholeCompany') {
      throw new ForbiddenException(
        `"${input.report.label}" covers the whole company and cannot be narrowed to your scope, ` +
          'so it is not available to you.',
      );
    }

    return this.resolve({
      scope: input.scope,
      actorUserId: input.actorUserId,
      scopeKind: narrowest,
      // The departments the granting assignments name, intersected across the required
      // permissions: a report needing two grants reaches only where both reach.
      departmentIds: ReportScopeService.commonDepartments(reaches),
    });
  }

  /**
   * Whether this person may open this report at all, for building the catalogue.
   *
   * The same two questions `forReport` asks — do you hold every permission it needs, and if it
   * cannot be narrowed are you entitled to the whole company — asked without throwing, because a
   * catalogue omits what you cannot read rather than failing to load.
   *
   * Deliberately a second call into the same rules rather than a copy of them: if the two ever
   * disagree, the route refuses and the list is merely wrong, which is the safe direction.
   */
  async mayRead(input: {
    scope: TenantScope;
    actorUserId: string;
    report: ReportDefinition;
  }): Promise<boolean> {
    try {
      await this.forReport(input);
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Which people a caller may be shown in a roster, by the same resolution.
   *
   * Users & Access listed every person in the company to anybody holding `users:View`, so a
   * Manager scoped to their own team saw the Company Admin, the Head and every other department —
   * six of six people in a six-person company. The server refused every *action* on them (403,
   * "Your role does not include ManageAccess"), so this was disclosure rather than escalation, but
   * a list of who works here, who reports to whom and what state their account is in is exactly
   * the kind of thing a team-scoped role is not given.
   *
   * No permission is asserted here: the caller has already been required to hold `users:View`, and
   * this answers the narrower question of *whose* rows that grant reaches.
   */
  async forPeopleList(input: { scope: TenantScope; actorUserId: string }): Promise<ReportScope> {
    const context = await this.authorization.contextFor(input.scope, input.actorUserId);
    return this.resolve({
      scope: input.scope,
      actorUserId: input.actorUserId,
      // The roster is `users:View`, so it reaches as far as the roles granting that — and no
      // further, however wide a role that does not grant it happens to be.
      ...ReportScopeService.reachOf(
        this.authorization.reachForPermission(context, 'users', 'View'),
        context,
      ),
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
      // Every role grants `dashboard:View`, so in practice this is the widest scope the person
      // holds — but it is now *why* it is, rather than a coincidence of holding a wide role.
      ...ReportScopeService.reachOf(
        this.authorization.reachForPermission(context, 'dashboard', 'View'),
        context,
      ),
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
   * What to resolve when **no** role grants the permission being exercised.
   *
   * Not `OwnWork`. A person whose only grant is a malformed one — a `Department` assignment naming
   * no department, which the service refuses but a direct database write can still produce — must
   * reach nobody, and the department branch of `resolve` says exactly that: "a person with a
   * department grant and no department is a configuration mistake, and the safe reading of it is an
   * empty report." Defaulting to `OwnWork` instead handed them their own row, which
   * `reports.e2e.spec.ts` caught with "a department grant with no department is nobody, not
   * everybody".
   *
   * So the fallback is the scope they actually hold, resolved as it always was. The callers above
   * reach this only when the permission is granted by no role at all, which their own guards
   * normally refuse first.
   */
  private static heldScope(context: {
    roleSummary: readonly { scopeKind: ScopeKind }[];
  }): ScopeKind {
    return ReportScopeService.widestScope(context.roleSummary.map((role) => role.scopeKind));
  }

  /**
   * The widest scope any of this person's roles grants.
   *
   * Two roles mean the union of what they permit — a person who is both an Employee and a Manager
   * is a manager. Taking the *narrowest* would make adding a role reduce somebody's reach, which
   * nobody expects.
   *
   * Used only for the fallback above, over the roles a person actually holds. The reach of one
   * permission is a different question, and `AuthorizationService.reachForPermission` answers it:
   * a role that grants a module narrowly must not have its rows widened by a role that grants a
   * wider scope and not that module.
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

  /**
   * The narrowest of several reaches — for a report that needs more than one permission.
   *
   * Two grants mean two doors, and the rows behind the narrower one are all you may see. Taking
   * the wider would show rows from a module the reader can only see part of.
   */
  private static narrowestScope(kinds: readonly ScopeKind[]): ScopeKind {
    const order: ScopeKind[] = [
      'SelectedResource',
      'OwnWork',
      'TeamSubtree',
      'Department',
      'MultipleDepartments',
      'WholeCompany',
    ];

    let narrowest: ScopeKind = kinds[0] ?? 'OwnWork';
    for (const kind of kinds) {
      if (order.indexOf(kind) < order.indexOf(narrowest)) {
        narrowest = kind;
      }
    }
    return narrowest;
  }

  /**
   * One permission's reach, in the shape `resolve` takes.
   *
   * `null` means no role grants this permission at all, and the fallback is the scope they do
   * hold, naming no departments — so a person whose only department grant is on some *other*
   * module reaches nobody here rather than reaching their own department.
   */
  private static reachOf(
    reach: { kind: ScopeKind; departmentIds: readonly string[] } | null,
    context: { roleSummary: readonly { scopeKind: ScopeKind }[] },
  ): { scopeKind: ScopeKind; departmentIds: readonly string[] } {
    if (reach === null) {
      return { scopeKind: ReportScopeService.heldScope(context), departmentIds: [] };
    }
    return { scopeKind: reach.kind, departmentIds: reach.departmentIds };
  }

  /**
   * The departments *every* required permission reaches — for a report that needs more than one.
   *
   * Intersection, to match `narrowestScope`: two doors, and only the rows behind both. Reaches
   * that name no department at all (a `WholeCompany` or `TeamSubtree` grant) are not a
   * constraint and are left out of the intersection rather than emptying it; when the narrowest
   * kind is a department kind, at least one reach names departments, and those are the ones that
   * count.
   */
  private static commonDepartments(
    reaches: readonly { departmentIds: readonly string[] }[],
  ): readonly string[] {
    const naming = reaches.filter((reach) => reach.departmentIds.length > 0);
    const first = naming[0];
    if (first === undefined) {
      return [];
    }
    return first.departmentIds.filter((id) =>
      naming.every((reach) => reach.departmentIds.includes(id)),
    );
  }

  private async resolve(input: {
    scope: TenantScope;
    actorUserId: string;
    scopeKind: ScopeKind;
    /**
     * The departments the *granting* assignments name. Required, not optional: a caller that
     * forgot it would silently resolve to nobody, and a caller that could omit it would
     * eventually be written to omit it.
     */
    departmentIds: readonly string[];
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
        /*
         * The departments the grant names — never the reader's own.
         *
         * Reading them from the employment record was the escalation: a grant naming one
         * department served whichever department the reader happens to work in, so a Head granted
         * Customer Operations was shown the whole of Operations, and the person granted the
         * department they already work in never noticed because the two answers agreed.
         */
        const departments = [...input.departmentIds];
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
