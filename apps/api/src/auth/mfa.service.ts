import { BadRequestException, Inject, Injectable, Logger } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import type { CookieOptions, Response } from 'express';

import { MfaRepository } from '../persistence/mfa.repository.js';
import { PrismaService } from '../persistence/prisma.service.js';
import { UserCredentialRepository } from '../persistence/user-credential.repository.js';
import { AUTH_CONFIG, type AuthConfig } from './auth.config.js';
import { createOneTimeToken, hashToken } from './one-time-token.js';
import {
  generateRecoveryCodeBatch,
  hashPresentedRecoveryCode,
  RECOVERY_CODE_BATCH_SIZE,
} from './recovery-code.js';
import { SECRET_PURPOSES, SecretBox } from './secret-box.js';
import { SECURITY_ACTIONS, SecurityEventPublisher } from './security-event.publisher.js';
import { generateTotpSecret, otpauthUri, verifyTotp } from './totp.js';

export interface EnrolmentStart {
  factorId: string;
  /** The shared secret, base32. Shown once, so it can be typed in manually. */
  secret: string;
  /** `otpauth://` URI for a QR code. Contains the same secret. */
  otpauthUri: string;
}

export interface RecoveryCodeBatch {
  /** Shown **once**. Only hashes are stored, so these can never be redisplayed. */
  codes: string[];
  generatedAt: Date;
}

export interface MfaFactorSummary {
  id: string;
  method: string;
  state: string;
  label: string | null;
  confirmedAt: string | null;
  lastUsedAt: string | null;
  createdAt: string;
}

export type ChallengeVerification =
  | {
      outcome: 'verified';
      userId: string;
      ubossUniqueId: string;
      displayName: string;
      isPlatformActor: boolean;
      method: 'Totp' | 'RecoveryCode';
      deviceLabel: string | null;
      clientHint: string | null;
      remainingRecoveryCodes?: number;
    }
  | { outcome: 'invalid' }
  | { outcome: 'expired' }
  | { outcome: 'too-many-attempts' };

/**
 * Multi-factor authentication: enrolment, verification and recovery.
 *
 * ## The challenge, and why it is not a session
 *
 * When a company requires MFA, a correct password produces an `MfaChallenge` rather than a
 * session. The challenge token goes into its own short-lived cookie and is worth nothing except
 * to complete this one sign-in.
 *
 * Modelling the half-finished login as a `Session` row with a `mfa_pending` flag was rejected: it
 * would mean every guard, every repository and every future feature had to remember that some
 * sessions are not really authenticated, and the first one that forgot would be a full
 * authentication bypass. Keeping it a separate object means `TenantGuard` needed no change at
 * all — an unfinished login simply has no session.
 *
 * ## Failures count against the same lockout
 *
 * A wrong TOTP code increments the same `user_credentials.failed_attempts` counter as a wrong
 * password. Otherwise the second factor would be the cheap thing to brute-force: six digits is
 * only a million possibilities, and an attacker who already has the password would have
 * unlimited attempts at the part meant to stop them.
 *
 * ## Method-agnostic on purpose
 *
 * Nothing outside `verifyTotpAgainstFactor` knows the factor is TOTP. Adding WebAuthn means a
 * new verifier and a new `AuthMethod` value — not a change to enrolment, policy, the challenge
 * flow, recovery codes or the cookie handling.
 */
@Injectable()
export class MfaService {
  private readonly logger = new Logger(MfaService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly mfa: MfaRepository,
    private readonly credentials: UserCredentialRepository,
    private readonly secrets: SecretBox,
    private readonly securityEvents: SecurityEventPublisher,
    @Inject(AUTH_CONFIG) private readonly config: AuthConfig,
  ) {}

  // -------------------------------------------------------------------------
  // Enrolment
  // -------------------------------------------------------------------------

