import {
  BadRequestException,
  ConflictException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';

import { PrismaService } from '../../persistence/prisma.service.js';
import { ProvisioningRepository } from '../../persistence/provisioning.repository.js';
import { TenantMembershipRepository } from '../../persistence/tenant-membership.repository.js';
import {
  tenantScopeForPlatformOperation,
  type TenantScope,
} from '../../persistence/tenant-context.js';
import { generateUbossUniqueId } from '../../persistence/uboss-unique-id.js';
import { UserRepository } from '../../persistence/user.repository.js';
import { createOneTimeToken, hashToken } from '../one-time-token.js';
import { SECURITY_ACTIONS, SecurityEventPublisher } from '../security-event.publisher.js';
import { DomainVerificationService } from '../domain-verification.service.js';
import { SessionService } from '../session.service.js';
import {
  SCIM_SCHEMAS,
  understandPatch,
  type ScimGroup,
  type ScimPatchOperation,
  type ScimUser,
} from './scim.types.js';

/** The company a SCIM credential belongs to. This is the only source of a SCIM request's scope. */
export interface ScimPrincipal {
  tenantId: string;
  clientId: string;
  scope: TenantScope;
}

export interface ScimUserInput {
  userName?: string;
  externalId?: string;
  displayName?: string;
  name?: { formatted?: string; givenName?: string; familyName?: string };
  emails?: { value?: string; primary?: boolean }[];
  active?: boolean;
}

export interface ScimGroupInput {
  displayName?: string;
  externalId?: string;
  members?: { value?: string }[];
}

/**
 * SCIM 2.0 provisioning.
 *
 * ## Why a verified domain is required, and what it buys
 *
 * SCIM provisions a person into a company **without that person doing anything** — no
 * invitation link, no activation click. That is how enterprise provisioning is supposed to work
 * (your employer creates your account), but it is also a way to add someone to a company they
 * have nothing to do with.
 *
 * The rule here is therefore: a SCIM request may only provision an address whose domain this
 * company has **verified** it controls. Control of the domain is the proof that makes
 * non-consensual provisioning legitimate — it is the difference between "this company is this
 * person's employer" and "this company typed in an address".
 *
 * Consequences, both deliberate:
 *
 *   * A company must verify a domain before SCIM does anything. That is stated in the error, and
 *     `/ServiceProviderConfig` is reachable without it so a connector can still be configured.
 *   * Contractors on other domains cannot be SCIM-provisioned. They are invited instead, which
 *     is the flow that asks for their consent.
 *
 * ## Deprovisioning suspends, it does not delete
 *
 * `active: false` and `DELETE /Users/:id` both move the membership to `Suspended` (and
 * `Offboarded` for a delete). The membership row and its audit history survive. An identity
 * provider that briefly loses sight of a person — a sync error, a filter change — would
 * otherwise destroy the record of their employment, and nothing would bring it back.
 *
 * Either way, **every session is revoked immediately**. Deprovisioning that leaves a live
 * session is the failure mode the whole feature exists to prevent.
 */
@Injectable()
export class ScimService {
  private readonly logger = new Logger(ScimService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly provisioning: ProvisioningRepository,
    private readonly memberships: TenantMembershipRepository,
    private readonly users: UserRepository,
    private readonly domains: DomainVerificationService,
    private readonly sessions: SessionService,
    private readonly securityEvents: SecurityEventPublisher,
  ) {}

  /**
   * Run tenant-owned work with the scope declared to PostgreSQL, so Row-Level Security enforces
   * it alongside the repository's own `where` clause.
   *
   * Every tenant-owned read and write in this file goes through here. Two consequences worth
   * knowing:
   *
   *   * an access that forgets it sees **zero rows** rather than another company's data;
   *   * platform-plane work — writing an audit event, revoking sessions — must happen *outside*
   *     it, because `PrismaService` refuses to escalate a tenant scope to a platform operation.
   *     That refusal is deliberate: it stops a tenant-scoped request quietly disabling the
   *     backstop.
   */
  private scoped<T>(principal: ScimPrincipal, work: () => Promise<T>): Promise<T> {
    return this.prisma.runInTenantTransaction(principal.scope, work);
  }

  /** The same, for the administration endpoints that hold a scope but no SCIM principal. */
  private inScope<T>(scope: TenantScope, work: () => Promise<T>): Promise<T> {
    return this.prisma.runInTenantTransaction(scope, work);
  }

  // -------------------------------------------------------------------------
  // Credentials
  // -------------------------------------------------------------------------

  /** Issue a provisioning credential. The token is returned **once**. */
  async createClient(
    scope: TenantScope,
    displayName: string,
    actorUserId?: string,
  ): Promise<{ id: string; token: string; displayName: string }> {
    const token = createOneTimeToken();
    const client = await this.inScope(scope, () =>
      this.provisioning.createScimClient(scope, { displayName, tokenHash: token.hash }),
    );

    await this.securityEvents.record({
      action: SECURITY_ACTIONS.scimClientCreated,
      ...(actorUserId === undefined ? {} : { actorUserId }),
      tenantId: scope.tenantId,
      resourceType: 'scim_client',
      resourceId: client.id,
      summary: 'Created a SCIM provisioning credential.',
      metadata: { displayName },
    });

    return { id: client.id, token: token.plaintext, displayName };
  }

  async listClients(scope: TenantScope) {
    const clients = await this.inScope(scope, () => this.provisioning.listScimClients(scope));
    return clients.map((client) => ({
      id: client.id,
      displayName: client.displayName,
      enabled: client.enabled,
      lastUsedAt: client.lastUsedAt?.toISOString() ?? null,
      revokedAt: client.revokedAt?.toISOString() ?? null,
      createdAt: client.createdAt.toISOString(),
      // Deliberately absent: `tokenHash`. It grants nothing, but there is no reason to publish it.
    }));
  }

  async revokeClient(scope: TenantScope, clientId: string, actorUserId?: string): Promise<boolean> {
    const revoked = await this.inScope(scope, () =>
      this.provisioning.revokeScimClient(scope, clientId, new Date()),
    );
    if (revoked === 0) {
      return false;
    }

    await this.securityEvents.recordSuspicious({
      action: SECURITY_ACTIONS.scimClientRevoked,
      ...(actorUserId === undefined ? {} : { actorUserId }),
      tenantId: scope.tenantId,
      resourceType: 'scim_client',
      resourceId: clientId,
      summary: 'Revoked a SCIM provisioning credential.',
    });
    return true;
  }

  /**
   * Authenticate a bearer token and derive the request's tenant scope from it.
   *
   * The scope comes from the credential and nothing else. A SCIM request carries no tenant id in
   * its path or body, so there is nothing for a caller to tamper with — which is what makes the
   * repository-level scoping sufficient here.
   */
  async authenticate(bearerToken: string | undefined): Promise<ScimPrincipal | null> {
    if (!bearerToken || bearerToken.trim() === '') {
      return null;
    }

    const client = await this.prisma.runAsPlatformOperation(() =>
      this.provisioning.findEnabledScimClientByTokenHashForPlatform(hashToken(bearerToken.trim())),
    );

    if (!client) {
      await this.securityEvents.record({
        action: SECURITY_ACTIONS.scimAuthFailed,
        resourceType: 'scim_client',
        summary: 'A SCIM request presented an unrecognised bearer token.',
        // No fragment of the presented token is recorded — it may be a real credential for
        // somewhere else, mistyped into this field.
      });
      return null;
    }

    // A company that is suspended, closed or still provisioning must not be provisioned into.
    if (client.tenant.lifecycleState !== 'Active' && client.tenant.lifecycleState !== 'ReadOnly') {
      return null;
    }

    await this.prisma.runAsPlatformOperation(() =>
      this.provisioning.touchScimClient(client.id, new Date()),
    );

    return {
      tenantId: client.tenantId,
      clientId: client.id,
      scope: tenantScopeForPlatformOperation(client.tenantId),
    };
  }

  // -------------------------------------------------------------------------
  // Users
  // -------------------------------------------------------------------------

  async listUsers(
    principal: ScimPrincipal,
    query: { filterAttribute?: string; filterValue?: string; startIndex: number; count: number },
    location: (id: string) => string,
  ): Promise<{ resources: ScimUser[]; total: number }> {
    if (query.filterAttribute !== undefined && query.filterValue !== undefined) {
      const match = await this.findMembership(principal, query.filterAttribute, query.filterValue);
      const resources = match ? [await this.toScimUser(principal, match, location)] : [];
      return { resources, total: resources.length };
    }

    const [rows, total] = await this.scoped(
      principal,
      async () =>
        [
          await this.memberships.listForTenantWithUsers(principal.scope, {
            skip: Math.max(query.startIndex - 1, 0),
            take: query.count,
          }),
          await this.memberships.countForTenant(principal.scope),
        ] as const,
    );

    return {
      resources: await Promise.all(rows.map((row) => this.toScimUser(principal, row, location))),
      total,
    };
  }

  async getUser(
    principal: ScimPrincipal,
    userId: string,
    location: (id: string) => string,
  ): Promise<ScimUser> {
    const membership = await this.scoped(principal, () =>
      this.memberships.findByUserIdWithUser(principal.scope, userId),
    );
    if (!membership) {
      // A person who is not a member of this company is indistinguishable from one who does not
      // exist: the scoped lookup returns nothing either way.
      throw new NotFoundException('No such user.');
    }
    return this.toScimUser(principal, membership, location);
  }

  /**
   * Create or reactivate a user.
   *
   * Idempotent by design: connectors retry, and a `409` on an address that already exists is
   * what SCIM specifies — but a *suspended* membership being re-pushed means "this person is
   * back", so that reactivates rather than conflicting.
   */
  async createUser(
    principal: ScimPrincipal,
    input: ScimUserInput,
    location: (id: string) => string,
  ): Promise<{ user: ScimUser; created: boolean }> {
    const email = normaliseEmail(input.userName ?? primaryEmail(input));
    if (email === undefined) {
      throw new BadRequestException('userName must be an email address.');
    }

    const domainVerified = await this.domains.isDomainVerifiedFor(principal.tenantId, email);
    if (!domainVerified) {
      throw new BadRequestException(
        `This company has not verified the domain of "${email}". Verify the domain before ` +
          'provisioning addresses at it, or invite the person instead.',
      );
    }

    const displayName = displayNameFrom(input) ?? email;
    const active = input.active ?? true;

    // Look the person up once. They may already exist on the platform (working for another
    // company, or previously invited here) without holding a live membership in this one.
    const person = await this.prisma.runAsPlatformOperation(() =>
      this.users.findByEmailForPlatform(email),
    );
    const existing = person
      ? await this.scoped(principal, () =>
          this.memberships.findByUserIdWithUser(principal.scope, person.id),
        )
      : null;

    if (existing) {
      if (existing.accountState === 'Active') {
        throw new ConflictException('A user with that userName already exists.');
      }

      // Suspended or offboarded and being pushed again: the identity provider is telling us this
      // person is back. Reactivating is the useful answer; a 409 would leave the connector stuck.
      await this.applyActive(principal, existing.userId, active, 'scim_create');
      if (input.externalId !== undefined) {
        await this.scoped(principal, () =>
          this.memberships.setProvisioningIdentity(principal.scope, existing.userId, {
            externalId: input.externalId as string,
            source: 'Scim',
          }),
        );
      }

      const refreshed = await this.scoped(principal, () =>
        this.memberships.findByUserIdWithUser(principal.scope, existing.userId),
      );
      return {
        user: await this.toScimUser(
          principal,
          refreshed as NonNullable<typeof refreshed>,
          location,
        ),
        created: false,
      };
    }

    const created = await this.prisma.runInTenantTransaction(principal.scope, async () => {
      // One transaction: a failure part-way through must not leave a platform identity with no
      // membership, which would be a person who exists and belongs nowhere.
      const provisioned =
        person ??
        // No `runAsPlatformOperation` here, and that is not an omission: `users` is deliberately
        // not under RLS (one human belongs to several companies, so a tenant_id would be wrong —
        // see the Prompt 4 RLS migration), so this write needs no platform escalation. Asking for
        // one inside a tenant scope is refused outright, which is how this was found.
        (await this.users.createForPlatform({
          ubossUniqueId: generateUbossUniqueId(),
          email,
          displayName,
        }));

      await this.memberships.create(principal.scope, { userId: provisioned.id });
      await this.memberships.setProvisioningIdentity(principal.scope, provisioned.id, {
        ...(input.externalId === undefined ? {} : { externalId: input.externalId }),
        source: 'Scim',
      });
      // Active immediately, with no activation link: the company has proved it controls the
      // domain, and the whole point of SCIM + SSO is that the person signs in through the
      // identity provider without a separate UBoss activation step. They still have no password,
      // so a company without SSO gains nothing from this until it invites them.
      await this.memberships.setAccountState(
        principal.scope,
        provisioned.id,
        active ? 'Active' : 'Suspended',
      );

      return provisioned;
    });

    await this.securityEvents.record({
      action: SECURITY_ACTIONS.scimUserProvisioned,
      tenantId: principal.tenantId,
      resourceType: 'tenant_membership',
      resourceId: created.id,
      summary: 'Provisioned a member through SCIM.',
      metadata: { active, source: 'Scim', clientId: principal.clientId },
    });

    const membership = await this.scoped(principal, () =>
      this.memberships.findByUserIdWithUser(principal.scope, created.id),
    );
    return {
      user: await this.toScimUser(
        principal,
        membership as NonNullable<typeof membership>,
        location,
      ),
      created: true,
    };
  }

  /** `PUT /Users/:id` — replace the mutable attributes. */
  async replaceUser(
    principal: ScimPrincipal,
    userId: string,
    input: ScimUserInput,
    location: (id: string) => string,
  ): Promise<ScimUser> {
    const membership = await this.scoped(principal, () =>
      this.memberships.findByUserIdWithUser(principal.scope, userId),
    );
    if (!membership) {
      throw new NotFoundException('No such user.');
    }

    if (input.active !== undefined) {
      await this.applyActive(principal, userId, input.active, 'scim_replace');
    }
    if (input.externalId !== undefined) {
      await this.scoped(principal, () =>
        this.memberships.setProvisioningIdentity(principal.scope, userId, {
          externalId: input.externalId as string,
          source: 'Scim',
        }),
      );
    }

    const refreshed = await this.scoped(principal, () =>
      this.memberships.findByUserIdWithUser(principal.scope, userId),
    );
    return this.toScimUser(principal, refreshed as NonNullable<typeof refreshed>, location);
  }

  /** `PATCH /Users/:id` — the understood subset only; anything else is refused, never ignored. */
  async patchUser(
    principal: ScimPrincipal,
    userId: string,
    operations: ScimPatchOperation[],
    location: (id: string) => string,
  ): Promise<ScimUser> {
    const membership = await this.scoped(principal, () =>
      this.memberships.findByUserIdWithUser(principal.scope, userId),
    );
    if (!membership) {
      throw new NotFoundException('No such user.');
    }

    for (const operation of operations) {
      const understood = understandPatch(operation);
      if (understood === undefined) {
        // Refusing is essential rather than pedantic: silently ignoring a deprovisioning PATCH
        // would leave a departed employee with access while the connector reported success.
        throw new BadRequestException(
          `This server does not support the operation "${operation.op} ${operation.path ?? ''}".`.trim(),
        );
      }

      if (understood.kind === 'set-active') {
        await this.applyActive(principal, userId, understood.active, 'scim_patch');
      } else if (understood.kind !== 'set-display-name') {
        throw new BadRequestException('That operation is not valid on a User resource.');
      }
      // `set-display-name` on a User is accepted and intentionally not applied: the display name
      // belongs to the person's platform identity, shared across every company they work for,
      // and one employer's directory must not rename them everywhere. Accepted rather than
      // refused because refusing would break connectors that always send it.
    }

    const refreshed = await this.scoped(principal, () =>
      this.memberships.findByUserIdWithUser(principal.scope, userId),
    );
    return this.toScimUser(principal, refreshed as NonNullable<typeof refreshed>, location);
  }

  /** `DELETE /Users/:id` — offboard. The membership and its history survive. */
  async deleteUser(principal: ScimPrincipal, userId: string): Promise<void> {
    const membership = await this.scoped(principal, () =>
      this.memberships.findByUserIdWithUser(principal.scope, userId),
    );
    if (!membership) {
      throw new NotFoundException('No such user.');
    }

    await this.scoped(principal, () =>
      this.memberships.setAccountState(principal.scope, userId, 'Offboarded'),
    );
    const revoked = await this.sessions.revokeAll(userId, { reason: 'scim_deprovisioned' });

    await this.securityEvents.recordSuspicious({
      action: SECURITY_ACTIONS.scimUserDeprovisioned,
      tenantId: principal.tenantId,
      resourceType: 'tenant_membership',
      resourceId: membership.id,
      summary: 'Offboarded a member through SCIM.',
      metadata: { sessionsRevoked: revoked, clientId: principal.clientId },
    });
  }

  /**
   * Apply `active`, and revoke sessions when it becomes false.
   *
   * The revoke is the part that matters. Setting a state without ending the sessions would mean
   * a deprovisioned person keeps working until their session happens to expire, which is up to
   * twelve hours of access after their employer said to remove it.
   */
  private async applyActive(
    principal: ScimPrincipal,
    userId: string,
    active: boolean,
    reason: string,
  ): Promise<void> {
    await this.scoped(principal, () =>
      this.memberships.setAccountState(principal.scope, userId, active ? 'Active' : 'Suspended'),
    );

    if (!active) {
      const revoked = await this.sessions.revokeAll(userId, { reason });
      await this.securityEvents.recordSuspicious({
        action: SECURITY_ACTIONS.scimUserDeprovisioned,
        tenantId: principal.tenantId,
        resourceType: 'tenant_membership',
        resourceId: userId,
        summary: 'Suspended a member through SCIM.',
        metadata: { sessionsRevoked: revoked, reason, clientId: principal.clientId },
      });
    } else {
      await this.securityEvents.record({
        action: SECURITY_ACTIONS.scimUserProvisioned,
        tenantId: principal.tenantId,
        resourceType: 'tenant_membership',
        resourceId: userId,
        summary: 'Reactivated a member through SCIM.',
        metadata: { reason, clientId: principal.clientId },
      });
    }
  }

  // -------------------------------------------------------------------------
  // Groups
  // -------------------------------------------------------------------------

  async listGroups(
    principal: ScimPrincipal,
    query: { filterAttribute?: string; filterValue?: string; startIndex: number; count: number },
    location: (id: string) => string,
  ): Promise<{ resources: ScimGroup[]; total: number }> {
    if (query.filterAttribute !== undefined && query.filterValue !== undefined) {
      const group =
        query.filterAttribute === 'displayName'
          ? await this.provisioning.findGroupByName(principal.scope, query.filterValue)
          : query.filterAttribute === 'externalId'
            ? await this.provisioning.findGroupByExternalId(principal.scope, query.filterValue)
            : null;

      const resources = group ? [await this.toScimGroup(principal, group, location)] : [];
      return { resources, total: resources.length };
    }

    const [groups, total] = await Promise.all([
      this.provisioning.listGroups(principal.scope, {
        skip: Math.max(query.startIndex - 1, 0),
        take: query.count,
      }),
      this.provisioning.countGroups(principal.scope),
    ]);

    return {
      resources: await Promise.all(
        groups.map((group) => this.toScimGroup(principal, group, location)),
      ),
      total,
    };
  }

  async getGroup(
    principal: ScimPrincipal,
    groupId: string,
    location: (id: string) => string,
  ): Promise<ScimGroup> {
    const group = await this.provisioning.findGroup(principal.scope, groupId);
    if (!group) {
      throw new NotFoundException('No such group.');
    }
    return this.toScimGroup(principal, group, location);
  }

  async createGroup(
    principal: ScimPrincipal,
    input: ScimGroupInput,
    location: (id: string) => string,
  ): Promise<ScimGroup> {
    const displayName = input.displayName?.trim();
    if (!displayName) {
      throw new BadRequestException('displayName is required.');
    }

    const clash = await this.provisioning.findGroupByName(principal.scope, displayName);
    if (clash) {
      throw new ConflictException('A group with that displayName already exists.');
    }

    const group = await this.provisioning.createGroup(principal.scope, {
      displayName,
      ...(input.externalId === undefined ? {} : { externalId: input.externalId }),
      source: 'Scim',
    });

    if (input.members?.length) {
      await this.provisioning.replaceGroupMembers(
        principal.scope,
        group.id,
        await this.membersInThisCompany(principal, input.members),
      );
    }

    await this.securityEvents.record({
      action: SECURITY_ACTIONS.scimGroupChanged,
      tenantId: principal.tenantId,
      resourceType: 'user_group',
      resourceId: group.id,
      summary: `Created the group "${displayName}" through SCIM.`,
      metadata: { members: input.members?.length ?? 0, clientId: principal.clientId },
    });

    return this.toScimGroup(principal, group, location);
  }

  async replaceGroup(
    principal: ScimPrincipal,
    groupId: string,
    input: ScimGroupInput,
    location: (id: string) => string,
  ): Promise<ScimGroup> {
    const group = await this.provisioning.findGroup(principal.scope, groupId);
    if (!group) {
      throw new NotFoundException('No such group.');
    }

    if (input.displayName && input.displayName !== group.displayName) {
      await this.provisioning.renameGroup(principal.scope, groupId, input.displayName.trim());
    }

    // `PUT` replaces the whole resource, so an absent `members` means "no members" rather than
    // "leave them alone" — that is what distinguishes PUT from PATCH.
    await this.provisioning.replaceGroupMembers(
      principal.scope,
      groupId,
      await this.membersInThisCompany(principal, input.members ?? []),
    );

    await this.securityEvents.record({
      action: SECURITY_ACTIONS.scimGroupChanged,
      tenantId: principal.tenantId,
      resourceType: 'user_group',
      resourceId: groupId,
      summary: 'Replaced a group through SCIM.',
      metadata: { members: input.members?.length ?? 0, clientId: principal.clientId },
    });

    const refreshed = await this.provisioning.findGroup(principal.scope, groupId);
    return this.toScimGroup(principal, refreshed as NonNullable<typeof refreshed>, location);
  }

  async patchGroup(
    principal: ScimPrincipal,
    groupId: string,
    operations: ScimPatchOperation[],
    location: (id: string) => string,
  ): Promise<ScimGroup> {
    const group = await this.provisioning.findGroup(principal.scope, groupId);
    if (!group) {
      throw new NotFoundException('No such group.');
    }

    for (const operation of operations) {
      const understood = understandPatch(operation);
      if (understood === undefined) {
        throw new BadRequestException(
          `This server does not support the operation "${operation.op} ${operation.path ?? ''}".`.trim(),
        );
      }

      switch (understood.kind) {
        case 'set-display-name':
          await this.provisioning.renameGroup(principal.scope, groupId, understood.displayName);
          break;
        case 'add-members':
          for (const userId of await this.membersInThisCompany(
            principal,
            understood.userIds.map((value) => ({ value })),
          )) {
            await this.provisioning.addGroupMember(principal.scope, {
              groupId,
              userId,
              source: 'Scim',
            });
          }
          break;
        case 'remove-members':
          for (const userId of understood.userIds) {
            await this.provisioning.removeGroupMember(principal.scope, groupId, userId);
          }
          break;
        case 'replace-members':
          await this.provisioning.replaceGroupMembers(
            principal.scope,
            groupId,
            await this.membersInThisCompany(
              principal,
              understood.userIds.map((value) => ({ value })),
            ),
          );
          break;
        default:
          throw new BadRequestException('That operation is not valid on a Group resource.');
      }
    }

    await this.securityEvents.record({
      action: SECURITY_ACTIONS.scimGroupChanged,
      tenantId: principal.tenantId,
      resourceType: 'user_group',
      resourceId: groupId,
      summary: 'Patched a group through SCIM.',
      metadata: { operations: operations.length, clientId: principal.clientId },
    });

    const refreshed = await this.provisioning.findGroup(principal.scope, groupId);
    return this.toScimGroup(principal, refreshed as NonNullable<typeof refreshed>, location);
  }

  async deleteGroup(principal: ScimPrincipal, groupId: string): Promise<void> {
    const removed = await this.provisioning.deleteGroup(principal.scope, groupId);
    if (removed === 0) {
      throw new NotFoundException('No such group.');
    }

    await this.securityEvents.record({
      action: SECURITY_ACTIONS.scimGroupChanged,
      tenantId: principal.tenantId,
      resourceType: 'user_group',
      resourceId: groupId,
      summary: 'Deleted a group through SCIM.',
      metadata: { clientId: principal.clientId },
    });
  }

  // -------------------------------------------------------------------------

  /**
   * Filter proposed group members down to people who are actually members of this company.
   *
   * A connector can send any id. Silently accepting one would put a stranger in a company's
   * group; the scoped membership lookup is what makes that impossible, and unknown ids are
   * dropped rather than erroring so one stale entry does not fail an otherwise valid sync.
   */
  private async membersInThisCompany(
    principal: ScimPrincipal,
    members: { value?: string }[],
  ): Promise<string[]> {
    const ids: string[] = [];

    for (const member of members) {
      if (!member.value) {
        continue;
      }
      const membership = await this.scoped(principal, () =>
        this.memberships.findByUserId(principal.scope, member.value as string),
      );
      if (membership) {
        ids.push(member.value);
      } else {
        this.logger.warn(
          `SCIM group membership referenced a user outside tenant ${principal.tenantId}; ignored.`,
        );
      }
    }

    return ids;
  }

  private async findMembership(principal: ScimPrincipal, attribute: string, value: string) {
    if (attribute === 'userName' || attribute === 'emails.value') {
      const email = normaliseEmail(value);
      if (email === undefined) {
        return null;
      }
      const person = await this.prisma.runAsPlatformOperation(() =>
        this.users.findByEmailForPlatform(email),
      );
      return person
        ? this.scoped(principal, () =>
            this.memberships.findByUserIdWithUser(principal.scope, person.id),
          )
        : null;
    }

    if (attribute === 'externalId') {
      return this.scoped(principal, () =>
        this.memberships.findByScimExternalId(principal.scope, value),
      );
    }

    if (attribute === 'id') {
      return this.scoped(principal, () =>
        this.memberships.findByUserIdWithUser(principal.scope, value),
      );
    }

    return null;
  }

  private async toScimUser(
    principal: ScimPrincipal,
    membership: {
      id: string;
      userId: string;
      accountState: string;
      scimExternalId: string | null;
      createdAt: Date;
      updatedAt: Date;
      user: { id: string; email: string; displayName: string; ubossUniqueId: string };
    },
    location: (id: string) => string,
  ): Promise<ScimUser> {
    const groups = await this.provisioning.listGroupsForUser(principal.scope, membership.userId);

    return {
      schemas: [SCIM_SCHEMAS.user],
      // The person's platform id, not the membership id: it is what every other endpoint calls
      // them, and it stays the same if the membership is rebuilt.
      id: membership.userId,
      ...(membership.scimExternalId === null ? {} : { externalId: membership.scimExternalId }),
      userName: membership.user.email,
      displayName: membership.user.displayName,
      name: { formatted: membership.user.displayName },
      emails: [{ value: membership.user.email, primary: true, type: 'work' }],
      // Only `Active` is active. `InvitePending` is not: the person cannot work yet, and a
      // connector that saw `true` would believe provisioning had completed.
      active: membership.accountState === 'Active',
      groups: groups.map((group) => ({ value: group.id, display: group.displayName })),
      meta: {
        resourceType: 'User',
        created: membership.createdAt.toISOString(),
        lastModified: membership.updatedAt.toISOString(),
        location: location(membership.userId),
      },
    };
  }

  private async toScimGroup(
    principal: ScimPrincipal,
    group: {
      id: string;
      displayName: string;
      externalId: string | null;
      createdAt: Date;
      updatedAt: Date;
    },
    location: (id: string) => string,
  ): Promise<ScimGroup> {
    const members = await this.provisioning.listGroupMembers(principal.scope, group.id);

    return {
      schemas: [SCIM_SCHEMAS.group],
      id: group.id,
      ...(group.externalId === null ? {} : { externalId: group.externalId }),
      displayName: group.displayName,
      members: members.map((member) => ({
        value: member.userId,
        display: member.user.displayName,
      })),
      meta: {
        resourceType: 'Group',
        created: group.createdAt.toISOString(),
        lastModified: group.updatedAt.toISOString(),
        location: location(group.id),
      },
    };
  }
}

function normaliseEmail(value: string | undefined): string | undefined {
  const trimmed = value?.trim().toLowerCase();
  if (!trimmed || !trimmed.includes('@') || trimmed.length > 320) {
    return undefined;
  }
  return trimmed;
}

function primaryEmail(input: ScimUserInput): string | undefined {
  const primary = input.emails?.find((email) => email.primary === true) ?? input.emails?.[0];
  return primary?.value;
}

function displayNameFrom(input: ScimUserInput): string | undefined {
  if (input.displayName?.trim()) {
    return input.displayName.trim();
  }
  if (input.name?.formatted?.trim()) {
    return input.name.formatted.trim();
  }
  const joined = `${input.name?.givenName ?? ''} ${input.name?.familyName ?? ''}`.trim();
  return joined === '' ? undefined : joined;
}
