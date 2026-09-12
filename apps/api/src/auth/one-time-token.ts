import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';

/**
 * One-time tokens for invitations, password resets and sessions.
 *
 * ## Why SHA-256 and not Argon2
 *
 * These tokens are 32 bytes of cryptographically random data — 256 bits of entropy. There is
 * nothing to brute-force, so a deliberately slow KDF buys nothing and would add latency to every
 * authenticated request (a session lookup happens on each one). A slow KDF is for *low-entropy*
 * secrets that humans choose, which is why passwords use Argon2id instead.
 *
 * What the hash does buy: a database reader — a leaked backup, an over-permissioned analyst, a
 * SQL-injection read — cannot turn stored rows into a working invitation link or a live session.
 */

const TOKEN_BYTES = 32;

export interface OneTimeToken {
  /** Give this to the recipient once. It is never stored or logged. */
  plaintext: string;
  /** Store this. */
  hash: string;
}

/** Generate a token and its hash. The plaintext exists only in the returned object. */
export function createOneTimeToken(): OneTimeToken {
  // base64url: URL-safe, so it can go straight into an activation link with no escaping.
  const plaintext = randomBytes(TOKEN_BYTES).toString('base64url');
  return { plaintext, hash: hashToken(plaintext) };
}

export function hashToken(plaintext: string): string {
  return createHash('sha256').update(plaintext, 'utf8').digest('hex');
}

/**
 * Compare two hex digests in constant time.
 *
 * Lookups in this codebase are by indexed hash equality in SQL, so this is used where a
 * comparison happens in application code — keeping it timing-safe by default means a future
 * caller cannot accidentally introduce a timing oracle.
 */
export function tokensMatch(expectedHash: string, candidateHash: string): boolean {
  const expected = Buffer.from(expectedHash, 'hex');
  const candidate = Buffer.from(candidateHash, 'hex');
  if (expected.length !== candidate.length || expected.length === 0) {
    return false;
  }
  return timingSafeEqual(expected, candidate);
}

/**
 * Reduce a client address to a coarse hint for the security trail.
 *
 * A full IP address is personal data with a real retention cost, and the security question here
 * is only "is this a different place than usual". IPv4 keeps the first two octets, IPv6 the
 * first three groups.
 */
export function clientHintFrom(address: string | undefined): string | undefined {
  if (!address) {
    return undefined;
  }
  const trimmed = address.trim();
  if (trimmed === '') {
    return undefined;
  }

  if (trimmed.includes(':') && !trimmed.includes('.')) {
    const groups = trimmed.split(':').filter((group) => group !== '');
    return groups.length > 0 ? `${groups.slice(0, 3).join(':')}::/48` : undefined;
  }

  const octets = trimmed.replace(/^::ffff:/, '').split('.');
  if (octets.length === 4) {
    return `${octets[0]}.${octets[1]}.0.0/16`;
  }

  return trimmed.slice(0, 64);
}

/**
 * Coarse device label from a User-Agent, for the Active Sessions list.
 *
 * Deliberately not the raw header: the list needs to be recognisable to the person reading it
 * ("Chrome on Windows"), not a fingerprint.
 */
export function deviceLabelFrom(userAgent: string | undefined): string | undefined {
  if (!userAgent) {
    return undefined;
  }

  const platform = /Windows/i.test(userAgent)
    ? 'Windows'
    : /Macintosh|Mac OS X/i.test(userAgent)
      ? 'macOS'
      : /Android/i.test(userAgent)
        ? 'Android'
        : /iPhone|iPad|iOS/i.test(userAgent)
          ? 'iOS'
          : /Linux/i.test(userAgent)
            ? 'Linux'
            : 'Unknown platform';

  const browser = /Edg\//i.test(userAgent)
    ? 'Edge'
    : /OPR\//i.test(userAgent)
      ? 'Opera'
      : /Chrome\//i.test(userAgent)
        ? 'Chrome'
        : /Firefox\//i.test(userAgent)
          ? 'Firefox'
          : /Safari\//i.test(userAgent)
            ? 'Safari'
            : /curl|node|supertest/i.test(userAgent)
              ? 'API client'
              : 'Unknown browser';

  return `${browser} on ${platform}`.slice(0, 120);
}
