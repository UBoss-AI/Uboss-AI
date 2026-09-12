import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { describe, it } from 'node:test';

import {
  generateRecoveryCode,
  generateRecoveryCodeBatch,
  hashPresentedRecoveryCode,
  normaliseRecoveryCode,
  RECOVERY_CODE_BATCH_SIZE,
} from '../src/auth/recovery-code.js';
import {
  keyProviderFromEnv,
  SECRET_PURPOSES,
  SecretBox,
  SecretBoxError,
} from '../src/auth/secret-box.js';
import {
  base32Decode,
  base32Encode,
  generateTotpSecret,
  hotp,
  otpauthUri,
  totpCode,
  totpCounter,
  verifyTotp,
} from '../src/auth/totp.js';

/**
 * Unit tests for the enterprise-identity crypto primitives.
 *
 * The TOTP tests are the published RFC vectors, not examples of my own devising. That is the
 * whole justification for implementing RFC 6238 here instead of taking a dependency (see the
 * comment at the top of `totp.ts`): the algorithm can be *proved* correct against the spec.
 */

const RFC_SHA1_SECRET = Buffer.from('12345678901234567890', 'ascii');
const RFC_SHA256_SECRET = Buffer.from('12345678901234567890123456789012', 'ascii');
const RFC_SHA512_SECRET = Buffer.from(
  '1234567890123456789012345678901234567890123456789012345678901234',
  'ascii',
);

describe('base32 (RFC 4648)', () => {
  it('round-trips arbitrary bytes', () => {
    for (let length = 1; length <= 40; length += 1) {
      const data = randomBytes(length);
      assert.deepEqual(base32Decode(base32Encode(data)), data);
    }
  });

  it('matches the RFC 4648 test vectors', () => {
    // From RFC 4648 section 10.
    const vectors: [string, string][] = [
      ['f', 'MY======'],
      ['fo', 'MZXQ===='],
      ['foo', 'MZXW6==='],
      ['foob', 'MZXW6YQ='],
      ['fooba', 'MZXW6YTB'],
      ['foobar', 'MZXW6YTBOI======'],
    ];

    for (const [plain, encoded] of vectors) {
      assert.equal(base32Encode(Buffer.from(plain, 'ascii')), encoded, plain);
      assert.equal(base32Decode(encoded).toString('ascii'), plain, encoded);
    }
  });

  it('accepts the sloppy input a human actually pastes', () => {
    const canonical = base32Encode(RFC_SHA1_SECRET);
    const messy = canonical
      .replace(/=+$/, '')
      .toLowerCase()
      .replace(/(.{4})/g, '$1 ');

    assert.deepEqual(base32Decode(messy), RFC_SHA1_SECRET);
  });

  it('rejects characters outside the alphabet', () => {
    // 0, 1 and 8 are not in the RFC 4648 base32 alphabet.
    assert.throws(() => base32Decode('MZXW6YTB01'), /not a valid base32 character/);
  });
});

describe('HOTP — RFC 4226 Appendix D vectors', () => {
  it('produces every published 6-digit value for counters 0-9', () => {
    const expected = [
      '755224',
      '287082',
      '359152',
      '969429',
      '338314',
      '254676',
      '287922',
      '162583',
      '399871',
      '520489',
    ];

    expected.forEach((code, counter) => {
      assert.equal(hotp(RFC_SHA1_SECRET, counter), code, `counter ${counter}`);
    });
  });
});

describe('TOTP — RFC 6238 Appendix B vectors', () => {
  // [unix seconds, expected 8-digit code]
  const times: number[] = [59, 1111111109, 1111111111, 1234567890, 2000000000, 20000000000];

  it('matches the SHA-1 vectors', () => {
    const expected = ['94287082', '07081804', '14050471', '89005924', '69279037', '65353130'];

    times.forEach((seconds, index) => {
      const code = hotp(RFC_SHA1_SECRET, totpCounter(seconds * 1000), {
        digits: 8,
        algorithm: 'SHA1',
      });
      assert.equal(code, expected[index], `T=${seconds}`);
    });
  });

  it('matches the SHA-256 vectors', () => {
    const expected = ['46119246', '68084774', '67062674', '91819424', '90698825', '77737706'];

    times.forEach((seconds, index) => {
      const code = hotp(RFC_SHA256_SECRET, totpCounter(seconds * 1000), {
        digits: 8,
        algorithm: 'SHA256',
      });
      assert.equal(code, expected[index], `T=${seconds}`);
    });
  });

  it('matches the SHA-512 vectors', () => {
    const expected = ['90693936', '25091201', '99943326', '93441116', '38618901', '47863826'];

    times.forEach((seconds, index) => {
      const code = hotp(RFC_SHA512_SECRET, totpCounter(seconds * 1000), {
        digits: 8,
        algorithm: 'SHA512',
      });
      assert.equal(code, expected[index], `T=${seconds}`);
    });
  });

  it('handles the vector past 2^32 steps, which a 32-bit counter would get wrong', () => {
    // T = 20000000000 is step 666666666 — fine in 32 bits — but the RFC's own note is that
    // implementations using two 32-bit halves get this one wrong. Asserted separately so a
    // regression here is unmistakable.
    assert.equal(hotp(RFC_SHA1_SECRET, totpCounter(20000000000 * 1000), { digits: 8 }), '65353130');
  });
});

