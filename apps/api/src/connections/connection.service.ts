import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';

import {
  categoryOfTool,
  connectorDefinition,
  derivedConnectionState,
  driftBetween,
  isCredentialExpiringSoon,
  isHighRiskToolCategory,
  isToolActionCategory,
  snapshotIsUnchanged,
  snapshotIsUsable,
  TOOL_ACTION_CATEGORIES,
  type ConnectionEnvironment,
  type ConnectionScope,
  type ConnectionState,
  type McpApprovedTool,
  type McpSnapshotDrift,
  type McpToolDescriptor,
  type McpToolSnapshot,
  type ToolActionCategory,
} from '@uboss/types';

import { AuditEventService } from '../audit/audit-event.service.js';
import { AuthorizationService } from '../authorization/authorization.service.js';
import type { Connection } from '../generated/prisma/client.js';
import { PrismaService } from '../persistence/prisma.service.js';
import type { TenantScope } from '../persistence/tenant-context.js';
import { ConnectorAdapters } from './connector-adapters.js';
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
    private readonly connectors: ConnectorAdapters,
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
    /** Where the server is, for a connector the company supplies the address of — CR-06. */
    endpoint?: string | undefined;
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

    /*
     * An address, for the connectors that have one of their own — CR-06.
     *
     * Required for `custom-mcp` and refused for everything else. A mock connection carrying a
     * URL would be a field nothing reads, and the day somebody wired it up they would find
     * addresses that had never been validated sitting in production rows.
     *
     * `https` only, and no private address. This endpoint is fetched **by the server**, with a
     * credential, on a schedule — which is the exact shape of a server-side request forgery: a
     * company that could point a connection at `http://169.254.169.254/` or at `localhost` would
     * be using UBoss to read UBoss's own cloud metadata and internal services. The rule has to
     * live here rather than in the adapter, because by the time the adapter has it, it is a
     * stored connection somebody has already approved.
     */
    const endpoint = input.endpoint?.trim() ?? '';
    if (input.connectorKind === 'custom-mcp') {
      if (endpoint === '') {
        throw new BadRequestException(
          'An MCP connection needs the address of the server it talks to. That is the whole of ' +
            'what makes it this company’s connection rather than a vendor UBoss already knows.',
        );
      }
      const problem = unreachableEndpointProblem(endpoint);
      if (problem !== null) throw new BadRequestException(problem);
    } else if (endpoint !== '') {
      throw new BadRequestException(
        `${definition.label} reaches a system UBoss already knows how to find, so it takes no ` +
          'server address.',
      );
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
          endpoint: endpoint === '' ? null : endpoint,
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

    // The adapter for *this* connection's kind — CR-06. One bound adapter was right while every
    // entry was a mock; sending an MCP connection to the mock would report a company's live
    // server as an unrecognised credential.
    const result = await this.connectors.for(row.connectorKind).check({
      connectorKind: row.connectorKind,
      environment: row.environment,
      endpoint: row.endpoint,
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

      /*
       * An MCP connection must also be the shape somebody approved — CR-06.
       *
       * Everything above this is about the connection; this is about what the server is
       * currently offering. A server that has added a tool since approval is not refused for
       * having added it — that is its business — it is refused because the approval in hand
       * describes a different server from the one on the other end, and the grant was given
       * against the description.
       */
      if (row.connectorKind === 'custom-mcp') {
        const snapshot = this.snapshotOf(row);
        if (!snapshotIsUsable(snapshot)) {
          return {
            allowed: false,
            reason:
              snapshot === null
                ? 'Nobody has approved a tool list for this MCP connection yet, so there is ' +
                  'nothing an agent is permitted to call.'
                : 'This MCP connection is waiting on an administrator: some of its tools have ' +
                  'no category, so no grant can cover them.',
            state,
          };
        }
      }

      return { allowed: true, reason: 'A live tool grant permits it.', state };
    });
  }

  // -------------------------------------------------------------------------
  // The MCP tool list: discovering it, approving it, and calling against it
  // -------------------------------------------------------------------------

  /**
   * What this server offers right now, and how that differs from what was approved.
   *
   * **Writes nothing.** The same decision the objective workbook and the agent-file reader made,
   * for the same reason: an administrator has to see what is there before any of it becomes the
   * thing an agent is permitted to do, and an endpoint that *cannot* write is a stronger promise
   * than one that chooses not to.
   *
   * `suspicious` names the tools whose own description is written like an instruction. An
   * administrator deciding whether to trust a server is the right person to be told that, and
   * before they approve it is the right moment.
   */
  async discoverTools(input: {
    scope: TenantScope;
    actorUserId: string;
    connectionId: string;
  }): Promise<{
    tools: readonly McpToolDescriptor[];
    drift: McpSnapshotDrift;
    suspicious: readonly string[];
    approved: boolean;
    /** Whether anybody has ever approved a list for this connection, which is different news. */
    everApproved: boolean;
    note: string;
  }> {
    const context = await this.authorization.contextFor(input.scope, input.actorUserId);
    await this.authorization.assertCan(context, { module: 'settings', action: 'Administer' });

    const row = await this.requireConnection(input.scope, input.connectionId);
    if (row.connectorKind !== 'custom-mcp') {
      throw new BadRequestException('Only an MCP connection has a tool list to read.');
    }
    if (row.endpoint === null) {
      throw new BadRequestException('This connection has no server address.');
    }

    const secret = await this.vault.reveal(input.scope, row.secretRef ?? '');
    const found = await this.connectors.mcpAdapter().discover(row.endpoint, secret);

    const snapshot = this.snapshotOf(row);
    const drift = driftBetween(snapshot?.tools ?? [], found.tools);

    return {
      tools: found.tools,
      drift,
      suspicious: found.suspicious,
      approved: snapshotIsUsable(snapshot) && snapshotIsUnchanged(drift),
      everApproved: snapshot !== null && snapshot.approvedByUserId !== null,
      note:
        'Nothing has been changed. Approving this list is what lets an agent use these tools, ' +
        'and each one needs a category before it can be granted to anybody.',
    };
  }

  /**
   * Approve the server's tool list, with a category against every tool.
   *
   * Re-read from the server rather than taking the browser's word for what the tools are: the
   * list shown and the list approved must be the same list, and several minutes may have passed
   * while somebody chose categories. A server that changed in between is refused outright —
   * approving a list nobody saw is the thing this whole mechanism exists to prevent.
   *
   * Every tool must be categorised. A half-mapped snapshot is refused rather than
   * part-permitted: "works except for the three tools nobody classified" is a sentence somebody
   * reads as a bug and fixes by granting more.
   */
  async approveToolSnapshot(input: {
    scope: TenantScope;
    actorUserId: string;
    connectionId: string;
    /** Tool name to the category an administrator assigned it. */
    categories: Record<string, string>;
  }): Promise<{ approvedTools: number; note: string }> {
    const context = await this.authorization.contextFor(input.scope, input.actorUserId);
    await this.authorization.assertCan(context, { module: 'settings', action: 'Administer' });

    const row = await this.requireConnection(input.scope, input.connectionId);
    if (row.connectorKind !== 'custom-mcp') {
      throw new BadRequestException('Only an MCP connection has a tool list to approve.');
    }
    if (row.endpoint === null) {
      throw new BadRequestException('This connection has no server address.');
    }

    const secret = await this.vault.reveal(input.scope, row.secretRef ?? '');
    const current = await this.connectors.mcpAdapter().discover(row.endpoint, secret);

    const named = new Set(Object.keys(input.categories));
    const offered = new Set(current.tools.map((tool) => tool.name));

    const unmapped = [...offered].filter((name) => !named.has(name)).sort();
    if (unmapped.length > 0) {
      throw new BadRequestException(
        `These tools have no category: ${unmapped.join(', ')}. Every tool needs one, because a ` +
          'tool outside the five categories is a tool outside every control built on them.',
      );
    }

    const unknown = [...named].filter((name) => !offered.has(name)).sort();
    if (unknown.length > 0) {
      throw new BadRequestException(
        `The server no longer offers: ${unknown.join(', ')}. Its tool list changed while this ` +
          'was being approved — read it again and approve what is actually there.',
      );
    }

    const tools: McpApprovedTool[] = [];
    for (const tool of current.tools) {
      const category = input.categories[tool.name];
      if (!isToolActionCategory(category)) {
        throw new BadRequestException(
          `"${String(category)}" is not a tool category. One of: ${TOOL_ACTION_CATEGORIES.join(', ')}.`,
        );
      }
      tools.push({ ...tool, category });
    }

    const snapshot: McpToolSnapshot = {
      tools,
      takenAt: new Date().toISOString(),
      approvedByUserId: input.actorUserId,
    };

    await this.prisma.runInTenantTransaction(input.scope, async () => {
      await this.prisma.client.connection.update({
        where: { id: row.id },
        data: { toolSnapshot: snapshot as unknown as object, version: { increment: 1 } },
      });

      await this.auditEvents.appendWithinCurrentScope(input.scope.tenantId, {
        action: 'connection.tools_approved',
        resourceType: 'connection',
        resourceId: row.id,
        actorUserId: input.actorUserId,
        resourceRef: row.label,
        summary:
          `Approved ${tools.length} tool${tools.length === 1 ? '' : 's'} on "${row.label}". ` +
          'An agent may be granted these and nothing else; if the server offers something ' +
          'different later, it waits for another approval.',
        metadata: {
          // The shape that was approved, named tool by tool, so a later argument about what was
          // permitted is settled by the record rather than by the server's current answer.
          // One string rather than a list: audit metadata holds flat values, and what somebody
          // reading the trail wants is the mapping as a sentence — which tool counted as what.
          tools: tools
            .map((tool) => `${tool.name}: ${tool.category ?? 'uncategorised'}`)
            .join(', '),
          ...(current.suspicious.length === 0
            ? {}
            : { descriptionsFlagged: current.suspicious.join(', ') }),
        },
      });
    });

    return {
      approvedTools: tools.length,
      note: 'Approved. Each tool can now be granted to an Engine Agent, one category at a time.',
    };
  }

  /**
   * May this agent call this named tool?
   *
   * The question a run actually asks, and it resolves the tool to its approved category before
   * asking everything else — so a grant is always given and checked in the same vocabulary. A
   * tool that is not in the approved snapshot has no category, and a tool with no category
   * cannot be covered by any grant, which is the point.
   */
  async mayAgentCallTool(input: {
    scope: TenantScope;
    agentId: string;
    connectionId: string;
    toolName: string;
    departmentId?: string | undefined;
  }): Promise<{ allowed: boolean; reason: string; category: ToolActionCategory | null }> {
    const row = await this.prisma.runInTenantTransaction(input.scope, () =>
      this.prisma.client.connection.findFirst({
        where: { tenantId: input.scope.tenantId, id: input.connectionId },
      }),
    );
    if (!row) {
      return {
        allowed: false,
        reason: 'There is no such connection in this company.',
        category: null,
      };
    }

    const category = categoryOfTool(this.snapshotOf(row), input.toolName);
    if (category === null) {
      return {
        allowed: false,
        reason:
          `"${input.toolName}" is not in the approved tool list for this connection. A tool ` +
          'nobody approved has no category, and no grant can cover it.',
        category: null,
      };
    }

    const decision = await this.mayAgentUse({
      scope: input.scope,
      agentId: input.agentId,
      connectionId: input.connectionId,
      category,
      ...(input.departmentId === undefined ? {} : { departmentId: input.departmentId }),
    });

    return { allowed: decision.allowed, reason: decision.reason, category };
  }

  /** The approved snapshot on a row, or null. Parsed in one place so no caller shapes the JSON. */
  private snapshotOf(row: { toolSnapshot: unknown }): McpToolSnapshot | null {
    const held = row.toolSnapshot;
    if (typeof held !== 'object' || held === null || Array.isArray(held)) return null;

    const shape = held as Partial<McpToolSnapshot>;
    return Array.isArray(shape.tools) && typeof shape.takenAt === 'string'
      ? {
          tools: shape.tools,
          takenAt: shape.takenAt,
          approvedByUserId: shape.approvedByUserId ?? null,
        }
      : null;
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

/**
 * Why a company may not point a connection wherever it likes — CR-06.
 *
 * This address is fetched **by UBoss's own server**, carrying a credential, on a schedule. That
 * is the precise shape of a server-side request forgery: whatever a company types here, UBoss
 * dials. A connection pointed at `http://169.254.169.254/` reads the cloud provider's instance
 * metadata — short-lived credentials for the whole deployment. One pointed at `localhost` or a
 * `10.x` address reaches UBoss's own database and internal services from inside the network,
 * past every boundary that exists.
 *
 * None of that requires a hostile company. One person pasting the wrong URL from a tutorial is
 * enough, and the request would look ordinary in every log.
 *
 * Returns the reason it is refused, or null when the address is one UBoss may dial.
 *
 * ## Why this is a check and not a resolver
 *
 * A thorough defence resolves the hostname and rejects private *resolved* addresses, because
 * `evil.example.com` can point at `127.0.0.1` and this check would pass it. That belongs in the
 * fetch path, where the resolution actually happens, and is noted as the next piece of this. What
 * this does is refuse the forms somebody types, which is the common case and the one that reaches
 * a stored row.
 */
export function unreachableEndpointProblem(endpoint: string): string | null {
  let url: URL;
  try {
    url = new URL(endpoint);
  } catch {
    return 'That is not a web address. An MCP endpoint looks like https://example.com/mcp.';
  }

  if (url.protocol !== 'https:') {
    return (
      'An MCP endpoint must be https. The credential for this connection travels on every ' +
      'call, and over http it travels in the clear.'
    );
  }

  const host = url.hostname.toLowerCase().replace(/^\[|\]$/g, '');

  if (host === 'localhost' || host.endsWith('.localhost') || host === '::1') {
    return 'That address is UBoss’s own machine, which is not a system this company runs.';
  }

  /*
   * The address ranges that are inside somebody's network rather than on the internet.
   *
   * `169.254.*` is first because it is the one that matters most: it is where every major cloud
   * serves instance metadata, and reaching it from inside UBoss would hand over credentials for
   * the deployment rather than for one company's connection.
   */
  const privateForms: readonly RegExp[] = [
    /^169\.254\./,
    /^127\./,
    /^10\./,
    /^192\.168\./,
    /^172\.(1[6-9]|2\d|3[01])\./,
    /^0\./,
    /^fc[0-9a-f]{2}:/i,
    /^fd[0-9a-f]{2}:/i,
    /^fe80:/i,
  ];
  if (privateForms.some((form) => form.test(host))) {
    return 'That address is inside a private network, which UBoss will not reach out to.';
  }

  // A bare hostname with no dot is a name only resolvable inside a network — a Kubernetes
  // service, a container name, a host in an internal DNS zone.
  if (!host.includes('.') && !host.includes(':')) {
    return 'That address names a host inside a network rather than a server on the internet.';
  }

  return null;
}
