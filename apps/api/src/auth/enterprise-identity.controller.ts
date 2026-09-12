import {
  BadRequestException,
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Logger,
  NotFoundException,
  Param,
  Patch,
  Post,
  Put,
} from '@nestjs/common';

import { tenantScopeForPlatformOperation } from '../persistence/tenant-context.js';
import { EnterpriseIdentityRepository } from '../persistence/enterprise-identity.repository.js';
import { actorUserId, isPlatformActor } from '../request-context/authenticated-actor.js';
import { getActor } from '../request-context/request-context.js';
import { PlatformOnly } from '../tenancy/tenancy.decorators.js';
import { AuthenticationPolicyService } from './authentication-policy.service.js';
import { DomainVerificationService } from './domain-verification.service.js';
import {
  ClaimDomainDto,
  CreateScimClientDto,
  CreateSsoConnectionDto,
  UpdateAuthPolicyDto,
  UpdateSsoConnectionDto,
} from './enterprise-identity.dto.js';
import { ScimService } from './scim/scim.service.js';
import { SECRET_PURPOSES, SecretBox } from './secret-box.js';
import { SECURITY_ACTIONS, SecurityEventPublisher } from './security-event.publisher.js';
import { OidcProvider } from './sso/oidc.provider.js';
import { SamlProvider } from './sso/saml.provider.js';
import { SsoService } from './sso/sso.service.js';

/**
 * Administration of a company's identity configuration: authentication policy, SSO connections,
 * domain claims and SCIM credentials.
 *
 * ## Why every route here is `@PlatformOnly`
 *
 * The same interim decision as Prompt 5's invitation and session-revoke administration: these
 * are Company-Admin operations, but the **role model arrives at Prompt 7**. The two ways to ship
 * them now are both wrong — grant every company member the power to reconfigure how their
 * colleagues authenticate, or invent a role check that Prompt 7 would immediately replace. So
 * they sit on the platform plane until there is a real authority to attach them to, and the
 * tenant id is a path parameter validated against the platform actor's privilege rather than
 * derived from a workspace.
 *
 * ## What is never returned
 *
 * No endpoint here returns an OIDC client secret or a SCIM bearer token after the request that
 * created it. The client secret is stored encrypted and can only be decrypted by the server for
 * the token exchange; the SCIM token is stored as a hash and cannot be decrypted at all. Both are
 * shown once. `hasClientSecret` is reported as a boolean so a screen can say whether one is
 * configured without ever seeing it.
 */
@Controller('tenants/:tenantId/identity')
@PlatformOnly()
export class EnterpriseIdentityController {
  private readonly logger = new Logger(EnterpriseIdentityController.name);

  constructor(
    private readonly policies: AuthenticationPolicyService,
    private readonly enterprise: EnterpriseIdentityRepository,
    private readonly domains: DomainVerificationService,
    private readonly scim: ScimService,
    private readonly sso: SsoService,
    private readonly oidc: OidcProvider,
    private readonly saml: SamlProvider,
    private readonly secrets: SecretBox,
    private readonly securityEvents: SecurityEventPublisher,
  ) {}

  // -------------------------------------------------------------------------
  // Authentication policy
  // -------------------------------------------------------------------------

  @Get('policy')
  async getPolicy(@Param('tenantId') tenantId: string) {
    const scope = this.scopeFor(tenantId);
    const policy = await this.policies.forTenant(scope);
    const enabledConnections = await this.enterprise.countEnabledConnections(scope);

    return {
      requireMfa: policy.requireMfa,
      requireSso: policy.requireSso,
      allowPasswordSignIn: policy.allowPasswordSignIn,
      mfaGraceUntil: policy.mfaGraceUntil?.toISOString() ?? null,
      // Surfaced so a screen can disable "require SSO" with a reason rather than letting the
      // administrator submit it and receive a 400.
      enabledSsoConnections: enabledConnections,
      canRequireSso: enabledConnections > 0,
    };
  }

