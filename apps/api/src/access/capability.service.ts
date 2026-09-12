import { BadRequestException, ForbiddenException, Injectable, Logger } from '@nestjs/common';

import {
  CAPABILITIES,
  CAPABILITY_KEYS,
  CAPABILITY_TIER_DESCRIPTIONS,
  CAPABILITY_TIER_LABELS,
  CAPABILITY_TIERS,
  DELEGATION_STANCE,
  delegationProblems,
  expandCapabilities,
  STANDARD_EMPLOYEE_CAPABILITIES,
  type CapabilityKey,
} from '@uboss/types';

import { AuditEventService } from '../audit/audit-event.service.js';
import { SECURITY_ACTIONS, SecurityEventPublisher } from '../auth/security-event.publisher.js';
import { AuthorizationService } from '../authorization/authorization.service.js';
import { PrismaService } from '../persistence/prisma.service.js';
import type { TenantScope } from '../persistence/tenant-context.js';

/** The prefix that marks a custom role as one of these grants rather than a hand-built role. */
const CAPABILITY_ROLE_PREFIX = 'Capability: ';

/**
 * The business-friendly Access & Permissions step — Prompt 40A (CR-03) §1.
 *
 * ## What this is, and the thing it very deliberately is not
 *
 * It is **not a permission engine**. CR-03 says "do not create a second RBAC system", and this
 * obeys that literally: a capability is a label over a set of grants in the existing model, and
 * `AuthorizationService` remains the only thing that decides anything. Granting a capability
 * writes a `Custom` role assignment — the mechanism that has existed since Prompt 7 — and the
 * engine's own union across a person's assignments does the rest.
 *
 * What it adds is the layer the client asked for. An administrator adding a colleague should be
 * choosing *"can build agents"*, not ticking `agent-builder:EditDraft` on a grid of fourteen
 * modules by fourteen actions. Keeping the mapping as data means the friendly words and the real
 * grants cannot drift apart, and a test can assert every capability expands to something the
 * engine recognises.
 *
 * ## Why one custom role per capability rather than one per person
 *
 * So that revoking is a deletion of one row rather than a recomputation of a matrix. A single
 * "this person's permissions" role would have to be diffed on every change, and a diff that goes
 * wrong silently removes access. One row per capability makes "what did this grant do" and "undo
 * exactly that" the same question.
 */
@Injectable()
export class CapabilityService {
  private readonly logger = new Logger(CapabilityService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly authorization: AuthorizationService,
    private readonly audit: AuditEventService,
    private readonly securityEvents: SecurityEventPublisher,
  ) {}

  /**
   * The step itself: what an administrator may offer this person.
   *
   * Returns every capability with whether it is already held and whether **this** administrator
   * may grant it. A screen that only knew the list would have to grey things out on a guess, and
   * an administrator refused at save time with no explanation writes a support ticket.
   */
  async stepFor(input: {
    scope: TenantScope;
    actorUserId: string;
    subjectUserId: string;
  }): Promise<unknown> {
    const [held, granterHolds, granterIsAdmin] = await Promise.all([
      this.capabilitiesOf(input.scope, input.subjectUserId),
      this.capabilitiesOf(input.scope, input.actorUserId),
      this.isCompanyAdmin(input.scope, input.actorUserId),
    ]);

    const refusals = new Map(
      delegationProblems({
        granterCapabilities: granterHolds,
        requested: [...CAPABILITY_KEYS],
        granterIsCompanyAdmin: granterIsAdmin,
      }).map((refusal) => [refusal.key, refusal.reason]),
    );

    return {
      tiers: CAPABILITY_TIERS.map((tier) => ({
        key: tier,
        label: CAPABILITY_TIER_LABELS[tier],
        description: CAPABILITY_TIER_DESCRIPTIONS[tier],
      })),
      capabilities: CAPABILITIES.map((capability) => ({
        key: capability.key,
        label: capability.label,
        tier: capability.tier,
        help: capability.help,
        held: held.includes(capability.key),
        canGrant: !refusals.has(capability.key),
        ...(refusals.has(capability.key) ? { whyNot: refusals.get(capability.key) } : {}),
        // What it really does, so an administrator can see it rather than trust the label.
        grants: capability.grants,
      })),
      /**
       * The default for somebody new, stated rather than left to be inferred.
       *
       * This is the CR-03 change made visible: a new employee gets operations only, and the
       * builder screens are something somebody decides to add.
       */
      defaultForNewEmployee: STANDARD_EMPLOYEE_CAPABILITIES,
      delegationStance: DELEGATION_STANCE,
    };
  }

