import { Injectable, Logger } from '@nestjs/common';
import { createHash, randomBytes } from 'node:crypto';

import {
  verifyIdToken,
  type IdTokenClaims,
  type JsonWebKey,
  type NonceExpectation,
  JwtError,
} from './jwt.js';

/**
 * OIDC authorization-code flow with PKCE.
 *
 * ## Which flow, and why
 *
 * Authorization code + PKCE, always. The implicit flow puts the ID token in a URL fragment,
 * where it lands in browser history and any `Referer` that leaks; the hybrid flow keeps that
 * problem. PKCE is applied even though this is a confidential client with a secret — it costs
 * one hash and closes code-injection independently of whether the secret is intact.
 *
 * ## What binds the callback to the request
 *
 * Three separate values, none of them redundant:
 *
 *   * **state** — proves the callback belongs to an authorization request we started. Its hash
 *     is the primary key we look the request up by.
 *   * **nonce** — proves the *ID token* belongs to that request. A `state` check alone would
 *     still allow a token obtained elsewhere to be injected.
 *   * **PKCE verifier** — proves the *authorization code* is being redeemed by the client that
 *     asked for it.
 *
 * ## SSRF posture
 *
 * The discovery URL is configured by a platform administrator, not by a request. On top of that,
 * `jwks_uri` and the token endpoint are required to share the issuer's origin: a discovery
 * document cannot redirect us to fetch keys from, or post credentials to, somewhere else.
 */

export interface OidcDiscovery {
  issuer: string;
  authorization_endpoint: string;
  token_endpoint: string;
  jwks_uri: string;
  end_session_endpoint?: string;
  userinfo_endpoint?: string;
  id_token_signing_alg_values_supported?: string[];
  code_challenge_methods_supported?: string[];
}

export interface OidcConnectionConfig {
  issuer: string;
  discoveryUrl: string;
  clientId: string;
  clientSecret: string;
  scopes?: string | undefined;
}

export interface AuthorizationRequest {
  authorizationUrl: string;
  state: string;
  nonce: string;
  codeVerifier: string;
}

export interface FederatedIdentity {
  /** The provider's stable identifier for the person. */
  subject: string;
  email: string | undefined;
  emailVerified: boolean | undefined;
  displayName: string | undefined;
  /** The provider's session id, when it publishes one. Enables back-channel logout. */
  providerSessionId: string | undefined;
  /** Kept so an RP-initiated logout can pass `id_token_hint`. */
  idToken: string;
  claims: IdTokenClaims;
}

/**
 * The only cross-origin endpoints any provider is allowed, keyed by the issuer that may use them.
 *
 * ## Why this exists
 *
 * Endpoints used to be required to sit on the issuer's own origin, which is a good default and is
 * still what happens for everything not listed here. It is also stricter than OpenID Connect
 * Discovery, which never required it — and Google's published metadata does not satisfy it:
 *
 *     issuer         https://accounts.google.com
 *     token_endpoint https://oauth2.googleapis.com/token
 *     jwks_uri       https://www.googleapis.com/oauth2/v3/certs
 *
 * Checked live against all three providers: Microsoft and Apple are entirely same-origin and need
 * nothing from this table. Google alone does.
 *
 * ## Why this is narrow rather than a relaxation
 *
 * Three things have to line up before a cross-origin endpoint is accepted, and all three are
 * configuration or published fact rather than anything the document can assert:
 *
 *   1. the **issuer** must match this connection's configured issuer exactly. That is checked
 *      before this table is consulted, so a hostile discovery document cannot nominate itself as
 *      Google in order to reach these origins.
 *   2. the **endpoint name** must be the one listed. Google may move its token endpoint to
 *      oauth2.googleapis.com; it may not move its authorization endpoint there.
 *   3. the **origin** must be exactly the one listed. Not a suffix match, not a subdomain — an
 *      entry for oauth2.googleapis.com does not admit evil.oauth2.googleapis.com.
 *
 * So the widest thing this grants is: "a connection configured for Google's real issuer, whose
 * discovery document Google itself served, may have its token endpoint on the one other origin
 * Google documents." Everything else still fails closed.
 */
