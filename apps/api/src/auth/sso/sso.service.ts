import {
  BadRequestException,
  Inject,
  Injectable,
  Logger,
  NotImplementedException,
  UnauthorizedException,
} from '@nestjs/common';

import { EnterpriseIdentityRepository } from '../../persistence/enterprise-identity.repository.js';
import { PrismaService } from '../../persistence/prisma.service.js';
import { SessionRepository } from '../../persistence/session.repository.js';
import { TenantMembershipRepository } from '../../persistence/tenant-membership.repository.js';
import { UserRepository } from '../../persistence/user.repository.js';
import { tenantScopeForPlatformOperation } from '../../persistence/tenant-context.js';
import { AUTH_CONFIG, type AuthConfig } from '../auth.config.js';
import { hashToken } from '../one-time-token.js';
import { SECRET_PURPOSES, SecretBox } from '../secret-box.js';
import { SECURITY_ACTIONS, SecurityEventPublisher } from '../security-event.publisher.js';
import { socialProvider, type SocialProviderKind } from '../social-providers.config.js';
import { JwtError } from './jwt.js';
import { OidcError, OidcProvider, type OidcConnectionConfig } from './oidc.provider.js';
import { SamlProvider } from './saml.provider.js';

/** A social sign-in that has been started. No tenant: see `beginSocial`. */
export interface SocialStart {
  authorizationUrl: string;
  providerKind: SocialProviderKind;
}

export interface SsoStart {
  authorizationUrl: string;
  connectionId: string;
  tenantId: string;
}

export type SsoCompletion =
  | {
      outcome: 'signed-in';
      userId: string;
      ubossUniqueId: string;
      displayName: string;
      isPlatformActor: boolean;
      tenantId: string;
      /** The company connection used, or null for a sign-in through UBoss’s own social app. */
      connectionId: string | null;
      providerSessionId: string | undefined;
      redirectAfter: string;
    }
  | { outcome: 'failed'; reason: string };

/**
 * Enterprise single sign-on.
 *
 * ## Federation never creates a person, and never creates a membership
 *
 * This is the single most important rule in the file, and it is the direct consequence of "no
 * public company signup". A successful assertion from a company's identity provider proves *who
 * someone is*. It does not prove they should have access — that is what the membership record is
 * for, and only an invitation creates one.
 *
 * So an SSO sign-in for an unknown email is **refused**, not auto-provisioned. Just-in-time
 * provisioning is the industry default and it is deliberately not implemented here: with it,
 * anyone the identity provider will authenticate becomes a UBoss user, which turns the IdP's
 * user directory into a signup form. Companies that want that behaviour have SCIM, which pushes
 * memberships explicitly and auditably.
 *
 * ## Identity matching
 *
 * The `sub` claim is the provider's stable identifier, but it cannot be the join key on a first
 * sign-in — nothing in UBoss has seen it before. So matching is by **email**, and only when:
 *
 *   1. the email's domain is one this company has **verified** it controls, and
 *   2. a membership already exists for that person in that company.
 *
 * The domain check is what stops a compromised or careless identity provider asserting
 * `someone@another-company.com` and being believed.
 */
@Injectable()
export class SsoService {
  private readonly logger = new Logger(SsoService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly enterprise: EnterpriseIdentityRepository,
    private readonly users: UserRepository,
    private readonly memberships: TenantMembershipRepository,
    private readonly sessions: SessionRepository,
    private readonly oidc: OidcProvider,
    private readonly secrets: SecretBox,
    private readonly securityEvents: SecurityEventPublisher,
    @Inject(AUTH_CONFIG) private readonly config: AuthConfig,
  ) {}

  /** The redirect URI registered with the identity provider. One value, for every connection. */
  get redirectUri(): string {
    return `${this.config.publicApiBaseUrl}/auth/sso/callback`;
  }

