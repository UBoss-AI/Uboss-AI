import { Injectable } from '@nestjs/common';

import type { MfaChallenge, MfaFactor, MfaRecoveryCode } from '../generated/prisma/client.js';
import { PrismaService } from './prisma.service.js';

/**
 * Repository for the three person-level MFA tables: `mfa_factors`, `mfa_recovery_codes` and
 * `mfa_challenges`.
 *
 * None of them is tenant-owned, for the same reason `user_credentials` and `sessions` are not:
 * one UBoss identity keeps one set of second factors across every company it belongs to. Giving
 * them a `tenant_id` would force a person to enrol separately per employer, which is the
 * opposite of what a single permanent UBoss identity is for.
 *
 * Isolation is therefore the application's job, and the shape here enforces it: **every** method
 * is keyed by `userId`, and no endpoint anywhere accepts a user id from a request. The id always
 * comes from a verified session or a verified MFA challenge.
 */
@Injectable()
export class MfaRepository {
  constructor(private readonly prisma: PrismaService) {}

  // ---- Factors ----

  async createFactor(input: {
    userId: string;
    method?: 'Totp' | 'WebAuthn';
    label?: string | undefined;
    secretCiphertext?: string | undefined;
  }): Promise<MfaFactor> {
    return this.prisma.client.mfaFactor.create({
      data: {
        userId: input.userId,
        method: input.method ?? 'Totp',
        ...(input.label === undefined ? {} : { label: input.label }),
        ...(input.secretCiphertext === undefined
          ? {}
          : { secretCiphertext: input.secretCiphertext }),
      },
    });
  }

  async findFactor(userId: string, factorId: string): Promise<MfaFactor | null> {
    return this.prisma.client.mfaFactor.findFirst({ where: { id: factorId, userId } });
  }

  /** Every factor for a person that has not been revoked, newest first. */
  async listFactors(userId: string): Promise<MfaFactor[]> {
    return this.prisma.client.mfaFactor.findMany({
      where: { userId, state: { not: 'Revoked' } },
      orderBy: { createdAt: 'desc' },
    });
  }

  /** The factors that can actually satisfy a policy: confirmed, not revoked. */
  async listActiveFactors(userId: string): Promise<MfaFactor[]> {
    return this.prisma.client.mfaFactor.findMany({
      where: { userId, state: 'Active' },
      orderBy: { createdAt: 'asc' },
    });
  }

  async countActiveFactors(userId: string): Promise<number> {
    return this.prisma.client.mfaFactor.count({ where: { userId, state: 'Active' } });
  }

  /**
   * Activate a pending factor, atomically.
   *
   * The `state: 'Pending'` predicate makes this a compare-and-set, so two concurrent
   * confirmations of the same enrolment cannot both appear to succeed.
   */
  async confirmFactor(
    userId: string,
    factorId: string,
    at: Date,
    counter: number,
  ): Promise<number> {
    const result = await this.prisma.client.mfaFactor.updateMany({
      where: { id: factorId, userId, state: 'Pending' },
      data: {
        state: 'Active',
        confirmedAt: at,
        lastUsedAt: at,
        lastUsedCounter: BigInt(counter),
        version: { increment: 1 },
      },
    });
    return result.count;
  }

  /**
   * Record a successful verification and advance the replay guard.
   *
   * The `lastUsedCounter: { lt: counter }` predicate is the guard itself, not just an
   * optimisation: two requests presenting the same code concurrently both pass verification in
   * memory, and only the first can win this write. The second updates 0 rows and is refused.
   */
  async recordFactorUse(
    userId: string,
    factorId: string,
    at: Date,
    counter: number,
  ): Promise<number> {
    const result = await this.prisma.client.mfaFactor.updateMany({
      where: {
        id: factorId,
        userId,
        state: 'Active',
        OR: [{ lastUsedCounter: null }, { lastUsedCounter: { lt: BigInt(counter) } }],
      },
      data: { lastUsedAt: at, lastUsedCounter: BigInt(counter), version: { increment: 1 } },
    });
    return result.count;
  }

