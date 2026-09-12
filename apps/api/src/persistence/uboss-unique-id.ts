import { randomBytes } from 'node:crypto';

/**
 * Generates the permanent UBoss Unique ID that follows a person across UBoss-enabled companies.
 *
 * Format `UB-XXXX-XXXX`, matching the client's approved UI reference, using an unambiguous
 * alphabet (no I, O, 0 or 1) because these identifiers get read aloud, printed and retyped.
 *
 * It is a public-facing identifier, not a secret and not an authorization token: holding
 * someone's UBoss Unique ID grants nothing. Authorized cross-company profile search takes this
 * value — never Aadhaar — and the permission check is server-side regardless.
 *
 * Uniqueness is enforced by the `users.uboss_unique_id` unique constraint. Callers that
 * generate a value must handle a collision by retrying; `generateUbossUniqueId` is random, not
 * coordinated.
 */
const ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

function randomBlock(length: number): string {
  // Rejection-free selection would bias the alphabet; 32 divides 256 evenly, so a plain
  // modulo over the byte range is uniform here.
  const bytes = randomBytes(length);
  let out = '';
  for (const byte of bytes) {
    out += ALPHABET[byte % ALPHABET.length];
  }
  return out;
}

export function generateUbossUniqueId(): string {
  return `UB-${randomBlock(4)}-${randomBlock(4)}`;
}

const UBOSS_UNIQUE_ID_PATTERN =
  /^UB-[ABCDEFGHJKLMNPQRSTUVWXYZ23456789]{4}-[ABCDEFGHJKLMNPQRSTUVWXYZ23456789]{4}$/;

export function isUbossUniqueId(value: string): boolean {
  return UBOSS_UNIQUE_ID_PATTERN.test(value);
}
