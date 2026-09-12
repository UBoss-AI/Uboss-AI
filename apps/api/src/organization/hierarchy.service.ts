import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';

import { AuditEventService } from '../audit/audit-event.service.js';
import { SECURITY_ACTIONS, SecurityEventPublisher } from '../auth/security-event.publisher.js';
import { AuthorizationService } from '../authorization/authorization.service.js';
import {
  OrganizationRepository,
  type HierarchyRow,
} from '../persistence/organization.repository.js';
import { PrismaService } from '../persistence/prisma.service.js';
import { TenantRepository } from '../persistence/tenant.repository.js';
import type { TenantScope } from '../persistence/tenant-context.js';
import { maskedAadhaar } from './aadhaar.js';

/** The hard ceiling the database trigger also enforces. See the migration. */
export const MAX_REPORTING_DEPTH = 64;

export interface HierarchyNode {
  kind: 'company' | 'department' | 'person';
  id: string;
  name: string;
  /** Person nodes only. */
  person?: {
    userId: string;
    ubossUniqueId: string;
    employeeId: string;
    designation: string;
    departmentName: string;
    reportingManagerName: string | null;
    employmentState: string;
    /** `NotInvited`, `InvitePending`, `Active`… or null when there is no membership yet. */
    accountState: string | null;
  };
  /** Department nodes only: how many people sit at or beneath it. */
  headcount?: number;
  children: HierarchyNode[];
}

export interface HierarchyView {
  company: { name: string; vision: string | null; mission: string | null };
  departments: {
    id: string;
    name: string;
    code: string | null;
    parentDepartmentId: string | null;
    description: string | null;
    headcount: number;
    archived: boolean;
  }[];
  /** Tree View — the default the client specified. Company → departments → reporting tree. */
  tree: HierarchyNode;
  /** List View — the secondary view, flat, exactly the reference's seven columns. */
  list: {
    userId: string;
    displayName: string;
    employeeId: string;
    designation: string;
    departmentName: string;
    reportingManagerName: string | null;
    ubossUniqueId: string;
    accountState: string | null;
    employmentState: string;
    /**
     * Masked, and **present only when the caller may see it** — somebody who can administer the
     * hierarchy, or the person themselves. Omitted rather than nulled, so a screen cannot render
     * a withheld value as "no identifier on record". The number itself does not exist in the
     * database to be returned.
     */
    aadhaarMasked?: string | null;
  }[];
  /** Empty-state honesty: this company has departments but nobody recorded yet. */
  employeeCount: number;
  /** Whether this caller was given the masked identifier fragments. Stated, not inferred. */
  identifiersVisible: boolean;
  /**
   * Whether this caller may change the structure.
   *
   * Sent so a screen can hide controls it knows will be refused, and named for what it is
   * rather than reusing `identifiersVisible` — the two happen to coincide today and mean
   * different things, and a UI keyed on the wrong one would drift the moment they diverge.
   * The server remains authoritative: hiding a control is a courtesy, never the enforcement.
   */
  mayAdminister: boolean;
}

/**
 * The organization hierarchy: the tree, the list, and the moves that are allowed.
 *
 * ## Two structures, deliberately not one
 *
 * A department hierarchy and a reporting hierarchy are different things, and the client's
 * requirement says so directly: "reporting manager relationship separate from department
 * membership". A person can report to somebody in another department — matrix teams and dotted
 * lines are the norm, not the exception — so collapsing the two would misrepresent most real
 * organisations. The tree this service builds groups people under their **department** and then
 * nests them by their **reporting manager within that department**, with anybody whose manager
 * sits elsewhere shown at the department's root. That is the reference UI's own layout, and it is
 * the only arrangement that can display both facts at once without lying about either.
 *
 * ## Practical unlimited depth, with a stated bound
 *
 * The client asked for "practical unlimited levels". There is no depth column and no fixed
 * nesting; the bound is {@link MAX_REPORTING_DEPTH}, which exists so a malformed tree cannot
 * hang a request rather than to limit an organisation. No real company approaches it.
 *
 * ## Move validation is where the interesting failures are
 *
 * Changing somebody's reporting manager can: close a loop (refused, in the service *and* by a
 * database trigger), point at a person who is not employed here (refused by a composite foreign
 * key, so it cannot be reached even by a raw query), or point at somebody in another company
 * (the same foreign key — this is the tenant-isolation case, and it is the one worth having a
 * database guarantee for).
 */
