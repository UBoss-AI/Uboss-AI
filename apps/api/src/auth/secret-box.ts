import {
  createCipheriv,
  createDecipheriv,
  createHmac,
  randomBytes,
  timingSafeEqual,
} from 'node:crypto';

/**
 * Authenticated encryption for the small class of secrets UBoss must be able to *use* rather
 * than merely compare.
 *
 * ## Why this exists at all
 *
 * Everything else in this codebase is hashed: passwords with Argon2id, session and invitation
 * tokens with SHA-256. Hashing is always preferable, because a hash cannot be turned back into
 * a working credential by anyone — including us.
 *
 * Three secrets cannot be hashed, because the server has to reproduce or replay them:
 *
 *   * a **TOTP shared secret** — verification recomputes the code from the secret;
 *   * an **OIDC client secret** — it is sent to the identity provider's token endpoint;
 *   * a **PKCE code verifier** — it is sent verbatim in the token exchange.
 *
 * For those, "store it in a column" would mean a database reader gets working credentials. So
 * they are encrypted with a key that lives *outside* the database, which reduces the threat from
 * "read the database" to "read the database **and** obtain the process's key material".
 *
 * ## Envelope format
 *
 * `v1.<keyId>.<iv>.<tag>.<ciphertext>` — each part base64url. The version prefix means the format
 * can change without guessing, and the key id means keys can be rotated: new values are sealed
 * with the active key while old values still open with a retired one.
 *
 * ## Purpose binding
 *
 * The purpose string is passed to AES-GCM as additional authenticated data. A ciphertext sealed
 * as `mfa.totp` therefore **fails to open** as `sso.client_secret`. Without this, a database
 * writer could move a value between columns and have it silently accepted somewhere it grants
 * more than it should.
 */

/** Where the key material comes from. A seam, so a KMS/Vault provider can replace it later. */
export interface EncryptionKeyProvider {
  /** The key new values are sealed with. */
  activeKey(): { id: string; key: Buffer };
  /** Every key that may open an existing value, including retired ones. */
  keyById(id: string): Buffer | undefined;
}

export const SECRET_PURPOSES = {
  /** A TOTP shared secret belonging to one enrolled factor. */
  totpSecret: 'mfa.totp_secret',
  /** A company's OIDC client secret. */
  ssoClientSecret: 'sso.client_secret',
  /** A PKCE code verifier for one in-flight authorization request. */
  pkceVerifier: 'sso.pkce_verifier',
  /**
   * A connection credential, behind a secret_ref (Prompt 16).
   *
   * Its own purpose so a sealed connection secret can never be opened as an SSO client secret or
   * a TOTP seed. Domain separation is what makes an envelope from one context useless in another,
   * and a connection credential is the highest-value secret in the system.
   */
  connectionSecret: 'connection.secret',
} as const;

export type SecretPurpose = (typeof SECRET_PURPOSES)[keyof typeof SECRET_PURPOSES];

/**
 * Purposes for a **blind index** — a keyed deterministic hash used to find a row by a value
 * without storing the value.
 *
 * Separate from {@link SECRET_PURPOSES} because these are not secrets UBoss can reproduce. A
 * blind index is one-way: it answers "have I seen this before" and nothing else. Mixing the two
 * taxonomies would invite `seal(..., aadhaarMatch)`, which would store the very number the
 * design exists to avoid holding.
 */
export const BLIND_INDEX_PURPOSES = {
  /**
   * An Aadhaar number, entered for person matching only.
   *
   * The number itself is never stored — see `PersonIdentifier` and ADR-063. This index is the
   * whole of what UBoss keeps, plus the last four digits for display.
   */
  aadhaarMatch: 'person.aadhaar_match',
  /** An official work email, as a secondary match signal. */
  workEmailMatch: 'person.work_email_match',
} as const;

export type BlindIndexPurpose = (typeof BLIND_INDEX_PURPOSES)[keyof typeof BLIND_INDEX_PURPOSES];

const KEY_BYTES = 32; // AES-256
const IV_BYTES = 12; // GCM standard nonce length
const TAG_BYTES = 16;
const ENVELOPE_VERSION = 'v1';

/** Domain separation label. Changing it invalidates every existing blind index. */
const BLIND_INDEX_LABEL = 'uboss-blind-index-v1';