  /** Which of these capabilities this person currently holds. */
  async capabilitiesOf(scope: TenantScope, userId: string): Promise<CapabilityKey[]> {
    const rows = await this.prisma.runInTenantTransaction(scope, () =>
      this.prisma.client.roleAssignment.findMany({
        where: {
          tenantId: scope.tenantId,
          userId,
          roleKind: 'Custom',
          OR: [{ expiresAt: null }, { expiresAt: { gt: new Date() } }],
        },
        select: { customRole: { select: { displayName: true, enabled: true } } },
      }),
    );

    const held = new Set<CapabilityKey>();
    for (const row of rows) {
      const name = row.customRole?.displayName ?? '';
      if (row.customRole?.enabled !== true) continue;
      if (!name.startsWith(CAPABILITY_ROLE_PREFIX)) continue;
      const key = name.slice(CAPABILITY_ROLE_PREFIX.length) as CapabilityKey;
      if (CAPABILITY_KEYS.includes(key)) held.add(key);
    }

    /**
     * Capabilities that come from the person's *template* rather than from a grant.
     *
     * A standard Employee holds `RunAssignedAgents` and `OwnTasks` because the Employee template
     * grants those modules — not because anybody ticked a box. Reporting them as held keeps the
     * screen honest: it would be misleading to show "Run assigned Engine Agents" as available to
     * grant when the person already has it.
     */
    const context = await this.authorization.contextFor(scope, userId);
    for (const capability of CAPABILITIES) {
      if (held.has(capability.key)) continue;
      const satisfied = Object.entries(capability.grants).every(([module, actions]) => {
        const granted = (context.granted as Record<string, readonly string[]>)[module] ?? [];
        return (actions as readonly string[]).every((action) => granted.includes(action));
      });
      if (satisfied) held.add(capability.key);
    }

    return [...held];
  }

  /**
   * Grant capabilities to somebody.
   *
   * ## The delegation check is the security boundary
   *
   * *"Admin cannot delegate permissions outside their own authority."* Enforced **before** any row
   * is written, and outside the transaction — so a refusal cannot roll back the security event that
   * records it. That is the mistake this codebase made twice (S-256, S-282) and it is not being
   * made a third time.
   */
  async grant(input: {
    scope: TenantScope;
    actorUserId: string;
    subjectUserId: string;
    capabilities: readonly CapabilityKey[];
  }): Promise<{ granted: CapabilityKey[]; alreadyHeld: CapabilityKey[] }> {
    if (input.capabilities.length === 0) {
      throw new BadRequestException('Choose at least one capability to grant.');
    }

    // Managing somebody's access is itself a permission. Without this, anybody who could reach
    // the route could grant themselves anything they happened to hold.
    const context = await this.authorization.contextFor(input.scope, input.actorUserId);
    await this.authorization.assertCan(context, { module: 'users', action: 'ManageAccess' });

    if (input.subjectUserId === input.actorUserId) {
      // Self-granting is refused even when the delegation rule would allow it. Somebody widening
      // their own access is the one case where "you already hold it" is not reassurance.
      await this.securityEvents.record({
        action: SECURITY_ACTIONS.separationOfDutiesBlocked,
        actorUserId: input.actorUserId,
        tenantId: input.scope.tenantId,
        resourceType: 'capability-grant',
        summary: 'Refused an attempt to grant capabilities to oneself.',
      });
      throw new ForbiddenException(
        'You cannot change your own capabilities. Ask another administrator.',
      );
    }

    const [granterHolds, granterIsAdmin] = await Promise.all([
      this.capabilitiesOf(input.scope, input.actorUserId),
      this.isCompanyAdmin(input.scope, input.actorUserId),
    ]);

    const refused = delegationProblems({
      granterCapabilities: granterHolds,
      requested: input.capabilities,
      granterIsCompanyAdmin: granterIsAdmin,
    });

    if (refused.length > 0) {
      // Recorded outside any transaction, then refused. See the note on this method.
      await this.securityEvents.record({
        action: SECURITY_ACTIONS.permissionDenied,
        actorUserId: input.actorUserId,
        tenantId: input.scope.tenantId,
        subjectUserId: input.subjectUserId,
        resourceType: 'capability-grant',
        summary: 'Refused a capability grant beyond the granter’s own authority.',
        metadata: { refused: refused.map((entry) => entry.key).join(',') },
      });
      throw new ForbiddenException(refused.map((entry) => entry.reason).join(' '));
    }

    const alreadyHeld = await this.capabilitiesOf(input.scope, input.subjectUserId);
    const toGrant = input.capabilities.filter((key) => !alreadyHeld.includes(key));

    for (const key of toGrant) {
      await this.writeGrant(input.scope, input.actorUserId, input.subjectUserId, key);
    }

    return {
      granted: toGrant,
      alreadyHeld: input.capabilities.filter((key) => alreadyHeld.includes(key)),
    };
  }

