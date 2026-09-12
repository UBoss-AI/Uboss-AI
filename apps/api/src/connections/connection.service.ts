import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';

import {
  connectorDefinition,
  derivedConnectionState,
  isCredentialExpiringSoon,
  isHighRiskToolCategory,
  type ConnectionEnvironment,
  type ConnectionScope,
  type ConnectionState,
  type ToolActionCategory,
} from '@uboss/types';

import { AuditEventService } from '../audit/audit-event.service.js';
import { AuthorizationService } from '../authorization/authorization.service.js';
import type { Connection } from '../generated/prisma/client.js';
import { PrismaService } from '../persistence/prisma.service.js';
import type { TenantScope } from '../persistence/tenant-context.js';
import { ConnectorAdapter } from './connector-adapter.js';
import { SecretNotFoundError, SecretsVault } from './secrets-vault.js';

export interface ConnectionView {
  id: string;
  scope: ConnectionScope;
  connectorKind: string;
  connectorLabel: string;
  label: string;
  ownerUserId: string;
  environment: ConnectionEnvironment | null;
  /** Derived, never stored. See the class comment. */
  state: ConnectionState;
  /** The handle. **Never the credential** — nothing returns that to a screen. */
  secretRef: string | null;
  hasSecret: boolean;
  allowedDepartmentIds: string[];
  credentialExpiresAt: string | null;
  expiringSoon: boolean;
  lastSuccessfulCheckAt: string | null;
  lastCheckedAt: string | null;
  lastError: string | null;
  disabledReason: string | null;
  /** How many Engine Agents hold a live grant. The client's "affected Agent count". */
  affectedAgentCount: number;
  /** Live grants, by category. */
  grants: {
    id: string;
    agentId: string;
    category: ToolActionCategory;
    highRisk: boolean;
    reason: string | null;
    grantedByUserId: string;
    grantedAt: string;
  }[];
}

/**
 * Integrations and Connections: the lifecycle, the secrets and Agent Tool Permission.
 *
 * ## The state is derived at read time, and there is no state column
 *
 * A credential that expired an hour ago is expired **now**, whether or not a sweep has run. A
 * stored state would leave a window in which the database says `Connected` and the provider says
 * otherwise, and every Engine Agent run in that window would be authorised against a stale
 * answer. `derivedConnectionState` reads `disabledAt`, `credentialExpiresAt`,
 * `needsReauthorization` and `lastError` — the same rule as break-glass and platform-role expiry
 * (ADR-047).
 *
 * ## Two permission systems, and they must not meet
 *
 * **A human** needs `settings:Administer` for anything belonging to the **company**: creating a
 * Company Connection, configuring one, disabling one, transferring it. That comes from the
 * Prompt 7 engine.
 *
 * **Their own** User Connection is different, and requiring `Administer` for it was wrong.
 * Connecting your own mailbox grants nobody else anything — it is the same act as enrolling your
 * own second factor — so it needs only `settings:View`, which every member holds. An ordinary
 * employee has to be able to do it, or the client's User Connection type would exist and be
 * unreachable by the people it is for.
 *
 * An administrator may **disable** anybody's personal connection, because that is the security
 * action a company needs. They may not rotate or reauthorize one: that means holding somebody
 * else's credential.
 *
 * **An Engine Agent** needs a `ConnectionToolGrant` naming it, the connection and the category.
 * That comes from here and from nowhere else. `mayAgentUse` is the only function that answers it,
 * and it deliberately takes an `agentId` rather than a user id, so it is impossible to satisfy by
 * passing a person.
 *
 * The client's rule is that these are separate; the concrete reason is that somebody able to
 * *configure* an integration should not thereby be able to make an agent delete records through
 * it. A single merged vocabulary would grant exactly that, silently, the first time somebody was
 * made an administrator.
 *
 * ## A User Connection is never transferred
 *
 * `transferOwner` refuses one outright. The credential is that person's own account; handing it
 * to a successor would give somebody access to a mailbox that is not theirs. Offboarding disables
 * it instead — which is why `HANDOVER_DOMAINS` names connections as preserved rather than moved.
 */
