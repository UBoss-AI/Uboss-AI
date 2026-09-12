import { BadRequestException, Injectable, Logger, NotFoundException } from '@nestjs/common';

import {
  isScopeKind,
  ROLE_TEMPLATES,
  sanitisePermissionSet,
  SCOPE_BREADTH,
  type Action,
  type ModuleKey,
  type RoleKind,
  type ScopeKind,
  type UserType,
} from '@uboss/types';

import { AuthorizationRepository } from '../persistence/authorization.repository.js';
import type { TenantScope } from '../persistence/tenant-context.js';
import { SECURITY_ACTIONS, SecurityEventPublisher } from '../auth/security-event.publisher.js';

/**
 * Granting and revoking authority.
 *
 * Every method here changes what somebody may do, so every method here writes a security event.
 * That is not decoration: "who granted this person Company Admin, when, and why" is the first
 * question of any access review, and an assignment row alone answers only the first two.
 *
 * ## The privilege-escalation gates
 *
 * Three, all enforced here rather than trusted to the caller:
 *
 *   1. **An assignment cannot exceed its role's `maxScope`.** An Employee assignment naming
 *      `WholeCompany` is refused, not silently capped — a caller who asked for it has a wrong
 *      model of the system and should be told.
 *   2. **A custom role cannot exceed what a built-in role could grant.** Specifically it cannot
 *      name `Administer` or `ManageAccess` unless it is created by someone who already holds
 *      them, which is checked by the controller's own `@RequirePermission`.
 *   3. **Nobody can grant themselves a role.** Self-assignment is refused outright, because it is
 *      the shortest path from "can manage access" to "can do anything", and there is no
 *      legitimate case for it that a second administrator cannot serve.
 */
@Injectable()
export class RoleAdministrationService {
  private readonly logger = new Logger(RoleAdministrationService.name);

  constructor(
    private readonly repository: AuthorizationRepository,
    private readonly securityEvents: SecurityEventPublisher,
  ) {}

  // ---- Assignments ----

