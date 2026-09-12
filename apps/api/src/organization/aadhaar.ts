/**
 * Normalisation and **format** validation for an Aadhaar number entered as a matching input.
 *
 * ## What this file is, and what it is emphatically not
 *
 * The client's rule, unchanged and repeated here because it governs every line below: in this
 * flow an Aadhaar number is **entered only, for internal person matching**. There is no OTP, no
 * authentication against any authority, and no verification. Nothing in UBoss may present an
 * Aadhaar number as verified, and nothing here does.
 *
 * What a checksum *can* tell you is that twelve digits were typed correctly rather than
 * mistyped — the difference between a transposition error and a valid-format number. That is
 * data quality, not identity: a format-valid number proves nothing about who owns it, and a
 * number can be format-valid and belong to somebody else entirely. The pack asks for
 * "normalize/validate input", and this is the whole of what validating input can honestly mean.
 *
 * ## Why normalise before hashing
 *
 * The match is a keyed deterministic hash, so `4021 8837 5510` and `402188375510` must produce
 * the same digest or the same person entered twice with different spacing becomes two people.
 * Normalisation is therefore part of the matching contract, not a convenience — which is why it
 * lives in one pure function that both the write path and any future re-index path call.
 */

/** Exactly twelve digits, and the first may not be 0 or 1 by UIDAI's own numbering scheme. */
const AADHAAR_DIGITS = 12;

/**
 * Verhoeff multiplication table (D5 dihedral group). UIDAI's checksum uses Verhoeff, not Luhn.
 *
 * Written out rather than computed so it can be checked against the published table by eye.
 */
const VERHOEFF_D = [
  [0, 1, 2, 3, 4, 5, 6, 7, 8, 9],
  [1, 2, 3, 4, 0, 6, 7, 8, 9, 5],
  [2, 3, 4, 0, 1, 7, 8, 9, 5, 6],
  [3, 4, 0, 1, 2, 8, 9, 5, 6, 7],
  [4, 0, 1, 2, 3, 9, 5, 6, 7, 8],
  [5, 9, 8, 7, 6, 0, 4, 3, 2, 1],
  [6, 5, 9, 8, 7, 1, 0, 4, 3, 2],
  [7, 6, 5, 9, 8, 2, 1, 0, 4, 3],
  [8, 7, 6, 5, 9, 3, 2, 1, 0, 4],
  [9, 8, 7, 6, 5, 4, 3, 2, 1, 0],
] as const;

/** Verhoeff permutation table. */
const VERHOEFF_P = [
  [0, 1, 2, 3, 4, 5, 6, 7, 8, 9],
  [1, 5, 7, 6, 2, 8, 3, 0, 9, 4],
  [5, 8, 0, 3, 7, 9, 6, 1, 4, 2],
  [8, 9, 1, 6, 0, 4, 3, 5, 2, 7],
  [9, 4, 5, 3, 1, 2, 6, 8, 7, 0],
  [4, 2, 8, 6, 5, 7, 3, 9, 0, 1],
  [2, 7, 9, 3, 8, 0, 6, 4, 1, 5],
  [7, 0, 4, 6, 9, 1, 3, 2, 5, 8],
] as const;

/** Verhoeff inverse table. Unused by the check itself; kept so the table set is complete. */
const VERHOEFF_INV = [0, 4, 3, 2, 1, 5, 6, 7, 8, 9] as const;

export type AadhaarRejection =
  'not-twelve-digits' | 'invalid-leading-digit' | 'repeated-digit' | 'checksum-failed';

export interface AadhaarNormalisation {
  /** Twelve digits, no separators. The value that gets hashed — never stored. */
  normalised: string;
  /** The only fragment UBoss keeps for display. */
  lastFour: string;
}

/** Human-readable reason for each rejection, safe to show the person typing. */
export const AADHAAR_REJECTION_MESSAGES: Record<AadhaarRejection, string> = {
  'not-twelve-digits': 'An Aadhaar number is twelve digits. Spaces and dashes are fine.',
  'invalid-leading-digit': 'An Aadhaar number does not begin with 0 or 1.',
  'repeated-digit': 'That is the same digit twelve times, which is not a real Aadhaar number.',
  'checksum-failed':
    'Those twelve digits do not form a valid Aadhaar number — please check for a typo. ' +
    'This is a format check only: UBoss does not verify Aadhaar.',
};

/**
 * Strip separators and check the format.
 *
 * Returns the normalised value or the reason it was rejected. A discriminated union rather than
 * a thrown error, because the caller is a form handler that has to turn this into a field-level
 * message, and because "invalid" is an ordinary outcome here rather than an exceptional one.
 */
export function normaliseAadhaar(
  raw: string,
): { ok: true; value: AadhaarNormalisation } | { ok: false; reason: AadhaarRejection } {
  const digits = raw.replace(/\D/g, '');

  if (digits.length !== AADHAAR_DIGITS) {
    return { ok: false, reason: 'not-twelve-digits' };
  }
  if (digits.startsWith('0') || digits.startsWith('1')) {
    return { ok: false, reason: 'invalid-leading-digit' };
  }
  // `999999999999` passes Verhoeff in some implementations and is obviously placeholder data.
  // Rejected explicitly so a test fixture cannot become a real person's identity.
  if (/^(\d)\1{11}$/.test(digits)) {
    return { ok: false, reason: 'repeated-digit' };
  }
  if (!verhoeffIsValid(digits)) {
    return { ok: false, reason: 'checksum-failed' };
  }

  return {
    ok: true,
    value: { normalised: digits, lastFour: digits.slice(-4) },
  };
}

/**
 * Verhoeff checksum over a digit string whose last digit is the check digit.
 *
 * Reads the digits right to left, which is what the algorithm specifies; getting the direction
 * wrong produces a check that rejects almost everything, so it is worth stating.
 */
export function verhoeffIsValid(digits: string): boolean {
  let checksum = 0;

  for (let position = 0; position < digits.length; position += 1) {
    const digit = Number(digits[digits.length - 1 - position]);
    if (!Number.isInteger(digit)) {
      return false;
    }
    checksum = VERHOEFF_D[checksum]![VERHOEFF_P[position % 8]![digit]!]!;
  }

  return checksum === 0;
}

/** The inverse table, exported so a generator (for test fixtures) can use the same source. */
export function verhoeffCheckDigit(elevenDigits: string): number {
  let checksum = 0;
  const withPlaceholder = `${elevenDigits}0`;

  for (let position = 0; position < withPlaceholder.length; position += 1) {
    const digit = Number(withPlaceholder[withPlaceholder.length - 1 - position]);
    checksum = VERHOEFF_D[checksum]![VERHOEFF_P[position % 8]![digit]!]!;
  }

  return VERHOEFF_INV[checksum]!;
}

/**
 * The masked form, and the only form any screen or API response may carry.
 *
 * Matches the client's approved reference exactly: `XXXX XXXX 5510`.
 */
export function maskedAadhaar(lastFour: string | null): string | null {
  return lastFour === null ? null : `XXXX XXXX ${lastFour}`;
}