  /**
   * Begin a federated sign-in.
   *
   * The `state`, `nonce` and PKCE verifier are stored server-side before the browser leaves, so
   * the callback can be checked against what we actually sent rather than against something the
   * callback itself supplies.
   */
  async begin(connectionId: string, redirectAfter?: string): Promise<SsoStart> {
    const connection = await this.prisma.runAsPlatformOperation(() =>
      this.enterprise.findEnabledConnectionForPlatform(connectionId),
    );

    if (!connection) {
      // Same answer for "no such connection" and "disabled", so the endpoint cannot be used to
      // enumerate which companies have SSO configured.
      throw new UnauthorizedException('That sign-in method is not available.');
    }

    if (connection.protocol === 'Saml') {
      throw new NotImplementedException(SamlProvider.NOT_IMPLEMENTED_REASON);
    }

    const oidcConfig = this.oidcConfigFor(connection);
    const request = await this.oidc.beginAuthorization(oidcConfig, this.redirectUri);

    await this.prisma.runAsPlatformOperation(() =>
      this.enterprise.createAuthRequest({
        tenantId: connection.tenantId,
        connectionId: connection.id,
        stateHash: hashToken(request.state),
        nonceHash: hashToken(request.nonce),
        codeVerifierCiphertext: this.secrets.seal(
          request.codeVerifier,
          SECRET_PURPOSES.pkceVerifier,
        ),
        ...(redirectAfter === undefined ? {} : { redirectAfter }),
        expiresAt: new Date(Date.now() + this.config.ssoAuthRequestMinutes * 60 * 1000),
      }),
    );

    await this.securityEvents.record({
      action: SECURITY_ACTIONS.ssoLoginStarted,
      tenantId: connection.tenantId,
      resourceType: 'sso_connection',
      resourceId: connection.id,
      summary: 'Federated sign-in started.',
      metadata: { protocol: connection.protocol },
    });

    return {
      authorizationUrl: request.authorizationUrl,
      connectionId: connection.id,
      tenantId: connection.tenantId,
    };
  }

  /**
   * Complete a federated sign-in.
   *
   * Every failure returns `{ outcome: 'failed' }` with a reason meant for the *screen*, not for
   * the caller to branch on — an unauthenticated endpoint must not explain whether the email was
   * unknown, the domain unverified or the membership missing.
   */
  /**
   * Start a sign-in through UBoss's own Google, Microsoft or Apple application.
   *
   * ## Why there is no tenant here
   *
   * Because nobody has said which company this is, and nothing the browser could say would be
   * worth trusting. The tenant is decided after the provider returns, from the **verified** domain
   * of the address it asserts — see `resolveSocialIdentity`. Starting a flow therefore commits to
   * nothing: it proves an address, and proving an address is not being let in.
   *
   * ## Why this reuses the enterprise authorization code exactly
   *
   * `beginAuthorization` already does state, nonce and PKCE with S256, and stores only hashes of
   * the first two because both travel in a URL and therefore reach logs and browser history. A
   * second implementation of that for social would be a second place to get it wrong, and this is
   * the one flow where getting it wrong is an account takeover.
   */
  async beginSocial(kind: SocialProviderKind, redirectAfter?: string): Promise<SocialStart> {
    const provider = socialProvider(kind);
    if (provider === null) {
      // The same sentence an unknown connection gets. A caller without a session must not be able
      // to learn which providers this deployment holds credentials for by probing.
      throw new UnauthorizedException('That sign-in method is not available.');
    }

    const request = await this.oidc.beginAuthorization(
      {
        issuer: provider.issuer,
        discoveryUrl: provider.discoveryUrl,
        clientId: provider.clientId,
        clientSecret: provider.clientSecret,
        scopes: provider.scopes.join(' '),
      },
      this.redirectUri,
    );

    await this.prisma.runAsPlatformOperation(() =>
      this.enterprise.createSocialAuthRequest({
        providerKind: kind,
        stateHash: hashToken(request.state),
        nonceHash: hashToken(request.nonce),
        codeVerifierCiphertext: this.secrets.seal(
          request.codeVerifier,
          SECRET_PURPOSES.pkceVerifier,
        ),
        ...(redirectAfter === undefined ? {} : { redirectAfter }),
        expiresAt: new Date(Date.now() + this.config.ssoAuthRequestMinutes * 60 * 1000),
      }),
    );

    /*
     * Recorded with no tenant, because there is not one yet.
     *
     * Worth recording all the same: a burst of starts that never complete is what a probe looks
     * like, and the trail is where that is visible.
     */
    await this.securityEvents.record({
      action: SECURITY_ACTIONS.ssoLoginStarted,
      resourceType: 'social_provider',
      resourceId: kind,
      summary: `Sign-in started with ${provider.displayName}.`,
      metadata: { providerKind: kind },
    });

    return { authorizationUrl: request.authorizationUrl, providerKind: kind };
  }

