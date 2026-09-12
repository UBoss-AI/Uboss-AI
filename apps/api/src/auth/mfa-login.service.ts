import { BadRequestException, Injectable, Logger } from '@nestjs/common';

import { MfaRepository } from '../persistence/mfa.repository.js';
import { PrismaService } from '../persistence/prisma.service.js';
import { UserRepository } from '../persistence/user.repository.js';
import { MfaService, type RecoveryCodeBatch } from './mfa.service.js';
import { hashToken } from './one-time-token.js';
import { SECURITY_ACTIONS, SecurityEventPublisher } from './security-event.publisher.js';
import { SessionService } from './session.service.js';

export interface CompletedMfaLogin {
  userId: string;
  ubossUniqueId: string;
  displayName: string;
  isPlatformActor: boolean;
  sessionToken: string;
  absoluteExpiresAt: Date;
  newDevice: boolean;
  method: 'Totp' | 'RecoveryCode';
  remainingRecoveryCodes?: number | undefined;
}

export type MfaLoginOutcome =
  | { outcome: 'signed-in'; login: CompletedMfaLogin }
  | { outcome: 'invalid' }
  | { outcome: 'expired' }
  | { outcome: 'too-many-attempts' };

/**
 * Turning a satisfied MFA challenge into a session.
 *
 * Separated from `MfaService` for one reason: **this is the only other place in the codebase
 * that can mint a session**, so it should be small, obvious and easy to audit alongside
 * `LoginService`. Burying it among enrolment and recovery-code management would make it easy to
 * miss when reviewing how a session can come into existence.
 *
 * Both paths here take the device label and network hint from the **challenge**, not from the
 * request completing it. Otherwise a sign-in that started on a laptop and finished after a
 * redirect would record the wrong origin, and the new-device signal — which is the thing that
 * tells someone "this was not me" — would be measuring the wrong request.
 */
@Injectable()
export class MfaLoginService {
  private readonly logger = new Logger(MfaLoginService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly mfa: MfaService,
    private readonly mfaRepository: MfaRepository,
    private readonly users: UserRepository,
    private readonly sessions: SessionService,
    private readonly securityEvents: SecurityEventPublisher,
  ) {}

  /** Complete a sign-in with a code from an already-enrolled factor, or a recovery code. */
  async completeWithCode(
    challengeToken: string | undefined,
    presented: string,
  ): Promise<MfaLoginOutcome> {
    const verified = await this.mfa.verifyChallenge(challengeToken, presented);

    if (verified.outcome !== 'verified') {
      return { outcome: verified.outcome };
    }

    const session = await this.sessions.establish(
      verified.userId,
      {
        ...(verified.deviceLabel === null ? {} : { deviceLabel: verified.deviceLabel }),
        ...(verified.clientHint === null ? {} : { clientHint: verified.clientHint }),
      },
      { primaryAuthMethod: 'Password', mfaSatisfiedAt: new Date() },
    );

    await this.securityEvents.record({
      action: SECURITY_ACTIONS.loginSucceeded,
      actorUserId: verified.userId,
      resourceType: 'session',
      resourceId: session.sessionId,
      summary: 'Signed in with a second factor.',
      metadata: { newDevice: session.newDevice, secondFactor: verified.method },
    });

    return {
      outcome: 'signed-in',
      login: {
        userId: verified.userId,
        ubossUniqueId: verified.ubossUniqueId,
        displayName: verified.displayName,
        isPlatformActor: verified.isPlatformActor,
        sessionToken: session.token,
        absoluteExpiresAt: session.absoluteExpiresAt,
        newDevice: session.newDevice,
        method: verified.method,
        remainingRecoveryCodes: verified.remainingRecoveryCodes,
      },
    };
  }

  /**
   * Resolve the person behind a challenge, so first-time enrolment can happen mid-sign-in.
   *
   * This is the case that stops a newly-imposed MFA requirement from being a lockout: the person
   * has a correct password and no enrolled factor, so the challenge is what authorises them to
   * enrol. It deliberately does **not** consume the challenge — enrolment takes two round trips
   * (issue a secret, then prove a code from it), and consuming it on the first would make the
   * second impossible.
   */
  async challengeHolder(
    challengeToken: string | undefined,
  ): Promise<{ userId: string; email: string; displayName: string } | null> {
    if (!challengeToken) {
      return null;
    }

    const challenge = await this.prisma.runAsPlatformOperation(() =>
      this.mfaRepository.findLiveChallengeByTokenHash(hashToken(challengeToken), new Date()),
    );

    if (!challenge) {
      return null;
    }

    return {
      userId: challenge.userId,
      email: challenge.user.email,
      displayName: challenge.user.displayName,
    };
  }

  /**
   * Finish enrolment against a challenge and sign the person in.
   *
   * The order matters and is deliberate: the factor is confirmed **first**, then the challenge is
   * consumed, then the session is created. If the process died between the first two steps the
   * person would have a working factor and have to sign in again — annoying but safe. Consuming
   * the challenge first could leave them with neither a factor nor a way back in.
   */
  async completeWithEnrolment(
    challengeToken: string | undefined,
    factorId: string,
    presentedCode: string,
  ): Promise<MfaLoginOutcome & { recoveryCodes?: RecoveryCodeBatch | null }> {
    if (challengeToken === undefined) {
      return { outcome: 'expired' };
    }

    const holder = await this.challengeHolder(challengeToken);
    if (!holder) {
      return { outcome: 'expired' };
    }

    let confirmation: { confirmed: true; recoveryCodes: RecoveryCodeBatch | null };
    try {
      confirmation = await this.mfa.confirmTotpEnrolment(holder.userId, factorId, presentedCode);
    } catch (cause) {
      if (cause instanceof BadRequestException) {
        return { outcome: 'invalid' };
      }
      throw cause;
    }

    const challenge = await this.prisma.runAsPlatformOperation(() =>
      this.mfaRepository.findLiveChallengeByTokenHash(hashToken(challengeToken), new Date()),
    );
    if (!challenge) {
      return { outcome: 'expired' };
    }

    const consumed = await this.prisma.runAsPlatformOperation(() =>
      this.mfaRepository.consumeChallenge(challenge.id, new Date()),
    );
    if (consumed === 0) {
      return { outcome: 'expired' };
    }

    const session = await this.sessions.establish(
      holder.userId,
      {
        ...(challenge.deviceLabel === null ? {} : { deviceLabel: challenge.deviceLabel }),
        ...(challenge.clientHint === null ? {} : { clientHint: challenge.clientHint }),
      },
      { primaryAuthMethod: 'Password', mfaSatisfiedAt: new Date() },
    );

    const user = await this.prisma.runAsPlatformOperation(() =>
      this.users.findByEmailForPlatform(holder.email),
    );

    await this.securityEvents.record({
      action: SECURITY_ACTIONS.loginSucceeded,
      actorUserId: holder.userId,
      resourceType: 'session',
      resourceId: session.sessionId,
      summary: 'Signed in after enrolling a second factor.',
      metadata: { newDevice: session.newDevice, secondFactor: 'Totp', firstEnrolment: true },
    });

    return {
      outcome: 'signed-in',
      login: {
        userId: holder.userId,
        ubossUniqueId: user?.ubossUniqueId ?? '',
        displayName: holder.displayName,
        isPlatformActor: user?.isPlatformActor ?? false,
        sessionToken: session.token,
        absoluteExpiresAt: session.absoluteExpiresAt,
        newDevice: session.newDevice,
        method: 'Totp',
        remainingRecoveryCodes: undefined,
      },
      recoveryCodes: confirmation.recoveryCodes,
    };
  }
}