const TRUSTED_CROSS_ORIGIN_ENDPOINTS: Record<string, Partial<Record<'authorization_endpoint' | 'token_endpoint' | 'jwks_uri' | 'end_session_endpoint', readonly string[]>>> = {
  'https://accounts.google.com': {
    token_endpoint: ['https://oauth2.googleapis.com'],
    jwks_uri: ['https://www.googleapis.com'],
  },
};

/**
 * A loopback host, which is the one place plain HTTP is acceptable.
 *
 * Not a convenience: an address that never leaves the machine cannot be intercepted on the wire,
 * which is the threat TLS is there for. It is also the only way the test identity provider and a
 * locally run IdP can work, and refusing them would mean the enterprise SSO flow had no way to be
 * exercised outside production.
 */
function isLoopback(hostname: string): boolean {
  return hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '::1' || hostname === '[::1]';
}

export class OidcError extends Error {}

const HTTP_TIMEOUT_MS = 5_000;
const DISCOVERY_CACHE_MS = 5 * 60 * 1000;

@Injectable()
export class OidcProvider {
  private readonly logger = new Logger(OidcProvider.name);

  /**
   * Discovery and key-set cache.
   *
   * Five minutes is short enough that a key rotation is picked up quickly and long enough that a
   * burst of sign-ins does not hammer the provider. Deliberately not longer: an identity
   * provider rotating a signing key must not break sign-in for an hour.
   */
  private readonly discoveryCache = new Map<string, { at: number; value: OidcDiscovery }>();
  private readonly jwksCache = new Map<string, { at: number; keys: JsonWebKey[] }>();

  /** Fetch (or reuse) the provider's discovery document. */
  async discover(config: OidcConnectionConfig): Promise<OidcDiscovery> {
    const cached = this.discoveryCache.get(config.discoveryUrl);
    if (cached && Date.now() - cached.at < DISCOVERY_CACHE_MS) {
      return cached.value;
    }

    const document = await this.fetchJson<OidcDiscovery>(config.discoveryUrl, 'discovery document');

    if (document.issuer !== config.issuer) {
      // The issuer is configuration, not something the document gets to declare: a compromised
      // or misconfigured discovery endpoint must not be able to change whose tokens we accept.
      throw new OidcError(
        `The discovery document declares issuer "${document.issuer}" but this connection is ` +
          `configured for "${config.issuer}".`,
      );
    }

    for (const [name, value] of [
      ['authorization_endpoint', document.authorization_endpoint],
      ['token_endpoint', document.token_endpoint],
      ['jwks_uri', document.jwks_uri],
    ] as const) {
      if (typeof value !== 'string' || value === '') {
        throw new OidcError(`The discovery document has no usable ${name}.`);
      }
    }

    /*
     * Keys and credentials go to the issuer, or to an origin that issuer publishes for that exact
     * endpoint. Without this a discovery document could point `token_endpoint` at an attacker and
     * we would post the client secret to it.
     *
     * The authorization endpoint is checked too. It only ever receives a redirect rather than a
     * secret, but an authorization endpoint on somebody else's origin is a phishing page wearing
     * the provider's flow, and there is no reason to allow one.
     */
    this.assertEndpointAllowed(config.issuer, document.authorization_endpoint, 'authorization_endpoint');
    this.assertEndpointAllowed(config.issuer, document.token_endpoint, 'token_endpoint');
    this.assertEndpointAllowed(config.issuer, document.jwks_uri, 'jwks_uri');

    this.discoveryCache.set(config.discoveryUrl, { at: Date.now(), value: document });
    return document;
  }

