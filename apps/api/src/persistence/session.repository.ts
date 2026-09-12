import { Injectable } from '@nestjs/common';
import type { Session } from '../generated/prisma/client.js';

import { PrismaService } from './prisma.service.js';

export interface CreateSessionInput {
  userId: string;
  tokenHash: string;
  absoluteExpiresAt: Date;
  deviceLabel?: string | undefined;
  clientHint?: string | undefined;
  /** How the identity was proved. Defaults to `Password`, which is what it was before Prompt 6. */
  primaryAuthMethod?: 'Password' | 'Oidc' | 'Saml' | undefined;
  /** When a second factor was satisfied. Null on a session that never needed one. */
  mfaSatisfiedAt?: Date | undefined;
  /** For a federated sign-in: which connection issued it, and the provider's own session id. */
  ssoConnectionId?: string | undefined;
  providerSessionId?: string | undefined;
}

/**
 * Repository for `sessions`.
 *
 * Sessions belong to a **platform person**, not to a company, so this table is not tenant-owned
 * and carries no `tenant_id` — one person keeps one set of sessions across every company they
 * work for. Isolation is therefore enforced by the application: every method here is keyed by
 * `userId`, and no endpoint accepts a user id from the request. A caller can only ever address
 * their own sessions, except through the explicitly platform-only admin revoke.
 */
@Injectable()
export class SessionRepository {
  constructor(private readonly prisma: PrismaService) {}

  async create(input: CreateSessionInput): Promise<Session> {
    return this.prisma.client.session.create({
      data: {
        userId: input.userId,
        tokenHash: input.tokenHash,
        absoluteExpiresAt: input.absoluteExpiresAt,
        ...(input.deviceLabel === undefined ? {} : { deviceLabel: input.deviceLabel }),
        ...(input.clientHint === undefined ? {} : { clientHint: input.clientHint }),
        ...(input.primaryAuthMethod === undefined
          ? {}
          : { primaryAuthMethod: input.primaryAuthMethod }),
        ...(input.mfaSatisfiedAt === undefined ? {} : { mfaSatisfiedAt: input.mfaSatisfiedAt }),
        ...(input.ssoConnectionId === undefined ? {} : { ssoConnectionId: input.ssoConnectionId }),
        ...(input.providerSessionId === undefined
          ? {}
          : { providerSessionId: input.providerSessionId }),
      },
    });
  }

  /** Look up a live session by token hash, including the person it belongs to. */
  async findLiveByTokenHash(tokenHash: string): Promise<
    | (Session & {
        user: { id: string; ubossUniqueId: string; isPlatformActor: boolean };
      })
    | null
  > {
    return this.prisma.client.session.findFirst({
      where: { tokenHash, revokedAt: null },
      include: { user: { select: { id: true, ubossUniqueId: true, isPlatformActor: true } } },
    });
  }

  /** Refresh the sliding idle window. */
  async touch(sessionId: string, at: Date): Promise<void> {
    await this.prisma.client.session.updateMany({
      where: { id: sessionId, revokedAt: null },
      data: { lastSeenAt: at },
    });
  }

  /** A person's own live sessions, newest first. */
  async listLiveForUser(userId: string): Promise<Session[]> {
    return this.prisma.client.session.findMany({
      where: { userId, revokedAt: null },
      orderBy: { lastSeenAt: 'desc' },
    });
  }

  /**
   * Revoke one session **belonging to `userId`**.
   *
   * The user id is part of the `where` clause on purpose: a caller cannot revoke someone else's
   * session by guessing its id. Returns 0 when the session is not theirs, so the response cannot
   * distinguish "not yours" from "does not exist".
   */
  async revokeOwn(userId: string, sessionId: string, reason: string, at: Date): Promise<number> {
    const result = await this.prisma.client.session.updateMany({
      where: { id: sessionId, userId, revokedAt: null },
      data: { revokedAt: at, revokedReason: reason },
    });
    return result.count;
  }

  /**
   * Revoke every live session for a person, optionally sparing one.
   *
   * `exceptSessionId` supports "log out everywhere else", which is what someone actually wants
   * after a suspicious-activity notice — signing themselves out too would be a hostile default.
   */
  async revokeAllForUser(
    userId: string,
    reason: string,
    at: Date,
    exceptSessionId?: string,
  ): Promise<number> {
    const result = await this.prisma.client.session.updateMany({
      where: {
        userId,
        revokedAt: null,
        ...(exceptSessionId === undefined ? {} : { id: { not: exceptSessionId } }),
      },
      data: { revokedAt: at, revokedReason: reason },
    });
    return result.count;
  }

  /** Platform-plane administrative revoke of a single session, by id alone. */
  async revokeByIdForPlatform(sessionId: string, reason: string, at: Date): Promise<number> {
    const result = await this.prisma.client.session.updateMany({
      where: { id: sessionId, revokedAt: null },
      data: { revokedAt: at, revokedReason: reason },
    });
    return result.count;
  }

  /** Has this person signed in from this coarse location before? Drives the new-device hook. */
  async hasSeenClientHint(userId: string, clientHint: string): Promise<boolean> {
    const seen = await this.prisma.client.session.findFirst({
      where: { userId, clientHint },
      select: { id: true },
    });
    return seen !== null;
  }

  async countLiveForUser(userId: string): Promise<number> {
    return this.prisma.client.session.count({ where: { userId, revokedAt: null } });
  }

  /**
   * Revoke every local session belonging to one **provider** session.
   *
   * This is what makes back-channel logout mean anything: the identity provider tells us one of
   * its sessions has ended, naming it by the `sid` claim, and every UBoss session that was
   * issued from it has to end too. Without this, signing out at the provider would leave the
   * UBoss session live — which is exactly the failure mode
   * `EnterpriseIdentityProvider.terminateProviderSession` exists to prevent, seen from the
   * other direction.
   *
   * Scoped by connection as well as `sid`, because a provider session id is only unique within
   * the provider that issued it.
   */
  async revokeByProviderSessionForPlatform(
    ssoConnectionId: string,
    providerSessionId: string,
    reason: string,
    at: Date,
  ): Promise<number> {
    const result = await this.prisma.client.session.updateMany({
      where: { ssoConnectionId, providerSessionId, revokedAt: null },
      data: { revokedAt: at, revokedReason: reason },
    });
    return result.count;
  }

  /**
   * Revoke every session issued by one connection, for one person.
   *
   * Used when a back-channel logout names a subject but no session id — permitted by the OIDC
   * back-channel logout spec — and when a connection is disabled or deleted, because a session
   * issued by a connection that no longer exists cannot be re-validated against anything.
   */
  async revokeByConnectionForPlatform(
    ssoConnectionId: string,
    reason: string,
    at: Date,
    userId?: string,
  ): Promise<number> {
    const result = await this.prisma.client.session.updateMany({
      where: {
        ssoConnectionId,
        revokedAt: null,
        ...(userId === undefined ? {} : { userId }),
      },
      data: { revokedAt: at, revokedReason: reason },
    });
    return result.count;
  }
}
