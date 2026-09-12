import { Injectable } from '@nestjs/common';

import type {
  DomainVerification,
  SsoAuthRequest,
  SsoConnection,
  TenantAuthPolicy,
} from '../generated/prisma/client.js';
import { PrismaService } from './prisma.service.js';
import type { TenantScope } from './tenant-context.js';

/**
 * Repository for the tenant-owned enterprise-identity tables: `tenant_auth_policies`,
 * `sso_connections`, `sso_auth_requests` and `domain_verifications`.
 *
 * All four follow the ADR-018 convention — every method takes a `TenantScope` — and all four are
 * under Row-Level Security. That matters more here than for ordinary business data: an
 * `sso_connections` row holds a company's encrypted client secret and its issuer configuration,
 * so a missing `WHERE tenant_id` would disclose another company's security configuration.
 *
 * Three methods are explicitly platform-plane, and each is named to say so:
 *
 *   * `findConnectionForCallbackForPlatform` and `consumeAuthRequestByStateForPlatform` run
 *     during an SSO callback, which is **pre-authentication** — the browser arriving from the
 *     identity provider has no session and no workspace, so a tenant scope cannot exist yet. The
 *     `state` hash is the only thing that selects the row, and it is unguessable.
 *   * `findVerifiedDomainOwnerForPlatform` answers "which company has proved control of this
 *     email domain", which is by definition a question across tenants. It returns only the
 *     tenant id and never the claim's internals.
 */
@Injectable()
export class EnterpriseIdentityRepository {
  constructor(private readonly prisma: PrismaService) {}

  // ---- Authentication policy ----

  async findPolicy(scope: TenantScope): Promise<TenantAuthPolicy | null> {
    return this.prisma.runInTenantTransaction(scope, async () => {
      return this.prisma.client.tenantAuthPolicy.findFirst({
        where: { tenantId: scope.tenantId },
      });
    });
  }

  /**
   * Create or update a company's policy.
   *
   * An upsert because an absent row and an all-permissive row mean exactly the same thing: no
   * requirements. Making the caller create the row first would only add a state where a company
   * has "no policy" as distinct from "no requirements", which nothing needs.
   */
  async upsertPolicy(
    scope: TenantScope,
    input: {
      requireMfa: boolean;
      requireSso: boolean;
      allowPasswordSignIn: boolean;
      mfaGraceUntil?: Date | null;
      updatedByUserId?: string | undefined;
    },
  ): Promise<TenantAuthPolicy> {
    return this.prisma.runInTenantTransaction(scope, async () => {
      const data = {
        requireMfa: input.requireMfa,
        requireSso: input.requireSso,
        allowPasswordSignIn: input.allowPasswordSignIn,
        mfaGraceUntil: input.mfaGraceUntil ?? null,
        ...(input.updatedByUserId === undefined ? {} : { updatedByUserId: input.updatedByUserId }),
      };

      return this.prisma.client.tenantAuthPolicy.upsert({
        where: { tenantId: scope.tenantId },
        create: { tenantId: scope.tenantId, ...data },
        update: { ...data, version: { increment: 1 } },
      });
    });
  }

  /**
   * Read a policy during sign-in.
   *
   * Platform-plane by necessity: policy is evaluated *before* a session exists, so there is no
   * verified membership to build a scope from. It returns the policy for one named tenant id
   * that the caller has already resolved from the person's own memberships — never from request
   * input.
   */
  async findPolicyForPlatform(tenantId: string): Promise<TenantAuthPolicy | null> {
    return this.prisma.client.tenantAuthPolicy.findFirst({ where: { tenantId } });
  }

  // ---- SSO connections ----

  async createConnection(
    scope: TenantScope,
    input: {
      protocol: 'Oidc' | 'Saml';
      displayName: string;
      enabled?: boolean;
      issuer?: string | undefined;
      discoveryUrl?: string | undefined;
      clientId?: string | undefined;
      clientSecretCiphertext?: string | undefined;
      scopes?: string | undefined;
      entityId?: string | undefined;
      ssoUrl?: string | undefined;
      sloUrl?: string | undefined;
      signingCertificate?: string | undefined;
      attributeMapping?: Record<string, string> | undefined;
    },
  ): Promise<SsoConnection> {
    return this.prisma.runInTenantTransaction(scope, async () => {
      return this.prisma.client.ssoConnection.create({
        data: {
          tenantId: scope.tenantId,
          protocol: input.protocol,
          displayName: input.displayName,
          enabled: input.enabled ?? false,
          ...optional('issuer', input.issuer),
          ...optional('discoveryUrl', input.discoveryUrl),
          ...optional('clientId', input.clientId),
          ...optional('clientSecretCiphertext', input.clientSecretCiphertext),
          ...optional('scopes', input.scopes),
          ...optional('entityId', input.entityId),
          ...optional('ssoUrl', input.ssoUrl),
          ...optional('sloUrl', input.sloUrl),
          ...optional('signingCertificate', input.signingCertificate),
          ...(input.attributeMapping === undefined
            ? {}
            : { attributeMapping: input.attributeMapping }),
        },
      });
    });
  }