  async assign(
    scope: TenantScope,
    input: {
      userId: string;
      roleKind: RoleKind;
      customRoleId?: string | undefined;
      scopeKind: ScopeKind;
      departmentIds?: readonly string[] | undefined;
      selectedResourceIds?: readonly string[] | undefined;
      expiresAt?: Date | undefined;
      justification?: string | undefined;
    },
    actorUserId: string,
  ): Promise<{ id: string; cappedScope: ScopeKind | null }> {
    /**
     * Gate 3, first because it is unconditional: nobody grants themselves a role.
     *
     * The shortest privilege-escalation path in any RBAC system is "I can manage access, so I
     * will give myself more access". Refused outright rather than audited-and-allowed, because an
     * audit trail of an escalation that succeeded is a worse outcome than a refusal.
     */
    if (input.userId === actorUserId) {
      throw new BadRequestException(
        'You cannot assign a role to yourself. Ask another administrator to do it, so the grant ' +
          'has two people behind it.',
      );
    }

    const membership = await this.repository.findMembershipUserType(scope, input.userId);
    if (!membership) {
      throw new NotFoundException('That person is not a member of this company.');
    }

    // A role can only be given to someone who is actually here. Assigning to an offboarded
    // person would create authority that reactivating them would silently restore.
    if (membership.accountState !== 'Active' && membership.accountState !== 'InvitePending') {
      throw new BadRequestException(
        `That person's account is ${membership.accountState}, so a role cannot be assigned to them.`,
      );
    }

    if (!isScopeKind(input.scopeKind)) {
      throw new BadRequestException('Unknown scope.');
    }

    let ceiling: ScopeKind;

    if (input.roleKind === 'Custom') {
      if (input.customRoleId === undefined) {
        throw new BadRequestException('A Custom role assignment must name the custom role.');
      }
      const customRole = await this.repository.findCustomRole(scope, input.customRoleId);
      if (!customRole) {
        throw new NotFoundException('That custom role does not exist in this company.');
      }
      ceiling = isScopeKind(customRole.maxScope) ? customRole.maxScope : 'OwnWork';
    } else {
      if (input.customRoleId !== undefined) {
        throw new BadRequestException(
          'A built-in role assignment must not also name a custom role.',
        );
      }
      const template = ROLE_TEMPLATES[input.roleKind as keyof typeof ROLE_TEMPLATES];
      if (!template) {
        throw new BadRequestException(`"${input.roleKind}" is not a role.`);
      }
      ceiling = template.maxScope;
    }

    /**
     * Gate 1. Refused rather than capped.
     *
     * The engine caps it again at read time (`scopeGrantFor`), so a row written by any other path
     * still cannot over-grant. Both exist on purpose: refusing here tells the caller they were
     * wrong, and capping there means being wrong is not exploitable.
     */
    if (SCOPE_BREADTH[input.scopeKind] > SCOPE_BREADTH[ceiling]) {
      throw new BadRequestException(
        `A ${input.roleKind} role cannot be given ${input.scopeKind} scope — the widest it ` +
          `supports is ${ceiling}. Assign a different role, or narrow the scope.`,
      );
    }

    if (
      (input.scopeKind === 'Department' || input.scopeKind === 'MultipleDepartments') &&
      (input.departmentIds ?? []).length === 0
    ) {
      throw new BadRequestException(
        'A department scope needs at least one department, or it grants nothing.',
      );
    }
    if (input.scopeKind === 'SelectedResource' && (input.selectedResourceIds ?? []).length === 0) {
      throw new BadRequestException(
        'A selected-resource scope needs at least one resource, or it grants nothing.',
      );
    }
    if (input.scopeKind === 'Department' && (input.departmentIds ?? []).length > 1) {
      throw new BadRequestException(
        'Department scope covers one department. Use MultipleDepartments for several.',
      );
    }

    const assignment = await this.repository.createAssignment(scope, {
      userId: input.userId,
      roleKind: input.roleKind,
      ...(input.customRoleId === undefined ? {} : { customRoleId: input.customRoleId }),
      scopeKind: input.scopeKind,
      ...(input.departmentIds === undefined ? {} : { departmentIds: input.departmentIds }),
      ...(input.selectedResourceIds === undefined
        ? {}
        : { selectedResourceIds: input.selectedResourceIds }),
      ...(input.expiresAt === undefined ? {} : { expiresAt: input.expiresAt }),
      grantedByUserId: actorUserId,
      ...(input.justification === undefined ? {} : { justification: input.justification }),
    });

    await this.securityEvents.recordSuspicious({
      action: SECURITY_ACTIONS.roleAssigned,
      actorUserId,
      tenantId: scope.tenantId,
      resourceType: 'role_assignment',
      resourceId: assignment.id,
      summary: `Assigned ${input.roleKind} at ${input.scopeKind} scope.`,
      metadata: {
        subjectUserId: input.userId,
        roleKind: input.roleKind,
        scopeKind: input.scopeKind,
        departments: (input.departmentIds ?? []).length,
        selectedResources: (input.selectedResourceIds ?? []).length,
        expires: input.expiresAt?.toISOString() ?? null,
        // Recorded as present-or-absent: an access review's finding is often that nobody wrote one.
        hasJustification: input.justification !== undefined && input.justification.trim() !== '',
      },
    });

    return { id: assignment.id, cappedScope: null };
  }

  async revoke(scope: TenantScope, assignmentId: string, actorUserId: string): Promise<boolean> {
    const assignment = await this.repository.findAssignment(scope, assignmentId);
    if (!assignment) {
      return false;
    }

    const removed = await this.repository.deleteAssignment(scope, assignmentId);
    if (removed === 0) {
      return false;
    }

    await this.securityEvents.recordSuspicious({
      action: SECURITY_ACTIONS.roleRevoked,
      actorUserId,
      tenantId: scope.tenantId,
      resourceType: 'role_assignment',
      resourceId: assignmentId,
      summary: `Revoked ${assignment.roleKind} at ${assignment.scopeKind} scope.`,
      metadata: {
        subjectUserId: assignment.userId,
        roleKind: assignment.roleKind,
        scopeKind: assignment.scopeKind,
      },
    });

    return true;
  }

  async listAssignments(scope: TenantScope) {
    const assignments = await this.repository.listAssignmentsForTenant(scope);

    return assignments.map((assignment) => ({
      id: assignment.id,
      userId: assignment.userId,
      roleKind: assignment.roleKind,
      customRoleId: assignment.customRoleId,
      customRoleName: assignment.customRole?.displayName ?? null,
      scopeKind: assignment.scopeKind,
      departmentIds: assignment.departmentIds,
      selectedResourceIds: assignment.selectedResourceIds,
      expiresAt: assignment.expiresAt?.toISOString() ?? null,
      /** Surfaced separately from `expiresAt` so a screen does not have to compare clocks. */
      expired: assignment.expiresAt !== null && assignment.expiresAt <= new Date(),
      grantedByUserId: assignment.grantedByUserId,
      justification: assignment.justification,
      createdAt: assignment.createdAt.toISOString(),
    }));
  }