  async complete(input: {
    code: string | undefined;
    state: string | undefined;
    error?: string | undefined;
  }): Promise<SsoCompletion> {
    if (input.error) {
      // The provider itself refused. Logged, but not echoed to the browser.
      this.logger.warn(`Identity provider returned an error: ${input.error.slice(0, 120)}`);
      return { outcome: 'failed', reason: 'Your identity provider did not complete the sign-in.' };
    }

    if (!input.code || !input.state) {
      return { outcome: 'failed', reason: 'That sign-in link is incomplete.' };
    }

    const now = new Date();

    // Finding and consuming the request is one atomic step, so a replayed callback finds nothing.
    const authRequest = await this.prisma.runAsPlatformOperation(() =>
      this.enterprise.consumeAuthRequestByStateForPlatform(hashToken(input.state as string), now),
    );

    if (!authRequest) {
      await this.securityEvents.recordSuspicious({
        action: SECURITY_ACTIONS.ssoLoginFailed,
        resourceType: 'sso_auth_request',
        summary: 'SSO callback did not match a live authorization request.',
        metadata: { reason: 'unknown_or_replayed_state' },
      });
      return {
        outcome: 'failed',
        reason: 'That sign-in has already been used or has expired. Please start again.',
      };
    }

    /*
     * This callback handles an enterprise connection request, which always carries a connection
     * and a tenant — the flow-shape constraint in the database refuses a row of this kind that
     * does not. Since `connection_id` became nullable for social requests, that guarantee has to
     * be stated here rather than assumed: a social request arriving at this path would mean the
     * callback router sent it to the wrong handler, and continuing with no connection would mean
     * completing a sign-in against configuration that was never loaded.
     */
    /*
     * One callback, two flows, routed on what the request said it was when it started.
     *
     * Routed here rather than on anything in the query string: `flowKind` was written by this
     * server before the browser left, and the state that found this row was matched by hash. A
     * social request completed down the enterprise path would be completed against configuration
     * that was never loaded.
     */
    if (authRequest.flowKind === 'SocialProvider') {
      return this.completeSocial(authRequest, input.code);
    }

    if (authRequest.flowKind !== 'EnterpriseConnection' || authRequest.connectionId === null) {
      await this.securityEvents.recordSuspicious({
        action: SECURITY_ACTIONS.ssoLoginFailed,
        resourceType: 'sso_auth_request',
        resourceId: authRequest.id,
        summary: 'An enterprise SSO callback received a request that is not an enterprise request.',
        metadata: { reason: 'flow_kind_mismatch', flowKind: authRequest.flowKind },
      });
      return {
        outcome: 'failed',
        reason: 'That sign-in could not be completed. Please start again.',
      };
    }

    const connection = await this.prisma.runAsPlatformOperation(() =>
      this.enterprise.findEnabledConnectionForPlatform(authRequest.connectionId as string),
    );
    if (!connection) {
      return { outcome: 'failed', reason: 'That sign-in method is no longer available.' };
    }

    let identity;
    try {
      identity = await this.oidc.completeAuthorization(this.oidcConfigFor(connection), {
        code: input.code,
        codeVerifier: this.secrets.open(
          authRequest.codeVerifierCiphertext,
          SECRET_PURPOSES.pkceVerifier,
        ),
        redirectUri: this.redirectUri,
        // Only the hash of the nonce was stored, because a nonce travels in the authorization
        // URL and therefore reaches logs and browser history. Verification compares hashes, so
        // the plaintext never has to be persisted.
        nonce: { kind: 'hash', sha256Hex: authRequest.nonceHash },
      });
    } catch (cause) {
      // A JwtError means the token itself did not hold up — bad signature, wrong issuer or
      // audience, expired, or a nonce that does not match this request. An OidcError means we
      // could not complete the exchange at all. The browser gets one message either way; the
      // trail separates them, because they need completely different investigation.
      const reason =
        cause instanceof JwtError
          ? 'id_token_rejected'
          : cause instanceof OidcError
            ? 'token_exchange_failed'
            : 'unexpected_failure';

      this.logger.warn(
        `SSO sign-in failed (${reason}): ${cause instanceof Error ? cause.message : 'unknown'}`,
      );

      await this.securityEvents.recordSuspicious({
        action: SECURITY_ACTIONS.ssoLoginFailed,
        tenantId: connection.tenantId,
        resourceType: 'sso_connection',
        resourceId: connection.id,
        summary: 'Federated sign-in failed before a session was issued.',
        metadata: { reason },
      });
      return { outcome: 'failed', reason: 'Your identity provider could not be verified.' };
    }

    const resolved = await this.resolveIdentity(connection.tenantId, identity.email);
    if (resolved.outcome !== 'matched') {
      await this.securityEvents.recordSuspicious({
        action: SECURITY_ACTIONS.ssoLoginFailed,
        tenantId: connection.tenantId,
        resourceType: 'sso_connection',
        resourceId: connection.id,
        summary: 'Federated sign-in refused: the asserted identity is not a member.',
        // The asserted address is deliberately absent, for the same reason a failed password
        // sign-in does not record the attempted email.
        metadata: { reason: resolved.outcome },
      });
      return {
        outcome: 'failed',
        // One message for unknown person, unverified domain and missing membership. UBoss does
        // not tell an unauthenticated caller which of those it was.
        reason:
          'Your identity provider signed you in, but you do not have access to this workspace. ' +
          'Ask an administrator to invite you.',
      };
    }

    await this.securityEvents.record({
      action: SECURITY_ACTIONS.ssoLoginSucceeded,
      actorUserId: resolved.user.id,
      tenantId: connection.tenantId,
      resourceType: 'sso_connection',
      resourceId: connection.id,
      summary: 'Signed in through the company identity provider.',
      metadata: {
        protocol: connection.protocol,
        hasProviderSession: identity.providerSessionId !== undefined,
      },
    });

    return {
      outcome: 'signed-in',
      userId: resolved.user.id,
      ubossUniqueId: resolved.user.ubossUniqueId,
      displayName: resolved.user.displayName,
      isPlatformActor: resolved.user.isPlatformActor,
      tenantId: connection.tenantId,
      connectionId: connection.id,
      providerSessionId: identity.providerSessionId,
      redirectAfter: this.safeRedirect(authRequest.redirectAfter),
    };
  }

