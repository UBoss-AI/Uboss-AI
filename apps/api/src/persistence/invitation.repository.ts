import { Injectable } from '@nestjs/common';
import type { Invitation } from '../generated/prisma/client.js';

import { PrismaService } from './prisma.service.js';
import type { TenantScope } from './tenant-context.js';

/**
 * Repository for `invitations` — a tenant-owned table, so it follows the ADR-018 convention:
 * every method takes a `TenantScope` and merges `tenant_id` into the query.
 *
 * The one exception is `findLiveByTokenHashForPlatform`, used by activation. Activation is
 * **pre-authentication**: the caller holds only a token and has no workspace yet, so a tenant
 * scope cannot exist at that point. It is named to make that obvious, and the token hash is the
 * only thing that can select a row — a caller cannot enumerate invitations with it.
 */
@Injectable()
export class InvitationRepository {
  constructor(private readonly prisma: PrismaService) {}

  async create(
    scope: TenantScope,
    input: {
      userId: string;
      tokenHash: string;
      expiresAt: Date;
      invitedByUserId?: string | undefined;
    },
  ): Promise<Invitation> {
    return this.prisma.client.invitation.create({
      data: {
        tenantId: scope.tenantId,
        userId: input.userId,
        tokenHash: input.tokenHash,
        expiresAt: input.expiresAt,
        ...(input.invitedByUserId === undefined ? {} : { invitedByUserId: input.invitedByUserId }),
      },
    });
  }

  /** The outstanding (neither accepted nor cancelled) invitation for a person, if any. */
  async findOutstanding(scope: TenantScope, userId: string): Promise<Invitation | null> {
    return this.prisma.client.invitation.findFirst({
      where: { tenantId: scope.tenantId, userId, acceptedAt: null, cancelledAt: null },
      orderBy: { createdAt: 'desc' },
    });
  }

  async findById(scope: TenantScope, invitationId: string): Promise<Invitation | null> {
    return this.prisma.client.invitation.findFirst({
      where: { id: invitationId, tenantId: scope.tenantId },
    });
  }

  async listForTenant(scope: TenantScope): Promise<Invitation[]> {
    return this.prisma.client.invitation.findMany({
      where: { tenantId: scope.tenantId },
      orderBy: { createdAt: 'desc' },
      take: 200,
    });
  }

  /**
   * Replace the token on an existing invitation and extend its expiry — a resend.
   *
   * Rotating the token is the point: the previous link stops working, so a resend cannot leave
   * two valid links in two different mailboxes.
   */
  async rotateToken(
    scope: TenantScope,
    invitationId: string,
    tokenHash: string,
    expiresAt: Date,
  ): Promise<number> {
    const result = await this.prisma.client.invitation.updateMany({
      where: { id: invitationId, tenantId: scope.tenantId, acceptedAt: null, cancelledAt: null },
      data: { tokenHash, expiresAt, resendCount: { increment: 1 }, version: { increment: 1 } },
    });
    return result.count;
  }

  /** Cancel an outstanding invitation. Returns 0 if it was already accepted or cancelled. */
  async cancel(scope: TenantScope, invitationId: string, at: Date): Promise<number> {
    const result = await this.prisma.client.invitation.updateMany({
      where: { id: invitationId, tenantId: scope.tenantId, acceptedAt: null, cancelledAt: null },
      data: { cancelledAt: at, version: { increment: 1 } },
    });
    return result.count;
  }

  /**
   * Activation lookup, by token hash only. Pre-authentication, so unavoidably cross-tenant —
   * see the class comment.
   */
  async findLiveByTokenHashForPlatform(tokenHash: string): Promise<
    | (Invitation & {
        tenant: { id: string; name: string; slug: string; lifecycleState: string };
        user: { id: string; email: string; displayName: string; ubossUniqueId: string };
      })
    | null
  > {
    return this.prisma.client.invitation.findFirst({
      where: { tokenHash, acceptedAt: null, cancelledAt: null },
      include: {
        tenant: { select: { id: true, name: true, slug: true, lifecycleState: true } },
        user: { select: { id: true, email: true, displayName: true, ubossUniqueId: true } },
      },
    });
  }

  /**
   * Mark an invitation accepted, atomically.
   *
   * The `acceptedAt: null` predicate makes this a compare-and-set, so two concurrent activations
   * with the same link cannot both succeed. Runs during activation, hence platform-plane.
   */
  async acceptForPlatform(invitationId: string, at: Date): Promise<number> {
    const result = await this.prisma.client.invitation.updateMany({
      where: { id: invitationId, acceptedAt: null, cancelledAt: null },
      data: { acceptedAt: at, version: { increment: 1 } },
    });
    return result.count;
  }
}
