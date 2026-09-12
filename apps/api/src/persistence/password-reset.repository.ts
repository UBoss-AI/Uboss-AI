import { Injectable } from '@nestjs/common';
import type { PasswordResetToken } from '../generated/prisma/client.js';

import { PrismaService } from './prisma.service.js';

/**
 * Repository for `password_reset_tokens`.
 *
 * Person-level, not tenant-owned. Only token **hashes** are stored, so a database reader cannot
 * mint a working reset link.
 */
@Injectable()
export class PasswordResetRepository {
  constructor(private readonly prisma: PrismaService) {}

  async create(input: {
    userId: string;
    tokenHash: string;
    expiresAt: Date;
    requestedFrom?: string | undefined;
  }): Promise<PasswordResetToken> {
    return this.prisma.client.passwordResetToken.create({
      data: {
        userId: input.userId,
        tokenHash: input.tokenHash,
        expiresAt: input.expiresAt,
        ...(input.requestedFrom === undefined ? {} : { requestedFrom: input.requestedFrom }),
      },
    });
  }

  /** Find an unused token by hash. Expiry is checked by the caller so it can be audited. */
  async findUnusedByTokenHash(tokenHash: string): Promise<PasswordResetToken | null> {
    return this.prisma.client.passwordResetToken.findFirst({
      where: { tokenHash, usedAt: null },
    });
  }

  /**
   * Consume a token, atomically.
   *
   * `updateMany` with `usedAt: null` in the `where` clause makes this a compare-and-set: two
   * concurrent requests presenting the same token cannot both succeed, because only one update
   * will match. Returns 0 for the loser.
   */
  async consume(tokenId: string, at: Date): Promise<number> {
    const result = await this.prisma.client.passwordResetToken.updateMany({
      where: { id: tokenId, usedAt: null },
      data: { usedAt: at },
    });
    return result.count;
  }

  /**
   * Invalidate every outstanding token for a person.
   *
   * Called after a successful reset: issuing a new password must retire any other reset link
   * that is still in a mailbox somewhere.
   */
  async invalidateAllForUser(userId: string, at: Date): Promise<number> {
    const result = await this.prisma.client.passwordResetToken.updateMany({
      where: { userId, usedAt: null },
      data: { usedAt: at },
    });
    return result.count;
  }

  /** Recent requests for this person, used to rate-limit reset requests. */
  async countRecentForUser(userId: string, since: Date): Promise<number> {
    return this.prisma.client.passwordResetToken.count({
      where: { userId, createdAt: { gte: since } },
    });
  }
}
