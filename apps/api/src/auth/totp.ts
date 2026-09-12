import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

/**
 * Time-based one-time passwords — RFC 6238, built on HOTP (RFC 4226).
 *
 * ## Why this is implemented here rather than taken from a package
 *
 * TOTP is a short, completely specified algorithm: HMAC the counter, take four bytes at a
 * dynamic offset, reduce modulo 10^digits. Both RFCs publish test vectors, so a from-scratch
 * implementation can be *proved* correct rather than trusted — which is not true of most
 * dependencies. Set against that, an authentication dependency is a supply-chain path straight
 * into the sign-in flow, and the popular options in this space have historically had awkward
 * ESM/CJS interop that this repo (ESM-only NestJS, ADR-006) would have had to work around.
 *
 * The unit tests run every published vector from RFC 4226 Appendix D and RFC 6238 Appendix B,
 * for SHA-1 and SHA-256. If any of them fails, this file is wrong.
 *
 * ## Algorithm choice
 *
 * SHA-1 is the default, and that is deliberate rather than lazy: HMAC-SHA-1 is not affected by
 * SHA-1's collision weaknesses, and every mainstream authenticator app ignores the `algorithm`
 * parameter in an `otpauth://` URI. Offering SHA-256 by default would produce codes that appear
 * to enrol and then never match. The parameter exists so a company that mandates SHA-256 and
 * controls its authenticator can have it.
 */

export type TotpAlgorithm = 'SHA1' | 'SHA256' | 'SHA512';

export interface TotpOptions {
  /** Seconds per step. 30 is the near-universal default and what apps assume. */
  period?: number;
  digits?: number;
  algorithm?: TotpAlgorithm;
}

export interface TotpVerifyOptions extends TotpOptions {
  /**
   * How many steps either side of now to accept, for clock drift between the phone and the
   * server. 1 means "the previous, current and next code", i.e. a 90-second window at the
   * default period.
   */
  window?: number;
  /**
   * Reject any code whose step is not strictly greater than this. Replay protection: a code
   * observed once (shoulder-surfed, keylogged, read from a proxy log) cannot be used again even
   * while it is still inside its own validity window.
   */
  afterCounter?: number | undefined;
  /** Injectable clock, in milliseconds. */
  now?: number;
}

export const TOTP_DEFAULTS = { period: 30, digits: 6, algorithm: 'SHA1' as TotpAlgorithm };

const HMAC_ALGORITHMS: Record<TotpAlgorithm, string> = {
  SHA1: 'sha1',
  SHA256: 'sha256',
  SHA512: 'sha512',
};

// ---------------------------------------------------------------------------
// Base32 (RFC 4648) — the encoding every authenticator app expects for a secret.
// ---------------------------------------------------------------------------

const BASE32_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

export function base32Encode(data: Buffer): string {
  let bits = 0;
  let value = 0;
  let out = '';

  for (const byte of data) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += BASE32_ALPHABET[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }

  if (bits > 0) {
    out += BASE32_ALPHABET[(value << (5 - bits)) & 31];
  }

  // Padding to a multiple of 8 characters. Optional for authenticator apps, but RFC 4648
  // specifies it and some enterprise provisioning tools validate against the spec.
  while (out.length % 8 !== 0) {
    out += '=';
  }

  return out;
}

export function base32Decode(encoded: string): Buffer {
  // Tolerant of what humans actually paste: lower case, spaces, and missing padding.
  const cleaned = encoded.replace(/[\s=]/g, '').toUpperCase();
  if (cleaned === '') {
    throw new Error('Base32 value is empty.');
  }

  let bits = 0;
  let value = 0;
  const out: number[] = [];

  for (const character of cleaned) {
    const index = BASE32_ALPHABET.indexOf(character);
    if (index === -1) {
      throw new Error(`"${character}" is not a valid base32 character.`);
    }
    value = (value << 5) | index;
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 0xff);
      bits -= 8;
    }
  }

  return Buffer.from(out);
}

// ---------------------------------------------------------------------------
// HOTP / TOTP
// ---------------------------------------------------------------------------

/**
 * Generate a shared secret.
 *
 * 20 bytes (160 bits) matches the HMAC-SHA-1 block behaviour and the RFC 4226 recommendation,
 * and is what authenticator apps are used to. Longer secrets are silently truncated by some
 * apps, which would produce codes that never verify.
 */
export function generateTotpSecret(bytes = 20): string {
  return base32Encode(randomBytes(bytes));
}