  /**
   * Begin enrolling an authenticator app.
   *
   * The factor is created `Pending` and cannot satisfy any policy until the person proves they
   * can generate a code from it. That two-step shape is what stops a mis-scanned QR code from
   * producing a factor that locks them out at the next sign-in.
   */
  async startTotpEnrolment(
    userId: string,
    accountName: string,
    label?: string,
  ): Promise<EnrolmentStart> {
    const secret = generateTotpSecret();

    const factor = await this.prisma.runAsPlatformOperation(() =>
      this.mfa.createFactor({
        userId,
        method: 'Totp',
        label: label ?? 'Authenticator app',
        secretCiphertext: this.secrets.seal(secret, SECRET_PURPOSES.totpSecret),
      }),
    );

    await this.securityEvents.record({
      action: SECURITY_ACTIONS.mfaEnrolmentStarted,
      actorUserId: userId,
      resourceType: 'mfa_factor',
      resourceId: factor.id,
      summary: 'Started enrolling an authenticator app.',
      metadata: { method: 'Totp' },
    });

    return {
      factorId: factor.id,
      secret,
      otpauthUri: otpauthUri({
        secretBase32: secret,
        accountName,
        issuer: this.config.totpIssuer,
      }),
    };
  }

  /**
   * Confirm an enrolment with a code from the app, and issue recovery codes.
   *
   * Recovery codes are generated here, at the moment the first factor becomes usable, because
   * that is the only point at which we know the person has working MFA *and* still has an
   * authenticated session to receive the codes in. Handing them out later would mean a window in
   * which MFA is required and unrecoverable.
   */
  async confirmTotpEnrolment(
    userId: string,
    factorId: string,
    presentedCode: string,
  ): Promise<{ confirmed: true; recoveryCodes: RecoveryCodeBatch | null }> {
    const factor = await this.prisma.runAsPlatformOperation(() =>
      this.mfa.findFactor(userId, factorId),
    );

    if (!factor || factor.state !== 'Pending' || !factor.secretCiphertext) {
      throw new BadRequestException('There is no enrolment in progress for that factor.');
    }

    const secret = this.secrets.open(factor.secretCiphertext, SECRET_PURPOSES.totpSecret);
    const now = new Date();
    const result = verifyTotp(secret, presentedCode, {
      window: this.config.totpWindowSteps,
      now: now.getTime(),
    });

    if (!result.valid) {
      // The pending factor is left in place: a mistyped code should not force the person to
      // re-scan the QR code they are looking at.
      await this.securityEvents.record({
        action: SECURITY_ACTIONS.mfaFailed,
        actorUserId: userId,
        resourceType: 'mfa_factor',
        resourceId: factorId,
        summary: 'Enrolment code did not verify.',
        metadata: { reason: result.reason, stage: 'enrolment' },
      });
      throw new BadRequestException(
        'That code did not match. Check your authenticator app is showing the current code, ' +
          'and that its time is correct.',
      );
    }

    const hadFactorAlready = await this.prisma.runAsPlatformOperation(() =>
      this.mfa.countActiveFactors(userId),
    );

    const confirmed = await this.prisma.runAsPlatformOperation(() =>
      this.mfa.confirmFactor(userId, factorId, now, result.counter),
    );
    if (confirmed === 0) {
      throw new BadRequestException('That enrolment has already been completed.');
    }

    await this.securityEvents.record({
      action: SECURITY_ACTIONS.mfaEnrolled,
      actorUserId: userId,
      resourceType: 'mfa_factor',
      resourceId: factorId,
      summary: 'Enrolled an authenticator app.',
      metadata: { method: 'Totp' },
    });

    // Only for the *first* factor: regenerating on every enrolment would silently invalidate
    // codes the person has already printed and filed.
    const recoveryCodes =
      hadFactorAlready === 0 ? await this.regenerateRecoveryCodes(userId) : null;

    return { confirmed: true, recoveryCodes };
  }