  async findConnection(scope: TenantScope, connectionId: string): Promise<SsoConnection | null> {
    return this.prisma.runInTenantTransaction(scope, async () => {
      return this.prisma.client.ssoConnection.findFirst({
        where: { id: connectionId, tenantId: scope.tenantId },
      });
    });
  }

  async listConnections(scope: TenantScope): Promise<SsoConnection[]> {
    return this.prisma.runInTenantTransaction(scope, async () => {
      return this.prisma.client.ssoConnection.findMany({
        where: { tenantId: scope.tenantId },
        orderBy: { createdAt: 'asc' },
      });
    });
  }

  async countEnabledConnections(scope: TenantScope): Promise<number> {
    return this.prisma.runInTenantTransaction(scope, async () => {
      return this.prisma.client.ssoConnection.count({
        where: { tenantId: scope.tenantId, enabled: true },
      });
    });
  }

  async updateConnection(
    scope: TenantScope,
    connectionId: string,
    input: Partial<{
      displayName: string;
      enabled: boolean;
      issuer: string;
      discoveryUrl: string;
      clientId: string;
      clientSecretCiphertext: string;
      scopes: string;
      entityId: string;
      ssoUrl: string;
      sloUrl: string;
      signingCertificate: string;
      attributeMapping: Record<string, string>;
    }>,
  ): Promise<number> {
    return this.prisma.runInTenantTransaction(scope, async () => {
      const result = await this.prisma.client.ssoConnection.updateMany({
        where: { id: connectionId, tenantId: scope.tenantId },
        data: { ...input, version: { increment: 1 } },
      });
      return result.count;
    });
  }

  async deleteConnection(scope: TenantScope, connectionId: string): Promise<number> {
    return this.prisma.runInTenantTransaction(scope, async () => {
      const result = await this.prisma.client.ssoConnection.deleteMany({
        where: { id: connectionId, tenantId: scope.tenantId },
      });
      return result.count;
    });
  }

  /**
   * The enabled connections a company offers, read while nobody is signed in.
   *
   * Platform-plane for the same reason as `findPolicyForPlatform`. It returns only what the
   * login screen may show — never a client secret, an issuer or a discovery URL.
   */
  async listEnabledConnectionsForPlatform(
    tenantId: string,
  ): Promise<{ id: string; displayName: string; protocol: 'Oidc' | 'Saml' }[]> {
    const rows = await this.prisma.client.ssoConnection.findMany({
      where: { tenantId, enabled: true },
      select: { id: true, displayName: true, protocol: true },
      orderBy: { createdAt: 'asc' },
    });
    return rows;
  }

  async countEnabledConnectionsForPlatform(tenantId: string): Promise<number> {
    return this.prisma.client.ssoConnection.count({ where: { tenantId, enabled: true } });
  }

  /** Load a connection to begin or complete a federated sign-in. Pre-authentication. */
  async findEnabledConnectionForPlatform(
    connectionId: string,
  ): Promise<
    (SsoConnection & { tenant: { id: string; name: string; lifecycleState: string } }) | null
  > {
    return this.prisma.client.ssoConnection.findFirst({
      where: { id: connectionId, enabled: true },
      include: { tenant: { select: { id: true, name: true, lifecycleState: true } } },
    });
  }

  // ---- In-flight authorization requests ----

  async createAuthRequest(input: {
    tenantId: string;
    connectionId: string;
    stateHash: string;
    nonceHash: string;
    codeVerifierCiphertext: string;
    redirectAfter?: string | undefined;
    expiresAt: Date;
  }): Promise<SsoAuthRequest> {
    return this.prisma.client.ssoAuthRequest.create({
      data: {
        tenantId: input.tenantId,
        connectionId: input.connectionId,
        stateHash: input.stateHash,
        nonceHash: input.nonceHash,
        codeVerifierCiphertext: input.codeVerifierCiphertext,
        ...optional('redirectAfter', input.redirectAfter),
        expiresAt: input.expiresAt,
      },
    });
  }

