import { createHmac, randomInt, timingSafeEqual } from 'node:crypto';

import { BadRequestException, Inject, Injectable } from '@nestjs/common';

import { AUTH_CONFIG, type AuthConfig } from './auth.config.js';

export interface CaptchaChallenge {
  /** Opaque, carries its own answer and expiry. Returned to the browser and handed back. */
  token: string;
  /** What the person is asked. Plain text, so a screen reader can read it aloud. */
  question: string;
  expiresInSeconds: number;
}

/**
 * The sign-in captcha.
 *
 * ## Why this is not a third-party widget
 *
 * reCAPTCHA, hCaptcha and Turnstile all need a key pair this deployment does not have, and a
 * widget with no key either fails closed — nobody signs in — or is wired to always pass, which
 * is a captcha-shaped decoration rather than a control. Neither is worth shipping.
 *
 * So the challenge is generated and verified here. It is a modest control and it is honest about
 * being one: it stops the naive scripted credential-stuffing that account lockout already
 * partly covers, and it would not stop somebody who wrote a parser for it. A provider can be
 * dropped in behind {@link issue} and {@link verify} without touching the sign-in flow, which is
 * why those two methods are the whole surface.
 *
 * ## Stateless, and that is the security-relevant decision
 *
 * The token carries the answer and the expiry, signed with the deployment's own key:
 *
 *     base64(answerHash).base64(expiresAt).hmac
 *
 * Nothing is stored. There is no challenge table to grow, no Redis key to expire, and no way for
 * one process to issue a challenge another cannot verify. The **answer is stored as a hash**, not
 * as plaintext: the token travels to a browser, so a token whose body could be read would hand
 * the answer to whoever read it.
 *
 * The signature is what makes it unforgeable, and the expiry is inside the signed payload rather
 * than beside it — an expiry a client could edit is not an expiry.
 *
 * ## Off by default
 *
 * `AUTH_CAPTCHA_ENABLED` decides. Off, `issue` returns nothing and `verify` requires nothing, so
 * the flow is exactly as it was. That default is deliberate: a captcha turned on by surprise
 * blocks every automated sign-in a deployment has — acceptance runs, health probes, demos — and
 * discovering that at the worst moment is how a safety control gets switched off permanently.
 */
@Injectable()
export class CaptchaService {
  constructor(@Inject(AUTH_CONFIG) private readonly config: AuthConfig) {}

  get enabled(): boolean {
    return this.config.captchaEnabled;
  }

  /**
   * A fresh challenge, or `null` when the captcha is off.
   *
   * Arithmetic rather than distorted text: it is readable by a screen reader, it needs no image
   * pipeline, and it cannot be mistaken for a solved problem the way a rendered glyph can. The
   * numbers stay small enough to do in your head and the operation is only ever addition or
   * multiplication — a captcha that makes a person reach for a calculator is a captcha that
   * makes them give up.
   */
  issue(): CaptchaChallenge | null {
    if (!this.enabled) return null;

    const left = randomInt(2, 10);
    const right = randomInt(2, 10);
    const multiply = randomInt(0, 2) === 1;

    const answer = multiply ? left * right : left + right;
    const question = multiply ? `What is ${left} × ${right}?` : `What is ${left} + ${right}?`;

    const expiresAt = Date.now() + this.config.captchaExpirySeconds * 1000;

    return {
      token: this.sign(answer, expiresAt),
      question,
      expiresInSeconds: this.config.captchaExpirySeconds,
    };
  }

  /**
   * Check an answer against its token.
   *
   * Refuses rather than returns false: every failure mode here — missing, expired, tampered,
   * wrong — is something the caller must stop for, and a boolean invites a caller to carry on
   * past it. The messages distinguish expired from wrong, because those need different actions
   * from the person, and say nothing else.
   */
  verify(input: { token?: string | undefined; answer?: string | undefined }): void {
    if (!this.enabled) return;

    const token = input.token ?? '';
    const answer = (input.answer ?? '').trim();

    if (token === '' || answer === '') {
      throw new BadRequestException('Answer the verification question to sign in.');
    }

    const parts = token.split('.');
    if (parts.length !== 3) {
      throw new BadRequestException('That verification question expired. A new one is below.');
    }

    const [answerHash, expiresAtRaw, signature] = parts as [string, string, string];

    // The signature first, before anything inside the token is trusted — including its expiry.
    const expected = this.hmac(`${answerHash}.${expiresAtRaw}`);
    if (!CaptchaService.constantTimeEquals(signature, expected)) {
      throw new BadRequestException('That verification question expired. A new one is below.');
    }

    const expiresAt = Number(Buffer.from(expiresAtRaw, 'base64url').toString('utf8'));
    if (!Number.isFinite(expiresAt) || expiresAt < Date.now()) {
      throw new BadRequestException('That verification question expired. A new one is below.');
    }

    if (!CaptchaService.constantTimeEquals(this.hashAnswer(answer), answerHash)) {
      throw new BadRequestException('That answer is not right. Try the new question below.');
    }
  }

  // -------------------------------------------------------------------------

  private sign(answer: number, expiresAt: number): string {
    const answerHash = this.hashAnswer(String(answer));
    const expiresAtRaw = Buffer.from(String(expiresAt), 'utf8').toString('base64url');
    return `${answerHash}.${expiresAtRaw}.${this.hmac(`${answerHash}.${expiresAtRaw}`)}`;
  }

  /**
   * The answer, hashed with the deployment key.
   *
   * Keyed rather than a bare digest: the answers are two-digit numbers, so an unkeyed hash of
   * one is reversible by trying all of them.
   */
  private hashAnswer(answer: string): string {
    return createHmac('sha256', this.key())
      .update(`captcha-answer:${answer}`, 'utf8')
      .digest('base64url');
  }

  private hmac(payload: string): string {
    return createHmac('sha256', this.key())
      .update(`captcha-token:${payload}`, 'utf8')
      .digest('base64url');
  }

  /**
   * The signing key.
   *
   * `AUTH_ENCRYPTION_KEYS` is already required for the product to start, so this adds no new
   * configuration. Its raw value is used as the HMAC key material rather than a decoded key,
   * which is fine for a signature: the property needed is that a client cannot produce it.
   */
  private key(): string {
    return process.env['AUTH_ENCRYPTION_KEYS'] ?? 'captcha-development-only';
  }

  private static constantTimeEquals(a: string, b: string): boolean {
    const left = Buffer.from(a, 'utf8');
    const right = Buffer.from(b, 'utf8');
    return left.length === right.length && timingSafeEqual(left, right);
  }
}
