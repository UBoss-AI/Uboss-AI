import { Injectable } from '@nestjs/common';
import type { UserCredential } from '../generated/prisma/client.js';

import { PrismaService } from './prisma.service.js';

/**
 * Repository for `user_credentials`.
 *
 * One row per platform person: a person keeps one UBoss identity and one password across every
 * company they work for.
 *
 * There is deliberately **no** method that returns a password, and none that could — the table
 * stores only an Argon2id hash. `findByUserId` returns the row including that hash because
 * verification needs it; nothing else in the codebase reads `passwordHash`, and it is never
 * serialised into a response.
 */
@Injectable()
export class UserCredentialRepository {
  constructor(private readonly prisma: PrismaService) {}

  async findByUserId(userId: string): Promise<UserCredential | null> {
    return this.prisma.client.userCredential.findUnique({ where: { userId } });
  }

  /**
   * Create or replace the credential for a person.
   *
   * Upsert rather than create: activation and password reset both end here, and a reset must
   * overwrite rather than fail. Setting a password always clears any lockout, because the person
   * has just proven control of their mailbox — continuing to lock them out would strand them.
   */
  async setPassword(userId: string, passwordHash: string, at: Date): Promise<UserCredential> {
    return this.prisma.client.userCredential.upsert({
      where: { userId },
      create: { userId, passwordHash, passwordUpdatedAt: at },
      update: {
        passwordHash,
        passwordUpdatedAt: at,
        failedAttempts: 0,
        lockedUntil: null,
        version: { increment: 1 },
      },
    });
  }

  /** Record a failed sign-in and return the new consecutive-failure count. */
  async recordFailure(userId: string): Promise<number> {
    const updated = await this.prisma.client.userCredential.update({
      where: { userId },
      data: { failedAttempts: { increment: 1 } },
      select: { failedAttempts: true },
    });
    return updated.failedAttempts;
  }

  async lockUntil(userId: string, until: Date): Promise<void> {
    await this.prisma.client.userCredential.update({
      where: { userId },
      data: { lockedUntil: until },
    });
  }

  /** Clear the failure counter and any lockout after a successful sign-in. */
  async clearFailures(userId: string): Promise<void> {
    await this.prisma.client.userCredential.update({
      where: { userId },
      data: { failedAttempts: 0, lockedUntil: null },
    });
  }

  /** Replace a hash whose Argon2 parameters are below current policy. */
  async upgradeHash(userId: string, passwordHash: string): Promise<void> {
    await this.prisma.client.userCredential.update({
      where: { userId },
      data: { passwordHash, version: { increment: 1 } },
    });
  }
}