  // PUT rather than PATCH: the body carries the whole policy, and a partial update of
  // interacting flags (requireSso forces allowPasswordSignIn) would be ambiguous.
  @Put('policy')
  async updatePolicy(@Param('tenantId') tenantId: string, @Body() body: UpdateAuthPolicyDto) {
    const scope = this.scopeFor(tenantId);
    const actor = actorUserId(getActor());

    const graceUntil = body.mfaGraceUntil === undefined ? null : new Date(body.mfaGraceUntil);
    if (graceUntil !== null && Number.isNaN(graceUntil.getTime())) {
      throw new BadRequestException('mfaGraceUntil is not a valid timestamp.');
    }

    const policy = await this.policies.update(scope, {
      requireMfa: body.requireMfa,
      requireSso: body.requireSso,
      mfaGraceUntil: graceUntil,
      ...(actor === undefined ? {} : { actorUserId: actor }),
    });

    return {
      requireMfa: policy.requireMfa,
      requireSso: policy.requireSso,
      allowPasswordSignIn: policy.allowPasswordSignIn,
      mfaGraceUntil: policy.mfaGraceUntil?.toISOString() ?? null,
    };
  }

  // -------------------------------------------------------------------------
  // SSO connections
  // -------------------------------------------------------------------------

  @Get('sso-connections')
  async listConnections(@Param('tenantId') tenantId: string) {
    const connections = await this.enterprise.listConnections(this.scopeFor(tenantId));
    return { connections: connections.map((connection) => this.toConnectionView(connection)) };
  }

  @Post('sso-connections')
  @HttpCode(HttpStatus.CREATED)
  async createConnection(
    @Param('tenantId') tenantId: string,
    @Body() body: CreateSsoConnectionDto,
  ) {
    const scope = this.scopeFor(tenantId);

    if (body.protocol === 'Oidc') {
      // Checked here rather than in the DTO because the requirement depends on the protocol, and
      // a connection missing any of these is one that cannot be used — better to refuse it than
      // to store something that fails at the first sign-in.
      for (const [name, value] of [
        ['issuer', body.issuer],
        ['discoveryUrl', body.discoveryUrl],
        ['clientId', body.clientId],
        ['clientSecret', body.clientSecret],
      ] as const) {
        if (!value) {
          throw new BadRequestException(`An OIDC connection requires ${name}.`);
        }
      }
    }

    const connection = await this.enterprise.createConnection(scope, {
      protocol: body.protocol,
      displayName: body.displayName,
      // Never enabled at creation: an untested connection that is already live is how a company
      // locks itself out. It has to be verified, then enabled explicitly.
      enabled: false,
      ...pick('issuer', body.issuer),
      ...pick('discoveryUrl', body.discoveryUrl),
      ...pick('clientId', body.clientId),
      ...(body.clientSecret === undefined
        ? {}
        : {
            clientSecretCiphertext: this.secrets.seal(
              body.clientSecret,
              SECRET_PURPOSES.ssoClientSecret,
            ),
          }),
      ...pick('scopes', body.scopes),
      ...pick('entityId', body.entityId),
      ...pick('ssoUrl', body.ssoUrl),
      ...pick('sloUrl', body.sloUrl),
      ...pick('signingCertificate', body.signingCertificate),
    });

    await this.securityEvents.record({
      action: SECURITY_ACTIONS.ssoConnectionCreated,
      ...(actorUserId(getActor()) === undefined
        ? {}
        : { actorUserId: actorUserId(getActor()) as string }),
      tenantId,
      resourceType: 'sso_connection',
      resourceId: connection.id,
      summary: `Created a ${body.protocol} connection.`,
      metadata: { protocol: body.protocol, displayName: body.displayName },
    });

    return this.toConnectionView(connection);
  }