  /** Build the URL to send the browser to, plus the three values the callback will be checked against. */
  async beginAuthorization(
    config: OidcConnectionConfig,
    redirectUri: string,
  ): Promise<AuthorizationRequest> {
    const discovery = await this.discover(config);

    const state = randomBytes(32).toString('base64url');
    const nonce = randomBytes(32).toString('base64url');
    const codeVerifier = randomBytes(64).toString('base64url');
    const codeChallenge = createHash('sha256').update(codeVerifier).digest('base64url');

    const scopes = new Set(['openid', ...(config.scopes ?? 'profile email').split(/\s+/)]);
    scopes.delete('');

    const url = new URL(discovery.authorization_endpoint);
    url.searchParams.set('response_type', 'code');
    url.searchParams.set('client_id', config.clientId);
    url.searchParams.set('redirect_uri', redirectUri);
    url.searchParams.set('scope', [...scopes].join(' '));
    url.searchParams.set('state', state);
    url.searchParams.set('nonce', nonce);
    url.searchParams.set('code_challenge', codeChallenge);
    // S256 only. `plain` is permitted by the spec and provides no protection at all.
    url.searchParams.set('code_challenge_method', 'S256');

    return { authorizationUrl: url.toString(), state, nonce, codeVerifier };
  }

  /**
   * Exchange the authorization code and verify the resulting ID token.
   *
   * Client authentication is `client_secret_post` in the body rather than HTTP Basic. Both are
   * standard; the body form avoids the long-standing ambiguity about whether the credentials
   * should be form-urlencoded before base64 encoding, which is a real source of interop failures
   * with secrets containing punctuation.
   */
  async completeAuthorization(
    config: OidcConnectionConfig,
    input: {
      code: string;
      codeVerifier: string;
      redirectUri: string;
      /** What the ID token's nonce must be. UBoss passes the stored hash — see `NonceExpectation`. */
      nonce: NonceExpectation;
    },
  ): Promise<FederatedIdentity> {
    const discovery = await this.discover(config);

    const body = new URLSearchParams({
      grant_type: 'authorization_code',
      code: input.code,
      redirect_uri: input.redirectUri,
      client_id: config.clientId,
      client_secret: config.clientSecret,
      code_verifier: input.codeVerifier,
    });

    const response = await fetch(discovery.token_endpoint, {
      method: 'POST',
      headers: {
        'content-type': 'application/x-www-form-urlencoded',
        accept: 'application/json',
      },
      body: body.toString(),
      signal: AbortSignal.timeout(HTTP_TIMEOUT_MS),
    }).catch((cause: unknown) => {
      throw new OidcError(`Could not reach the token endpoint: ${describe(cause)}`);
    });

    if (!response.ok) {
      // The provider's error body may name the client id but never the secret; even so, only the
      // OAuth error code is surfaced, and nothing from the body is echoed to the browser.
      const detail = await response.text().catch(() => '');
      const code = extractOauthError(detail);
      this.logger.warn(
        `Token exchange failed with HTTP ${response.status}${code ? ` (${code})` : ''}.`,
      );
      throw new OidcError(
        `The identity provider refused the token exchange${code ? ` (${code})` : ''}.`,
      );
    }

    const tokens = (await response.json().catch(() => null)) as { id_token?: string } | null;
    if (!tokens?.id_token) {
      throw new OidcError('The token response contained no ID token.');
    }

    const keys = await this.jwks(discovery);

    let claims: IdTokenClaims;
    try {
      claims = verifyIdToken(tokens.id_token, {
        keys,
        issuer: config.issuer,
        audience: config.clientId,
        nonce: input.nonce,
      });
    } catch (cause) {
      if (cause instanceof JwtError) {
        // Retry once against freshly fetched keys: the overwhelmingly common cause of a
        // signature failure on a well-configured connection is a key rotation that our cache has
        // not seen yet.
        this.jwksCache.delete(discovery.jwks_uri);
        claims = verifyIdToken(tokens.id_token, {
          keys: await this.jwks(discovery),
          issuer: config.issuer,
          audience: config.clientId,
          nonce: input.nonce,
        });
      } else {
        throw cause;
      }
    }

    return {
      subject: claims.sub,
      email: typeof claims.email === 'string' ? claims.email.toLowerCase() : undefined,
      emailVerified: typeof claims.email_verified === 'boolean' ? claims.email_verified : undefined,
      displayName: displayNameFrom(claims),
      providerSessionId: typeof claims.sid === 'string' ? claims.sid : undefined,
      idToken: tokens.id_token,
      claims,
    };
  }