/** HOTP (RFC 4226) for an explicit counter. Exported so the RFC vectors can be tested directly. */
export function hotp(
  secret: Buffer,
  counter: number,
  options: { digits?: number; algorithm?: TotpAlgorithm } = {},
): string {
  const digits = options.digits ?? TOTP_DEFAULTS.digits;
  const algorithm = options.algorithm ?? TOTP_DEFAULTS.algorithm;

  // The counter is an 8-byte big-endian integer. BigInt rather than two 32-bit halves so the
  // RFC 6238 vector at T = 20000000000 (which exceeds 2^32 steps) is handled correctly.
  const counterBytes = Buffer.alloc(8);
  counterBytes.writeBigUInt64BE(BigInt(counter));

  const digest = createHmac(HMAC_ALGORITHMS[algorithm], secret).update(counterBytes).digest();

  // Dynamic truncation: the low nibble of the last byte selects the offset.
  const offset = (digest[digest.length - 1] as number) & 0x0f;
  const binary =
    (((digest[offset] as number) & 0x7f) << 24) |
    (((digest[offset + 1] as number) & 0xff) << 16) |
    (((digest[offset + 2] as number) & 0xff) << 8) |
    ((digest[offset + 3] as number) & 0xff);

  return String(binary % 10 ** digits).padStart(digits, '0');
}

/** Which time step a moment falls in. */
export function totpCounter(nowMs: number, period = TOTP_DEFAULTS.period): number {
  return Math.floor(nowMs / 1000 / period);
}

/** The code for a moment. Used by tests and by the enrolment preview, never to check input. */
export function totpCode(
  secretBase32: string,
  options: TotpOptions & { now?: number } = {},
): string {
  const period = options.period ?? TOTP_DEFAULTS.period;
  const now = options.now ?? Date.now();
  return hotp(base32Decode(secretBase32), totpCounter(now, period), options);
}

export type TotpVerification =
  | { valid: true; counter: number }
  | { valid: false; reason: 'malformed' | 'no-match' | 'replayed' };

/**
 * Check a presented code.
 *
 * Returns which step matched, so the caller can persist it and refuse anything at or below it
 * next time. Comparison is constant-time; a code is a secret for its lifetime, and a length- or
 * content-dependent comparison would leak how much of a guess was right.
 */
export function verifyTotp(
  secretBase32: string,
  presented: string,
  options: TotpVerifyOptions = {},
): TotpVerification {
  const digits = options.digits ?? TOTP_DEFAULTS.digits;
  const period = options.period ?? TOTP_DEFAULTS.period;
  const window = options.window ?? 1;
  const now = options.now ?? Date.now();

  // Humans and password managers insert spaces; authenticator apps show "123 456".
  const candidate = presented.replace(/[\s-]/g, '');
  if (!new RegExp(`^\\d{${digits}}$`).test(candidate)) {
    return { valid: false, reason: 'malformed' };
  }

  const secret = base32Decode(secretBase32);
  const current = totpCounter(now, period);

  // Oldest first, so the *earliest* acceptable step wins and `afterCounter` advances by the
  // smallest amount that is still safe. Advancing to the newest match would silently invalidate
  // codes the user's app is about to show.
  let matched: number | undefined;
  for (let offset = -window; offset <= window; offset += 1) {
    const counter = current + offset;
    if (counter < 0) {
      continue;
    }
    if (constantTimeEquals(hotp(secret, counter, { digits, ...options }), candidate)) {
      matched = counter;
      break;
    }
  }

  if (matched === undefined) {
    return { valid: false, reason: 'no-match' };
  }

  if (options.afterCounter !== undefined && matched <= options.afterCounter) {
    // The code is arithmetically correct but has already been spent. Reported distinctly from
    // "wrong code" so the audit trail can show a replay attempt for what it is; the *user* sees
    // one message either way.
    return { valid: false, reason: 'replayed' };
  }

  return { valid: true, counter: matched };
}

function constantTimeEquals(a: string, b: string): boolean {
  const left = Buffer.from(a, 'utf8');
  const right = Buffer.from(b, 'utf8');
  if (left.length !== right.length || left.length === 0) {
    return false;
  }
  return timingSafeEqual(left, right);
}

/**
 * The `otpauth://` URI an authenticator app scans.
 *
 * The label is `issuer:account`, and `issuer` is repeated as a parameter — both are required by
 * the de-facto Key Uri Format, and apps that only read one of them get the right answer either
 * way.
 *
 * This string **contains the shared secret**. It is returned exactly once, during enrolment,
 * over the authenticated session that requested it, and is never logged or persisted.
 */
export function otpauthUri(input: {
  secretBase32: string;
  accountName: string;
  issuer?: string;
  options?: TotpOptions;
}): string {
  const issuer = input.issuer ?? 'UBoss';
  const period = input.options?.period ?? TOTP_DEFAULTS.period;
  const digits = input.options?.digits ?? TOTP_DEFAULTS.digits;
  const algorithm = input.options?.algorithm ?? TOTP_DEFAULTS.algorithm;

  const label = `${encodeURIComponent(issuer)}:${encodeURIComponent(input.accountName)}`;
  const query = new URLSearchParams({
    // Padding is stripped here: '=' has to be percent-encoded in a query string, and several
    // widely-used apps mishandle the escaped form.
    secret: input.secretBase32.replace(/=+$/, ''),
    issuer,
    algorithm,
    digits: String(digits),
    period: String(period),
  });

  return `otpauth://totp/${label}?${query.toString()}`;
}