  async listFactors(userId: string): Promise<MfaFactorSummary[]> {
    const factors = await this.prisma.runAsPlatformOperation(() => this.mfa.listFactors(userId));

    return factors.map((factor) => ({
      id: factor.id,
      method: factor.method,
      state: factor.state,
      label: factor.label,
      confirmedAt: factor.confirmedAt?.toISOString() ?? null,
      lastUsedAt: factor.lastUsedAt?.toISOString() ?? null,
      createdAt: factor.createdAt.toISOString(),
      // Deliberately absent: `secretCiphertext`. Nothing outside this service ever sees it, in
      // plaintext or sealed.
    }));
  }

  async revokeFactor(userId: string, factorId: string): Promise<boolean> {
    const revoked = await this.prisma.runAsPlatformOperation(() =>
      this.mfa.revokeFactor(userId, factorId, new Date()),
    );

    if (revoked === 0) {
      return false;
    }

    // No factors left means the recovery codes protect nothing and would only be a standing
    // bypass of a factor that no longer exists.
    const remaining = await this.prisma.runAsPlatformOperation(() =>
      this.mfa.countActiveFactors(userId),
    );
    if (remaining === 0) {
      await this.prisma.runAsPlatformOperation(() => this.mfa.deleteRecoveryCodes(userId));
    }

    await this.securityEvents.recordSuspicious({
      action: SECURITY_ACTIONS.mfaFactorRevoked,
      actorUserId: userId,
      resourceType: 'mfa_factor',
      resourceId: factorId,
      summary: 'Removed a second factor.',
      metadata: { remainingActiveFactors: remaining },
    });

    return true;
  }

  // -------------------------------------------------------------------------
  // Recovery codes
  // -------------------------------------------------------------------------

  /**
   * Issue a fresh batch, retiring every previous code.
   *
   * Returns the plaintext codes **once**. There is no endpoint that can show them again, because
   * only hashes are stored — the same property that makes a database disclosure useless also
   * makes "show me my codes again" impossible, and that is the correct trade.
   */
  async regenerateRecoveryCodes(userId: string): Promise<RecoveryCodeBatch> {
    const batch = generateRecoveryCodeBatch();
    const batchId = randomUUID();

    await this.prisma.runAsPlatformOperation(() =>
      this.mfa.replaceRecoveryCodes(
        userId,
        batchId,
        batch.map((code) => code.hash),
      ),
    );

    await this.securityEvents.record({
      action: SECURITY_ACTIONS.mfaRecoveryCodesGenerated,
      actorUserId: userId,
      resourceType: 'user',
      resourceId: userId,
      summary: `Generated ${batch.length} recovery codes.`,
      metadata: { count: batch.length, batchId },
    });

    return { codes: batch.map((code) => code.display), generatedAt: new Date() };
  }

  async countRemainingRecoveryCodes(userId: string): Promise<number> {
    return this.prisma.runAsPlatformOperation(() => this.mfa.countUnusedRecoveryCodes(userId));
  }

  // -------------------------------------------------------------------------
  // The challenge
  // -------------------------------------------------------------------------

  /** Issue a challenge after a correct password, when policy requires a second factor. */
  async issueChallenge(
    userId: string,
    origin: { deviceLabel?: string | undefined; clientHint?: string | undefined },
  ): Promise<{ token: string; expiresAt: Date }> {
    const token = createOneTimeToken();
    const expiresAt = new Date(Date.now() + this.config.mfaChallengeMinutes * 60 * 1000);

    await this.prisma.runAsPlatformOperation(async () => {
      // Any earlier challenge is abandoned. Two live challenges for one person would mean two
      // chances to guess, each with its own attempt counter.
      await this.mfa.consumeAllChallenges(userId, new Date());
      await this.mfa.createChallenge({
        userId,
        tokenHash: token.hash,
        expiresAt,
        ...(origin.deviceLabel === undefined ? {} : { deviceLabel: origin.deviceLabel }),
        ...(origin.clientHint === undefined ? {} : { clientHint: origin.clientHint }),
      });
    });

    await this.securityEvents.record({
      action: SECURITY_ACTIONS.mfaChallengeIssued,
      actorUserId: userId,
      resourceType: 'user',
      resourceId: userId,
      summary: 'Password accepted; second factor required.',
      metadata: { expiresInMinutes: this.config.mfaChallengeMinutes },
    });

    return { token: token.plaintext, expiresAt };
  }

