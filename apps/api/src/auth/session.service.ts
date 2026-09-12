import { Inject, Injectable, Logger } from '@nestjs/common';
import type { CookieOptions, Response } from 'express';

import { PrismaService } from '../persistence/prisma.service.js';
import { SessionRepository } from '../persistence/session.repository.js';
import { AUTH_CONFIG, type AuthConfig } from './auth.config.js';
import {
  clientHintFrom,
  createOneTimeToken,
  deviceLabelFrom,
  hashToken,
} from './one-time-token.js';
import { SECURITY_ACTIONS, SecurityEventPublisher } from './security-event.publisher.js';

export interface SessionOrigin {
  userAgent?: string | undefined;
  ipAddress?: string | undefined;
  /**
   * Pre-computed device label and network hint, used when a sign-in finishes on a *different*
   * request from the one it started on — the second-factor step. The session must record where
   * the sign-in came from, not where it was completed.
   */
  deviceLabel?: string | undefined;
  clientHint?: string | undefined;
}

/**
 * How the identity behind a session was proved.
 *
 * Recorded on the session so an audit reader can tell a password sign-in from a federated one,
 * and so a provider-initiated logout can find the sessions it owns.
 */
export interface SessionAuthentication {
  primaryAuthMethod?: 'Password' | 'Oidc' | 'Saml' | undefined;
  mfaSatisfiedAt?: Date | undefined;
  ssoConnectionId?: string | undefined;
  providerSessionId?: string | undefined;
}

export interface EstablishedSession {
  sessionId: string;
  /** The opaque token to put in the cookie. Returned once and never stored in plaintext. */
  token: string;
  absoluteExpiresAt: Date;
  newDevice: boolean;
}

export type SessionValidation =
  | {
      outcome: 'valid';
      sessionId: string;
      userId: string;
      ubossUniqueId: string;
      isPlatformActor: boolean;
    }
  | { outcome: 'absent' }
  | { outcome: 'unknown' }
  | { outcome: 'idle-expired'; userId: string; sessionId: string }
  | { outcome: 'absolute-expired'; userId: string; sessionId: string };

/**
 * Server-side session lifecycle.
 *
 * UBoss uses opaque server-side sessions rather than self-contained (JWT-style) tokens. Every
 * requirement in this step — Active Sessions, Logout All Devices, admin revoke, revoke-on-
 * password-change — depends on being able to invalidate a specific session *immediately*, and a
 * stateless token cannot be un-issued. The cost is a database read per request, which is one
 * indexed lookup on a hash.
 */
@Injectable()
export class SessionService {
  private readonly logger = new Logger(SessionService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly sessions: SessionRepository,
    private readonly securityEvents: SecurityEventPublisher,
    @Inject(AUTH_CONFIG) private readonly config: AuthConfig,
  ) {}

  /** Create a session and return its one-time token. */
  async establish(
    userId: string,
    origin: SessionOrigin,
    authentication: SessionAuthentication = {},
  ): Promise<EstablishedSession> {
    const token = createOneTimeToken();
    // An explicitly supplied label/hint wins: see `SessionOrigin`.
    const deviceLabel = origin.deviceLabel ?? deviceLabelFrom(origin.userAgent);
    const clientHint = origin.clientHint ?? clientHintFrom(origin.ipAddress);

    const absoluteExpiresAt = new Date(
      Date.now() + this.config.absoluteTimeoutHours * 60 * 60 * 1000,
    );

    const { session, newDevice } = await this.prisma.runAsPlatformOperation(async () => {
      // "New" means this coarse location has not been seen for this person before. Checked
      // before the insert, or the session being created would itself count as prior history.
      const seenBefore = clientHint
        ? await this.sessions.hasSeenClientHint(userId, clientHint)
        : true;

      const created = await this.sessions.create({
        userId,
        tokenHash: token.hash,
        absoluteExpiresAt,
        deviceLabel,
        clientHint,
        ...authentication,
      });

      return { session: created, newDevice: !seenBefore };
    });

    if (newDevice) {
      await this.securityEvents.recordSuspicious({
        action: SECURITY_ACTIONS.newDeviceSignIn,
        actorUserId: userId,
        resourceType: 'session',
        resourceId: session.id,
        summary: `Sign-in from a new device or location (${deviceLabel ?? 'unknown device'}).`,
        metadata: { deviceLabel: deviceLabel ?? null, clientHint: clientHint ?? null },
      });
    }

    return { sessionId: session.id, token: token.plaintext, absoluteExpiresAt, newDevice };
  }

