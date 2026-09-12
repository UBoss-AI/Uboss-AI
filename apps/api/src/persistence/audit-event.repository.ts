import { Injectable } from '@nestjs/common';
import type { AuditEvent } from '../generated/prisma/client.js';

import { PrismaService } from './prisma.service.js';
import type { TenantScope } from './tenant-context.js';

/**
 * **Read-only** access to `audit_events`.
 *
 * ## Why this no longer writes
 *
 * Prompt 3 built this as an append-only writer, where "append-only" meant "there is no update or
 * delete method" — a property of the code. Prompt 8 replaced that with a property of the data
 * (`REVOKE` plus triggers, ADR-046) and added hash chaining, which lives in
 * `AuditTrailRepository` because a chain link is only correct if the read of the head, the lock
 * and the write are one unit.
 *
 * The write methods were then **deleted from here** rather than left as a second path. Two paths
 * would mean new unchained rows kept being written, which would quietly turn the
 * `unchainedCount` a verification reports from "rows written before the chain existed" into
 * "…plus whatever still uses the old path". A number that means two things means nothing, and the
 * honest reporting of unverifiable rows is the whole reason that count exists.
 *
 * Write through `AuditEventService`. These reads remain because tenant-isolation tests use them
 * to prove Row-Level Security from outside the query layer.
 */
@Injectable()
export class AuditEventRepository {
  constructor(private readonly prisma: PrismaService) {}

  /** One tenant's audit trail, newest first. Matches the `(tenant_id, occurred_at DESC)` index. */
  async listForTenant(scope: TenantScope, options: { take?: number } = {}): Promise<AuditEvent[]> {
    return this.prisma.client.auditEvent.findMany({
      where: { tenantId: scope.tenantId },
      orderBy: { occurredAt: 'desc' },
      take: options.take ?? 50,
    });
  }

  async findById(scope: TenantScope, auditEventId: string): Promise<AuditEvent | null> {
    return this.prisma.client.auditEvent.findFirst({
      where: { id: auditEventId, tenantId: scope.tenantId },
    });
  }

  async countForTenant(scope: TenantScope): Promise<number> {
    return this.prisma.client.auditEvent.count({ where: { tenantId: scope.tenantId } });
  }
}
