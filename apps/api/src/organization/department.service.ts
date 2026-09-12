import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';

import { AuditEventService } from '../audit/audit-event.service.js';
import { AuthorizationService } from '../authorization/authorization.service.js';
import type { Department } from '../generated/prisma/client.js';
import { OrganizationRepository } from '../persistence/organization.repository.js';
import { PrismaService } from '../persistence/prisma.service.js';
import type { TenantScope } from '../persistence/tenant-context.js';

/** How deep a department tree may nest. Generous; exists so a malformed tree cannot hang a walk. */
export const MAX_DEPARTMENT_DEPTH = 32;

/**
 * Departments: create, rename, re-parent and archive.
 *
 * ## Archived, never deleted
 *
 * A department that has ever had people in it cannot be removed without rewriting employment
 * history, and employment history is exactly what a person needs years later. So there is no
 * delete path: `archivedAt` closes a department, it stops appearing in pickers and in the tree,
 * and every historical employment record still points at a department that exists and has a
 * name. This is the same rule as seat reduction (ADR-061) applied to structure instead of people.
 *
 * A department with **active** employees cannot even be archived — the people would be left
 * pointing at something no screen shows. Move them first, which is a deliberate act with its own
 * audit.
 *
 * ## Why a department is required rather than optional
 *
 * Department is one of the client's six mandatory Add Employee fields, and `Department`-scoped
 * roles have existed since Prompt 7. An optional department would make both of those
 * conditional on data quality.
 */