export class SecretBoxError extends Error {}

/**
 * Parse `AUTH_ENCRYPTION_KEYS` into a key provider.
 *
 * Format: `id:base64key[,id:base64key...]`. The **first** entry is active; the rest are retired
 * and used only to open existing values. Key ids are short and non-secret — they appear in every
 * envelope so the right key can be chosen without trial decryption.
 */
export function keyProviderFromEnv(raw: string | undefined): EncryptionKeyProvider {
  if (!raw || raw.trim() === '') {
    throw new SecretBoxError(
      'AUTH_ENCRYPTION_KEYS is not set. Enterprise identity stores TOTP secrets and OIDC ' +
        'client secrets encrypted, so it cannot start without a key. Generate one with:\n' +
        "  node -e \"console.log('k1:' + require('crypto').randomBytes(32).toString('base64'))\"\n" +
        'and set AUTH_ENCRYPTION_KEYS to the result. Never commit the value.',
    );
  }

  const keys = new Map<string, Buffer>();
  const order: string[] = [];

  for (const entry of raw.split(',')) {
    const trimmed = entry.trim();
    if (trimmed === '') {
      continue;
    }

    const separator = trimmed.indexOf(':');
    if (separator <= 0) {
      throw new SecretBoxError(
        `AUTH_ENCRYPTION_KEYS entry "${redactEntry(trimmed)}" is malformed. ` +
          'Each entry must be "id:base64key".',
      );
    }

    const id = trimmed.slice(0, separator);
    const key = Buffer.from(trimmed.slice(separator + 1), 'base64');

    if (!/^[A-Za-z0-9_-]{1,32}$/.test(id)) {
      throw new SecretBoxError(
        `AUTH_ENCRYPTION_KEYS key id "${id}" is invalid: use 1-32 characters of [A-Za-z0-9_-].`,
      );
    }
    if (key.length !== KEY_BYTES) {
      // The length is reported but never the key itself.
      throw new SecretBoxError(
        `AUTH_ENCRYPTION_KEYS key "${id}" decodes to ${key.length} bytes; AES-256 needs ${KEY_BYTES}.`,
      );
    }
    if (keys.has(id)) {
      throw new SecretBoxError(`AUTH_ENCRYPTION_KEYS contains key id "${id}" twice.`);
    }

    keys.set(id, key);
    order.push(id);
  }

  const activeId = order[0];
  if (activeId === undefined) {
    throw new SecretBoxError('AUTH_ENCRYPTION_KEYS contained no usable keys.');
  }

  return {
    activeKey: () => ({ id: activeId, key: keys.get(activeId) as Buffer }),
    keyById: (id) => keys.get(id),
  };
}

/** Never echo key material back, even in a configuration error. */
function redactEntry(entry: string): string {
  const separator = entry.indexOf(':');
  return separator > 0 ? `${entry.slice(0, separator)}:<redacted>` : '<redacted>';
}

export class SecretBox {
  constructor(private readonly keys: EncryptionKeyProvider) {}

  /**
   * A **keyed deterministic hash** of a value, for finding a row by it without storing it.
   *
   * ## Why keyed
   *
   * A plain `SHA-256` of a 12-digit Aadhaar number is not protection: there are only 10^12
   * candidates, and enumerating them is minutes of commodity GPU time. Anybody who read the
   * column could recover every number in it. With a key that lives outside the database, the
   * same read yields nothing without also obtaining the process's key material — the same
   * threat reduction as {@link seal}, for a value that must be *matched* rather than *used*.
   *
   * ## Why HMAC and not the encryption key directly
   *
   * The HMAC key is derived from the master key with a label and the purpose, so:
   *
   *   * a blind index cannot be compared against a ciphertext produced by {@link seal} — the
   *     keys are different;
   *   * an Aadhaar index and a work-email index of the same string differ, so one cannot be
   *     used to probe the other.
   *
   * ## Deterministic on purpose, with the cost stated
   *
   * The same input always produces the same digest — that is what makes matching possible, and
   * it is also the cost: two people with the same Aadhaar produce the same digest, which is the
   * feature, while an attacker holding both the key and a candidate number can confirm whether
   * that person is in UBoss. There is no way to have match-on-value without that property.
   *
   * Returns 64 lower-case hex characters. The database enforces that shape, so a raw value
   * written to the column is rejected rather than stored.
   */
  blindIndex(value: string, purpose: BlindIndexPurpose): { hash: string; keyId: string } {
    const normalised = value.trim();
    if (normalised === '') {
      throw new SecretBoxError('Refusing to index an empty value.');
    }

    const { id, key } = this.keys.activeKey();
    const derived = createHmac('sha256', key)
      .update(`${BLIND_INDEX_LABEL}:${purpose}`, 'utf8')
      .digest();

    return {
      hash: createHmac('sha256', derived).update(normalised, 'utf8').digest('hex'),
      keyId: id,
    };
  }