  @Patch('sso-connections/:connectionId')
  async updateConnection(
    @Param('tenantId') tenantId: string,
    @Param('connectionId') connectionId: string,
    @Body() body: UpdateSsoConnectionDto,
  ) {
    const scope = this.scopeFor(tenantId);
    const existing = await this.enterprise.findConnection(scope, connectionId);
    if (!existing) {
      throw new NotFoundException('No such connection.');
    }

    if (body.enabled === true && existing.protocol === 'Saml') {
      // A SAML connection cannot be enabled, because sign-in through it is not implemented.
      // Refusing here is the difference between "not built yet" and a login screen that offers a
      // button which cannot work.
      throw new BadRequestException(SamlProvider.NOT_IMPLEMENTED_REASON);
    }

    const changes = {
      ...pick('displayName', body.displayName),
      ...pick('enabled', body.enabled),
      ...pick('issuer', body.issuer),
      ...pick('discoveryUrl', body.discoveryUrl),
      ...pick('clientId', body.clientId),
      ...pick('scopes', body.scopes),
      ...(body.clientSecret === undefined
        ? {}
        : {
            clientSecretCiphertext: this.secrets.seal(
              body.clientSecret,
              SECRET_PURPOSES.ssoClientSecret,
            ),
          }),
    };

    await this.enterprise.updateConnection(scope, connectionId, changes);

    // The discovery document and key set are cached; a configuration change must not keep
    // talking to the old endpoints.
    if (existing.discoveryUrl && (body.discoveryUrl !== undefined || body.issuer !== undefined)) {
      this.oidc.forget(existing.discoveryUrl);
    }

    // Disabling a connection ends the sessions it issued: a federated session whose federation
    // has been turned off can never be re-validated against anything.
    if (body.enabled === false) {
      const revoked = await this.sso.revokeSessionsForConnection(
        connectionId,
        'sso_connection_disabled',
      );
      this.logger.log(`Disabling connection ${connectionId} revoked ${revoked} session(s).`);
    }

    await this.securityEvents.record({
      action: SECURITY_ACTIONS.ssoConnectionUpdated,
      tenantId,
      resourceType: 'sso_connection',
      resourceId: connectionId,
      summary: 'Updated an enterprise identity connection.',
      metadata: {
        fields: Object.keys(changes).join(','),
        // Recorded as a boolean, so the trail shows a secret was rotated without holding it.
        clientSecretRotated: body.clientSecret !== undefined,
      },
    });

    const refreshed = await this.enterprise.findConnection(scope, connectionId);
    return this.toConnectionView(refreshed as NonNullable<typeof refreshed>);
  }

  @Delete('sso-connections/:connectionId')
  @HttpCode(HttpStatus.NO_CONTENT)
  async deleteConnection(
    @Param('tenantId') tenantId: string,
    @Param('connectionId') connectionId: string,
  ) {
    const scope = this.scopeFor(tenantId);

    // Sessions first: deleting the row would null their `sso_connection_id` (the foreign key is
    // ON DELETE SET NULL), and then nothing could find the sessions that belonged to it.
    const revoked = await this.sso.revokeSessionsForConnection(
      connectionId,
      'sso_connection_deleted',
    );

    const deleted = await this.enterprise.deleteConnection(scope, connectionId);
    if (deleted === 0) {
      throw new NotFoundException('No such connection.');
    }

    await this.securityEvents.recordSuspicious({
      action: SECURITY_ACTIONS.ssoConnectionDeleted,
      tenantId,
      resourceType: 'sso_connection',
      resourceId: connectionId,
      summary: `Deleted an enterprise identity connection; revoked ${revoked} session(s).`,
      metadata: { sessionsRevoked: revoked },
    });
  }

  /**
   * The redirect URI and SAML metadata a company needs to configure its identity provider.
   *
   * Static and non-secret. Exposed as an endpoint because the alternative is an administrator
   * constructing the redirect URI by hand, and one wrong character produces an error message
   * from the identity provider that says nothing useful.
   */
  @Get('sso-setup')
  async ssoSetup(@Param('tenantId') tenantId: string) {
    return {
      redirectUri: this.sso.redirectUri,
      backchannelLogoutUriTemplate: `${this.sso.redirectUri.replace('/auth/sso/callback', '')}/auth/sso/{connectionId}/backchannel-logout`,
      supportedIdTokenAlgorithms: [
        'RS256',
        'RS384',
        'RS512',
        'PS256',
        'PS384',
        'PS512',
        'ES256',
        'ES384',
        'ES512',
      ],
      // Stated rather than implied: a company reading this needs to know HMAC-signed ID tokens
      // are refused before it configures one.
      unsupportedIdTokenAlgorithms: ['none', 'HS256', 'HS384', 'HS512'],
      samlServiceProviderMetadata: this.saml.serviceProviderMetadata({
        entityId: `${this.sso.redirectUri.replace('/auth/sso/callback', '')}/saml/${tenantId}`,
        assertionConsumerServiceUrl: `${this.sso.redirectUri.replace('/auth/sso/callback', '')}/auth/saml/${tenantId}/acs`,
      }),
      samlStatus: 'not-implemented',
      samlNote: SamlProvider.NOT_IMPLEMENTED_REASON,
    };
  }

  // -------------------------------------------------------------------------
  // Domain verification
  // -------------------------------------------------------------------------

  @Get('domains')
  async listDomains(@Param('tenantId') tenantId: string) {
    return { domains: await this.domains.list(this.scopeFor(tenantId)) };
  }

