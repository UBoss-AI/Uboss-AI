import { createPublicKey, createVerify, constants as cryptoConstants } from 'node:crypto';

import { hashToken, tokensMatch } from '../one-time-token.js';

/**
 * Verification of a signed JWT (an OIDC ID token) against a JWKS.
 *
 * ## Why this is hand-rolled
 *
 * Same reasoning as `totp.ts`, plus a stronger one: JWT verification is where JWT libraries have
 * historically gone wrong, in ways that are catastrophic and quiet. The classic failures are
 * accepting `alg: none`, letting the token's own `alg` header choose the key type (so an
 * RSA public key gets used as an HMAC secret), and skipping `iss`/`aud` because the caller has
 * to opt in. All three are impossible to introduce here: the algorithm allow-list is a constant,
 * the key type is derived from the JWKS entry and not from the token, and every claim check
 * below is mandatory rather than optional.
 *
 * ## Algorithms
 *
 * Asymmetric only: RSA (PKCS#1 v1.5 and PSS) and ECDSA. HMAC (`HS256` and friends) is
 * deliberately **refused**, even though OIDC permits it. With HMAC the verification key is the
 * client secret, which means any party holding the client secret — including our own database if
 * it leaked — can mint valid ID tokens. Asymmetric signing keeps that power with the identity
 * provider alone, which is the entire point of federation.
 */

export class JwtError extends Error {}

export interface JsonWebKey {
  kty: string;
  kid?: string;
  alg?: string;
  use?: string;
  n?: string;
  e?: string;
  crv?: string;
  x?: string;
  y?: string;
}

/**
 * Permitted algorithms, mapped to how Node must verify them.
 *
 * `dsaEncoding: 'ieee-p1363'` is essential for ECDSA: JWS carries the raw `r || s` pair, while
 * Node defaults to DER. Without it, every ES256 token fails verification for a reason that looks
 * like a bad signature.
 */
const ALGORITHMS: Record<
  string,
  {
    hash: string;
    keyType: string;
    padding?: number;
    saltLength?: number;
    dsaEncoding?: 'ieee-p1363';
  }
> = {
  RS256: { hash: 'RSA-SHA256', keyType: 'RSA' },
  RS384: { hash: 'RSA-SHA384', keyType: 'RSA' },
  RS512: { hash: 'RSA-SHA512', keyType: 'RSA' },
  PS256: {
    hash: 'RSA-SHA256',
    keyType: 'RSA',
    padding: cryptoConstants.RSA_PKCS1_PSS_PADDING,
    saltLength: cryptoConstants.RSA_PSS_SALTLEN_DIGEST,
  },
  PS384: {
    hash: 'RSA-SHA384',
    keyType: 'RSA',
    padding: cryptoConstants.RSA_PKCS1_PSS_PADDING,
    saltLength: cryptoConstants.RSA_PSS_SALTLEN_DIGEST,
  },
  PS512: {
    hash: 'RSA-SHA512',
    keyType: 'RSA',
    padding: cryptoConstants.RSA_PKCS1_PSS_PADDING,
    saltLength: cryptoConstants.RSA_PSS_SALTLEN_DIGEST,
  },
  ES256: { hash: 'SHA256', keyType: 'EC', dsaEncoding: 'ieee-p1363' },
  ES384: { hash: 'SHA384', keyType: 'EC', dsaEncoding: 'ieee-p1363' },
  ES512: { hash: 'SHA512', keyType: 'EC', dsaEncoding: 'ieee-p1363' },
};

export interface JwtHeader {
  alg: string;
  kid?: string;
  typ?: string;
}

export interface IdTokenClaims {
  iss: string;
  sub: string;
  aud: string | string[];
  exp: number;
  iat: number;
  nonce?: string;
  /** The identity provider's session identifier. What makes back-channel logout addressable. */
  sid?: string;
  azp?: string;
  email?: string;
  email_verified?: boolean;
  name?: string;
  preferred_username?: string;
  given_name?: string;
  family_name?: string;
  [claim: string]: unknown;
}

