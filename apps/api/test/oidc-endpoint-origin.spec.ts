import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import { after, before, describe, it } from 'node:test';

import { OidcError, OidcProvider } from '../src/auth/sso/oidc.provider.js';

/*
 * Where a discovery document is allowed to put its endpoints.
 *
 * The rule used to be "the issuer's own origin, always", which is stricter than OpenID Connect
 * Discovery and which Google's published metadata does not satisfy — Google serves its token
 * endpoint from oauth2.googleapis.com and its keys from www.googleapis.com. The rule is now "the
 * issuer's origin, or one of the specific origins that issuer documents for that specific
 * endpoint".
 *
 * This file exists to hold the second half of that sentence. The relaxation is worth exactly
 * nothing if an arbitrary origin also gets through, so most of what follows is an attempt to get
 * something hostile accepted.
 *
 * Each case serves a discovery document from a local server and configures the connection with an
 * issuer of our choosing, which is how a real attack would look: the document is whatever the
 * attacker wants, and the issuer is the one thing they do not control.
 */

/** A discovery document served over loopback, saying whatever the test needs it to say. */
class FakeDiscovery {
  private server: Server | undefined;
  private body: Record<string, unknown> = {};
  private port = 0;

  async start(): Promise<void> {
    this.server = createServer((request, response) => {
      if (request.url?.includes('openid-configuration')) {
        response.writeHead(200, { 'content-type': 'application/json' });
        response.end(JSON.stringify(this.body));
        return;
      }
      // A key set, so a document that passes validation can go on to fetch keys.
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ keys: [{ kty: 'RSA', n: 'x', e: 'AQAB', kid: 'k' }] }));
    });

    await new Promise<void>((resolve) => {
      this.server!.listen(0, '127.0.0.1', () => {
        this.port = (this.server!.address() as { port: number }).port;
        resolve();
      });
    });
  }

  async stop(): Promise<void> {
    await new Promise<void>((resolve) => this.server?.close(() => resolve()));
  }

  get origin(): string {
    return `http://127.0.0.1:${this.port}`;
  }

  get discoveryUrl(): string {
    return `${this.origin}/.well-known/openid-configuration`;
  }

  /** What the document will claim next. */
  serve(body: Record<string, unknown>): void {
    this.body = body;
  }
}

const idp = new FakeDiscovery();
let provider: OidcProvider;

/** A provider with its caches empty, because a cached document would hide the next answer. */
const fresh = (): OidcProvider => new OidcProvider();

before(async () => {
  await idp.start();
  provider = fresh();
});

after(async () => {
  await idp.stop();
});

const config = (issuer: string) => ({
  issuer,
  discoveryUrl: idp.discoveryUrl,
  clientId: 'test-client',
  clientSecret: 'test-secret',
  // A space-separated string on this interface, not an array.
  scopes: 'openid email',
});