  @Post('domains')
  @HttpCode(HttpStatus.CREATED)
  async claimDomain(@Param('tenantId') tenantId: string, @Body() body: ClaimDomainDto) {
    const actor = actorUserId(getActor());
    return this.domains.claim(this.scopeFor(tenantId), body.domain, actor);
  }

  @Post('domains/:claimId/verify')
  @HttpCode(HttpStatus.OK)
  async verifyDomain(@Param('tenantId') tenantId: string, @Param('claimId') claimId: string) {
    const actor = actorUserId(getActor());
    return this.domains.verify(this.scopeFor(tenantId), claimId, actor);
  }

  @Delete('domains/:claimId')
  @HttpCode(HttpStatus.NO_CONTENT)
  async removeDomain(@Param('tenantId') tenantId: string, @Param('claimId') claimId: string) {
    const actor = actorUserId(getActor());
    const removed = await this.domains.remove(this.scopeFor(tenantId), claimId, actor);
    if (!removed) {
      throw new NotFoundException('No such domain claim.');
    }
  }

  // -------------------------------------------------------------------------
  // SCIM credentials
  // -------------------------------------------------------------------------

  @Get('scim-clients')
  async listScimClients(@Param('tenantId') tenantId: string) {
    return { clients: await this.scim.listClients(this.scopeFor(tenantId)) };
  }

  @Post('scim-clients')
  @HttpCode(HttpStatus.CREATED)
  async createScimClient(@Param('tenantId') tenantId: string, @Body() body: CreateScimClientDto) {
    const actor = actorUserId(getActor());
    const client = await this.scim.createClient(this.scopeFor(tenantId), body.displayName, actor);

    return {
      id: client.id,
      displayName: client.displayName,
      /** Returned **once**. Only a hash is stored, so a lost token is replaced, never recovered. */
      token: client.token,
      scimBaseUrl: `${this.sso.redirectUri.replace('/auth/sso/callback', '')}/scim/v2`,
    };
  }

  @Delete('scim-clients/:clientId')
  @HttpCode(HttpStatus.NO_CONTENT)
  async revokeScimClient(@Param('tenantId') tenantId: string, @Param('clientId') clientId: string) {
    const actor = actorUserId(getActor());
    const revoked = await this.scim.revokeClient(this.scopeFor(tenantId), clientId, actor);
    if (!revoked) {
      throw new NotFoundException('No such SCIM client.');
    }
  }

  // -------------------------------------------------------------------------

  /**
   * A tenant scope from the path, permitted **only** because the route is platform-only.
   *
   * The guard has already established that the caller is a platform actor, so this is the
   * documented "platform-plane operation on one named tenant" case rather than trusting a
   * browser-supplied tenant id — which working rule E forbids for a company member.
   */
  private scopeFor(tenantId: string) {
    if (!isPlatformActor(getActor())) {
      // Belt and braces: the decorator already guarantees this. Kept because the alternative is
      // a scope built from a path parameter with nothing local proving it was checked.
      throw new BadRequestException('Platform administrator access is required.');
    }
    return tenantScopeForPlatformOperation(tenantId);
  }

  private toConnectionView(connection: {
    id: string;
    protocol: string;
    displayName: string;
    enabled: boolean;
    issuer: string | null;
    discoveryUrl: string | null;
    clientId: string | null;
    clientSecretCiphertext: string | null;
    scopes: string | null;
    entityId: string | null;
    ssoUrl: string | null;
    sloUrl: string | null;
    createdAt: Date;
    updatedAt: Date;
  }) {
    return {
      id: connection.id,
      protocol: connection.protocol,
      displayName: connection.displayName,
      enabled: connection.enabled,
      issuer: connection.issuer,
      discoveryUrl: connection.discoveryUrl,
      clientId: connection.clientId,
      // The secret itself is never returned, in plaintext or sealed. Only whether one is set.
      hasClientSecret: connection.clientSecretCiphertext !== null,
      scopes: connection.scopes,
      entityId: connection.entityId,
      ssoUrl: connection.ssoUrl,
      sloUrl: connection.sloUrl,
      createdAt: connection.createdAt.toISOString(),
      updatedAt: connection.updatedAt.toISOString(),
    };
  }
}

/** Include a key only when its value is defined, so `exactOptionalPropertyTypes` holds. */
function pick<K extends string, V>(key: K, value: V | undefined): Record<K, V> | object {
  return value === undefined ? {} : ({ [key]: value } as Record<K, V>);
}