  /** Encrypt a value, bound to the purpose it is being stored for. */
  seal(plaintext: string, purpose: SecretPurpose): string {
    if (plaintext === '') {
      throw new SecretBoxError('Refusing to seal an empty value.');
    }

    const { id, key } = this.keys.activeKey();
    const iv = randomBytes(IV_BYTES);
    const cipher = createCipheriv('aes-256-gcm', key, iv, { authTagLength: TAG_BYTES });
    cipher.setAAD(Buffer.from(purpose, 'utf8'));

    const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
    const tag = cipher.getAuthTag();

    return [
      ENVELOPE_VERSION,
      id,
      iv.toString('base64url'),
      tag.toString('base64url'),
      ciphertext.toString('base64url'),
    ].join('.');
  }

  /**
   * Decrypt a value.
   *
   * Throws when the envelope is malformed, its key is unknown, its authentication tag does not
   * verify, or it was sealed for a **different purpose**. All four are the same kind of problem —
   * this value is not what the caller thinks it is — so none of them returns a value.
   */
  open(envelope: string, purpose: SecretPurpose): string {
    const parts = envelope.split('.');
    if (parts.length !== 5 || parts[0] !== ENVELOPE_VERSION) {
      throw new SecretBoxError('Not a recognised secret envelope.');
    }

    const [, keyId, ivPart, tagPart, ciphertextPart] = parts as [
      string,
      string,
      string,
      string,
      string,
    ];

    const key = this.keys.keyById(keyId);
    if (!key) {
      throw new SecretBoxError(
        `This value was sealed with key "${keyId}", which is not configured. ` +
          'A retired key must stay in AUTH_ENCRYPTION_KEYS until every value it sealed has been ' +
          're-sealed with the active key.',
      );
    }

    const iv = Buffer.from(ivPart, 'base64url');
    const tag = Buffer.from(tagPart, 'base64url');
    if (iv.length !== IV_BYTES || tag.length !== TAG_BYTES) {
      throw new SecretBoxError('Secret envelope has a malformed nonce or authentication tag.');
    }

    const decipher = createDecipheriv('aes-256-gcm', key, iv, { authTagLength: TAG_BYTES });
    decipher.setAAD(Buffer.from(purpose, 'utf8'));
    decipher.setAuthTag(tag);

    try {
      return Buffer.concat([
        decipher.update(Buffer.from(ciphertextPart, 'base64url')),
        decipher.final(),
      ]).toString('utf8');
    } catch {
      // GCM's tag check failing means tampering, the wrong key, or the wrong purpose. The
      // message deliberately does not say which — a caller cannot act differently on any of
      // them, and distinguishing them would describe our key state to whoever provoked it.
      throw new SecretBoxError('Secret envelope failed authentication and was not decrypted.');
    }
  }

  /** Which key sealed a value, so a rotation job can find what still needs re-sealing. */
  keyIdOf(envelope: string): string | undefined {
    const parts = envelope.split('.');
    return parts.length === 5 && parts[0] === ENVELOPE_VERSION ? parts[1] : undefined;
  }

  /** Is this value sealed with the currently active key? */
  isCurrent(envelope: string): boolean {
    const id = this.keyIdOf(envelope);
    if (id === undefined) {
      return false;
    }
    const active = this.keys.activeKey().id;
    const a = Buffer.from(id, 'utf8');
    const b = Buffer.from(active, 'utf8');
    return a.length === b.length && timingSafeEqual(a, b);
  }
}