  /**
   * Map an asserted email onto an existing UBoss person and membership.
   *
   * Both conditions are required, and neither is sufficient:
   *
   *   * the domain must be **verified** for this company — otherwise a misconfigured provider
   *     could assert any address it likes;
   *   * a membership must already exist — otherwise this is signup by federation.
   */
  /**
   * Finish a sign-in that came back from Google, Microsoft or Apple.
   *
   * ## The rule this exists to enforce
   *
   * **A social identity never creates anything.** Anybody in the world can obtain a Google
   * account at any address they control, so proving one proves exactly one thing: that this
   * person reads that mailbox. Being let into a company requires, separately, that the address's
   * domain is **verified** as belonging to that company and that the person already holds an
   * **active** membership there. Three conditions, all checked below, none of which the browser
   * can influence.
   *
   * That is also why the tenant is derived here rather than carried from the start: the company
   * is a conclusion drawn from a proved address, not an input.
   */
  private async completeSocial(
    authRequest: {
      id: string;
      providerKind: string | null;
      nonceHash: string;
      codeVerifierCiphertext: string;
      redirectAfter: string | null;
    },
    code: string,
  ): Promise<SsoCompletion> {
    const kind = authRequest.providerKind as SocialProviderKind | null;
    const provider = kind === null ? null : socialProvider(kind);

    if (provider === null) {
      /*
       * Credentials withdrawn between the start and the callback, or a row with no provider.
       *
       * Refused rather than guessed at: completing against a different provider's configuration
       * would verify a token against the wrong issuer and audience.
       */
      await this.securityEvents.recordSuspicious({
        action: SECURITY_ACTIONS.ssoLoginFailed,
        resourceType: 'sso_auth_request',
        resourceId: authRequest.id,
        summary: 'A social sign-in came back for a provider this deployment no longer offers.',
        metadata: { reason: 'provider_not_configured', providerKind: kind },
      });
      return { outcome: 'failed', reason: 'That sign-in method is no longer available.' };
    }

    let identity;
    try {
      identity = await this.oidc.completeAuthorization(
        {
          issuer: provider.issuer,
          discoveryUrl: provider.discoveryUrl,
          clientId: provider.clientId,
          clientSecret: provider.clientSecret,
          scopes: provider.scopes.join(' '),
        },
        {
          code,
          codeVerifier: this.secrets.open(
            authRequest.codeVerifierCiphertext,
            SECRET_PURPOSES.pkceVerifier,
          ),
          redirectUri: this.redirectUri,
          // Hash only, for the same reason as the enterprise flow: a nonce travels in a URL.
          nonce: { kind: 'hash', sha256Hex: authRequest.nonceHash },
        },
      );
    } catch (cause) {
      const reason =
        cause instanceof JwtError
          ? 'id_token_rejected'
          : cause instanceof OidcError
            ? 'token_exchange_failed'
            : 'unexpected_failure';

      this.logger.warn(
        `Social sign-in failed (${reason}): ${cause instanceof Error ? cause.message : 'unknown'}`,
      );
      await this.securityEvents.recordSuspicious({
        action: SECURITY_ACTIONS.ssoLoginFailed,
        resourceType: 'social_provider',
        resourceId: kind ?? 'unknown',
        summary: 'A social sign-in failed before a session was issued.',
        metadata: { reason, providerKind: kind },
      });
      return { outcome: 'failed', reason: 'That sign-in could not be verified.' };
    }

    const resolved = await this.resolveSocialIdentity(identity.email);
    if (resolved.outcome !== 'matched') {
      await this.securityEvents.recordSuspicious({
        action: SECURITY_ACTIONS.ssoLoginFailed,
        resourceType: 'social_provider',
        resourceId: kind ?? 'unknown',
        summary: 'A social sign-in was refused: the proved address is not a member of any company.',
        // The address is deliberately absent, as it is for a failed password attempt.
        metadata: { reason: resolved.outcome, providerKind: kind },
      });
      return {
        outcome: 'failed',
        /*
         * One sentence for every refusal below.
         *
         * Unknown person, unverified domain and suspended membership are deliberately
         * indistinguishable: told apart, this endpoint would let anybody with a Google account
         * discover which domains UBoss hosts and who works at them.
         */
        reason:
          `${provider.displayName.replace('Continue with ', '')} verified your address, but it ` +
          'does not have access to a UBoss workspace. Ask an administrator to invite you.',
      };
    }

    await this.securityEvents.record({
      action: SECURITY_ACTIONS.ssoLoginSucceeded,
      actorUserId: resolved.user.id,
      tenantId: resolved.tenantId,
      resourceType: 'social_provider',
      resourceId: kind ?? 'unknown',
      summary: `Signed in with ${provider.displayName.replace('Continue with ', '')}.`,
      metadata: { providerKind: kind },
    });

    return {
      outcome: 'signed-in',
      userId: resolved.user.id,
      ubossUniqueId: resolved.user.ubossUniqueId,
      displayName: resolved.user.displayName,
      isPlatformActor: resolved.user.isPlatformActor,
      tenantId: resolved.tenantId,
      connectionId: null,
      providerSessionId: undefined,
      redirectAfter: this.safeRedirect(authRequest.redirectAfter),
      /*
       * No provider session id.
       *
       * Back-channel logout is an enterprise connection's contract with a company's own identity
       * provider. UBoss's Google application has no such arrangement, and recording an id that
       * nothing will ever call back about would be a field that looks like a capability.
       */
    };
  }

