import { Inject, Injectable, Logger } from '@nestjs/common';

import { PrismaService } from '../persistence/prisma.service.js';
import { UserCredentialRepository } from '../persistence/user-credential.repository.js';
import { UserRepository } from '../persistence/user.repository.js';
import { AUTH_CONFIG, type AuthConfig } from './auth.config.js';
import { PasswordService } from './password.service.js';
import { SECURITY_ACTIONS, SecurityEventPublisher } from './security-event.publisher.js';
import { TenantContextService } from '../tenancy/tenant-context.service.js';
import { AuthenticationPolicyService } from './authentication-policy.service.js';
import { MfaService } from './mfa.service.js';
import { clientHintFrom, deviceLabelFrom } from './one-time-token.js';
import { SessionService, type SessionOrigin } from './session.service.js';

export type LoginResult =
  | {
      outcome: 'success';
      userId: string;
      ubossUniqueId: string;
      displayName: string;
      isPlatformActor: boolean;
      sessionToken: string;
      absoluteExpiresAt: Date;
      newDevice: boolean;
    }
  /**
   * The password was correct but the company requires a second factor, so **no session has been
   * issued**. The challenge token is the only thing that can complete this sign-in.
   */
  | {
      outcome: 'mfa-required';
      userId: string;
      challengeToken: string;
      challengeExpiresAt: Date;
      /**
       * True when the person has no enrolled factor and must enrol to get in. The same challenge
       * covers it: enrolment completed against this challenge finishes the sign-in. Without that,
       * switching MFA on would lock out everyone who had not enrolled yet, with no way back.
       */
      enrolmentRequired: boolean;
      graceUntil: Date | null;
    }
  /**
   * The company requires enterprise SSO, so a password is not an accepted way in — whether or
   * not this one was correct.
   */
  | {
      outcome: 'sso-required';
      tenantName: string;
      connections: { id: string; displayName: string; protocol: 'Oidc' | 'Saml' }[];
    }
  | { outcome: 'invalid-credentials' }
  | { outcome: 'locked'; retryAfterSeconds: number };

/**
 * Sign-in, with throttling and lockout.
 *
 * ## Uniform failure
 *
 * An unknown email, a known email with no password set, and a wrong password all return
 * `invalid-credentials`. The caller cannot tell them apart, so the endpoint cannot be used to
 * discover which addresses have UBoss accounts. Lockout is reported distinctly, because telling
 * someone their account is temporarily locked is necessary for them to act, and the lockout
 * itself is what stops the enumeration being useful.
 *
 * ## Timing
 *
 * When no credential exists, a dummy Argon2id verification still runs. Without it, "unknown
 * email" would return in ~1 ms and "wrong password" in ~50 ms, and that difference alone is an
 * account-enumeration oracle.
 */
@Injectable()
export class LoginService {
  private readonly logger = new Logger(LoginService.name);

  /**
   * A real Argon2id hash used only to burn equivalent CPU when no credential exists.
   * The password it encodes is irrelevant and can never match, because it is never a candidate.
   */
  private dummyHash: string | undefined;

  constructor(
    private readonly prisma: PrismaService,
    private readonly users: UserRepository,
    private readonly credentials: UserCredentialRepository,
    private readonly passwords: PasswordService,
    private readonly sessions: SessionService,
    private readonly policies: AuthenticationPolicyService,
    private readonly mfa: MfaService,
    private readonly tenantContext: TenantContextService,
    private readonly securityEvents: SecurityEventPublisher,
    @Inject(AUTH_CONFIG) private readonly config: AuthConfig,
  ) {}