  /**
   * The provider's RP-initiated logout URL, when it publishes one.
   *
   * Returns `undefined` rather than throwing when the provider has no `end_session_endpoint`:
   * plenty do not, and a local sign-out must still work. The caller is responsible for saying so
   * honestly instead of implying the provider session ended.
   */
  async endSessionUrl(
    config: OidcConnectionConfig,
    input: { idTokenHint?: string | undefined; postLogoutRedirectUri?: string | undefined },
  ): Promise<string | undefined> {
    const discovery = await this.discover(config);
    if (!discovery.end_session_endpoint) {
      return undefined;
    }

    const url = new URL(discovery.end_session_endpoint);
    url.searchParams.set('client_id', config.clientId);
    if (input.idTokenHint) {
      url.searchParams.set('id_token_hint', input.idTokenHint);
    }
    if (input.postLogoutRedirectUri) {
      url.searchParams.set('post_logout_redirect_uri', input.postLogoutRedirectUri);
    }
    return url.toString();
  }

  /**
   * Verify a back-channel `logout_token`.
   *
   * Same signature and issuer checks as an ID token, with the differences the OIDC back-channel
   * logout spec requires: there is no `nonce` (there was no authorization request), the `events`
   * claim must name the logout event, and a token carrying `nonce` must be **rejected** — that
   * is how the spec stops an ID token being replayed as a logout token.
   */
  async verifyLogoutToken(
    config: OidcConnectionConfig,
    logoutToken: string,
  ): Promise<{ subject: string | undefined; providerSessionId: string | undefined }> {
    const discovery = await this.discover(config);
    const keys = await this.jwks(discovery);

    const claims = verifyIdToken(logoutToken, {
      keys,
      issuer: config.issuer,
      audience: config.clientId,
      // A logout token must carry no nonce at all — see `NonceExpectation`.
      nonce: { kind: 'absent' },
      // A logout token may identify its session by `sid` alone, with no subject. The
      // "names at least one of them" check is below, where it belongs.
      requireSubject: false,
    });

    const events = claims['events'];
    if (
      typeof events !== 'object' ||
      events === null ||
      !('http://schemas.openid.net/event/backchannel-logout' in events)
    ) {
      throw new OidcError('The logout token does not carry a back-channel logout event.');
    }

    const subject = typeof claims.sub === 'string' && claims.sub !== '' ? claims.sub : undefined;
    const providerSessionId = typeof claims.sid === 'string' ? claims.sid : undefined;

    if (subject === undefined && providerSessionId === undefined) {
      throw new OidcError('The logout token names neither a subject nor a session.');
    }

    return { subject, providerSessionId };
  }

  private async jwks(discovery: OidcDiscovery): Promise<JsonWebKey[]> {
    const cached = this.jwksCache.get(discovery.jwks_uri);
    if (cached && Date.now() - cached.at < DISCOVERY_CACHE_MS) {
      return cached.keys;
    }

    const document = await this.fetchJson<{ keys?: JsonWebKey[] }>(discovery.jwks_uri, 'key set');
    const keys = Array.isArray(document.keys) ? document.keys : [];
    if (keys.length === 0) {
      throw new OidcError('The provider published an empty key set.');
    }

    this.jwksCache.set(discovery.jwks_uri, { at: Date.now(), keys });
    return keys;
  }