  /**
   * Revoke a factor.
   *
   * Kept as a `Revoked` row rather than deleted: "this person removed their authenticator on
   * this date" is exactly the kind of thing an incident review needs, and a deleted row cannot
   * say it. The secret is cleared at the same time, so a revoked row holds no usable material.
   */
  async revokeFactor(userId: string, factorId: string, at: Date): Promise<number> {
    const result = await this.prisma.client.mfaFactor.updateMany({
      where: { id: factorId, userId, state: { not: 'Revoked' } },
      data: { state: 'Revoked', revokedAt: at, secretCiphertext: null, version: { increment: 1 } },
    });
    return result.count;
  }

  // ---- Recovery codes ----

  /** Replace a person's codes with a new batch, retiring every previous one. */
  async replaceRecoveryCodes(userId: string, batchId: string, hashes: string[]): Promise<number> {
    // Deleted rather than marked used: an unused code from a retired batch must not be
    // distinguishable from one that was spent, and keeping them would only invite a query that
    // treats them as live.
    await this.prisma.client.mfaRecoveryCode.deleteMany({ where: { userId } });

    const created = await this.prisma.client.mfaRecoveryCode.createMany({
      data: hashes.map((codeHash) => ({ userId, batchId, codeHash })),
    });
    return created.count;
  }

  async deleteRecoveryCodes(userId: string): Promise<number> {
    const result = await this.prisma.client.mfaRecoveryCode.deleteMany({ where: { userId } });
    return result.count;
  }

  /** How many of the person's current codes are still unspent. */
  async countUnusedRecoveryCodes(userId: string): Promise<number> {
    return this.prisma.client.mfaRecoveryCode.count({ where: { userId, usedAt: null } });
  }

  async findUnusedRecoveryCode(userId: string, codeHash: string): Promise<MfaRecoveryCode | null> {
    return this.prisma.client.mfaRecoveryCode.findFirst({
      where: { userId, codeHash, usedAt: null },
    });
  }

  /**
   * Spend a recovery code, atomically.
   *
   * `usedAt: null` makes it a compare-and-set: a code presented twice in parallel can only be
   * consumed once, so two sessions cannot both be created from one code.
   */
  async consumeRecoveryCode(userId: string, codeHash: string, at: Date): Promise<number> {
    const result = await this.prisma.client.mfaRecoveryCode.updateMany({
      where: { userId, codeHash, usedAt: null },
      data: { usedAt: at },
    });
    return result.count;
  }

  // ---- Challenges (a password sign-in awaiting its second factor) ----

  async createChallenge(input: {
    userId: string;
    tokenHash: string;
    expiresAt: Date;
    deviceLabel?: string | undefined;
    clientHint?: string | undefined;
  }): Promise<MfaChallenge> {
    return this.prisma.client.mfaChallenge.create({
      data: {
        userId: input.userId,
        tokenHash: input.tokenHash,
        expiresAt: input.expiresAt,
        ...(input.deviceLabel === undefined ? {} : { deviceLabel: input.deviceLabel }),
        ...(input.clientHint === undefined ? {} : { clientHint: input.clientHint }),
      },
    });
  }

  /** Look up a live challenge by token hash, with the person it belongs to. */
  async findLiveChallengeByTokenHash(tokenHash: string, now: Date) {
    return this.prisma.client.mfaChallenge.findFirst({
      where: { tokenHash, consumedAt: null, expiresAt: { gt: now } },
      include: {
        user: {
          select: {
            id: true,
            email: true,
            displayName: true,
            ubossUniqueId: true,
            isPlatformActor: true,
          },
        },
      },
    });
  }

  async recordChallengeAttempt(challengeId: string): Promise<number> {
    const updated = await this.prisma.client.mfaChallenge.update({
      where: { id: challengeId },
      data: { attempts: { increment: 1 } },
      select: { attempts: true },
    });
    return updated.attempts;
  }

  /** Consume a challenge, atomically, so one challenge yields at most one session. */
  async consumeChallenge(challengeId: string, at: Date): Promise<number> {
    const result = await this.prisma.client.mfaChallenge.updateMany({
      where: { id: challengeId, consumedAt: null },
      data: { consumedAt: at },
    });
    return result.count;
  }

  /** Invalidate every outstanding challenge for a person — used when a challenge is abandoned. */
  async consumeAllChallenges(userId: string, at: Date): Promise<number> {
    const result = await this.prisma.client.mfaChallenge.updateMany({
      where: { userId, consumedAt: null },
      data: { consumedAt: at },
    });
    return result.count;
  }
}