  /**
   * Complete a challenge with a TOTP code or a recovery code.
   *
   * One entry point for both, because the caller must not be able to tell them apart from the
   * outside: a response that distinguished "wrong TOTP" from "wrong recovery code" would confirm
   * which kind of credential the attacker is holding.
   */
  async verifyChallenge(
    challengeToken: string | undefined,
    presented: string,
  ): Promise<ChallengeVerification> {
    if (!challengeToken) {
      return { outcome: 'expired' };
    }

    const now = new Date();
    const challenge = await this.prisma.runAsPlatformOperation(() =>
      this.mfa.findLiveChallengeByTokenHash(hashToken(challengeToken), now),
    );

    if (!challenge) {
      // Unknown, consumed and expired are one answer: distinguishing them would let a stolen
      // challenge cookie be probed for whether it is still worth using.
      return { outcome: 'expired' };
    }

    const attempts = await this.prisma.runAsPlatformOperation(() =>
      this.mfa.recordChallengeAttempt(challenge.id),
    );

    if (attempts > this.config.mfaMaxAttempts) {
      await this.prisma.runAsPlatformOperation(() => this.mfa.consumeChallenge(challenge.id, now));
      await this.securityEvents.recordSuspicious({
        action: SECURITY_ACTIONS.mfaFailed,
        actorUserId: challenge.userId,
        resourceType: 'user',
        resourceId: challenge.userId,
        summary: 'Second-factor challenge abandoned after too many attempts.',
        metadata: { attempts },
      });
      return { outcome: 'too-many-attempts' };
    }

    const verified = await this.attempt(challenge.userId, presented, now);

    if (!verified) {
      // Counted against the *password* lockout: six digits is a million guesses, so an attacker
      // holding the password must not get unlimited attempts at the factor meant to stop them.
      const failures = await this.prisma.runAsPlatformOperation(() =>
        this.credentials.recordFailure(challenge.userId),
      );

      await this.securityEvents.record({
        action: SECURITY_ACTIONS.mfaFailed,
        actorUserId: challenge.userId,
        resourceType: 'user',
        resourceId: challenge.userId,
        summary: 'Second factor did not verify.',
        metadata: { attempts, consecutiveCredentialFailures: failures },
      });

      return { outcome: 'invalid' };
    }

    const consumed = await this.prisma.runAsPlatformOperation(() =>
      this.mfa.consumeChallenge(challenge.id, now),
    );
    if (consumed === 0) {
      // Two requests raced and the other one won. Only one session may come from one challenge.
      return { outcome: 'expired' };
    }

    await this.prisma.runAsPlatformOperation(() =>
      this.credentials.clearFailures(challenge.userId),
    );

    await this.securityEvents.record({
      action: SECURITY_ACTIONS.mfaSucceeded,
      actorUserId: challenge.userId,
      resourceType: 'user',
      resourceId: challenge.userId,
      summary: 'Second factor verified.',
      metadata: { method: verified.method },
    });

    const remaining =
      verified.method === 'RecoveryCode'
        ? await this.countRemainingRecoveryCodes(challenge.userId)
        : undefined;

    return {
      outcome: 'verified',
      userId: challenge.userId,
      ubossUniqueId: challenge.user.ubossUniqueId,
      displayName: challenge.user.displayName,
      isPlatformActor: challenge.user.isPlatformActor,
      method: verified.method,
      deviceLabel: challenge.deviceLabel,
      clientHint: challenge.clientHint,
      ...(remaining === undefined ? {} : { remainingRecoveryCodes: remaining }),
    };
  }