  /**
   * Which company a proved address belongs to, if any.
   *
   * The same three conditions the enterprise flow applies, with one difference: there the tenant
   * is known and the domain must match it, here the tenant **is** whichever company has verified
   * that domain. A domain no company has proved resolves to nothing, so an address at a public
   * mail provider can never reach this far.
   */
  private async resolveSocialIdentity(email: string | undefined): Promise<
    | {
        outcome: 'matched';
        tenantId: string;
        user: { id: string; ubossUniqueId: string; displayName: string; isPlatformActor: boolean };
      }
    | { outcome: 'no_email' | 'domain_not_verified' | 'unknown_person' | 'not_a_member' }
  > {
    if (!email || !email.includes('@')) return { outcome: 'no_email' };

    const domain = email.slice(email.lastIndexOf('@') + 1).toLowerCase();

    return this.prisma.runAsPlatformOperation(async () => {
      const owner = await this.enterprise.findVerifiedDomainOwnerForPlatform(domain);
      if (!owner) return { outcome: 'domain_not_verified' as const };

      const user = await this.users.findByEmailForPlatform(email.toLowerCase());
      if (!user) return { outcome: 'unknown_person' as const };

      const membership = await this.memberships.findByUserId(
        tenantScopeForPlatformOperation(owner.tenantId),
        user.id,
      );
      if (!membership || membership.accountState !== 'Active') {
        return { outcome: 'not_a_member' as const };
      }

      return {
        outcome: 'matched' as const,
        tenantId: owner.tenantId,
        user: {
          id: user.id,
          ubossUniqueId: user.ubossUniqueId,
          displayName: user.displayName,
          isPlatformActor: user.isPlatformActor,
        },
      };
    });
  }