  /**
   * Validate a session token and refresh its idle window.
   *
   * Both expiry rules are enforced here rather than by a background job, so a session is dead
   * the moment it should be — a sweep that runs every five minutes would leave a five-minute
   * window in which an expired session still works.
   */
  async validate(token: string | undefined): Promise<SessionValidation> {
    if (!token) {
      return { outcome: 'absent' };
    }

    const now = new Date();

    return this.prisma.runAsPlatformOperation(async () => {
      const session = await this.sessions.findLiveByTokenHash(hashToken(token));

      if (!session) {
        return { outcome: 'unknown' };
      }

      if (session.absoluteExpiresAt <= now) {
        await this.sessions.revokeOwn(session.userId, session.id, 'absolute_expiry', now);
        return { outcome: 'absolute-expired', userId: session.userId, sessionId: session.id };
      }

      const idleDeadline = new Date(
        session.lastSeenAt.getTime() + this.config.idleTimeoutMinutes * 60 * 1000,
      );
      if (idleDeadline <= now) {
        await this.sessions.revokeOwn(session.userId, session.id, 'idle_timeout', now);
        return { outcome: 'idle-expired', userId: session.userId, sessionId: session.id };
      }

      // Only write when the value is meaningfully stale, so a busy session does not mean a
      // database write on every request.
      const staleBy = now.getTime() - session.lastSeenAt.getTime();
      if (staleBy > this.config.lastSeenRefreshSeconds * 1000) {
        await this.sessions.touch(session.id, now);
      }

      return {
        outcome: 'valid',
        sessionId: session.id,
        userId: session.userId,
        ubossUniqueId: session.user.ubossUniqueId,
        isPlatformActor: session.user.isPlatformActor,
      };
    });
  }

  async revokeCurrent(userId: string, sessionId: string): Promise<void> {
    await this.prisma.runAsPlatformOperation(() =>
      this.sessions.revokeOwn(userId, sessionId, 'logout', new Date()),
    );

    await this.securityEvents.record({
      action: SECURITY_ACTIONS.logout,
      actorUserId: userId,
      resourceType: 'session',
      resourceId: sessionId,
      summary: 'Signed out.',
    });
  }

  /** Revoke one of the caller's own sessions. Returns false when it is not theirs. */
  async revokeOwn(userId: string, sessionId: string): Promise<boolean> {
    const revoked = await this.prisma.runAsPlatformOperation(() =>
      this.sessions.revokeOwn(userId, sessionId, 'user_revoke', new Date()),
    );

    if (revoked === 0) {
      return false;
    }

    await this.securityEvents.record({
      action: SECURITY_ACTIONS.sessionRevoked,
      actorUserId: userId,
      resourceType: 'session',
      resourceId: sessionId,
      summary: 'Revoked one of their own sessions.',
    });
    return true;
  }

  /**
   * Log out everywhere.
   *
   * `keepCurrent` supports "sign out my other devices", which is what someone actually wants
   * after a suspicious-activity notice — signing themselves out as well would be a hostile
   * default.
   */
  async revokeAll(
    userId: string,
    options: { keepSessionId?: string; reason?: string } = {},
  ): Promise<number> {
    const reason = options.reason ?? 'logout_all';
    const revoked = await this.prisma.runAsPlatformOperation(() =>
      this.sessions.revokeAllForUser(userId, reason, new Date(), options.keepSessionId),
    );

    await this.securityEvents.record({
      action: SECURITY_ACTIONS.logoutAllDevices,
      actorUserId: userId,
      resourceType: 'user',
      resourceId: userId,
      summary: `Revoked ${revoked} session(s).`,
      metadata: { revoked, reason, keptCurrent: options.keepSessionId !== undefined },
    });

    return revoked;
  }