  /** Take a capability away. */
  async revoke(input: {
    scope: TenantScope;
    actorUserId: string;
    subjectUserId: string;
    capability: CapabilityKey;
  }): Promise<{ revoked: boolean }> {
    const context = await this.authorization.contextFor(input.scope, input.actorUserId);
    await this.authorization.assertCan(context, { module: 'users', action: 'ManageAccess' });

    const removed = await this.prisma.runInTenantTransaction(input.scope, async () => {
      const assignments = await this.prisma.client.roleAssignment.findMany({
        where: { tenantId: input.scope.tenantId, userId: input.subjectUserId, roleKind: 'Custom' },
        select: { id: true, customRoleId: true, customRole: { select: { displayName: true } } },
      });

      const match = assignments.find(
        (assignment) =>
          assignment.customRole?.displayName === `${CAPABILITY_ROLE_PREFIX}${input.capability}`,
      );
      if (match === undefined) return false;

      await this.prisma.client.roleAssignment.delete({ where: { id: match.id } });
      if (match.customRoleId !== null) {
        await this.prisma.client.customRole.delete({ where: { id: match.customRoleId } });
      }
      return true;
    });

    if (removed) {
      await this.securityEvents.record({
        action: SECURITY_ACTIONS.roleRevoked,
        actorUserId: input.actorUserId,
        tenantId: input.scope.tenantId,
        subjectUserId: input.subjectUserId,
        resourceType: 'capability',
        summary: `Revoked "${input.capability}".`,
        metadata: { capability: input.capability },
      });
    }

    return { revoked: removed };
  }

  private async writeGrant(
    scope: TenantScope,
    actorUserId: string,
    subjectUserId: string,
    capability: CapabilityKey,
  ): Promise<void> {
    const permissions = expandCapabilities([capability]);

    await this.prisma.runInTenantTransaction(scope, async () => {
      const role = await this.prisma.client.customRole.create({
        data: {
          tenantId: scope.tenantId,
          displayName: `${CAPABILITY_ROLE_PREFIX}${capability}`,
          description: `Granted through the Access & Permissions step.`,
          permissions: permissions as never,
          // **Never wider than the person's own work.** Granting a capability must not also widen
          // reach: a Power Employee builds their own assigned work and nobody else's. Somebody who
          // needs wider reach is given a role, which is a different and more visible decision.
          maxScope: 'OwnWork',
        },
      });

      await this.prisma.client.roleAssignment.create({
        data: {
          tenantId: scope.tenantId,
          userId: subjectUserId,
          roleKind: 'Custom',
          customRoleId: role.id,
          scopeKind: 'OwnWork',
          grantedByUserId: actorUserId,
        },
      });

      await this.audit.appendWithinCurrentScope(scope.tenantId, {
        action: 'access.capability_granted',
        actorUserId,
        resourceType: 'capability',
        resourceId: role.id,
        summary: `Granted "${capability}".`,
        // The subject belongs in metadata here: `AuditEventInput` has no subject field, unlike the
        // security trail, which does. The security event below carries it properly.
        metadata: { capability, subjectUserId, modules: Object.keys(permissions).join(',') },
      });
    });

    await this.securityEvents.record({
      action: SECURITY_ACTIONS.roleAssigned,
      actorUserId,
      tenantId: scope.tenantId,
      subjectUserId,
      resourceType: 'capability',
      summary: `Granted "${capability}".`,
      metadata: { capability },
    });
  }

  private async isCompanyAdmin(scope: TenantScope, userId: string): Promise<boolean> {
    const count = await this.prisma.runInTenantTransaction(scope, () =>
      this.prisma.client.roleAssignment.count({
        where: {
          tenantId: scope.tenantId,
          userId,
          roleKind: 'CompanyAdmin',
          OR: [{ expiresAt: null }, { expiresAt: { gt: new Date() } }],
        },
      }),
    );
    return count > 0;
  }
}