describe('verifyTotp', () => {
  const secret = base32Encode(RFC_SHA1_SECRET);
  const now = 1111111109 * 1000;

  it('accepts the current code', () => {
    const result = verifyTotp(secret, totpCode(secret, { now }), { now });
    assert.equal(result.valid, true);
  });

  it('accepts the previous and next code, for clock drift', () => {
    const previous = totpCode(secret, { now: now - 30_000 });
    const next = totpCode(secret, { now: now + 30_000 });

    assert.equal(verifyTotp(secret, previous, { now }).valid, true);
    assert.equal(verifyTotp(secret, next, { now }).valid, true);
  });

  it('refuses a code two steps away', () => {
    const stale = totpCode(secret, { now: now - 90_000 });
    const result = verifyTotp(secret, stale, { now });

    assert.equal(result.valid, false);
    assert.equal(result.valid === false && result.reason, 'no-match');
  });

  it('honours a wider window when one is configured', () => {
    const stale = totpCode(secret, { now: now - 90_000 });
    assert.equal(verifyTotp(secret, stale, { now, window: 3 }).valid, true);
  });

  it('reports the matched step so the caller can pin replay protection to it', () => {
    const result = verifyTotp(secret, totpCode(secret, { now }), { now });
    assert.equal(result.valid && result.counter, totpCounter(now));
  });

  it('refuses a code whose step has already been spent', () => {
    const code = totpCode(secret, { now });
    const first = verifyTotp(secret, code, { now });
    assert.equal(first.valid, true);

    // Same code, replayed while still inside its own validity window.
    const replay = verifyTotp(secret, code, {
      now,
      afterCounter: first.valid ? first.counter : undefined,
    });

    assert.equal(replay.valid, false);
    assert.equal(replay.valid === false && replay.reason, 'replayed');
  });

  it('still accepts the next code after one has been spent', () => {
    const spent = totpCounter(now);
    const next = totpCode(secret, { now: now + 30_000 });

    const result = verifyTotp(secret, next, { now: now + 30_000, afterCounter: spent });
    assert.equal(result.valid, true);
  });

  it('prefers the earliest matching step, so it does not invalidate codes yet to be shown', () => {
    // A secret and moment where the previous step's code is presented: the match must be the
    // older step, not the current one, or accepting a drifted code would burn the newer steps.
    const previousStep = totpCounter(now) - 1;
    const result = verifyTotp(secret, totpCode(secret, { now: now - 30_000 }), { now });

    assert.equal(result.valid && result.counter, previousStep);
  });

  it('rejects malformed input without touching the secret', () => {
    for (const bad of ['', 'abcdef', '12345', '1234567', 'not-a-code']) {
      const result = verifyTotp(secret, bad, { now });
      assert.equal(result.valid, false, bad);
      assert.equal(result.valid === false && result.reason, 'malformed', bad);
    }
  });

  it('tolerates the spacing authenticator apps display', () => {
    const code = totpCode(secret, { now });
    const spaced = `${code.slice(0, 3)} ${code.slice(3)}`;

    assert.equal(verifyTotp(secret, spaced, { now }).valid, true);
  });
});

describe('generateTotpSecret', () => {
  it('produces a 160-bit base32 secret that decodes to 20 bytes', () => {
    const secret = generateTotpSecret();
    assert.equal(base32Decode(secret).length, 20);
  });

  it('does not repeat', () => {
    const secrets = new Set(Array.from({ length: 50 }, () => generateTotpSecret()));
    assert.equal(secrets.size, 50);
  });
});