  private async fetchJson<T>(url: string, what: string): Promise<T> {
    const response = await fetch(url, {
      headers: { accept: 'application/json' },
      signal: AbortSignal.timeout(HTTP_TIMEOUT_MS),
    }).catch((cause: unknown) => {
      throw new OidcError(`Could not fetch the ${what}: ${describe(cause)}`);
    });

    if (!response.ok) {
      throw new OidcError(`Fetching the ${what} returned HTTP ${response.status}.`);
    }

    const parsed = (await response.json().catch(() => null)) as T | null;
    if (parsed === null || typeof parsed !== 'object') {
      throw new OidcError(`The ${what} was not a JSON object.`);
    }
    return parsed;
  }

  /**
   * Where an endpoint from the discovery document is allowed to live.
   *
   * Two rules, in order:
   *
   *   * **Transport.** HTTPS, or a loopback address. Previously nothing here checked the scheme at
   *     all — the same-origin rule was doing that job by accident, because the issuer is
   *     configuration and a configured https issuer forced its endpoints to be https too. Once a
   *     cross-origin endpoint is permitted at all, that accident stops protecting anything, so the
   *     requirement is stated outright.
   *   * **Origin.** The issuer's own origin, or one of the specific origins that issuer documents
   *     for that specific endpoint. See TRUSTED_CROSS_ORIGIN_ENDPOINTS for why that is narrow.
   *
   * The refusal names what it refused and why, because the alternative is an operator staring at
   * "sign-in unavailable" with no way to tell a misconfiguration from an attack.
   */
  private assertEndpointAllowed(
    issuer: string,
    endpoint: string,
    name: 'authorization_endpoint' | 'token_endpoint' | 'jwks_uri' | 'end_session_endpoint',
  ): void {
    let issuerUrl: URL;
    let endpointUrl: URL;
    try {
      issuerUrl = new URL(issuer);
      endpointUrl = new URL(endpoint);
    } catch {
      throw new OidcError(`The discovery document's ${name} is not a valid URL.`);
    }

    if (endpointUrl.protocol !== 'https:' && !isLoopback(endpointUrl.hostname)) {
      throw new OidcError(
        `The discovery document's ${name} (${endpointUrl.origin}) is not HTTPS. Refusing: an ` +
          'authorization code, a client secret or a key set must not travel in clear text.',
      );
    }

    if (endpointUrl.origin === issuerUrl.origin) {
      return;
    }

    const permitted = TRUSTED_CROSS_ORIGIN_ENDPOINTS[issuerUrl.origin]?.[name] ?? [];
    if (permitted.includes(endpointUrl.origin)) {
      return;
    }

    throw new OidcError(
      `The discovery document's ${name} (${endpointUrl.origin}) is neither on the issuer's origin ` +
        `(${issuerUrl.origin}) nor an origin that issuer documents for ${name}. Refusing, so a ` +
        'discovery document cannot redirect key fetches or credentials elsewhere.',
    );
  }

  /** Clear the caches. Used when a connection's configuration changes. */
  forget(discoveryUrl: string): void {
    const discovery = this.discoveryCache.get(discoveryUrl);
    if (discovery) {
      this.jwksCache.delete(discovery.value.jwks_uri);
    }
    this.discoveryCache.delete(discoveryUrl);
  }
}

function displayNameFrom(claims: IdTokenClaims): string | undefined {
  if (typeof claims.name === 'string' && claims.name.trim() !== '') {
    return claims.name.trim();
  }
  const given = typeof claims.given_name === 'string' ? claims.given_name : '';
  const family = typeof claims.family_name === 'string' ? claims.family_name : '';
  const joined = `${given} ${family}`.trim();
  if (joined !== '') {
    return joined;
  }
  return typeof claims.preferred_username === 'string' ? claims.preferred_username : undefined;
}

/** Pull just the OAuth error code out of an error body, never the whole body. */
function extractOauthError(body: string): string | undefined {
  try {
    const parsed = JSON.parse(body) as { error?: unknown };
    return typeof parsed.error === 'string' ? parsed.error.slice(0, 60) : undefined;
  } catch {
    return undefined;
  }
}

function describe(cause: unknown): string {
  if (cause instanceof Error) {
    return cause.name === 'TimeoutError' ? 'the request timed out' : cause.message;
  }
  return 'unknown error';
}