function decodeSegment(segment: string): unknown {
  try {
    return JSON.parse(Buffer.from(segment, 'base64url').toString('utf8'));
  } catch {
    throw new JwtError('Token segment is not valid base64url JSON.');
  }
}

/** Read the header without verifying anything, so the right key can be selected. */
export function decodeJwtHeader(token: string): JwtHeader {
  const parts = token.split('.');
  if (parts.length !== 3) {
    throw new JwtError('A JWS compact token must have exactly three segments.');
  }

  const header = decodeSegment(parts[0] as string) as JwtHeader;
  if (typeof header?.alg !== 'string') {
    throw new JwtError('Token header has no algorithm.');
  }
  return header;
}

/** Read the payload without verifying. Only for diagnostics; never for a decision. */
export function decodeJwtPayloadUnsafe(token: string): Record<string, unknown> {
  const parts = token.split('.');
  if (parts.length !== 3) {
    throw new JwtError('A JWS compact token must have exactly three segments.');
  }
  return decodeSegment(parts[1] as string) as Record<string, unknown>;
}

/**
 * What the `nonce` claim must be.
 *
 * Three genuinely different cases, modelled as data so none of them can be reached by accident:
 *
 *   * `value` — the plaintext nonce, when the caller still holds it.
 *   * `hash` — the SHA-256 of the nonce. UBoss stores only the hash of an in-flight
 *     authorization request's nonce (it travels in a URL, so it reaches logs and browser
 *     history), and this lets verification happen without ever persisting the plaintext.
 *   * `absent` — the token must carry **no** nonce. Required for a back-channel logout token:
 *     the OIDC spec forbids a nonce there precisely so an ID token cannot be replayed as one.
 *
 * There is no "skip the check" case, which is the point.
 */
export type NonceExpectation =
  { kind: 'value'; value: string } | { kind: 'hash'; sha256Hex: string } | { kind: 'absent' };

export interface VerifyIdTokenOptions {
  /** Keys from the provider's JWKS. */
  keys: JsonWebKey[];
  /** Must equal the `iss` claim exactly. */
  issuer: string;
  /** Must appear in `aud`. */
  audience: string;
  /** What the `nonce` claim must be. Mandatory — see `NonceExpectation`. */
  nonce: NonceExpectation;
  /**
   * Whether a `sub` claim is required.
   *
   * True for an ID token — a token that authenticates nobody in particular is meaningless. False
   * for a back-channel logout token, where the OIDC spec allows the session to be identified by
   * `sid` alone; `verifyLogoutToken` then enforces "at least one of sub or sid" itself, because
   * a token naming neither would be equally meaningless.
   */
  requireSubject?: boolean;
  /** Clock skew allowance, seconds. */
  leewaySeconds?: number;
  now?: number;
}

/**
 * Verify an ID token's signature and every claim that matters.
 *
 * Order is deliberate: the signature is checked **before** any claim is trusted, so a forged
 * token never reaches the claim logic.
 */