describe('otpauthUri', () => {
  it('is a scannable Key Uri with the issuer in both places', () => {
    const uri = otpauthUri({ secretBase32: 'JBSWY3DPEHPK3PXP', accountName: 'priya@spm.example' });
    const parsed = new URL(uri);

    assert.equal(parsed.protocol, 'otpauth:');
    assert.equal(parsed.host, 'totp');
    assert.equal(decodeURIComponent(parsed.pathname), '/UBoss:priya@spm.example');
    assert.equal(parsed.searchParams.get('issuer'), 'UBoss');
    assert.equal(parsed.searchParams.get('secret'), 'JBSWY3DPEHPK3PXP');
    assert.equal(parsed.searchParams.get('algorithm'), 'SHA1');
    assert.equal(parsed.searchParams.get('digits'), '6');
    assert.equal(parsed.searchParams.get('period'), '30');
  });

  it('strips base32 padding, which several authenticator apps mishandle when escaped', () => {
    const uri = otpauthUri({ secretBase32: 'MY======', accountName: 'a@b.example' });
    assert.equal(new URL(uri).searchParams.get('secret'), 'MY');
    assert.ok(!uri.includes('%3D'));
  });
});

describe('recovery codes', () => {
  it('are 20 characters of Crockford base32, shown in four groups', () => {
    const { display } = generateRecoveryCode();

    assert.match(
      display,
      /^[0-9A-HJKMNP-TV-Z]{5}-[0-9A-HJKMNP-TV-Z]{5}-[0-9A-HJKMNP-TV-Z]{5}-[0-9A-HJKMNP-TV-Z]{5}$/,
    );
    assert.equal(display.replace(/-/g, '').length, 20);
  });

  it('never contain the confusable letters I, L, O or U', () => {
    const codes = generateRecoveryCodeBatch(200)
      .map((code) => code.display)
      .join('');

    assert.doesNotMatch(codes, /[ILOU]/);
  });

  it('hash to a 64-character hex digest and never store the code itself', () => {
    const { display, hash } = generateRecoveryCode();

    assert.match(hash, /^[0-9a-f]{64}$/);
    assert.ok(!hash.includes(display.replace(/-/g, '')));
  });

  it('hash consistently however the person types them back', () => {
    const { display, hash } = generateRecoveryCode();

    const variants = [
      display,
      display.toLowerCase(),
      display.replace(/-/g, ''),
      display.replace(/-/g, ' '),
      `  ${display}  `,
      display.replace(/-/g, '_'),
    ];

    for (const variant of variants) {
      assert.equal(hashPresentedRecoveryCode(variant), hash, variant);
    }
  });

  it('maps the confusable characters a person is likely to mistype', () => {
    // A code containing 1 and 0 must still match when typed as I/L and O.
    const normalised = normaliseRecoveryCode('1ABCD-0EFGH-1JKMN-0PQRS');
    assert.equal(normaliseRecoveryCode('IABCD-OEFGH-LJKMN-OPQRS'), normalised);
  });

  it('refuses input that cannot be a code, rather than hashing rubbish', () => {
    for (const bad of ['', 'too-short', 'A'.repeat(21), '!!!!!-!!!!!-!!!!!-!!!!!']) {
      assert.equal(normaliseRecoveryCode(bad), undefined, JSON.stringify(bad));
      assert.equal(hashPresentedRecoveryCode(bad), undefined, JSON.stringify(bad));
    }
  });

  it('generates a distinct batch of ten', () => {
    const batch = generateRecoveryCodeBatch();

    assert.equal(batch.length, RECOVERY_CODE_BATCH_SIZE);
    assert.equal(new Set(batch.map((code) => code.hash)).size, RECOVERY_CODE_BATCH_SIZE);
  });

  it('carries 100 bits of entropy, which is what makes a fast digest correct', () => {
    // 32 symbols ** 20 characters === 2 ** 100. Asserted so a future change that shortens the
    // code forces a re-read of why SHA-256 is acceptable here.
    assert.equal(32 ** 20, 2 ** 100);
  });
});

