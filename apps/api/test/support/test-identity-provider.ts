import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { createSign, generateKeyPairSync, type KeyObject } from 'node:crypto';
import { once } from 'node:events';
import type { AddressInfo } from 'node:net';

/**
 * A real, minimal OIDC identity provider, for tests.
 *
 * ## Why this exists
 *
 * Prompt 6 asks for "at least one testable enterprise SSO path if configuration is available".
 * No real identity provider is configured for this repository, and there will not be one in CI —
 * so the honest way to make the OIDC path *testable* is to stand up a provider that genuinely
 * speaks the protocol: an RSA signing key, a discovery document, a JWKS endpoint, and a token
 * endpoint that issues a properly signed ID token.
 *
 * That is materially stronger than mocking `OidcProvider`. A mock would assert that our code
 * calls the methods we wrote; this asserts that our code completes a real authorization-code
 * exchange, verifies a real RS256 signature against a real published key set, and rejects
 * tokens that are wrong in the specific ways that matter — wrong issuer, wrong audience, wrong
 * nonce, expired, `alg: none`, unknown `kid`.
 *
 * It is deliberately *not* lenient. It records the PKCE challenge, the nonce and the redirect URI
 * from the authorization request and refuses a token exchange that does not match, because a test
 * provider that accepts anything would let a broken client pass.
 */
export interface TestIdpOptions {
  /** Subject to issue tokens for. */
  subject?: string;
  email?: string;
  name?: string;
  /** Provider session id, published as the `sid` claim. Drives back-channel logout. */
  sessionId?: string;
}

interface PendingAuthorization {
  codeChallenge: string;
  nonce: string;
  redirectUri: string;
  clientId: string;
  state: string;
}

export class TestIdentityProvider {
  private server: Server | undefined;
  private origin = '';

  readonly clientId = 'uboss-test-client';
  readonly clientSecret = 'test-client-secret-value';

  private readonly privateKey: KeyObject;
  private readonly publicJwk: Record<string, unknown>;
  private readonly keyId = 'test-key-1';

  private readonly pending = new Map<string, PendingAuthorization>();

  /** Overrides for the next issued token, so a test can produce a specifically wrong one. */
  tokenOverrides: {
    issuer?: string;
    audience?: string;
    nonce?: string | null;
    expiresInSeconds?: number;
    algorithm?: 'none';
    keyId?: string;
    omitSid?: boolean;
  } = {};

  private profile: Required<TestIdpOptions>;

  constructor(options: TestIdpOptions = {}) {
    this.profile = {
      subject: options.subject ?? 'idp-subject-1',
      email: options.email ?? 'federated@sso.example',
      name: options.name ?? 'Federated Person',
      sessionId: options.sessionId ?? 'idp-session-1',
    };

    const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
    this.privateKey = privateKey;
    this.publicJwk = {
      ...publicKey.export({ format: 'jwk' }),
      kid: this.keyId,
      alg: 'RS256',
      use: 'sig',
    };
  }

  /** Change who the provider will assert next. */
  setProfile(options: TestIdpOptions): void {
    this.profile = { ...this.profile, ...options };
  }

  get issuer(): string {
    return this.origin;
  }

  get discoveryUrl(): string {
    return `${this.origin}/.well-known/openid-configuration`;
  }

  async start(): Promise<void> {
    this.server = createServer((request, response) => {
      const url = new URL(request.url ?? '/', this.origin || 'http://127.0.0.1');

      if (url.pathname === '/.well-known/openid-configuration') {
        return this.json(response, {
          issuer: this.origin,
          authorization_endpoint: `${this.origin}/authorize`,
          token_endpoint: `${this.origin}/token`,
          jwks_uri: `${this.origin}/jwks`,
          end_session_endpoint: `${this.origin}/logout`,
          id_token_signing_alg_values_supported: ['RS256'],
          code_challenge_methods_supported: ['S256'],
        });
      }

      if (url.pathname === '/jwks') {
        return this.json(response, { keys: [this.publicJwk] });
      }

      if (url.pathname === '/token' && request.method === 'POST') {
        return void this.handleToken(request, response);
      }

      response.statusCode = 404;
      response.end();
    });

    this.server.listen(0, '127.0.0.1');
    await once(this.server, 'listening');
    const address = this.server.address() as AddressInfo;
    this.origin = `http://127.0.0.1:${address.port}`;
  }

  async stop(): Promise<void> {
    if (this.server) {
      this.server.close();
      await once(this.server, 'close');
      this.server = undefined;
    }
  }

  /**
   * Simulate the browser arriving at the provider's authorization endpoint and being redirected
   * back with a code.
   *
   * The authorization request's own parameters are recorded, so the later token exchange can be
   * checked against them exactly as a real provider would.
   */
  authorize(authorizationUrl: string): { code: string; state: string } {
    const url = new URL(authorizationUrl);

    const state = required(url.searchParams.get('state'), 'state');
    const nonce = required(url.searchParams.get('nonce'), 'nonce');
    const codeChallenge = required(url.searchParams.get('code_challenge'), 'code_challenge');
    const redirectUri = required(url.searchParams.get('redirect_uri'), 'redirect_uri');
    const clientId = required(url.searchParams.get('client_id'), 'client_id');

    if (url.searchParams.get('code_challenge_method') !== 'S256') {
      throw new Error('The client did not request S256 PKCE.');
    }
    if (url.searchParams.get('response_type') !== 'code') {
      throw new Error('The client did not request the authorization-code flow.');
    }

    const code = `code-${this.pending.size}-${Math.random().toString(36).slice(2)}`;
    this.pending.set(code, { codeChallenge, nonce, redirectUri, clientId, state });

    return { code, state };
  }

