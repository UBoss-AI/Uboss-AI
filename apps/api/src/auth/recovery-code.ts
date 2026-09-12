import { randomBytes } from 'node:crypto';

import { hashToken } from './one-time-token.js';

/**
 * MFA recovery codes: single-use credentials that let someone back in when their second factor
 * is gone — a lost phone, a wiped authenticator, a broken hardware key.
 *
 * ## Why the codes are this long
 *
 * A recovery code bypasses MFA, so it is exactly as powerful as the factor it replaces. It is
 * stored as a **SHA-256 hash**, and that is only defensible if the code itself has enough
 * entropy that guessing is hopeless — which is the same argument used for session and invitation
 * tokens.
 *
 * 20 characters of a 32-symbol alphabet is 100 bits. That is far past the point where a fast
 * digest matters, so the alternative (Argon2id) would buy nothing and cost real time: recovery
 * verification would have to try each of the person's stored codes in turn, so ten codes would
 * mean ten Argon2 verifications. Instead, lookup is a single indexed probe on the hash.
 *
 * The trade is that the code is longer to type than the 8–10 characters some products use. That
 * is the right way round: recovery codes are typed once, in an emergency, from a printout.
 *
 * ## Why Crockford's alphabet
 *
 * These get written down and read back by a human under stress. Crockford base32 omits I, L, O
 * and U — the first three because they are indistinguishable from 1, 1 and 0 in most fonts, U
 * because removing it removes an entire category of accidentally offensive strings. Normalisation
 * then maps what people actually type (`I`, `l`, `O`) onto what was meant.
 */

/** Crockford base32: no I, L, O or U. */
const ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';

const GROUPS = 4;
const GROUP_LENGTH = 5;
const CODE_LENGTH = GROUPS * GROUP_LENGTH; // 20 characters => 100 bits

/** How many codes a batch contains. Ten is the industry norm and enough for a real emergency. */
export const RECOVERY_CODE_BATCH_SIZE = 10;

export interface GeneratedRecoveryCode {
  /** Shown to the person **once**, formatted for reading aloud and typing back. */
  display: string;
  /** Stored. */
  hash: string;
}

/**
 * Generate one code.
 *
 * Rejection sampling rather than `% 32` on a random byte: 256 is divisible by 32, so modulo
 * would in fact be uniform here — but writing it this way means the alphabet can change size
 * later without silently introducing bias, which is the kind of bug that never gets noticed.
 */
function randomCharacters(count: number): string {
  const limit = 256 - (256 % ALPHABET.length);
  let out = '';

  while (out.length < count) {
    for (const byte of randomBytes(count)) {
      if (byte >= limit) {
        continue;
      }
      out += ALPHABET[byte % ALPHABET.length];
      if (out.length === count) {
        break;
      }
    }
  }

  return out;
}

export function generateRecoveryCode(): GeneratedRecoveryCode {
  const raw = randomCharacters(CODE_LENGTH);
  const display = (raw.match(/.{5}/g) as string[]).join('-');

  // Hashed from the NORMALISED form, so what the user types back always hashes to the same
  // value regardless of how they space or case it.
  return { display, hash: hashToken(normaliseRecoveryCode(display) as string) };
}

export function generateRecoveryCodeBatch(
  size = RECOVERY_CODE_BATCH_SIZE,
): GeneratedRecoveryCode[] {
  return Array.from({ length: size }, () => generateRecoveryCode());
}

/**
 * Normalise a code the way a person might type it back.
 *
 * Upper-cases, strips separators and whitespace, and applies Crockford's confusable mapping
 * (`I`/`L` → `1`, `O` → `0`). Returns `undefined` when the result cannot be a code at all, so a
 * caller never hashes and looks up obvious rubbish.
 */
export function normaliseRecoveryCode(input: string): string | undefined {
  const normalised = input
    .toUpperCase()
    .replace(/[\s\-_]/g, '')
    .replace(/[IL]/g, '1')
    .replace(/O/g, '0');

  if (normalised.length !== CODE_LENGTH) {
    return undefined;
  }

  for (const character of normalised) {
    if (!ALPHABET.includes(character)) {
      return undefined;
    }
  }

  return normalised;
}

/** Hash a presented code for lookup, or `undefined` when it is not a well-formed code. */
export function hashPresentedRecoveryCode(input: string): string | undefined {
  const normalised = normaliseRecoveryCode(input);
  return normalised === undefined ? undefined : hashToken(normalised);
}