@Injectable()
export class HierarchyService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly organization: OrganizationRepository,
    private readonly tenants: TenantRepository,
    private readonly authorization: AuthorizationService,
    private readonly auditEvents: AuditEventService,
    private readonly securityEvents: SecurityEventPublisher,
  ) {}

  /**
   * The whole hierarchy screen in one call: Vision, Mission, departments, tree and list.
   *
   * One call because the screen shows all of it at once and the client's layout puts the Vision
   * and Mission *above* the tree — two requests would let the strip render before the structure
   * it introduces.
   */
  async viewFor(scope: TenantScope, userId: string): Promise<HierarchyView> {
    const context = await this.authorization.contextFor(scope, userId);
    await this.authorization.assertCan(context, { module: 'hierarchy', action: 'View' });

    // **The scoped part of "scoped visibility".**
    //
    // The org chart itself is company-wide: an employee seeing the structure of the company they
    // work for is normal, and the client's reference renders every department to every role that
    // has the screen. What must *not* be company-wide is the entered identifier — an ordinary
    // employee has no business reading a colleague's masked Aadhaar, even four digits of it.
    //
    // So the structure is visible to `hierarchy:View` and the identifier fragment only to
    // somebody who can administer the hierarchy, plus each person for themselves. Withholding
    // the field is done by omitting it rather than by blanking it, so a screen cannot render an
    // empty value as though the person had no identifier on record.
    const maySeeIdentifiers = (
      await this.authorization.authorize(context, {
        module: 'hierarchy',
        action: 'Administer',
      })
    ).allowed;

    const tenant = await this.tenants.findByIdForPlatform(scope.tenantId);
    if (!tenant) {
      throw new NotFoundException('No such company.');
    }

    const [departments, rows] = await Promise.all([
      this.organization.listDepartments(scope, true),
      this.organization.listHierarchy(scope),
    ]);

    const headcount = new Map<string, number>();
    for (const row of rows) {
      if (row.state === 'Active') {
        headcount.set(row.departmentId, (headcount.get(row.departmentId) ?? 0) + 1);
      }
    }

    return {
      company: { name: tenant.name, vision: tenant.vision, mission: tenant.mission },
      departments: departments.map((department) => ({
        id: department.id,
        name: department.name,
        code: department.code,
        parentDepartmentId: department.parentDepartmentId,
        description: department.description,
        headcount: headcount.get(department.id) ?? 0,
        archived: department.archivedAt !== null,
      })),
      tree: HierarchyService.buildTree(tenant.name, departments, rows),
      list: rows.map((row) => ({
        userId: row.userId,
        displayName: row.displayName,
        employeeId: row.employeeId,
        designation: row.designation,
        departmentName: row.departmentName,
        reportingManagerName: row.reportingManagerName,
        ubossUniqueId: row.ubossUniqueId,
        accountState: row.accountState,
        employmentState: row.state,
        ...(maySeeIdentifiers || row.userId === userId
          ? { aadhaarMasked: maskedAadhaar(row.aadhaarLastFour) }
          : {}),
      })),
      employeeCount: rows.length,
      identifiersVisible: maySeeIdentifiers,
      mayAdminister: maySeeIdentifiers,
    };
  }

  /**
   * Company → departments → people, nested by reporting manager within each department.
   *
   * Pure and static so it is testable without a database, which matters: the placement rule for
   * "manager is in another department" is the part a reader would get wrong.
   */
  static buildTree(
    companyName: string,
    departments: { id: string; name: string; sortOrder: number; archivedAt: Date | null }[],
    rows: HierarchyRow[],
  ): HierarchyNode {
    const live = departments.filter((department) => department.archivedAt === null);

    const departmentNodes = live.map((department) => {
      const members = rows.filter((row) => row.departmentId === department.id);
      const memberIds = new Set(members.map((row) => row.userId));

      const build = (row: HierarchyRow, depth: number): HierarchyNode => ({
        kind: 'person',
        id: row.userId,
        name: row.displayName,
        person: {
          userId: row.userId,
          ubossUniqueId: row.ubossUniqueId,
          employeeId: row.employeeId,
          designation: row.designation,
          departmentName: row.departmentName,
          reportingManagerName: row.reportingManagerName,
          employmentState: row.state,
          accountState: row.accountState,
        },
        children:
          depth >= MAX_REPORTING_DEPTH
            ? []
            : members
                .filter((candidate) => candidate.reportingManagerUserId === row.userId)
                .map((child) => build(child, depth + 1)),
      });

      // A department's roots are the people whose manager is not in this department — including
      // those with no manager at all. That is what puts somebody reporting across a department
      // boundary at the top of their own department rather than hiding them.
      const roots = members.filter(
        (row) => row.reportingManagerUserId === null || !memberIds.has(row.reportingManagerUserId),
      );

      return {
        kind: 'department' as const,
        id: department.id,
        name: department.name,
        headcount: members.filter((row) => row.state === 'Active').length,
        children: roots.map((row) => build(row, 0)),
      };
    });

    return {
      kind: 'company',
      id: 'company',
      name: companyName,
      children: departmentNodes,
    };
  }

  /**
   * Set the company's Vision and Mission.
   *
   * `settings:Administer`, because this is company identity rather than structure — the same
   * permission that governs every other company-identity field. It lives on this service
   * because the hierarchy is the screen that displays it, and the client's requirement is that
   * the structure and the purpose it serves are read together.
   */
  async updateCompanyIdentity(input: {
    scope: TenantScope;
    actorUserId: string;
    vision?: string | undefined;
    mission?: string | undefined;
  }): Promise<{ vision: string | null; mission: string | null }> {
    const context = await this.authorization.contextFor(input.scope, input.actorUserId);
    await this.authorization.assertCan(context, { module: 'settings', action: 'Administer' });

    if (input.vision === undefined && input.mission === undefined) {
      throw new BadRequestException('Nothing to change: send a vision, a mission, or both.');
    }

    const tenant = await this.tenants.findByIdForPlatform(input.scope.tenantId);
    if (!tenant) {
      throw new NotFoundException('No such company.');
    }

    await this.prisma.runInTenantTransaction(input.scope, async () => {
      await this.prisma.client.tenant.update({
        where: { id: input.scope.tenantId },
        data: {
          ...(input.vision === undefined ? {} : { vision: input.vision.trim() || null }),
          ...(input.mission === undefined ? {} : { mission: input.mission.trim() || null }),
          version: { increment: 1 },
        },
      });

      await this.auditEvents.appendWithinCurrentScope(input.scope.tenantId, {
        action: 'company.identity_updated',
        resourceType: 'tenant',
        resourceId: input.scope.tenantId,
        resourceRef: tenant.code ?? tenant.slug,
        resourceVersion: tenant.version,
        actorUserId: input.actorUserId,
        summary: 'Updated the company Vision and/or Mission.',
        metadata: {
          visionChanged: input.vision !== undefined,
          missionChanged: input.mission !== undefined,
        },
      });
    });

    const updated = await this.tenants.findByIdForPlatform(input.scope.tenantId);
    return { vision: updated?.vision ?? null, mission: updated?.mission ?? null };
  }

  /**
   * Change somebody's reporting manager, or clear it.
   *
   * `hierarchy:Administer` — moving a person in the org chart changes what a `TeamSubtree`-scoped
   * manager can reach, so it is an authority-adjacent act and not an editing convenience.
   */
  async changeReportingManager(input: {
    scope: TenantScope;
    actorUserId: string;
    subjectUserId: string;
    /** Null detaches the person, making them a root of their department. */
    newManagerUserId: string | null;
    reason?: string | undefined;
  }): Promise<void> {
    const context = await this.authorization.contextFor(input.scope, input.actorUserId);
    await this.authorization.assertCan(context, { module: 'hierarchy', action: 'Administer' });

    if (input.newManagerUserId === input.subjectUserId) {
      throw new BadRequestException('Somebody cannot report to themselves.');
    }

    const subject = await this.organization.findEmployment(input.scope, input.subjectUserId);
    if (!subject) {
      throw new NotFoundException('That person has no employment record in this company.');
    }

    if (input.newManagerUserId !== null) {
      const manager = await this.organization.findEmployment(input.scope, input.newManagerUserId);
      if (!manager) {
        // Also guaranteed by the composite foreign key. Checked here so the message names the
        // cause instead of surfacing a constraint violation.
        throw new BadRequestException(
          'A reporting manager must be employed by this company. Add them as an employee first.',
        );
      }
      if (manager.state !== 'Active') {
        throw new ConflictException(
          'That person’s employment has ended, so they cannot be somebody’s reporting manager. ' +
            'Move their reports first, then end their employment.',
        );
      }

      // Would this close a loop? Refused before the database has to. The trigger is the
      // guarantee; this is the explanation.
      const wouldCycle = await this.organization.isInReportingSubtree({
        tenantId: input.scope.tenantId,
        managerUserId: input.subjectUserId,
        subjectUserId: input.newManagerUserId,
      });

      if (wouldCycle) {
        await this.refuseCycle(input);
        throw new ConflictException(
          'That move would make the reporting line circular: the person you chose already ' +
            'reports, directly or indirectly, to the person being moved. Move the manager out ' +
            'from under them first.',
        );
      }
    }

    await this.prisma.runInTenantTransaction(input.scope, async () => {
      const changed = await this.organization.updateEmployment(input.scope, input.subjectUserId, {
        reportingManagerUserId: input.newManagerUserId,
      });
      if (changed !== 1) {
        throw new ConflictException('That employment record changed while you were editing it.');
      }

      await this.auditEvents.appendWithinCurrentScope(input.scope.tenantId, {
        action: 'hierarchy.reporting_manager_changed',
        resourceType: 'employment_record',
        resourceId: subject.id,
        resourceRef: subject.employeeId,
        resourceVersion: subject.version,
        actorUserId: input.actorUserId,
        summary:
          input.newManagerUserId === null
            ? 'Detached from their reporting manager.'
            : 'Reporting manager changed.',
        ...(input.reason?.trim() ? { reason: input.reason.trim() } : {}),
        metadata: {
          from: subject.reportingManagerUserId,
          to: input.newManagerUserId,
          subjectUserId: input.subjectUserId,
        },
      });
    });
  }

  /**
   * Record a refused cycle in its own transaction.
   *
   * Its own because the caller throws immediately afterwards, and a refusal recorded inside the
   * transaction the throw aborts leaves no trace. That mistake has now been made twice in this
   * codebase — break-glass at Prompt 8 and the commercial self-decision at Prompt 11 — so it is
   * written this way from the start here.
   */
  private async refuseCycle(input: {
    scope: TenantScope;
    actorUserId: string;
    subjectUserId: string;
    newManagerUserId: string | null;
  }): Promise<void> {
    try {
      await this.prisma.runInTenantTransaction(input.scope, () =>
        this.securityEvents.recordWithinCurrentScope({
          action: SECURITY_ACTIONS.reportingCycleBlocked,
          tenantId: input.scope.tenantId,
          actorUserId: input.actorUserId,
          subjectUserId: input.subjectUserId,
          resourceType: 'employment_record',
          resourceId: input.subjectUserId,
          summary: 'Refused a reporting-manager change that would have closed a loop.',
          metadata: { proposedManagerUserId: input.newManagerUserId },
        }),
      );
    } catch {
      // The refusal must stand even if the trail write fails; turning a correct 409 into a 500
      // would report a control as a bug.
    }
  }
}