  private async resolveIdentity(
    tenantId: string,
    email: string | undefined,
  ): Promise<
    | {
        outcome: 'matched';
        user: {
          id: string;
          ubossUniqueId: string;
          displayName: string;
          isPlatformActor: boolean;
        };
      }
    | { outcome: 'no_email' | 'domain_not_verified' | 'unknown_person' | 'not_a_member' }
  > {
    if (!email || !email.includes('@')) {
      return { outcome: 'no_email' };
    }

    const domain = email.slice(email.lastIndexOf('@') + 1).toLowerCase();

    return this.prisma.runAsPlatformOperation(async () => {
      const owner = await this.enterprise.findVerifiedDomainOwnerForPlatform(domain);
      if (!owner || owner.tenantId !== tenantId) {
        return { outcome: 'domain_not_verified' as const };
      }

      const user = await this.users.findByEmailForPlatform(email.toLowerCase());
      if (!user) {
        return { outcome: 'unknown_person' as const };
      }

      const membership = await this.memberships.findByUserId(
        tenantScopeForPlatformOperation(tenantId),
        user.id,
      );
      if (!membership || membership.accountState !== 'Active') {
        return { outcome: 'not_a_member' as const };
      }

      return {
        outcome: 'matched' as const,
        user: {
          id: user.id,
          ubossUniqueId: user.ubossUniqueId,
          displayName: user.displayName,
          isPlatformActor: user.isPlatformActor,
        },
      };
    });
  }