@Injectable()
export class DepartmentService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly organization: OrganizationRepository,
    private readonly authorization: AuthorizationService,
    private readonly auditEvents: AuditEventService,
  ) {}

  async list(scope: TenantScope, userId: string, includeArchived = false): Promise<Department[]> {
    const context = await this.authorization.contextFor(scope, userId);
    await this.authorization.assertCan(context, { module: 'hierarchy', action: 'View' });
    return this.organization.listDepartments(scope, includeArchived);
  }

  async create(input: {
    scope: TenantScope;
    actorUserId: string;
    name: string;
    code?: string | undefined;
    parentDepartmentId?: string | undefined;
    headUserId?: string | undefined;
    description?: string | undefined;
    sortOrder?: number | undefined;
  }): Promise<Department> {
    const context = await this.authorization.contextFor(input.scope, input.actorUserId);
    await this.authorization.assertCan(context, { module: 'hierarchy', action: 'Administer' });

    const name = input.name.trim();
    if (name === '') {
      throw new BadRequestException('A department needs a name.');
    }

    if (input.parentDepartmentId !== undefined) {
      const parent = await this.organization.findDepartment(input.scope, input.parentDepartmentId);
      if (!parent) {
        // The composite foreign key also refuses a parent in another company. Checked here so
        // the message says which of the two problems it is.
        throw new BadRequestException('That parent department does not exist in this company.');
      }
      if (parent.archivedAt !== null) {
        throw new ConflictException(
          'That parent department is archived. A live department under an archived one would ' +
            'be unreachable in the tree.',
        );
      }
      const depth = await this.depthOf(input.scope, input.parentDepartmentId);
      if (depth + 1 >= MAX_DEPARTMENT_DEPTH) {
        throw new ConflictException(
          `A department tree deeper than ${MAX_DEPARTMENT_DEPTH} levels is refused.`,
        );
      }
    }

    if (input.headUserId !== undefined) {
      const head = await this.organization.findEmployment(input.scope, input.headUserId);
      if (!head) {
        throw new BadRequestException(
          'A department head must be employed by this company. Add them as an employee first.',
        );
      }
    }

    return this.prisma.runInTenantTransaction(input.scope, async () => {
      const existing = await this.organization.listDepartments(input.scope, true);
      if (existing.some((department) => department.name.toLowerCase() === name.toLowerCase())) {
        throw new ConflictException(
          `This company already has a department called "${name}". Two departments with one ` +
            'name make every department-scoped permission ambiguous.',
        );
      }

      const department = await this.organization.createDepartment(input.scope, {
        name,
        code: input.code?.trim() || undefined,
        parentDepartmentId: input.parentDepartmentId,
        headUserId: input.headUserId,
        description: input.description?.trim() || undefined,
        sortOrder: input.sortOrder,
      });

      await this.auditEvents.appendWithinCurrentScope(input.scope.tenantId, {
        action: 'hierarchy.department_created',
        resourceType: 'department',
        resourceId: department.id,
        resourceRef: department.name,
        actorUserId: input.actorUserId,
        summary: `Created the department "${department.name}".`,
        metadata: {
          parentDepartmentId: department.parentDepartmentId,
          headUserId: department.headUserId,
        },
      });

      return department;
    });
  }

  async update(input: {
    scope: TenantScope;
    actorUserId: string;
    departmentId: string;
    name?: string | undefined;
    code?: string | undefined;
    parentDepartmentId?: string | null | undefined;
    headUserId?: string | null | undefined;
    description?: string | undefined;
    sortOrder?: number | undefined;
  }): Promise<Department> {
    const context = await this.authorization.contextFor(input.scope, input.actorUserId);
    await this.authorization.assertCan(context, { module: 'hierarchy', action: 'Administer' });

    const existing = await this.organization.findDepartment(input.scope, input.departmentId);
    if (!existing) {
      throw new NotFoundException('No such department.');
    }

    if (input.parentDepartmentId !== undefined && input.parentDepartmentId !== null) {
      if (input.parentDepartmentId === input.departmentId) {
        throw new BadRequestException('A department cannot be its own parent.');
      }
      // Re-parenting under a descendant would detach a whole branch from the company and make
      // the tree walk non-terminating. The one-step case has a check constraint; this is the
      // general case.
      const descendants = await this.descendantIds(input.scope, input.departmentId);
      if (descendants.includes(input.parentDepartmentId)) {
        throw new ConflictException(
          'That move would put this department underneath one of its own sub-departments, ' +
            'which would detach the branch from the company.',
        );
      }
    }

    const data: Record<string, unknown> = {};
    if (input.name !== undefined) {
      data['name'] = input.name.trim();
    }
    if (input.code !== undefined) {
      data['code'] = input.code.trim() || null;
    }
    if (input.parentDepartmentId !== undefined) {
      data['parentDepartmentId'] = input.parentDepartmentId;
    }
    if (input.headUserId !== undefined) {
      data['headUserId'] = input.headUserId;
    }
    if (input.description !== undefined) {
      data['description'] = input.description.trim() || null;
    }
    if (input.sortOrder !== undefined) {
      data['sortOrder'] = input.sortOrder;
    }

    if (Object.keys(data).length === 0) {
      return existing;
    }

    return this.prisma.runInTenantTransaction(input.scope, async () => {
      const changed = await this.organization.updateDepartment(
        input.scope,
        input.departmentId,
        data,
      );
      if (changed !== 1) {
        throw new ConflictException('That department changed while you were editing it.');
      }

      await this.auditEvents.appendWithinCurrentScope(input.scope.tenantId, {
        action: 'hierarchy.department_updated',
        resourceType: 'department',
        resourceId: input.departmentId,
        resourceRef: existing.name,
        resourceVersion: existing.version,
        actorUserId: input.actorUserId,
        summary: `Updated the department "${existing.name}".`,
        metadata: { fields: Object.keys(data).join(',') },
      });

      const updated = await this.organization.findDepartment(input.scope, input.departmentId);
      return updated as Department;
    });
  }

  /**
   * Archive a department. Refused while anybody is actively employed in it.
   *
   * Not a delete: see the class comment. The audit event says `nothingDeleted` so the record
   * answers the question a customer asks.
   */
  async archive(input: {
    scope: TenantScope;
    actorUserId: string;
    departmentId: string;
    reason: string;
  }): Promise<void> {
    const context = await this.authorization.contextFor(input.scope, input.actorUserId);
    await this.authorization.assertCan(context, { module: 'hierarchy', action: 'Administer' });

    if (!input.reason.trim()) {
      throw new BadRequestException('Archiving a department requires a reason.');
    }

    const existing = await this.organization.findDepartment(input.scope, input.departmentId);
    if (!existing) {
      throw new NotFoundException('No such department.');
    }
    if (existing.archivedAt !== null) {
      throw new ConflictException('That department is already archived.');
    }

    const employed = await this.organization.countEmployedInDepartment(
      input.scope,
      input.departmentId,
    );
    if (employed > 0) {
      throw new ConflictException(
        `${employed} ${employed === 1 ? 'person is' : 'people are'} still employed in ` +
          `"${existing.name}". Move them to another department first — archiving would leave ` +
          'them pointing at a department no screen shows.',
      );
    }

    const children = await this.organization.listDepartments(input.scope, false);
    if (children.some((child) => child.parentDepartmentId === input.departmentId)) {
      throw new ConflictException(
        'That department still has live sub-departments. Archive or re-parent them first.',
      );
    }

    await this.prisma.runInTenantTransaction(input.scope, async () => {
      await this.organization.updateDepartment(input.scope, input.departmentId, {
        archivedAt: new Date(),
      });

      await this.auditEvents.appendWithinCurrentScope(input.scope.tenantId, {
        action: 'hierarchy.department_archived',
        resourceType: 'department',
        resourceId: input.departmentId,
        resourceRef: existing.name,
        resourceVersion: existing.version,
        actorUserId: input.actorUserId,
        summary: `Archived the department "${existing.name}".`,
        reason: input.reason.trim(),
        // Historical employment records still point here and still resolve to a named
        // department. Nothing was removed.
        metadata: { nothingDeleted: true },
      });
    });
  }

  /** How many levels above a department. Bounded, for the same reason as the reporting walk. */
  private async depthOf(scope: TenantScope, departmentId: string): Promise<number> {
    const all = await this.organization.listDepartments(scope, true);
    const byId = new Map(all.map((department) => [department.id, department]));

    let depth = 0;
    let cursor = byId.get(departmentId);
    while (cursor?.parentDepartmentId && depth < MAX_DEPARTMENT_DEPTH) {
      cursor = byId.get(cursor.parentDepartmentId);
      depth += 1;
    }
    return depth;
  }

  /** Every department at or beneath one, for move validation. */
  private async descendantIds(scope: TenantScope, departmentId: string): Promise<string[]> {
    const all = await this.organization.listDepartments(scope, true);
    const found = new Set<string>([departmentId]);

    // Repeated passes rather than recursion: the set is small, and this terminates even if the
    // data somehow contained a loop the constraints should have prevented.
    for (let pass = 0; pass < MAX_DEPARTMENT_DEPTH; pass += 1) {
      let grew = false;
      for (const department of all) {
        if (
          department.parentDepartmentId !== null &&
          found.has(department.parentDepartmentId) &&
          !found.has(department.id)
        ) {
          found.add(department.id);
          grew = true;
        }
      }
      if (!grew) {
        break;
      }
    }

    found.delete(departmentId);
    return [...found];
  }
}