describe('a discovery document may not put endpoints wherever it likes', () => {
  it('accepts endpoints on the issuer’s own origin', async () => {
    idp.serve({
      issuer: idp.origin,
      authorization_endpoint: `${idp.origin}/authorize`,
      token_endpoint: `${idp.origin}/token`,
      jwks_uri: `${idp.origin}/keys`,
    });

    const discovery = await fresh().discover(config(idp.origin));
    assert.equal(discovery.token_endpoint, `${idp.origin}/token`);
  });

  /*
   * The case the whole exception exists for. The issuer is Google's real one, the endpoints are
   * the ones Google actually publishes, and nothing else about the document matters.
   */
  it('accepts Google’s documented cross-origin token endpoint and key set', async () => {
    idp.serve({
      issuer: 'https://accounts.google.com',
      authorization_endpoint: 'https://accounts.google.com/o/oauth2/v2/auth',
      token_endpoint: 'https://oauth2.googleapis.com/token',
      jwks_uri: 'https://www.googleapis.com/oauth2/v3/certs',
    });

    const discovery = await fresh().discover(config('https://accounts.google.com'));
    assert.equal(discovery.token_endpoint, 'https://oauth2.googleapis.com/token');
    assert.equal(discovery.jwks_uri, 'https://www.googleapis.com/oauth2/v3/certs');
  });

  it('refuses an arbitrary cross-origin token endpoint', async () => {
    idp.serve({
      issuer: idp.origin,
      authorization_endpoint: `${idp.origin}/authorize`,
      // Where the client secret would be posted.
      token_endpoint: 'https://collector.evil.example/token',
      jwks_uri: `${idp.origin}/keys`,
    });

    await assert.rejects(
      () => fresh().discover(config(idp.origin)),
      (error: unknown) =>
        error instanceof OidcError && /neither on the issuer's origin/.test(error.message),
    );
  });

  /*
   * The attack the exception invites, stated plainly: claim to be Google in order to reach the
   * origins Google is allowed. It fails on the issuer check, before the table is ever consulted.
   */
  it('refuses a document that nominates itself as Google to borrow Google’s origins', async () => {
    idp.serve({
      issuer: 'https://accounts.google.com',
      authorization_endpoint: 'https://accounts.google.com/o/oauth2/v2/auth',
      token_endpoint: 'https://oauth2.googleapis.com/token',
      jwks_uri: 'https://www.googleapis.com/oauth2/v3/certs',
    });

    // This connection is configured for its own issuer, not for Google's.
    await assert.rejects(
      () => fresh().discover(config(idp.origin)),
      (error: unknown) => error instanceof OidcError && /declares issuer/.test(error.message),
    );
  });

  it('refuses an origin that merely looks like a permitted one', async () => {
    idp.serve({
      issuer: 'https://accounts.google.com',
      authorization_endpoint: 'https://accounts.google.com/o/oauth2/v2/auth',
      // A subdomain of the permitted origin, which is a different origin and a different owner.
      token_endpoint: 'https://evil.oauth2.googleapis.com/token',
      jwks_uri: 'https://www.googleapis.com/oauth2/v3/certs',
    });

    await assert.rejects(
      () => fresh().discover(config('https://accounts.google.com')),
      (error: unknown) =>
        error instanceof OidcError && /neither on the issuer's origin/.test(error.message),
    );
  });

  it('refuses a permitted origin used for the wrong endpoint', async () => {
    idp.serve({
      issuer: 'https://accounts.google.com',
      // Google's token origin is allowed for the token endpoint only. An authorization endpoint
      // there would be a sign-in page on an origin Google does not serve one from.
      authorization_endpoint: 'https://oauth2.googleapis.com/o/oauth2/v2/auth',
      token_endpoint: 'https://oauth2.googleapis.com/token',
      jwks_uri: 'https://www.googleapis.com/oauth2/v3/certs',
    });

    await assert.rejects(
      () => fresh().discover(config('https://accounts.google.com')),
      (error: unknown) =>
        error instanceof OidcError && /authorization_endpoint/.test(error.message),
    );
  });

  it('refuses Google’s key origin being used as Google’s token endpoint', async () => {
    idp.serve({
      issuer: 'https://accounts.google.com',
      authorization_endpoint: 'https://accounts.google.com/o/oauth2/v2/auth',
      // Both origins are in the table, but each is listed for one endpoint only.
      token_endpoint: 'https://www.googleapis.com/token',
      jwks_uri: 'https://www.googleapis.com/oauth2/v3/certs',
    });

    await assert.rejects(
      () => fresh().discover(config('https://accounts.google.com')),
      (error: unknown) => error instanceof OidcError && /token_endpoint/.test(error.message),
    );
  });

  /*
   * Transport. Nothing checked the scheme before, because the same-origin rule was doing it by
   * accident: a configured https issuer forced its endpoints to be https as well. Permitting a
   * cross-origin endpoint removes that accident, so the requirement is now stated.
   */
  it('refuses a plain-HTTP endpoint on a public host', async () => {
    idp.serve({
      issuer: 'https://accounts.google.com',
      authorization_endpoint: 'https://accounts.google.com/o/oauth2/v2/auth',
      token_endpoint: 'http://oauth2.googleapis.com/token',
      jwks_uri: 'https://www.googleapis.com/oauth2/v3/certs',
    });

    await assert.rejects(
      () => fresh().discover(config('https://accounts.google.com')),
      (error: unknown) => error instanceof OidcError && /is not HTTPS/.test(error.message),
    );
  });

  it('still allows plain HTTP on loopback, so a local provider can be used', async () => {
    // Not a convenience: an address that never leaves the machine cannot be intercepted, and
    // refusing it would leave the enterprise flow with no way to be exercised outside production.
    idp.serve({
      issuer: idp.origin,
      authorization_endpoint: `${idp.origin}/authorize`,
      token_endpoint: `${idp.origin}/token`,
      jwks_uri: `${idp.origin}/keys`,
    });

    const discovery = await fresh().discover(config(idp.origin));
    assert.ok(discovery.token_endpoint.startsWith('http://127.0.0.1'));
  });

  it('refuses a document missing an endpoint rather than defaulting one', async () => {
    idp.serve({
      issuer: idp.origin,
      authorization_endpoint: `${idp.origin}/authorize`,
      jwks_uri: `${idp.origin}/keys`,
    });

    await assert.rejects(
      () => fresh().discover(config(idp.origin)),
      (error: unknown) => error instanceof OidcError && /no usable token_endpoint/.test(error.message),
    );
  });
});