  /** Platform-plane administrative revoke. */
  async revokeByAdmin(
    sessionId: string,
    adminUserId: string,
    reason = 'admin_revoke',
  ): Promise<boolean> {
    const revoked = await this.prisma.runAsPlatformOperation(() =>
      this.sessions.revokeByIdForPlatform(sessionId, reason, new Date()),
    );

    if (revoked === 0) {
      return false;
    }

    await this.securityEvents.recordSuspicious({
      action: SECURITY_ACTIONS.sessionRevokedByAdmin,
      actorUserId: adminUserId,
      resourceType: 'session',
      resourceId: sessionId,
      summary: 'A platform administrator revoked a session.',
      metadata: { reason },
    });
    return true;
  }

  /**
   * Revoke a session as a **company** administrator — Prompt 32.
   *
   * Separate from `revokeByAdmin`, which is the platform doing it, and separate for a reason
   * that matters to an investigation: one is UBoss acting on a customer's tenancy and the other
   * is the customer acting on their own people. A single action for both would leave the trail
   * unable to tell them apart, and "did UBoss sign our CFO out, or did we?" is not a question to
   * answer by inference.
   *
   * The caller — `SecurityCenterService` — has already established that the session belongs to a
   * member of the company and that the actor holds `settings:Administer` at whole-company scope.
   * This method does the revoke and records it; it does not re-derive authority, because a second
   * implementation of the same check is how the two drift apart.
   *
   * `membershipCount` is recorded because a session is person-level: signing somebody out here
   * signs them out of every company they belong to, and that consequence should be visible in the
   * trail afterwards rather than reconstructed from membership history.
   */
  async revokeByCompanyAdmin(input: {
    sessionId: string;
    tenantId: string;
    actorUserId: string;
    subjectUserId: string;
    reason: string;
    membershipCount: number;
  }): Promise<boolean> {
    const revoked = await this.prisma.runAsPlatformOperation(() =>
      this.sessions.revokeByIdForPlatform(input.sessionId, 'company_admin_revoke', new Date()),
    );

    if (revoked === 0) {
      return false;
    }

    await this.securityEvents.recordSuspicious({
      action: SECURITY_ACTIONS.sessionRevokedByCompanyAdmin,
      actorUserId: input.actorUserId,
      tenantId: input.tenantId,
      subjectUserId: input.subjectUserId,
      resourceType: 'session',
      resourceId: input.sessionId,
      summary: 'A company administrator revoked a session.',
      metadata: {
        reason: input.reason,
        signedOutOfCompanies: input.membershipCount,
        // Worth recording explicitly rather than leaving to be worked out from the count: this
        // is the case where one company's administrator has ended somebody's access to another.
        crossCompanyEffect: input.membershipCount > 1,
      },
    });

    return true;
  }

  /** Every session for a person, for the Active Sessions screen. */
  async listForUser(userId: string) {
    return this.prisma.runAsPlatformOperation(() => this.sessions.listLiveForUser(userId));
  }

  /** Cookie attributes. Shared by set and clear so they cannot drift apart. */
  cookieOptions(): CookieOptions {
    return {
      // Not readable from JavaScript, so an XSS bug cannot exfiltrate the session.
      httpOnly: true,
      // HTTPS only outside development: a session cookie over plain HTTP is stealable in transit.
      secure: this.config.secureCookies,
      // `lax` rather than `strict`: it still blocks cross-site POSTs (the CSRF case that matters)
      // while letting someone follow an emailed activation link into a signed-in session.
      // `none` is never used, since it would require third-party cookie semantics.
      sameSite: 'lax',
      path: '/',
    };
  }

  setSessionCookie(response: Response, token: string, expiresAt: Date): void {
    response.cookie(this.config.sessionCookieName, token, {
      ...this.cookieOptions(),
      expires: expiresAt,
    });
  }

  clearSessionCookie(response: Response): void {
    response.clearCookie(this.config.sessionCookieName, this.cookieOptions());
  }

  get cookieName(): string {
    return this.config.sessionCookieName;
  }
}