  /**
   * Try the presented value as every factor the person has, then as a recovery code.
   *
   * TOTP first, because it is the overwhelmingly common case and a recovery code is a different
   * shape entirely, so there is no ambiguity to resolve.
   */
  private async attempt(
    userId: string,
    presented: string,
    now: Date,
  ): Promise<{ method: 'Totp' | 'RecoveryCode' } | null> {
    const factors = await this.prisma.runAsPlatformOperation(() =>
      this.mfa.listActiveFactors(userId),
    );

    for (const factor of factors) {
      if (factor.method !== 'Totp' || !factor.secretCiphertext) {
        // WebAuthn factors are declared in the model but have no verifier yet, and are skipped
        // rather than treated as a failure — see the class comment.
        continue;
      }

      const secret = this.secrets.open(factor.secretCiphertext, SECRET_PURPOSES.totpSecret);
      const result = verifyTotp(secret, presented, {
        window: this.config.totpWindowSteps,
        now: now.getTime(),
        ...(factor.lastUsedCounter === null
          ? {}
          : { afterCounter: Number(factor.lastUsedCounter) }),
      });

      if (result.valid) {
        // The write is the real replay guard: it only succeeds if the stored counter is still
        // lower, so two requests presenting the same code concurrently cannot both pass.
        const advanced = await this.prisma.runAsPlatformOperation(() =>
          this.mfa.recordFactorUse(userId, factor.id, now, result.counter),
        );
        if (advanced === 1) {
          return { method: 'Totp' };
        }
        return null;
      }

      if (result.reason === 'replayed') {
        await this.securityEvents.recordSuspicious({
          action: SECURITY_ACTIONS.mfaReplayRejected,
          actorUserId: userId,
          resourceType: 'mfa_factor',
          resourceId: factor.id,
          summary: 'A one-time code was presented twice and refused.',
        });
        return null;
      }
    }

    const codeHash = hashPresentedRecoveryCode(presented);
    if (codeHash === undefined) {
      return null;
    }

    const consumed = await this.prisma.runAsPlatformOperation(() =>
      this.mfa.consumeRecoveryCode(userId, codeHash, now),
    );
    if (consumed === 0) {
      return null;
    }

    await this.securityEvents.recordSuspicious({
      action: SECURITY_ACTIONS.mfaRecoveryCodeUsed,
      actorUserId: userId,
      resourceType: 'user',
      resourceId: userId,
      summary: 'Signed in with a recovery code.',
      metadata: { remaining: await this.countRemainingRecoveryCodes(userId) },
    });

    return { method: 'RecoveryCode' };
  }

  // -------------------------------------------------------------------------
  // Cookie handling
  // -------------------------------------------------------------------------

  /**
   * Attributes for the challenge cookie.
   *
   * `sameSite: 'strict'` here, unlike the session cookie's `lax`: nothing legitimately navigates
   * to the second-factor step from another site, so there is no reason to accept the cookie on a
   * cross-site navigation. The session cookie needs `lax` so an emailed activation link works;
   * this one has no such case.
   */
  challengeCookieOptions(): CookieOptions {
    return {
      httpOnly: true,
      secure: this.config.secureCookies,
      sameSite: 'strict',
      path: '/',
    };
  }

  setChallengeCookie(response: Response, token: string, expiresAt: Date): void {
    response.cookie(this.config.mfaChallengeCookieName, token, {
      ...this.challengeCookieOptions(),
      expires: expiresAt,
    });
  }

  clearChallengeCookie(response: Response): void {
    response.clearCookie(this.config.mfaChallengeCookieName, this.challengeCookieOptions());
  }

  get challengeCookieName(): string {
    return this.config.mfaChallengeCookieName;
  }

  get recoveryCodeBatchSize(): number {
    return RECOVERY_CODE_BATCH_SIZE;
  }
}