export function verifyIdToken(token: string, options: VerifyIdTokenOptions): IdTokenClaims {
  const parts = token.split('.');
  if (parts.length !== 3) {
    throw new JwtError('A JWS compact token must have exactly three segments.');
  }
  const [headerPart, payloadPart, signaturePart] = parts as [string, string, string];

  const header = decodeJwtHeader(token);
  const spec = ALGORITHMS[header.alg];
  if (!spec) {
    // Covers `none` and every HMAC variant with one message, because the answer is the same:
    // this token cannot be verified in a way we are willing to rely on.
    throw new JwtError(
      `Algorithm "${header.alg}" is not accepted. UBoss verifies ID tokens with asymmetric ` +
        'signatures only (RS/PS/ES); "none" and HMAC are refused.',
    );
  }

  // Candidate keys: the matching `kid` when the token names one, otherwise every key of the
  // right type. Filtering by key type here — from the JWKS, not from the token — is what stops
  // an algorithm-confusion attack.
  const candidates = options.keys.filter((key) => {
    if (key.kty !== spec.keyType) {
      return false;
    }
    if (header.kid !== undefined && key.kid !== undefined) {
      return key.kid === header.kid;
    }
    return true;
  });

  if (candidates.length === 0) {
    throw new JwtError(
      header.kid === undefined
        ? `The provider's key set has no ${spec.keyType} key to verify this token.`
        : `The provider's key set has no ${spec.keyType} key with id "${header.kid}".`,
    );
  }

  const signingInput = `${headerPart}.${payloadPart}`;
  const signature = Buffer.from(signaturePart, 'base64url');

  const verified = candidates.some((jwk) => {
    let publicKey;
    try {
      publicKey = createPublicKey({ key: jwk as never, format: 'jwk' });
    } catch {
      // A malformed entry in the key set is skipped, not fatal: providers publish several keys
      // and one unusable entry must not break verification against the others.
      return false;
    }

    const verifier = createVerify(spec.hash);
    verifier.update(signingInput, 'utf8');

    return verifier.verify(
      {
        key: publicKey,
        ...(spec.padding === undefined ? {} : { padding: spec.padding }),
        ...(spec.saltLength === undefined ? {} : { saltLength: spec.saltLength }),
        ...(spec.dsaEncoding === undefined ? {} : { dsaEncoding: spec.dsaEncoding }),
      },
      signature,
    );
  });

  if (!verified) {
    throw new JwtError('The ID token signature did not verify against the provider key set.');
  }

  // ---- Only now are the claims worth reading. ----

  const claims = decodeSegment(payloadPart) as IdTokenClaims;
  const leeway = options.leewaySeconds ?? 60;
  const now = Math.floor((options.now ?? Date.now()) / 1000);

  if (claims.iss !== options.issuer) {
    throw new JwtError(
      `ID token issuer "${claims.iss}" does not match the configured issuer "${options.issuer}".`,
    );
  }

  const audiences = Array.isArray(claims.aud) ? claims.aud : [claims.aud];
  if (!audiences.includes(options.audience)) {
    throw new JwtError('ID token audience does not include this client.');
  }

  // With several audiences, OIDC requires `azp` to name the intended party. Checking it stops a
  // token minted for a different client at the same provider being replayed at us.
  if (audiences.length > 1 && claims.azp !== options.audience) {
    throw new JwtError('ID token has multiple audiences and azp does not name this client.');
  }
  if (claims.azp !== undefined && claims.azp !== options.audience) {
    throw new JwtError('ID token azp names a different client.');
  }

  if (typeof claims.exp !== 'number' || claims.exp + leeway < now) {
    throw new JwtError('ID token has expired.');
  }
  if (typeof claims.iat !== 'number' || claims.iat - leeway > now) {
    throw new JwtError('ID token was issued in the future.');
  }
  if ((options.requireSubject ?? true) && (typeof claims.sub !== 'string' || claims.sub === '')) {
    throw new JwtError('ID token has no subject.');
  }

  // The nonce is what ties this token to the authorization request *we* started. Without it, a
  // token obtained elsewhere could be injected into someone else's callback.
  assertNonce(claims.nonce, options.nonce);

  return claims;
}

function assertNonce(presented: string | undefined, expectation: NonceExpectation): void {
  if (expectation.kind === 'absent') {
    if (presented !== undefined) {
      throw new JwtError(
        'This token must not carry a nonce. A nonce here means an ID token is being presented ' +
          'where a back-channel logout token is expected.',
      );
    }
    return;
  }

  if (typeof presented !== 'string' || presented === '') {
    throw new JwtError('ID token carries no nonce, so it cannot be bound to a sign-in request.');
  }

  const matches =
    expectation.kind === 'value'
      ? tokensMatch(hashToken(expectation.value), hashToken(presented))
      : tokensMatch(expectation.sha256Hex, hashToken(presented));

  if (!matches) {
    throw new JwtError('ID token nonce does not match the authorization request.');
  }
}