@Injectable()
export class ConnectionService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly authorization: AuthorizationService,
    private readonly auditEvents: AuditEventService,
    private readonly vault: SecretsVault,
    private readonly connector: ConnectorAdapter,
  ) {}

  // -------------------------------------------------------------------------
  // Lifecycle
  // -------------------------------------------------------------------------

  /**
   * Create a connection and store its credential.
   *
   * One transaction for the row; the secret is written **first**, outside it, because a
   * connection row pointing at a handle the vault does not hold is a broken connection, whereas
   * an orphaned secret is a harmless row the vault can forget. Given the choice, leave the
   * useless artefact rather than the misleading one.
   */
  async create(input: {
    scope: TenantScope;
    actorUserId: string;
    scopeKind: ConnectionScope;
    connectorKind: string;
    label: string;
    /** For a `User` connection, defaults to the actor: it is their own account. */
    ownerUserId?: string | undefined;
    environment?: ConnectionEnvironment | undefined;
    secret: string;
    allowedDepartmentIds?: string[] | undefined;
  }): Promise<ConnectionView> {
    const context = await this.authorization.contextFor(input.scope, input.actorUserId);
    /*
     * A Company Connection is company infrastructure: `Administer`.
     *
     * A person's **own** User Connection is not — it is their own account, and connecting it
     * grants nobody else anything, so it needs only the permission that gets them to Settings at
     * all. Requiring `Administer` here would make the client's User Connection type unreachable
     * by exactly the people it exists for, which is what this prompt's own test caught.
     */
    await this.authorization.assertCan(context, {
      module: 'settings',
      action: input.scopeKind === 'User' ? 'View' : 'Administer',
    });

    const definition = connectorDefinition(input.connectorKind);
    if (!definition) {
      throw new BadRequestException(
        `There is no connector called "${input.connectorKind}". Only connectors with an adapter ` +
          'behind them are offered — a catalogue entry with nothing to talk to would fail in a ' +
          'way that looks like a credential problem.',
      );
    }

    if (!definition.scopes.includes(input.scopeKind)) {
      throw new BadRequestException(
        `${definition.label} cannot be a ${input.scopeKind} connection. ` +
          (input.scopeKind === 'Company'
            ? 'It is one person’s own account, so it belongs to them and is never transferred.'
            : 'It is company infrastructure, so it belongs to the company rather than a person.'),
      );
    }

    if (definition.hasEnvironments && input.environment === undefined) {
      throw new BadRequestException(
        `${definition.label} has separate Test and Production environments, so this connection ` +
          'must say which. A connection that could be either is one somebody will point at ' +
          'production by accident.',
      );
    }
    if (!definition.hasEnvironments && input.environment !== undefined) {
      throw new BadRequestException(`${definition.label} has only one environment.`);
    }

    const ownerUserId =
      input.scopeKind === 'User' ? input.actorUserId : (input.ownerUserId ?? input.actorUserId);

    if (
      input.scopeKind === 'User' &&
      input.ownerUserId &&
      input.ownerUserId !== input.actorUserId
    ) {
      throw new ForbiddenException(
        'A User Connection can only be created for yourself. Its credential is your own account, ' +
          'and creating one on somebody else’s behalf would mean holding their credential.',
      );
    }

    const secretRef = await this.vault.put(input.scope, input.secret);

    return this.prisma.runInTenantTransaction(input.scope, async () => {
      const existing = await this.prisma.client.connection.findFirst({
        where: {
          tenantId: input.scope.tenantId,
          connectorKind: input.connectorKind,
          environment: input.environment ?? null,
          ownerUserId,
          label: input.label.trim(),
        },
      });
      if (existing) {
        // Forget the secret we just stored rather than leaving it behind a handle nothing uses.
        await this.vault.forget(input.scope, secretRef);
        throw new ConflictException(
          'A connection with that name already exists for this connector, environment and ' +
            'owner. Two rows for the same credential make the affected-agent count wrong.',
        );
      }

      const created = await this.prisma.client.connection.create({
        data: {
          tenantId: input.scope.tenantId,
          scope: input.scopeKind,
          connectorKind: input.connectorKind,
          label: input.label.trim(),
          ownerUserId,
          environment: input.environment ?? null,
          secretRef,
          allowedDepartmentIds: input.allowedDepartmentIds ?? [],
          createdByUserId: input.actorUserId,
        },
      });

      await this.auditEvents.appendWithinCurrentScope(input.scope.tenantId, {
        action: 'connection.created',
        resourceType: 'connection',
        resourceId: created.id,
        actorUserId: input.actorUserId,
        summary: `Created the ${definition.label} connection "${created.label}".`,
        metadata: {
          connectorKind: input.connectorKind,
          scope: input.scopeKind,
          environment: input.environment ?? null,
          ownerUserId,
          // The handle, never the value, and never its length.
          secretRef,
          vault: this.vault.describe().name,
        },
      });

      return this.viewOf(created, []);
    });
  }

  /** Everything this caller may see, with each state derived and each agent count computed. */
  async list(input: { scope: TenantScope; actorUserId: string }): Promise<{
    connections: ConnectionView[];
    vault: { name: string; isExternalProvider: boolean; note: string };
    note: string;
  }> {
    const context = await this.authorization.contextFor(input.scope, input.actorUserId);
    await this.authorization.assertCan(context, { module: 'settings', action: 'View' });

    const mayAdminister = (
      await this.authorization.authorize(context, { module: 'settings', action: 'Administer' })
    ).allowed;

    return this.prisma.runInTenantTransaction(input.scope, async () => {
      const rows = await this.prisma.client.connection.findMany({
        where: {
          tenantId: input.scope.tenantId,
          // A person always sees their own User Connections. Somebody else's personal connection
          // is visible only to an administrator, and even then only as a row — never a credential.
          ...(mayAdminister
            ? {}
            : { OR: [{ scope: 'Company' }, { ownerUserId: input.actorUserId }] }),
        },
        orderBy: [{ connectorKind: 'asc' }, { label: 'asc' }],
      });

      const grants = await this.prisma.client.connectionToolGrant.findMany({
        where: {
          tenantId: input.scope.tenantId,
          connectionId: { in: rows.map((row) => row.id) },
          revokedAt: null,
        },
      });

      return {
        connections: rows.map((row) =>
          this.viewOf(
            row,
            grants.filter((grant) => grant.connectionId === row.id),
          ),
        ),
        vault: this.vault.describe(),
        note:
          'A connection stores a reference to its credential, never the credential. Nothing in ' +
          'this response, and no route in this module, returns a secret value — a credential ' +
          'that has been shown once is a credential in a browser’s memory.',
      };
    });
  }

  /** One connection. */
  async view(input: {
    scope: TenantScope;
    actorUserId: string;
    connectionId: string;
  }): Promise<ConnectionView> {
    const all = await this.list({ scope: input.scope, actorUserId: input.actorUserId });
    const found = all.connections.find((row) => row.id === input.connectionId);
    if (!found) {
      throw new NotFoundException('There is no such connection you can see.');
    }
    return found;
  }

  /**
   * *Test Connection*.
   *
   * The credential is resolved from the vault **here**, handed to the adapter, and never returned.
   * The result updates the state inputs and appends to the append-only check history — a history
   * rather than two columns, because "it has been failing since Tuesday" is what somebody
   * debugging an integration needs.
   */
  async check(input: {
    scope: TenantScope;
    actorUserId: string;
    connectionId: string;
  }): Promise<{ succeeded: boolean; detail: string; state: ConnectionState }> {
    const row = await this.requireConnection(input.scope, input.connectionId);
    // Testing your own personal connection is part of setting it up, so the same split applies:
    // `View` for your own, `Administer` for the company's.
    await this.assertMayConfigure(input.scope, input.actorUserId, row, 'enable');

    if (row.secretRef === null) {
      return {
        succeeded: false,
        detail: 'There is no credential stored for this connection yet.',
        state: 'NeedsReauthorization',
      };
    }

    let secret: string;
    try {
      secret = await this.vault.reveal(input.scope, row.secretRef);
    } catch (error) {
      if (error instanceof SecretNotFoundError) {
        // The row points at a handle the vault does not hold. Reported as a check failure rather
        // than a 500: it is a real state a connection can be in, and it needs reauthorizing.
        return await this.recordCheck(input, row, {
          succeeded: false,
          detail: 'The stored credential could not be found. Reauthorize this connection.',
          durationMs: 0,
          needsReauthorization: true,
        });
      }
      throw error;
    }

    const result = await this.connector.check({
      connectorKind: row.connectorKind,
      environment: row.environment,
      secret,
    });

    return this.recordCheck(input, row, result);
  }

  /** Replace the credential, keeping the handle and the grants. */
  async rotateSecret(input: {
    scope: TenantScope;
    actorUserId: string;
    connectionId: string;
    secret: string;
    /** Where the provider states one. Clears `Expired` when it is in the future. */
    credentialExpiresAt?: Date | undefined;
  }): Promise<ConnectionView> {
    const row = await this.requireConnection(input.scope, input.connectionId);
    await this.assertMayConfigure(input.scope, input.actorUserId, row, 'rotateSecret');

    // A rotation keeps the handle, so every tool grant and every agent reference survives.
    // Issuing a new handle would silently detach them.
    if (row.secretRef === null) {
      const secretRef = await this.vault.put(input.scope, input.secret);
      await this.prisma.runInTenantTransaction(input.scope, () =>
        this.prisma.client.connection.update({
          where: { id: row.id },
          data: { secretRef, version: { increment: 1 } },
        }),
      );
    } else {
      await this.vault.rotate(input.scope, row.secretRef, input.secret);
    }

    return this.prisma.runInTenantTransaction(input.scope, async () => {
      const updated = await this.prisma.client.connection.update({
        where: { id: row.id },
        data: {
          // A new credential clears both failure states: whatever was wrong, this is a different
          // credential and the next check decides.
          needsReauthorization: false,
          lastError: null,
          ...(input.credentialExpiresAt === undefined
            ? {}
            : { credentialExpiresAt: input.credentialExpiresAt }),
          version: { increment: 1 },
        },
      });

      await this.auditEvents.appendWithinCurrentScope(input.scope.tenantId, {
        action: 'connection.secret_rotated',
        resourceType: 'connection',
        resourceId: row.id,
        resourceVersion: updated.version,
        actorUserId: input.actorUserId,
        summary: `Rotated the credential for "${row.label}".`,
        metadata: {
          secretRef: row.secretRef,
          // Stated: the handle is unchanged, so nothing an agent holds was detached.
          handleUnchanged: true,
          liveGrantsPreserved: true,
        },
      });

      return this.viewOf(updated, await this.liveGrants(input.scope, row.id));
    });
  }

  /**
   * Reauthorize: clear the withdrawn-consent state after the credential has been replaced.
   *
   * Separate from `rotateSecret` because the client lists them separately and they are genuinely
   * different acts — a provider can withdraw consent for a credential that is still valid, and
   * re-consenting does not always mean a new key.
   */
  async reauthorize(input: {
    scope: TenantScope;
    actorUserId: string;
    connectionId: string;
    /** Supplied when re-consent produced a new credential. */
    secret?: string | undefined;
  }): Promise<ConnectionView> {
    if (input.secret !== undefined) {
      await this.rotateSecret({
        scope: input.scope,
        actorUserId: input.actorUserId,
        connectionId: input.connectionId,
        secret: input.secret,
      });
    }

    const row = await this.requireConnection(input.scope, input.connectionId);
    await this.assertMayConfigure(input.scope, input.actorUserId, row, 'reauthorize');

    return this.prisma.runInTenantTransaction(input.scope, async () => {
      const updated = await this.prisma.client.connection.update({
        where: { id: row.id },
        data: { needsReauthorization: false, lastError: null, version: { increment: 1 } },
      });

      await this.auditEvents.appendWithinCurrentScope(input.scope.tenantId, {
        action: 'connection.reauthorized',
        resourceType: 'connection',
        resourceId: row.id,
        actorUserId: input.actorUserId,
        summary: `Reauthorized "${row.label}".`,
        metadata: { credentialReplaced: input.secret !== undefined },
      });

      return this.viewOf(updated, await this.liveGrants(input.scope, row.id));
    });
  }

  /**
   * Disable a connection.
   *
   * **Grants are left standing.** A disabled connection cannot be used — `mayAgentUse` refuses
   * on state — so revoking every grant would destroy a configuration somebody has to rebuild in
   * order to re-enable, for no security gain. The reason is mandatory, in the database too:
   * "Disabled" with no reason is the state nobody can safely undo.
   */
  async disable(input: {
    scope: TenantScope;
    actorUserId: string;
    connectionId: string;
    reason: string;
  }): Promise<ConnectionView> {
    if (!input.reason.trim()) {
      throw new BadRequestException(
        'Disabling a connection needs a reason. Every Engine Agent that uses it stops working, ' +
          'and whoever finds that out needs to know why.',
      );
    }

    const row = await this.requireConnection(input.scope, input.connectionId);
    await this.assertMayConfigure(input.scope, input.actorUserId, row, 'disable');

    return this.prisma.runInTenantTransaction(input.scope, async () => {
      const grants = await this.liveGrants(input.scope, row.id);

      const updated = await this.prisma.client.connection.update({
        where: { id: row.id },
        data: {
          disabledAt: new Date(),
          disabledReason: input.reason.trim(),
          version: { increment: 1 },
        },
      });

      await this.auditEvents.appendWithinCurrentScope(input.scope.tenantId, {
        action: 'connection.disabled',
        resourceType: 'connection',
        resourceId: row.id,
        resourceVersion: updated.version,
        actorUserId: input.actorUserId,
        summary: `Disabled "${row.label}".`,
        reason: input.reason.trim(),
        metadata: {
          affectedAgentCount: new Set(grants.map((grant) => grant.agentId)).size,
          // Stated, because it is the surprising half: grants survive so re-enabling restores
          // the configuration rather than requiring it to be rebuilt.
          grantsRevoked: false,
        },
      });

      return this.viewOf(updated, grants);
    });
  }

  /** Bring a disabled connection back. The next check decides whether it works. */
  async enable(input: {
    scope: TenantScope;
    actorUserId: string;
    connectionId: string;
  }): Promise<ConnectionView> {
    const row = await this.requireConnection(input.scope, input.connectionId);
    await this.assertMayConfigure(input.scope, input.actorUserId, row, 'disable');

    return this.prisma.runInTenantTransaction(input.scope, async () => {
      const updated = await this.prisma.client.connection.update({
        where: { id: row.id },
        data: { disabledAt: null, disabledReason: null, version: { increment: 1 } },
      });

      await this.auditEvents.appendWithinCurrentScope(input.scope.tenantId, {
        action: 'connection.enabled',
        resourceType: 'connection',
        resourceId: row.id,
        actorUserId: input.actorUserId,
        summary: `Enabled "${row.label}". Its next check decides whether it works.`,
      });

      return this.viewOf(updated, await this.liveGrants(input.scope, row.id));
    });
  }

  /**
   * Transfer ownership of a **Company** connection.
   *
   * Refused for a User Connection. The credential is that person's own account, and handing it to
   * a successor would give somebody access to a mailbox that is not theirs — which is exactly why
   * offboarding disables a personal connection rather than moving it.
   */
  async transferOwner(input: {
    scope: TenantScope;
    actorUserId: string;
    connectionId: string;
    newOwnerUserId: string;
    reason: string;
  }): Promise<ConnectionView> {
    const context = await this.authorization.contextFor(input.scope, input.actorUserId);
    await this.authorization.assertCan(context, { module: 'settings', action: 'Administer' });

    const row = await this.requireConnection(input.scope, input.connectionId);

    if (row.scope === 'User') {
      throw new BadRequestException(
        'A User Connection cannot be transferred. Its credential is that person’s own account, ' +
          'so handing it over would give somebody else access to an account that is not theirs. ' +
          'Disable it and have the new owner create their own.',
      );
    }

    if (!input.reason.trim()) {
      throw new BadRequestException('Transferring a connection needs a reason.');
    }
    if (input.newOwnerUserId === row.ownerUserId) {
      throw new BadRequestException('That person already owns it.');
    }

    return this.prisma.runInTenantTransaction(input.scope, async () => {
      const membership = await this.prisma.client.tenantMembership.findFirst({
        where: {
          tenantId: input.scope.tenantId,
          userId: input.newOwnerUserId,
          accountState: 'Active',
        },
      });
      if (!membership) {
        throw new BadRequestException(
          'The new owner must be somebody with an active account in this company. Accountability ' +
            'for a live integration cannot sit with a suspended or offboarded person.',
        );
      }

      const updated = await this.prisma.client.connection.update({
        where: { id: row.id },
        data: { ownerUserId: input.newOwnerUserId, version: { increment: 1 } },
      });

      await this.auditEvents.appendWithinCurrentScope(input.scope.tenantId, {
        action: 'connection.owner_transferred',
        resourceType: 'connection',
        resourceId: row.id,
        resourceVersion: updated.version,
        actorUserId: input.actorUserId,
        summary: `Ownership of "${row.label}" moved.`,
        reason: input.reason.trim(),
        metadata: { fromUserId: row.ownerUserId, toUserId: input.newOwnerUserId },
      });

      return this.viewOf(updated, await this.liveGrants(input.scope, row.id));
    });
  }

  // -------------------------------------------------------------------------
  // Agent Tool Permission
  // -------------------------------------------------------------------------

  /**
   * Grant one Engine Agent one category on one connection.
   *
   * A high-risk category needs a reason, in the service **and** in the database. An unexplained
   * grant letting an agent delete records in a company's ERP is precisely the one somebody will
   * be asked to justify.
   */
  async grantToolPermission(input: {
    scope: TenantScope;
    actorUserId: string;
    connectionId: string;
    agentId: string;
    category: ToolActionCategory;
    reason?: string | undefined;
  }): Promise<{ id: string; note: string }> {
    const context = await this.authorization.contextFor(input.scope, input.actorUserId);
    // `Administer` on settings, not on some agent module: granting a tool permission is
    // configuring an integration's reach, and it is the highest-privilege act in this module.
    await this.authorization.assertCan(context, { module: 'settings', action: 'Administer' });

    const row = await this.requireConnection(input.scope, input.connectionId);
    const definition = connectorDefinition(row.connectorKind);

    if (!definition?.supportedCategories.includes(input.category)) {
      throw new BadRequestException(
        `${definition?.label ?? row.connectorKind} does not support ${input.category}. Granting a ` +
          'category the connector cannot perform would be a permission that reads as capability ' +
          'and is not.',
      );
    }

    if (isHighRiskToolCategory(input.category) && !input.reason?.trim()) {
      throw new BadRequestException(
        `${input.category} is a high-risk category and needs a reason. This grant lets an ` +
          'automated agent take that action in a live external system without a person present ' +
          'at the time.',
      );
    }

    return this.prisma.runInTenantTransaction(input.scope, async () => {
      const existing = await this.prisma.client.connectionToolGrant.findFirst({
        where: {
          tenantId: input.scope.tenantId,
          connectionId: row.id,
          agentId: input.agentId,
          category: input.category,
          revokedAt: null,
        },
      });
      if (existing) {
        return {
          id: existing.id,
          note: 'That agent already holds this category on this connection.',
        };
      }

      const created = await this.prisma.client.connectionToolGrant.create({
        data: {
          tenantId: input.scope.tenantId,
          connectionId: row.id,
          agentId: input.agentId,
          category: input.category,
          ...(input.reason?.trim() ? { reason: input.reason.trim() } : {}),
          grantedByUserId: input.actorUserId,
        },
      });

      await this.auditEvents.appendWithinCurrentScope(input.scope.tenantId, {
        action: 'connection.tool_permission_granted',
        resourceType: 'connection_tool_grant',
        resourceId: created.id,
        actorUserId: input.actorUserId,
        summary: `Engine Agent ${input.agentId} may now ${input.category} through "${row.label}".`,
        ...(input.reason?.trim() ? { reason: input.reason.trim() } : {}),
        metadata: {
          connectionId: row.id,
          agentId: input.agentId,
          category: input.category,
          highRisk: isHighRiskToolCategory(input.category),
          // Stated in the trail: this is an **agent** permission, not a human one.
          permissionKind: 'AgentToolPermission',
        },
      });

      return {
        id: created.id,
        note: isHighRiskToolCategory(input.category)
          ? 'Granted. This is a high-risk category: the agent can take this action in a live ' +
            'external system with no person present.'
          : 'Granted.',
      };
    });
  }

  /** Revoke a grant. Kept as a row, because "who could do this in March" must stay answerable. */
  async revokeToolPermission(input: {
    scope: TenantScope;
    actorUserId: string;
    grantId: string;
    reason: string;
  }): Promise<{ revoked: boolean }> {
    const context = await this.authorization.contextFor(input.scope, input.actorUserId);
    await this.authorization.assertCan(context, { module: 'settings', action: 'Administer' });

    if (!input.reason.trim()) {
      throw new BadRequestException('Revoking a tool permission needs a reason.');
    }

    return this.prisma.runInTenantTransaction(input.scope, async () => {
      const grant = await this.prisma.client.connectionToolGrant.findFirst({
        where: { tenantId: input.scope.tenantId, id: input.grantId, revokedAt: null },
      });
      if (!grant) {
        throw new NotFoundException('There is no such live tool permission.');
      }

      await this.prisma.client.connectionToolGrant.update({
        where: { id: grant.id },
        data: {
          revokedAt: new Date(),
          revokedByUserId: input.actorUserId,
          revokedReason: input.reason.trim(),
        },
      });

      await this.auditEvents.appendWithinCurrentScope(input.scope.tenantId, {
        action: 'connection.tool_permission_revoked',
        resourceType: 'connection_tool_grant',
        resourceId: grant.id,
        actorUserId: input.actorUserId,
        summary: `Engine Agent ${grant.agentId} may no longer ${grant.category} through this connection.`,
        reason: input.reason.trim(),
        metadata: { connectionId: grant.connectionId, category: grant.category },
      });

      return { revoked: true };
    });
  }

  /**
   * Whether a connection could be used for a category, ignoring any per-agent grant.
   *
   * The companion to `mayAgentUse`, for the one moment when there is no agent yet: Agent Builder
   * is choosing a connection *before* activation creates the Engine Agent identity. Asking
   * `mayAgentUse` there is unanswerable — an Agent Tool Permission is granted to an agent, and no
   * grant can exist for an identity that does not exist, so every piece of work needing a
   * connection would have been permanently unable to activate.
   *
   * What this checks is everything that is knowable at setup time: the connection exists, its
   * derived state is healthy, the connector can actually perform the category, and the work's
   * department is allowed to use it. What it deliberately does **not** check is the per-agent
   * grant — so a caller must not read a `true` here as permission to act. It means "this is a
   * sensible choice to record", not "this agent may use it".
   *
   * The grant itself stays a separate administrative act (`grantToolPermission`, `settings:
   * Administer`). That separation is the point: an employee completing their own agent's setup
   * must not be able to widen an integration's reach as a side effect.
   */
  async mayBeUsedForSetup(input: {
    scope: TenantScope;
    connectionId: string;
    category: ToolActionCategory;
    departmentId?: string | undefined;
  }): Promise<{ usable: boolean; reason: string; state: ConnectionState }> {
    return this.prisma.runInTenantTransaction(input.scope, async () => {
      const row = await this.prisma.client.connection.findFirst({
        where: { tenantId: input.scope.tenantId, id: input.connectionId },
      });
      if (!row) {
        return {
          usable: false,
          reason: 'There is no such connection in this company.',
          state: 'Error' as ConnectionState,
        };
      }

      const state = this.stateOf(row);
      if (state !== 'Connected') {
        return {
          usable: false,
          reason:
            `The connection is ${state}. Recording it now would mean the agent activates against ` +
            'an integration that is already known to be unusable.',
          state,
        };
      }

      const definition = connectorDefinition(row.connectorKind);
      if (!definition?.supportedCategories.includes(input.category)) {
        return {
          usable: false,
          reason:
            `${definition?.label ?? row.connectorKind} cannot perform ${input.category}, so it ` +
            'cannot be the source for this work.',
          state,
        };
      }

      if (
        input.departmentId !== undefined &&
        row.allowedDepartmentIds.length > 0 &&
        !row.allowedDepartmentIds.includes(input.departmentId)
      ) {
        return {
          usable: false,
          reason: 'This connection is restricted to other departments.',
          state,
        };
      }

      return {
        usable: true,
        reason:
          'The connection is healthy and permitted for this work. The agent’s own tool ' +
          'permission is granted separately, by an administrator, once the agent exists.',
        state,
      };
    });
  }

  /**
   * **May this Engine Agent do this, through this connection, right now?**
   *
   * The only function that answers Agent Tool Permission, and the one every later prompt's run
   * path must call. It takes an `agentId`, never a user id, so it cannot be satisfied by passing
   * a person who happens to be an administrator.
   *
   * Both halves are required: a live grant **and** a usable connection state. A grant on an
   * expired credential is not permission to act — it is permission that would fail, and failing
   * at the provider rather than at the boundary is how a half-completed external action happens.
   */
  async mayAgentUse(input: {
    scope: TenantScope;
    agentId: string;
    connectionId: string;
    category: ToolActionCategory;
    departmentId?: string | undefined;
  }): Promise<{ allowed: boolean; reason: string; state: ConnectionState }> {
    return this.prisma.runInTenantTransaction(input.scope, async () => {
      const row = await this.prisma.client.connection.findFirst({
        where: { tenantId: input.scope.tenantId, id: input.connectionId },
      });
      if (!row) {
        return {
          allowed: false,
          reason: 'There is no such connection in this company.',
          state: 'Error' as ConnectionState,
        };
      }

      const state = this.stateOf(row);
      if (state !== 'Connected') {
        return {
          allowed: false,
          reason:
            `The connection is ${state}, so this action would fail at the provider. Failing ` +
            'here instead is the point: a half-completed external action is worse than a refused one.',
          state,
        };
      }

      // Departments restrict *which* work may use a connection. Empty means the whole company,
      // stated rather than implied — an empty list read as "nobody" would have broken every
      // existing connection the day departments were introduced.
      if (
        input.departmentId !== undefined &&
        row.allowedDepartmentIds.length > 0 &&
        !row.allowedDepartmentIds.includes(input.departmentId)
      ) {
        return {
          allowed: false,
          reason: 'This connection is restricted to other departments.',
          state,
        };
      }

      const grant = await this.prisma.client.connectionToolGrant.findFirst({
        where: {
          tenantId: input.scope.tenantId,
          connectionId: input.connectionId,
          agentId: input.agentId,
          category: input.category,
          revokedAt: null,
        },
      });

      if (!grant) {
        return {
          allowed: false,
          reason:
            `This Engine Agent has no ${input.category} permission on this connection. An Agent ` +
            'Tool Permission is separate from any human permission: nobody’s role grants it.',
          state,
        };
      }

      return { allowed: true, reason: 'A live tool grant permits it.', state };
    });
  }

  // -------------------------------------------------------------------------
  // The expiry sweep
  // -------------------------------------------------------------------------

  /**
   * Notify owners of credentials that have expired or are close to it.
   *
   * Platform-plane, one pass, idempotent through the notification dedupe key — so it is safe on a
   * frequent timer. This is the producer behind Prompt 15's `ConnectionExpiry` kind, which shipped
   * with its preference controls working and nothing raising it.
   *
   * `raise` is injected rather than imported so this service does not depend on the notifications
   * module: the dependency runs the other way at Prompt 15, and a cycle here would appear the
   * moment a notification wanted to name a connection.
   */
  async sweepExpiringCredentials(
    raise: (input: {
      tenantId: string;
      recipientUserId: string;
      connectionId: string;
      label: string;
      state: 'Expiring' | 'Expired';
      expiresAt: Date;
    }) => Promise<void>,
  ): Promise<{ expiring: number; expired: number }> {
    const rows = await this.prisma.runAsPlatformOperation(() =>
      this.prisma.client.connection.findMany({
        where: { disabledAt: null, credentialExpiresAt: { not: null } },
        select: {
          id: true,
          tenantId: true,
          label: true,
          ownerUserId: true,
          credentialExpiresAt: true,
        },
      }),
    );

    const now = new Date();
    let expiring = 0;
    let expired = 0;

    for (const row of rows) {
      const expiresAt = row.credentialExpiresAt as Date;
      const isExpired = expiresAt <= now;
      const soon = isCredentialExpiringSoon(expiresAt, now);

      if (!isExpired && !soon) {
        continue;
      }

      await raise({
        tenantId: row.tenantId,
        recipientUserId: row.ownerUserId,
        connectionId: row.id,
        label: row.label,
        state: isExpired ? 'Expired' : 'Expiring',
        expiresAt,
      });

      if (isExpired) {
        expired += 1;
      } else {
        expiring += 1;
      }
    }

    return { expiring, expired };
  }

  // -------------------------------------------------------------------------
  // Internals
  // -------------------------------------------------------------------------

  private stateOf(row: Connection): ConnectionState {
    return derivedConnectionState({
      disabledAt: row.disabledAt,
      credentialExpiresAt: row.credentialExpiresAt,
      needsReauthorization: row.needsReauthorization,
      lastError: row.lastError,
    });
  }

  private viewOf(
    row: Connection,
    grants: {
      id: string;
      agentId: string;
      category: ToolActionCategory;
      reason: string | null;
      grantedByUserId: string;
      grantedAt: Date;
    }[],
  ): ConnectionView {
    const definition = connectorDefinition(row.connectorKind);

    return {
      id: row.id,
      scope: row.scope,
      connectorKind: row.connectorKind,
      connectorLabel: definition?.label ?? row.connectorKind,
      label: row.label,
      ownerUserId: row.ownerUserId,
      environment: row.environment,
      state: this.stateOf(row),
      secretRef: row.secretRef,
      hasSecret: row.secretRef !== null,
      allowedDepartmentIds: [...row.allowedDepartmentIds],
      credentialExpiresAt: row.credentialExpiresAt?.toISOString() ?? null,
      expiringSoon: isCredentialExpiringSoon(row.credentialExpiresAt),
      lastSuccessfulCheckAt: row.lastSuccessfulCheckAt?.toISOString() ?? null,
      lastCheckedAt: row.lastCheckedAt?.toISOString() ?? null,
      lastError: row.lastError,
      disabledReason: row.disabledReason,
      // Distinct **agents**, not grants: an agent with three categories is one affected agent,
      // and "12 agents affected" meaning four agents is the kind of number nobody trusts twice.
      affectedAgentCount: new Set(grants.map((grant) => grant.agentId)).size,
      grants: grants.map((grant) => ({
        id: grant.id,
        agentId: grant.agentId,
        category: grant.category,
        highRisk: isHighRiskToolCategory(grant.category),
        reason: grant.reason,
        grantedByUserId: grant.grantedByUserId,
        grantedAt: grant.grantedAt.toISOString(),
      })),
    };
  }

  private async requireConnection(scope: TenantScope, connectionId: string): Promise<Connection> {
    const row = await this.prisma.runInTenantTransaction(scope, () =>
      this.prisma.client.connection.findFirst({
        where: { tenantId: scope.tenantId, id: connectionId },
      }),
    );
    if (!row) {
      throw new NotFoundException('There is no such connection in this company.');
    }
    return row;
  }

  /**
   * May this person configure this connection, and how?
   *
   * Three rules, in one place because they interact:
   *
   * 1. A **Company** connection needs `settings:Administer`. It is company infrastructure.
   * 2. **Your own** User Connection needs only `settings:View`. It is your own account, and
   *    connecting it grants nobody else anything — the same act as enrolling your own second
   *    factor. Requiring `Administer` made the client's User Connection type unreachable by the
   *    people it exists for.
   * 3. **Somebody else's** User Connection can be *disabled* or *enabled* by an administrator —
   *    that is the security action a company needs — but never rotated or reauthorized, because
   *    that means holding their credential.
   */
  private async assertMayConfigure(
    scope: TenantScope,
    actorUserId: string,
    row: Connection,
    operation: 'rotateSecret' | 'reauthorize' | 'disable' | 'enable',
  ): Promise<void> {
    const own = row.scope === 'User' && row.ownerUserId === actorUserId;
    const context = await this.authorization.contextFor(scope, actorUserId);

    await this.authorization.assertCan(context, {
      module: 'settings',
      action: own ? 'View' : 'Administer',
    });

    if (
      row.scope === 'User' &&
      !own &&
      (operation === 'rotateSecret' || operation === 'reauthorize')
    ) {
      throw new ForbiddenException(
        'This is somebody else’s personal connection. An administrator can disable it, but ' +
          'rotating or reauthorizing it means holding their credential, which is theirs alone.',
      );
    }
  }

  private async liveGrants(scope: TenantScope, connectionId: string) {
    return this.prisma.client.connectionToolGrant.findMany({
      where: { tenantId: scope.tenantId, connectionId, revokedAt: null },
    });
  }

  private async recordCheck(
    input: { scope: TenantScope; actorUserId: string },
    row: Connection,
    result: {
      succeeded: boolean;
      detail: string;
      durationMs: number;
      credentialExpiresAt?: Date | undefined;
      needsReauthorization?: boolean | undefined;
    },
  ): Promise<{ succeeded: boolean; detail: string; state: ConnectionState }> {
    return this.prisma.runInTenantTransaction(input.scope, async () => {
      const at = new Date();

      await this.prisma.client.connectionCheck.create({
        data: {
          tenantId: input.scope.tenantId,
          connectionId: row.id,
          succeeded: result.succeeded,
          detail: result.detail.slice(0, 1000),
          durationMs: Math.max(0, Math.round(result.durationMs)),
          checkedByUserId: input.actorUserId,
          checkedAt: at,
        },
      });

      const updated = await this.prisma.client.connection.update({
        where: { id: row.id },
        data: {
          lastCheckedAt: at,
          ...(result.succeeded ? { lastSuccessfulCheckAt: at, lastError: null } : {}),
          ...(result.succeeded ? {} : { lastError: result.detail.slice(0, 1000) }),
          ...(result.needsReauthorization === undefined
            ? {}
            : { needsReauthorization: result.needsReauthorization }),
          ...(result.credentialExpiresAt === undefined
            ? {}
            : { credentialExpiresAt: result.credentialExpiresAt }),
          version: { increment: 1 },
        },
      });

      await this.auditEvents.appendWithinCurrentScope(input.scope.tenantId, {
        action: result.succeeded ? 'connection.check_succeeded' : 'connection.check_failed',
        resourceType: 'connection',
        resourceId: row.id,
        actorUserId: input.actorUserId,
        summary: `Tested "${row.label}": ${result.succeeded ? 'reachable' : 'failed'}.`,
        metadata: {
          connectorKind: row.connectorKind,
          durationMs: result.durationMs,
          // The adapter's message, which is deliberately never a credential.
          detail: result.detail.slice(0, 300),
        },
      });

      return { succeeded: result.succeeded, detail: result.detail, state: this.stateOf(updated) };
    });
  }
}