  /** Mint a back-channel logout token for the current session. */
  logoutToken(
    options: { sessionId?: string; subject?: string; omitEvents?: boolean } = {},
  ): string {
    const claims: Record<string, unknown> = {
      iss: this.origin,
      aud: this.clientId,
      iat: Math.floor(Date.now() / 1000),
      exp: Math.floor(Date.now() / 1000) + 120,
      jti: `logout-${Math.random().toString(36).slice(2)}`,
      ...(options.omitEvents === true
        ? {}
        : { events: { 'http://schemas.openid.net/event/backchannel-logout': {} } }),
    };

    if (options.subject !== undefined) {
      claims['sub'] = options.subject;
    }
    if (options.sessionId !== undefined) {
      claims['sid'] = options.sessionId;
    } else if (options.subject === undefined) {
      claims['sid'] = this.profile.sessionId;
    }

    return this.sign(claims);
  }

  /** Mint an ID token directly, for tests that need a specifically malformed one. */
  idToken(claims: Record<string, unknown>): string {
    return this.sign({
      iss: this.origin,
      aud: this.clientId,
      sub: this.profile.subject,
      iat: Math.floor(Date.now() / 1000),
      exp: Math.floor(Date.now() / 1000) + 300,
      ...claims,
    });
  }

  get jwk(): Record<string, unknown> {
    return this.publicJwk;
  }

  // -------------------------------------------------------------------------

  private async handleToken(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const chunks: Buffer[] = [];
    for await (const chunk of request) {
      chunks.push(chunk as Buffer);
    }
    const body = new URLSearchParams(Buffer.concat(chunks).toString('utf8'));

    const code = body.get('code') ?? '';
    const authorization = this.pending.get(code);

    if (!authorization) {
      response.statusCode = 400;
      return this.json(response, { error: 'invalid_grant' });
    }
    // Single use, exactly like a real provider: a replayed code must fail.
    this.pending.delete(code);

    if (
      body.get('client_id') !== this.clientId ||
      body.get('client_secret') !== this.clientSecret
    ) {
      response.statusCode = 401;
      return this.json(response, { error: 'invalid_client' });
    }
    if (body.get('redirect_uri') !== authorization.redirectUri) {
      response.statusCode = 400;
      return this.json(response, { error: 'invalid_grant' });
    }

    // PKCE: S256(verifier) must equal the challenge sent in the authorization request.
    const verifier = body.get('code_verifier') ?? '';
    const { createHash } = await import('node:crypto');
    const computed = createHash('sha256').update(verifier).digest('base64url');
    if (computed !== authorization.codeChallenge) {
      response.statusCode = 400;
      return this.json(response, { error: 'invalid_grant' });
    }

    const now = Math.floor(Date.now() / 1000);
    const overrides = this.tokenOverrides;

    const claims: Record<string, unknown> = {
      iss: overrides.issuer ?? this.origin,
      aud: overrides.audience ?? this.clientId,
      sub: this.profile.subject,
      email: this.profile.email,
      email_verified: true,
      name: this.profile.name,
      iat: now,
      exp: now + (overrides.expiresInSeconds ?? 300),
    };

    if (overrides.nonce !== null) {
      claims['nonce'] = overrides.nonce ?? authorization.nonce;
    }
    if (overrides.omitSid !== true) {
      claims['sid'] = this.profile.sessionId;
    }

    const idToken =
      overrides.algorithm === 'none'
        ? unsignedToken(claims)
        : this.sign(claims, overrides.keyId ?? this.keyId);

    return this.json(response, {
      access_token: 'test-access-token',
      token_type: 'Bearer',
      expires_in: 300,
      id_token: idToken,
    });
  }

  private sign(claims: Record<string, unknown>, keyId = this.keyId): string {
    const header = { alg: 'RS256', typ: 'JWT', kid: keyId };
    const signingInput = `${base64url(header)}.${base64url(claims)}`;

    const signer = createSign('RSA-SHA256');
    signer.update(signingInput, 'utf8');
    const signature = signer.sign(this.privateKey).toString('base64url');

    return `${signingInput}.${signature}`;
  }

  private json(response: ServerResponse, body: unknown): void {
    response.statusCode = response.statusCode === 200 ? 200 : response.statusCode;
    response.setHeader('content-type', 'application/json');
    response.end(JSON.stringify(body));
  }
}

function base64url(value: unknown): string {
  return Buffer.from(JSON.stringify(value), 'utf8').toString('base64url');
}

/** An `alg: none` token — the classic JWT bypass, which must be refused. */
function unsignedToken(claims: Record<string, unknown>): string {
  return `${base64url({ alg: 'none', typ: 'JWT' })}.${base64url(claims)}.`;
}

function required(value: string | null, name: string): string {
  if (value === null || value === '') {
    throw new Error(`The authorization request had no ${name}.`);
  }
  return value;
}