  // -------------------------------------------------------------------------
  // Termination
  // -------------------------------------------------------------------------

  /**
   * Handle a back-channel logout from an identity provider.
   *
   * This is the half of "SSO session termination" that the provider drives: someone signs out at
   * the IdP (or an administrator disables them there), and the IdP tells every relying party.
   * Without it, disabling an account at the identity provider would leave live UBoss sessions —
   * which is precisely the gap that makes federated logout worth having.
   *
   * The logout token is verified exactly like an ID token, so an unauthenticated POST cannot end
   * anyone's session by guessing a `sid`.
   */
  async handleBackchannelLogout(
    connectionId: string,
    logoutToken: string,
  ): Promise<{ revoked: number }> {
    const connection = await this.prisma.runAsPlatformOperation(() =>
      this.enterprise.findEnabledConnectionForPlatform(connectionId),
    );
    if (!connection) {
      throw new UnauthorizedException('That sign-in method is not available.');
    }
    if (connection.protocol === 'Saml') {
      throw new NotImplementedException(SamlProvider.NOT_IMPLEMENTED_REASON);
    }

    let verified;
    try {
      verified = await this.oidc.verifyLogoutToken(this.oidcConfigFor(connection), logoutToken);
    } catch (cause) {
      await this.securityEvents.recordSuspicious({
        action: SECURITY_ACTIONS.ssoBackchannelLogout,
        tenantId: connection.tenantId,
        resourceType: 'sso_connection',
        resourceId: connection.id,
        summary: 'A back-channel logout token failed verification and was ignored.',
        metadata: { reason: cause instanceof Error ? cause.name : 'unknown' },
      });
      throw new UnauthorizedException('That logout token could not be verified.');
    }

    const now = new Date();
    let revoked = 0;

    if (verified.providerSessionId !== undefined) {
      revoked = await this.prisma.runAsPlatformOperation(() =>
        this.sessions.revokeByProviderSessionForPlatform(
          connection.id,
          verified.providerSessionId as string,
          'sso_backchannel_logout',
          now,
        ),
      );
    } else if (verified.subject !== undefined) {
      // No `sid`: the spec permits a subject-only logout, which means "end every session this
      // person has through this connection". Broader than a single session, and correct — the
      // provider is telling us it no longer vouches for them at all.
      const user = await this.prisma.runAsPlatformOperation(() =>
        this.users.findByEmailForPlatform(verified.subject as string),
      );

      revoked = await this.prisma.runAsPlatformOperation(() =>
        this.sessions.revokeByConnectionForPlatform(
          connection.id,
          'sso_backchannel_logout',
          now,
          user?.id,
        ),
      );
    }

    await this.securityEvents.recordSuspicious({
      action: SECURITY_ACTIONS.ssoBackchannelLogout,
      tenantId: connection.tenantId,
      resourceType: 'sso_connection',
      resourceId: connection.id,
      summary: `Provider-initiated logout revoked ${revoked} session(s).`,
      metadata: {
        revoked,
        byProviderSession: verified.providerSessionId !== undefined,
      },
    });

    return { revoked };
  }

