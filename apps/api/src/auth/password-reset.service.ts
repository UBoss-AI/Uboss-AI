import { Inject, Injectable, Logger } from '@nestjs/common';

import { PasswordResetRepository } from '../persistence/password-reset.repository.js';
import { PrismaService } from '../persistence/prisma.service.js';
import { UserCredentialRepository } from '../persistence/user-credential.repository.js';
import { UserRepository } from '../persistence/user.repository.js';
import { AUTH_CONFIG, type AuthConfig } from './auth.config.js';
import { clientHintFrom, createOneTimeToken, hashToken } from './one-time-token.js';
import { PasswordService } from './password.service.js';
import { SECURITY_ACTIONS, SecurityEventPublisher } from './security-event.publisher.js';
import { SessionService } from './session.service.js';

/** How many reset requests one account may make in the window before further ones are ignored. */
const MAX_REQUESTS_PER_HOUR = 5;

export interface ResetRequestOutcome {
  /**
   * The token, present only when one was actually issued.
   *
   * Returned from the service (not the HTTP layer) so the notifications module can deliver it.
   * The endpoint never returns it — see `AuthController`.
   */
  token?: string;
  userId?: string;
  email?: string;
}

export type ResetConfirmResult =
  { outcome: 'reset'; userId: string; sessionsRevoked: number } | { outcome: 'invalid' };

/**
 * Password reset by one-time hashed token.
 *
 * **An administrator can never view or set a password.** There is no code path that reveals one,
 * and no administrative "set password" operation: an admin can only trigger a reset, after which
 * the person chooses their own password. That is why this service exists rather than an admin
 * password field.
 */
@Injectable()
export class PasswordResetService {
  private readonly logger = new Logger(PasswordResetService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly users: UserRepository,
    private readonly credentials: UserCredentialRepository,
    private readonly resetTokens: PasswordResetRepository,
    private readonly passwords: PasswordService,
    private readonly sessions: SessionService,
    private readonly securityEvents: SecurityEventPublisher,
    @Inject(AUTH_CONFIG) private readonly config: AuthConfig,
  ) {}

  /**
   * Request a reset.
   *
   * Returns without a token for an unknown address, an account with no password yet, or an
   * account over its request limit — and the endpoint answers identically in every case, so this
   * cannot be used to discover which addresses have UBoss accounts.
   */
  async request(email: string, ipAddress?: string): Promise<ResetRequestOutcome> {
    const normalisedEmail = email.trim().toLowerCase();
    const now = new Date();

    const account = await this.prisma.runAsPlatformOperation(async () => {
      const user = await this.users.findByEmailForPlatform(normalisedEmail);
      if (!user) {
        return null;
      }
      const credential = await this.credentials.findByUserId(user.id);
      // Someone who has never activated has no password to reset; they need their invitation
      // resent instead, which is a different flow.
      return credential ? { user } : null;
    });

    if (!account) {
      await this.securityEvents.record({
        action: SECURITY_ACTIONS.passwordResetRequested,
        resourceType: 'user',
        summary: 'Password reset requested for an address with no resettable account.',
        // The address itself is not recorded: a log of probed addresses would be its own leak.
        metadata: { issued: false, reason: 'no_resettable_account' },
      });
      return {};
    }

    const recent = await this.prisma.runAsPlatformOperation(() =>
      this.resetTokens.countRecentForUser(
        account.user.id,
        new Date(now.getTime() - 60 * 60 * 1000),
      ),
    );

    if (recent >= MAX_REQUESTS_PER_HOUR) {
      // Rate limiting here is not just abuse prevention: without it, one request per second
      // would fill the person's mailbox with valid reset links.
      await this.securityEvents.recordSuspicious({
        action: SECURITY_ACTIONS.passwordResetRequested,
        actorUserId: account.user.id,
        resourceType: 'user',
        resourceId: account.user.id,
        summary: 'Password reset request throttled.',
        metadata: { issued: false, reason: 'rate_limited', recentRequests: recent },
      });
      return {};
    }

    const token = createOneTimeToken();
    const expiresAt = new Date(now.getTime() + this.config.passwordResetExpiryMinutes * 60 * 1000);

    await this.prisma.runAsPlatformOperation(() =>
      this.resetTokens.create({
        userId: account.user.id,
        tokenHash: token.hash,
        expiresAt,
        requestedFrom: clientHintFrom(ipAddress),
      }),
    );

    await this.securityEvents.record({
      action: SECURITY_ACTIONS.passwordResetRequested,
      actorUserId: account.user.id,
      resourceType: 'user',
      resourceId: account.user.id,
      summary: 'Password reset token issued.',
      metadata: { issued: true, expiresAt: expiresAt.toISOString() },
    });

    return { token: token.plaintext, userId: account.user.id, email: account.user.email };
  }

  /**
   * Complete a reset.
   *
   * Every live session for the person is revoked. That is the point of a reset: if the password
   * was changed because someone else had it, leaving their sessions alive would defeat the
   * exercise.
   */
  async confirm(token: string, newPassword: string): Promise<ResetConfirmResult> {
    const now = new Date();

    // Validated before the transaction so a policy rejection does not consume the token — the
    // person can correct a too-short password and retry with the same link.
    this.passwords.assertAcceptable(newPassword);

    const passwordHash = await this.passwords.hash(newPassword);

    const applied = await this.prisma.runAsPlatformOperation(async () => {
      const record = await this.resetTokens.findUnusedByTokenHash(hashToken(token));

      if (!record || record.expiresAt <= now) {
        return null;
      }

      // Compare-and-set, so the same link cannot be redeemed twice concurrently.
      const consumed = await this.resetTokens.consume(record.id, now);
      if (consumed === 0) {
        return null;
      }

      await this.credentials.setPassword(record.userId, passwordHash, now);
      // Retire any other outstanding link for this person.
      await this.resetTokens.invalidateAllForUser(record.userId, now);

      return { userId: record.userId };
    });

    if (!applied) {
      await this.securityEvents.record({
        action: SECURITY_ACTIONS.passwordResetRejected,
        resourceType: 'user',
        summary: 'Password reset rejected: the link is invalid, expired or already used.',
      });
      return { outcome: 'invalid' };
    }

    const sessionsRevoked = await this.sessions.revokeAll(applied.userId, {
      reason: 'password_changed',
    });

    await this.securityEvents.recordSuspicious({
      action: SECURITY_ACTIONS.passwordResetCompleted,
      actorUserId: applied.userId,
      resourceType: 'user',
      resourceId: applied.userId,
      summary: `Password reset completed; ${sessionsRevoked} session(s) revoked.`,
      metadata: { sessionsRevoked },
    });

    return { outcome: 'reset', userId: applied.userId, sessionsRevoked };
  }
}