  // ---- Custom roles ----

  async createCustomRole(
    scope: TenantScope,
    input: {
      displayName: string;
      description?: string | undefined;
      permissions: Record<string, string[]>;
      maxScope: ScopeKind;
    },
    actorUserId: string,
    /** What the creator themselves may do — a custom role cannot exceed it. */
    creatorMatrix: Record<string, Action[]>,
  ): Promise<{ id: string }> {
    const permissions = sanitisePermissionSet(input.permissions);

    if (Object.keys(permissions).length === 0) {
      throw new BadRequestException(
        'A custom role needs at least one module and action that UBoss recognises.',
      );
    }
    if (!isScopeKind(input.maxScope)) {
      throw new BadRequestException('Unknown scope.');
    }

    /**
     * Gate 2: a custom role cannot grant what its creator does not have.
     *
     * Without this, "can create custom roles" is equivalent to "can do anything" — an
     * administrator with no `Approve` permission could mint a role carrying it and assign it to a
     * colleague, or to a second account they control. The check is against the creator's *own*
     * effective matrix, so it also respects every policy layer that restricts them.
     */
    const overreach: string[] = [];
    for (const [module, actions] of Object.entries(permissions)) {
      const creatorActions = creatorMatrix[module] ?? [];
      for (const action of actions ?? []) {
        if (!creatorActions.includes(action)) {
          overreach.push(`${action} on ${module}`);
        }
      }
    }

    if (overreach.length > 0) {
      throw new BadRequestException(
        'A custom role cannot grant permissions you do not have yourself: ' +
          `${overreach.slice(0, 5).join(', ')}${overreach.length > 5 ? ', …' : ''}.`,
      );
    }

    const role = await this.repository.createCustomRole(scope, {
      displayName: input.displayName.trim(),
      ...(input.description === undefined ? {} : { description: input.description }),
      permissions: permissions as Record<string, string[]>,
      maxScope: input.maxScope,
      createdByUserId: actorUserId,
    });

    await this.securityEvents.recordSuspicious({
      action: SECURITY_ACTIONS.customRoleCreated,
      actorUserId,
      tenantId: scope.tenantId,
      resourceType: 'custom_role',
      resourceId: role.id,
      summary: `Created the custom role "${input.displayName.trim()}".`,
      metadata: {
        modules: Object.keys(permissions).length,
        maxScope: input.maxScope,
      },
    });

    return { id: role.id };
  }

  async listCustomRoles(scope: TenantScope) {
    const roles = await this.repository.listCustomRoles(scope);

    return roles.map((role) => ({
      id: role.id,
      displayName: role.displayName,
      description: role.description,
      permissions: sanitisePermissionSet(role.permissions),
      maxScope: role.maxScope,
      enabled: role.enabled,
      createdAt: role.createdAt.toISOString(),
    }));
  }

  // ---- User type ----

  /**
   * Change what kind of person somebody is inside this company.
   *
   * Recorded as suspicious in both directions. Promoting a guest to internal widens everything
   * their role can reach; demoting an internal person to guest is how an account is quietly
   * neutered. Both are things an investigation wants to find.
   */
  async setUserType(
    scope: TenantScope,
    userId: string,
    userType: UserType,
    actorUserId: string,
  ): Promise<boolean> {
    if (userType === 'PlatformUser') {
      throw new BadRequestException(
        'A company membership cannot be a Platform User. Platform actors have no company ' +
          'membership at all.',
      );
    }

    const before = await this.repository.findMembershipUserType(scope, userId);
    if (!before) {
      return false;
    }

    const changed = await this.repository.setMembershipUserType(scope, userId, { userType });
    if (changed === 0) {
      return false;
    }

    await this.securityEvents.recordSuspicious({
      action: SECURITY_ACTIONS.userTypeChanged,
      actorUserId,
      tenantId: scope.tenantId,
      resourceType: 'tenant_membership',
      resourceId: userId,
      summary: `Changed user type from ${before.userType} to ${userType}.`,
      metadata: { from: before.userType, to: userType, subjectUserId: userId },
    });

    return true;
  }

  /** The built-in role catalogue, for a permissions screen. Read-only by design (ADR-038). */
  roleCatalogue() {
    return Object.values(ROLE_TEMPLATES).map((template) => ({
      kind: template.kind,
      label: template.label,
      summary: template.summary,
      maxScope: template.maxScope,
      defaultScope: template.defaultScope,
      modules: Object.keys(template.permissions) as ModuleKey[],
      permissions: template.permissions,
      isBuiltIn: true as const,
    }));
  }
}