  async login(email: string, password: string, origin: SessionOrigin): Promise<LoginResult> {
    const normalisedEmail = email.trim().toLowerCase();

    const account = await this.prisma.runAsPlatformOperation(async () => {
      const user = await this.users.findByEmailForPlatform(normalisedEmail);
      if (!user) {
        return null;
      }
      const credential = await this.credentials.findByUserId(user.id);
      return { user, credential };
    });

    if (!account || !account.credential) {
      // Equalise timing against the "wrong password" path — see the class comment.
      await this.burnVerificationTime(password);
      await this.securityEvents.record({
        action: SECURITY_ACTIONS.loginFailed,
        ...(account ? { actorUserId: account.user.id } : {}),
        resourceType: 'user',
        summary: 'Sign-in failed.',
        // The email is deliberately absent: an audit trail of attempted addresses would itself
        // become a list of probed accounts.
        metadata: { reason: account ? 'no_credential' : 'unknown_account' },
      });
      return { outcome: 'invalid-credentials' };
    }

    const { user, credential } = account;
    const now = new Date();

    if (credential.lockedUntil && credential.lockedUntil > now) {
      const retryAfterSeconds = Math.ceil(
        (credential.lockedUntil.getTime() - now.getTime()) / 1000,
      );
      await this.securityEvents.record({
        action: SECURITY_ACTIONS.loginBlockedLockout,
        actorUserId: user.id,
        resourceType: 'user',
        resourceId: user.id,
        summary: 'Sign-in blocked: the account is temporarily locked.',
        metadata: { retryAfterSeconds },
      });
      return { outcome: 'locked', retryAfterSeconds };
    }

    const matches = await this.passwords.verify(credential.passwordHash, password);

    if (!matches) {
      const failures = await this.prisma.runAsPlatformOperation(() =>
        this.credentials.recordFailure(user.id),
      );

      if (failures >= this.config.maxFailedAttempts) {
        const lockedUntil = new Date(now.getTime() + this.config.lockoutMinutes * 60 * 1000);
        await this.prisma.runAsPlatformOperation(() =>
          this.credentials.lockUntil(user.id, lockedUntil),
        );

        await this.securityEvents.recordSuspicious({
          action: SECURITY_ACTIONS.accountLocked,
          actorUserId: user.id,
          resourceType: 'user',
          resourceId: user.id,
          summary: `Account locked after ${failures} consecutive failed sign-ins.`,
          metadata: { failures, lockoutMinutes: this.config.lockoutMinutes },
        });

        return {
          outcome: 'locked',
          retryAfterSeconds: this.config.lockoutMinutes * 60,
        };
      }

      await this.securityEvents.record({
        action: SECURITY_ACTIONS.loginFailed,
        actorUserId: user.id,
        resourceType: 'user',
        resourceId: user.id,
        summary: 'Sign-in failed: incorrect password.',
        metadata: { consecutiveFailures: failures },
      });

      return { outcome: 'invalid-credentials' };
    }

    // --- success ---
    await this.prisma.runAsPlatformOperation(() => this.credentials.clearFailures(user.id));

    // Transparently strengthen the stored hash if policy has moved on since it was written.
    if (this.passwords.needsRehash(credential.passwordHash)) {
      const upgraded = await this.passwords.hash(password);
      await this.prisma.runAsPlatformOperation(() =>
        this.credentials.upgradeHash(user.id, upgraded),
      );
      this.logger.log(`Upgraded Argon2id parameters for user ${user.id}`);
    }

    // --- policy, before any session exists ---
    //
    // Evaluated here rather than in the controller so there is exactly one place a password can
    // become a session. A second caller that skipped this would be an authentication bypass, and
    // the type makes that visible: `login` is the only thing that returns a session token.
    const memberships = await this.tenantContext.listMemberships(user.id);
    const decision = await this.policies.decideForPasswordSignIn(
      user.id,
      memberships.map((membership) => ({
        tenantId: membership.tenantId,
        tenantName: membership.tenantName,
      })),
    );

    if (decision.outcome === 'sso-required') {
      const connections = await this.policies.signInMethodsForTenant(decision.tenantId);
      await this.securityEvents.record({
        action: SECURITY_ACTIONS.loginBlockedPolicy,
        actorUserId: user.id,
        tenantId: decision.tenantId,
        resourceType: 'user',
        resourceId: user.id,
        summary: 'Password sign-in refused: this company requires enterprise SSO.',
        metadata: { requireSso: true },
      });
      return {
        outcome: 'sso-required',
        tenantName: decision.tenantName,
        connections: connections.ssoConnections,
      };
    }

    if (decision.outcome === 'mfa-required' || decision.outcome === 'mfa-enrolment-required') {
      const challenge = await this.mfa.issueChallenge(user.id, {
        deviceLabel: deviceLabelFrom(origin.userAgent),
        clientHint: clientHintFrom(origin.ipAddress),
      });

      return {
        outcome: 'mfa-required',
        userId: user.id,
        challengeToken: challenge.token,
        challengeExpiresAt: challenge.expiresAt,
        enrolmentRequired: decision.outcome === 'mfa-enrolment-required',
        graceUntil: decision.outcome === 'mfa-enrolment-required' ? decision.graceUntil : null,
      };
    }

    const session = await this.sessions.establish(user.id, origin);

    await this.securityEvents.record({
      action: SECURITY_ACTIONS.loginSucceeded,
      actorUserId: user.id,
      resourceType: 'session',
      resourceId: session.sessionId,
      summary: 'Signed in.',
      metadata: { newDevice: session.newDevice },
    });

    return {
      outcome: 'success',
      userId: user.id,
      ubossUniqueId: user.ubossUniqueId,
      displayName: user.displayName,
      isPlatformActor: user.isPlatformActor,
      sessionToken: session.token,
      absoluteExpiresAt: session.absoluteExpiresAt,
      newDevice: session.newDevice,
    };
  }

  /**
   * Spend roughly the same CPU as a real verification, so a non-existent account does not answer
   * measurably faster than a wrong password.
   */
  private async burnVerificationTime(candidate: string): Promise<void> {
    this.dummyHash ??= await this.passwords.hash('argon2-timing-equaliser-not-a-credential');
    await this.passwords.verify(this.dummyHash, candidate);
  }
}