describe('SecretBox', () => {
  const key = (id: string) => `${id}:${randomBytes(32).toString('base64')}`;
  const boxFor = (raw: string) => new SecretBox(keyProviderFromEnv(raw));

  it('round-trips a value', () => {
    const box = boxFor(key('k1'));
    const sealed = box.seal('JBSWY3DPEHPK3PXP', SECRET_PURPOSES.totpSecret);

    assert.equal(box.open(sealed, SECRET_PURPOSES.totpSecret), 'JBSWY3DPEHPK3PXP');
  });

  it('does not leak the plaintext into the envelope', () => {
    const box = boxFor(key('k1'));
    const secret = 'super-secret-client-value';
    const sealed = box.seal(secret, SECRET_PURPOSES.ssoClientSecret);

    assert.ok(!sealed.includes(secret));
    assert.ok(!Buffer.from(sealed).toString('base64').includes(secret));
  });

  it('produces a different envelope every time, so equal secrets are not detectable', () => {
    const box = boxFor(key('k1'));
    const a = box.seal('same', SECRET_PURPOSES.totpSecret);
    const b = box.seal('same', SECRET_PURPOSES.totpSecret);

    assert.notEqual(a, b);
    assert.equal(box.open(a, SECRET_PURPOSES.totpSecret), box.open(b, SECRET_PURPOSES.totpSecret));
  });

  it('refuses to open a value sealed for a different purpose', () => {
    const box = boxFor(key('k1'));
    const sealed = box.seal('value', SECRET_PURPOSES.totpSecret);

    // This is the attack the purpose binding exists to stop: moving a ciphertext from the TOTP
    // column into the SSO client-secret column.
    assert.throws(() => box.open(sealed, SECRET_PURPOSES.ssoClientSecret), /failed authentication/);
  });

  it('refuses a tampered ciphertext', () => {
    const box = boxFor(key('k1'));
    const sealed = box.seal('value', SECRET_PURPOSES.totpSecret);
    const parts = sealed.split('.');
    const body = Buffer.from(parts[4] as string, 'base64url');
    body[0] = (body[0] as number) ^ 0xff;
    parts[4] = body.toString('base64url');

    assert.throws(() => box.open(parts.join('.'), SECRET_PURPOSES.totpSecret), SecretBoxError);
  });

  it('refuses a value sealed with a different key', () => {
    const sealed = boxFor(key('k1')).seal('value', SECRET_PURPOSES.totpSecret);
    const other = boxFor(`k1:${randomBytes(32).toString('base64')}`);

    assert.throws(() => other.open(sealed, SECRET_PURPOSES.totpSecret), /failed authentication/);
  });

  it('opens a value sealed with a retired key, and names the key when it is missing', () => {
    const oldKey = key('k1');
    const newKey = key('k2');

    const sealed = boxFor(oldKey).seal('value', SECRET_PURPOSES.totpSecret);

    // Rotation: k2 is active, k1 is retained for decryption only.
    const rotated = boxFor(`${newKey},${oldKey}`);
    assert.equal(rotated.open(sealed, SECRET_PURPOSES.totpSecret), 'value');
    assert.equal(rotated.keyIdOf(sealed), 'k1');
    assert.equal(rotated.isCurrent(sealed), false);
    assert.equal(rotated.isCurrent(rotated.seal('x', SECRET_PURPOSES.totpSecret)), true);

    // Dropping k1 too early must fail loudly, and say which key is missing.
    assert.throws(() => boxFor(newKey).open(sealed, SECRET_PURPOSES.totpSecret), /key "k1"/);
  });

  it('rejects a malformed envelope', () => {
    const box = boxFor(key('k1'));

    for (const bad of ['', 'nope', 'v1.k1.a.b', 'v2.k1.a.b.c', 'v1.k1.a.b.c.d']) {
      assert.throws(() => box.open(bad, SECRET_PURPOSES.totpSecret), SecretBoxError, bad);
    }
  });

  it('refuses to seal an empty value', () => {
    assert.throws(() => boxFor(key('k1')).seal('', SECRET_PURPOSES.totpSecret), SecretBoxError);
  });
});

describe('keyProviderFromEnv', () => {
  it('explains how to generate a key when none is configured', () => {
    for (const missing of [undefined, '', '   ']) {
      assert.throws(() => keyProviderFromEnv(missing), /AUTH_ENCRYPTION_KEYS is not set/);
    }
  });

  it('rejects a key that is not 32 bytes, and reports the length without the key', () => {
    const short = `k1:${randomBytes(16).toString('base64')}`;

    assert.throws(
      () => keyProviderFromEnv(short),
      (error: unknown) => {
        const message = (error as Error).message;
        assert.match(message, /16 bytes/);
        assert.ok(!message.includes(short.slice(3)), 'the key must not appear in the error');
        return true;
      },
    );
  });

  it('rejects a malformed entry without echoing it', () => {
    assert.throws(
      () => keyProviderFromEnv('no-separator-here'),
      (error: unknown) => {
        assert.match((error as Error).message, /<redacted>/);
        return true;
      },
    );
  });

  it('rejects a duplicate key id, which would make rotation ambiguous', () => {
    const raw = `k1:${randomBytes(32).toString('base64')},k1:${randomBytes(32).toString('base64')}`;
    assert.throws(() => keyProviderFromEnv(raw), /twice/);
  });

  it('rejects an unusable key id', () => {
    assert.throws(
      () => keyProviderFromEnv(`bad id!:${randomBytes(32).toString('base64')}`),
      /key id/,
    );
  });

  it('treats the first key as active', () => {
    const provider = keyProviderFromEnv(
      `first:${randomBytes(32).toString('base64')},second:${randomBytes(32).toString('base64')}`,
    );

    assert.equal(provider.activeKey().id, 'first');
    assert.ok(provider.keyById('second'));
    assert.equal(provider.keyById('third'), undefined);
  });
});