  /**
   * Find and consume an authorization request by its `state` hash, atomically.
   *
   * The consume is part of the lookup rather than a later step, and `consumedAt: null` makes it a
   * compare-and-set: a replayed callback — the same `state` and `code` submitted twice — finds
   * nothing the second time. Doing this as read-then-write would leave a window in which two
   * concurrent callbacks both proceed.
   */
  async consumeAuthRequestByStateForPlatform(
    stateHash: string,
    now: Date,
  ): Promise<SsoAuthRequest | null> {
    const found = await this.prisma.client.ssoAuthRequest.findFirst({
      where: { stateHash, consumedAt: null, expiresAt: { gt: now } },
    });
    if (!found) {
      return null;
    }

    const claimed = await this.prisma.client.ssoAuthRequest.updateMany({
      where: { id: found.id, consumedAt: null },
      data: { consumedAt: now },
    });

    return claimed.count === 1 ? found : null;
  }

  // ---- Domain verification ----

  async upsertDomainClaim(
    scope: TenantScope,
    input: { domain: string; verificationToken: string; expiresAt: Date },
  ): Promise<DomainVerification> {
    return this.prisma.runInTenantTransaction(scope, async () => {
      return this.prisma.client.domainVerification.upsert({
        where: { tenantId_domain: { tenantId: scope.tenantId, domain: input.domain } },
        create: {
          tenantId: scope.tenantId,
          domain: input.domain,
          verificationToken: input.verificationToken,
          expiresAt: input.expiresAt,
        },
        // Re-claiming resets the attempt: a new token, a fresh window, and back to Pending. A
        // company that let a claim expire should not have to delete it first.
        update: {
          verificationToken: input.verificationToken,
          expiresAt: input.expiresAt,
          state: 'Pending',
          failureReason: null,
          verifiedAt: null,
          version: { increment: 1 },
        },
      });
    });
  }

  async findDomainClaim(scope: TenantScope, id: string): Promise<DomainVerification | null> {
    return this.prisma.runInTenantTransaction(scope, async () => {
      return this.prisma.client.domainVerification.findFirst({
        where: { id, tenantId: scope.tenantId },
      });
    });
  }

  async listDomainClaims(scope: TenantScope): Promise<DomainVerification[]> {
    return this.prisma.runInTenantTransaction(scope, async () => {
      return this.prisma.client.domainVerification.findMany({
        where: { tenantId: scope.tenantId },
        orderBy: { domain: 'asc' },
      });
    });
  }

  async markDomainVerified(scope: TenantScope, id: string, at: Date): Promise<number> {
    return this.prisma.runInTenantTransaction(scope, async () => {
      const result = await this.prisma.client.domainVerification.updateMany({
        where: { id, tenantId: scope.tenantId },
        data: {
          state: 'Verified',
          verifiedAt: at,
          lastCheckedAt: at,
          failureReason: null,
          version: { increment: 1 },
        },
      });
      return result.count;
    });
  }

  async markDomainFailed(
    scope: TenantScope,
    id: string,
    at: Date,
    reason: string,
    expired = false,
  ): Promise<number> {
    return this.prisma.runInTenantTransaction(scope, async () => {
      const result = await this.prisma.client.domainVerification.updateMany({
        where: { id, tenantId: scope.tenantId },
        data: {
          state: expired ? 'Expired' : 'Failed',
          lastCheckedAt: at,
          failureReason: reason.slice(0, 300),
          version: { increment: 1 },
        },
      });
      return result.count;
    });
  }

  async deleteDomainClaim(scope: TenantScope, id: string): Promise<number> {
    return this.prisma.runInTenantTransaction(scope, async () => {
      const result = await this.prisma.client.domainVerification.deleteMany({
        where: { id, tenantId: scope.tenantId },
      });
      return result.count;
    });
  }

  /**
   * Which company has proved control of this email domain, if any.
   *
   * Cross-tenant by definition — the question is "who owns this domain" — so it deliberately
   * returns nothing but the tenant id. A partial unique index guarantees at most one row can be
   * `Verified` for a given domain, so this cannot be ambiguous.
   */
  async findVerifiedDomainOwnerForPlatform(domain: string): Promise<{ tenantId: string } | null> {
    return this.prisma.client.domainVerification.findFirst({
      where: { domain, state: 'Verified' },
      select: { tenantId: true },
    });
  }
}

/** Only include a key when its value is defined, so `exactOptionalPropertyTypes` holds. */
function optional<K extends string, V>(key: K, value: V | undefined): Record<K, V> | object {
  return value === undefined ? {} : ({ [key]: value } as Record<K, V>);
}