  /**
   * Where to send the browser so the *provider* session also ends, for a federated session.
   *
   * Returns `undefined` when the session was not federated, or when the provider publishes no
   * `end_session_endpoint`. The caller must then say plainly that only the UBoss session ended —
   * claiming a full sign-out we did not perform is exactly the failure
   * `terminateProviderSession` was made mandatory to prevent.
   */
  async providerLogoutUrl(sessionId: string): Promise<string | undefined> {
    const session = await this.prisma.runAsPlatformOperation(async () =>
      this.prisma.client.session.findFirst({
        where: { id: sessionId },
        select: { id: true, userId: true, ssoConnectionId: true },
      }),
    );

    if (!session?.ssoConnectionId) {
      return undefined;
    }

    const connection = await this.prisma.runAsPlatformOperation(() =>
      this.enterprise.findEnabledConnectionForPlatform(session.ssoConnectionId as string),
    );
    if (!connection || connection.protocol === 'Saml') {
      return undefined;
    }

    await this.securityEvents.record({
      action: SECURITY_ACTIONS.ssoProviderLogoutRequested,
      actorUserId: session.userId,
      tenantId: connection.tenantId,
      resourceType: 'sso_connection',
      resourceId: connection.id,
      summary: 'Requested provider-side sign-out.',
    });

    // No `id_token_hint`: the ID token is not retained. Keeping it would mean storing a live
    // bearer credential for the lifetime of the session in order to make logout marginally
    // tidier, which is a bad trade. Providers that need a hint will prompt the user instead.
    return this.oidc.endSessionUrl(this.oidcConfigFor(connection), {
      postLogoutRedirectUri: `${this.config.webBaseUrl}/login`,
    });
  }

  /**
   * Where to send a browser whose federated sign-in failed.
   *
   * Always the configured login screen with a short, non-specific reason in the query string.
   * Built here rather than in the controller so there is one place a callback can redirect to,
   * and so nothing from the request can influence it.
   */
  loginFailureUrl(reason: string): string {
    const url = new URL('/login', this.config.webBaseUrl);
    url.searchParams.set('ssoError', reason.slice(0, 200));
    return url.toString();
  }

  /**
   * Revoke every session a connection issued.
   *
   * Called when a connection is disabled or deleted: a session that was issued by a connection
   * that no longer exists can never be re-validated against the provider, so leaving it live
   * would mean a federated session outliving the federation.
   */
  async revokeSessionsForConnection(connectionId: string, reason: string): Promise<number> {
    return this.prisma.runAsPlatformOperation(() =>
      this.sessions.revokeByConnectionForPlatform(connectionId, reason, new Date()),
    );
  }

  // -------------------------------------------------------------------------

  private oidcConfigFor(connection: {
    issuer: string | null;
    discoveryUrl: string | null;
    clientId: string | null;
    clientSecretCiphertext: string | null;
    scopes: string | null;
  }): OidcConnectionConfig {
    if (
      !connection.issuer ||
      !connection.discoveryUrl ||
      !connection.clientId ||
      !connection.clientSecretCiphertext
    ) {
      throw new BadRequestException(
        'This OIDC connection is missing its issuer, discovery URL, client id or client secret.',
      );
    }

    return {
      issuer: connection.issuer,
      discoveryUrl: connection.discoveryUrl,
      clientId: connection.clientId,
      clientSecret: this.secrets.open(
        connection.clientSecretCiphertext,
        SECRET_PURPOSES.ssoClientSecret,
      ),
      ...(connection.scopes === null ? {} : { scopes: connection.scopes }),
    };
  }

  /**
   * Constrain the post-sign-in redirect to the configured web origin.
   *
   * An SSO callback that echoes a caller-supplied URL is an open redirect on an authentication
   * endpoint — the most useful kind to a phisher, because the link genuinely starts at our
   * domain. Only a same-origin path is honoured; anything else falls back to the default.
   */
  private safeRedirect(candidate: string | null): string {
    const fallback = `${this.config.webBaseUrl}/login`;
    if (!candidate) {
      return fallback;
    }

    try {
      const resolved = new URL(candidate, this.config.webBaseUrl);
      return resolved.origin === new URL(this.config.webBaseUrl).origin
        ? resolved.toString()
        : fallback;
    } catch {
      return fallback;
    }
  }
}
