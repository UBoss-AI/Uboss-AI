import { Injectable } from '@nestjs/common';

import {
  AUDIT_CHAIN_VERSION,
  PLATFORM_CHAIN_KEY,
  auditRowHash,
  chainLockKey,
  securityRowHash,
  type AuditChainPayload,
  type SecurityChainPayload,
  type TrailName,
} from '../audit/audit-chain.js';
import type {
  AuditChainCheckpoint,
  AuditEvent,
  Prisma,
  SecurityEvent,
} from '../generated/prisma/client.js';
import { PrismaService } from './prisma.service.js';

/**
 * The chained, append-only writer and reader for both trails.
 *
 * ## Why the chaining lives here and not in a service
 *
 * A chain link is only correct if nothing else appends between reading the head and writing the
 * next row. That is a database-level ordering property, so the read, the lock and the write have
 * to be one unit — which makes it a repository concern. A service computing a hash and handing
 * it down would have no way to hold the position it computed it for.
 *
 * ## Why `pg_advisory_xact_lock`
 *
 * Two concurrent appends to the same chain would both read the same head and both claim the same
 * sequence. The unique index on `(chain_key, sequence)` means one of them fails rather than
 * corrupting the chain — correct, but a user-visible error for an entirely internal race. The
 * advisory lock makes them queue instead. It is transaction-scoped, so it is released on commit
 * or rollback with no cleanup path to get wrong, and it is keyed per chain, so two companies
 * never wait on each other.
 *
 * The unique index stays as the real guarantee. The lock is there so it never has to fire.
 */
@Injectable()
export class AuditTrailRepository {
  constructor(private readonly prisma: PrismaService) {}

  // -------------------------------------------------------------------------
  // Appending
  // -------------------------------------------------------------------------

  /**
   * Append one audit row, chained.
   *
   * Must be called inside a transaction that has already declared its RLS scope — the caller
   * decides whether this is tenant or platform work, because only the caller knows. The audit
   * row and the change it records then commit or roll back together, which is the point: a
   * trail that can commit without its change, or a change that can commit without its trail,
   * is not a trail.
   */
  async appendAuditEvent(input: {
    tenantId: string | null;
    action: string;
    resourceType: string;
    resourceId?: string | null;
    actorUserId?: string | null;
    summary?: string | null;
    reason?: string | null;
    resourceVersion?: number | null;
    resourceRef?: string | null;
    correlationId?: string | null;
    metadata?: Prisma.InputJsonValue | null;
    occurredAt?: Date;
  }): Promise<AuditEvent> {
    const chainKey = input.tenantId ?? PLATFORM_CHAIN_KEY;
    const occurredAt = input.occurredAt ?? new Date();

    const { sequence, prevHash } = await this.claimNextPosition('audit', chainKey);

    const payload: AuditChainPayload = {
      tenantId: input.tenantId,
      action: input.action,
      resourceType: input.resourceType,
      resourceId: input.resourceId ?? null,
      actorUserId: input.actorUserId ?? null,
      summary: input.summary ?? null,
      reason: input.reason ?? null,
      resourceVersion: input.resourceVersion ?? null,
      resourceRef: input.resourceRef ?? null,
      correlationId: input.correlationId ?? null,
      metadata: input.metadata ?? null,
      occurredAt,
    };

    const rowHash = auditRowHash({ chainKey, sequence, prevHash, payload });

    return this.prisma.client.auditEvent.create({
      data: {
        tenantId: input.tenantId,
        action: input.action,
        resourceType: input.resourceType,
        resourceId: input.resourceId ?? null,
        actorUserId: input.actorUserId ?? null,
        summary: input.summary ?? null,
        reason: input.reason ?? null,
        resourceVersion: input.resourceVersion ?? null,
        resourceRef: input.resourceRef ?? null,
        correlationId: input.correlationId ?? null,
        ...(input.metadata === undefined || input.metadata === null
          ? {}
          : { metadata: input.metadata }),
        occurredAt,
        chainKey,
        sequence,
        prevHash,
        rowHash,
      },
    });
  }

  /** Append one security row, chained. Same transactional contract as `appendAuditEvent`. */
  async appendSecurityEvent(input: {
    tenantId: string | null;
    category: SecurityEvent['category'];
    severity: SecurityEvent['severity'];
    outcome: SecurityEvent['outcome'];
    action: string;
    actorUserId?: string | null;
    subjectUserId?: string | null;
    resourceType?: string | null;
    resourceId?: string | null;
    reason?: string | null;
    deviceLabel?: string | null;
    clientHint?: string | null;
    correlationId?: string | null;
    metadata?: Prisma.InputJsonValue | null;
    occurredAt?: Date;
  }): Promise<SecurityEvent> {
    const chainKey = input.tenantId ?? PLATFORM_CHAIN_KEY;
    const occurredAt = input.occurredAt ?? new Date();

    const { sequence, prevHash } = await this.claimNextPosition('security', chainKey);

    const payload: SecurityChainPayload = {
      tenantId: input.tenantId,
      category: input.category,
      severity: input.severity,
      outcome: input.outcome,
      action: input.action,
      actorUserId: input.actorUserId ?? null,
      subjectUserId: input.subjectUserId ?? null,
      resourceType: input.resourceType ?? null,
      resourceId: input.resourceId ?? null,
      reason: input.reason ?? null,
      deviceLabel: input.deviceLabel ?? null,
      clientHint: input.clientHint ?? null,
      correlationId: input.correlationId ?? null,
      metadata: input.metadata ?? null,
      occurredAt,
    };

    const rowHash = securityRowHash({ chainKey, sequence, prevHash, payload });

    return this.prisma.client.securityEvent.create({
      data: {
        tenantId: input.tenantId,
        category: input.category,
        severity: input.severity,
        outcome: input.outcome,
        action: input.action,
        actorUserId: input.actorUserId ?? null,
        subjectUserId: input.subjectUserId ?? null,
        resourceType: input.resourceType ?? null,
        resourceId: input.resourceId ?? null,
        reason: input.reason ?? null,
        deviceLabel: input.deviceLabel ?? null,
        clientHint: input.clientHint ?? null,
        correlationId: input.correlationId ?? null,
        ...(input.metadata === undefined || input.metadata === null
          ? {}
          : { metadata: input.metadata }),
        occurredAt,
        chainKey,
        sequence,
        prevHash,
        rowHash,
      },
    });
  }

  /**
   * Take the chain's lock and read its head.
   *
   * The lock is taken **before** the read, which is the whole reason this works: locking after
   * reading would leave the read unprotected, and two appends could still agree on the same
   * head.
   *
   * `MAX(sequence)` is used rather than a counter table because the trail is append-only — the
   * maximum can never go down, so it cannot be stale in a way that matters, and there is no
   * second row to keep in step. The index on `(chain_key, sequence)` makes it a single lookup.
   */
  private async claimNextPosition(
    trail: TrailName,
    chainKey: string,
  ): Promise<{ sequence: bigint; prevHash: string | null }> {
    const lock = chainLockKey(trail, chainKey);
    // `$executeRawUnsafe`, not `$queryRawUnsafe`: `pg_advisory_xact_lock` returns `void`, and
    // the driver adapter cannot deserialize a void column — it throws
    // `UnsupportedNativeDataType`. A lock call has no result worth reading, so discarding the
    // result set is both correct and the only thing that works.
    await this.prisma.client.$executeRawUnsafe(`SELECT pg_advisory_xact_lock(${lock.toString()})`);

    const table = trail === 'audit' ? 'audit_events' : 'security_events';
    // `sequence` is `int8`, which the pg adapter returns as a decimal **string** rather than a
    // JavaScript bigint. Typing it `bigint` compiles and then lies at runtime, so the string is
    // declared and `BigInt(...)` does the conversion below.
    const rows = await this.prisma.client.$queryRawUnsafe<
      { sequence: string; row_hash: string | null }[]
    >(
      `SELECT sequence, row_hash FROM "${table}" ` +
        `WHERE chain_key = $1 AND sequence IS NOT NULL ` +
        `ORDER BY sequence DESC LIMIT 1`,
      chainKey,
    );

    const head = rows[0];
    if (!head) {
      return { sequence: 1n, prevHash: null };
    }
    return { sequence: BigInt(head.sequence) + 1n, prevHash: head.row_hash };
  }

  // -------------------------------------------------------------------------
  // Reading whole chains, for verification
  // -------------------------------------------------------------------------

  /**
   * Every chained audit row for one key, ascending.
   *
   * Deliberately unpaged: verification needs the whole chain, because a page would report a
   * spurious broken link at its first row. If a chain ever grows past what fits in memory,
   * the answer is to verify **from the last sealed checkpoint** rather than to page — the
   * checkpoint is exactly the state that makes a partial verification meaningful.
   */
  async readAuditChain(chainKey: string, fromSequence?: bigint): Promise<AuditEvent[]> {
    return this.prisma.client.auditEvent.findMany({
      where: {
        chainKey,
        ...(fromSequence === undefined ? {} : { sequence: { gt: fromSequence } }),
      },
      orderBy: { sequence: 'asc' },
    });
  }

  async readSecurityChain(chainKey: string, fromSequence?: bigint): Promise<SecurityEvent[]> {
    return this.prisma.client.securityEvent.findMany({
      where: {
        chainKey,
        ...(fromSequence === undefined ? {} : { sequence: { gt: fromSequence } }),
      },
      orderBy: { sequence: 'asc' },
    });
  }

  /**
   * Audit rows written before Prompt 8, which carry no chain data.
   *
   * Counted and reported rather than quietly excluded — see `ChainVerificationResult`.
   */
  async countUnchainedAuditRows(tenantId: string | null): Promise<number> {
    return this.prisma.client.auditEvent.count({ where: { tenantId, chainKey: null } });
  }

  // -------------------------------------------------------------------------
  // Filtering and export
  // -------------------------------------------------------------------------

  async findAuditEvents(filter: {
    tenantId: string | null;
    action?: string | undefined;
    actionPrefix?: string | undefined;
    actorUserId?: string | undefined;
    resourceType?: string | undefined;
    resourceId?: string | undefined;
    from?: Date | undefined;
    to?: Date | undefined;
    take: number;
    /** Keyset cursor: return rows strictly older than this. */
    before?: Date | undefined;
  }): Promise<AuditEvent[]> {
    return this.prisma.client.auditEvent.findMany({
      where: {
        tenantId: filter.tenantId,
        ...(filter.action === undefined ? {} : { action: filter.action }),
        ...(filter.actionPrefix === undefined
          ? {}
          : { action: { startsWith: filter.actionPrefix } }),
        ...(filter.actorUserId === undefined ? {} : { actorUserId: filter.actorUserId }),
        ...(filter.resourceType === undefined ? {} : { resourceType: filter.resourceType }),
        ...(filter.resourceId === undefined ? {} : { resourceId: filter.resourceId }),
        ...(filter.from === undefined && filter.to === undefined && filter.before === undefined
          ? {}
          : {
              occurredAt: {
                ...(filter.from === undefined ? {} : { gte: filter.from }),
                ...(filter.to === undefined ? {} : { lte: filter.to }),
                ...(filter.before === undefined ? {} : { lt: filter.before }),
              },
            }),
      },
      orderBy: [{ occurredAt: 'desc' }, { id: 'desc' }],
      take: filter.take,
    });
  }

  async countAuditEvents(tenantId: string | null): Promise<number> {
    return this.prisma.client.auditEvent.count({ where: { tenantId } });
  }

  async findSecurityEvents(filter: {
    tenantId: string | null;
    category?: SecurityEvent['category'] | undefined;
    /** Any of these categories. Ignored when `category` names one. */
    categories?: readonly SecurityEvent['category'][] | undefined;
    severity?: SecurityEvent['severity'] | undefined;
    outcome?: SecurityEvent['outcome'] | undefined;
    action?: string | undefined;
    /** Any of these actions. Ignored when `action` names one. */
    actions?: readonly string[] | undefined;
    actorUserId?: string | undefined;
    subjectUserId?: string | undefined;
    /** The request that produced the event — how an investigation joins two trails together. */
    correlationId?: string | undefined;
    resourceType?: string | undefined;
    resourceId?: string | undefined;
    from?: Date | undefined;
    to?: Date | undefined;
    take: number;
    before?: Date | undefined;
  }): Promise<SecurityEvent[]> {
    return this.prisma.client.securityEvent.findMany({
      where: {
        tenantId: filter.tenantId,
        // The singular wins where both are given, so a caller narrowing a set filter to one
        // value gets what it asked for rather than an ignored predicate.
        ...(filter.category !== undefined
          ? { category: filter.category }
          : filter.categories === undefined || filter.categories.length === 0
            ? {}
            : { category: { in: [...filter.categories] } }),
        ...(filter.severity === undefined ? {} : { severity: filter.severity }),
        ...(filter.outcome === undefined ? {} : { outcome: filter.outcome }),
        ...(filter.action !== undefined
          ? { action: filter.action }
          : filter.actions === undefined || filter.actions.length === 0
            ? {}
            : { action: { in: [...filter.actions] } }),
        ...(filter.actorUserId === undefined ? {} : { actorUserId: filter.actorUserId }),
        ...(filter.subjectUserId === undefined ? {} : { subjectUserId: filter.subjectUserId }),
        ...(filter.correlationId === undefined ? {} : { correlationId: filter.correlationId }),
        ...(filter.resourceType === undefined ? {} : { resourceType: filter.resourceType }),
        ...(filter.resourceId === undefined ? {} : { resourceId: filter.resourceId }),
        ...(filter.from === undefined && filter.to === undefined && filter.before === undefined
          ? {}
          : {
              occurredAt: {
                ...(filter.from === undefined ? {} : { gte: filter.from }),
                ...(filter.to === undefined ? {} : { lte: filter.to }),
                ...(filter.before === undefined ? {} : { lt: filter.before }),
              },
            }),
      },
      orderBy: [{ occurredAt: 'desc' }, { id: 'desc' }],
      take: filter.take,
    });
  }

  async countSecurityEvents(tenantId: string | null): Promise<number> {
    return this.prisma.client.securityEvent.count({ where: { tenantId } });
  }

  /**
   * How many security events match a filter.
   *
   * The Security Center needs this and the whole-trail count is the wrong number for it: a view
   * that says "12 of 4,318" when it is showing every export there has ever been is telling the
   * reader about the audit trail's size rather than about their exports.
   */
  async countSecurityEventsMatching(filter: {
    tenantId: string | null;
    category?: SecurityEvent['category'] | undefined;
    categories?: readonly SecurityEvent['category'][] | undefined;
    severity?: SecurityEvent['severity'] | undefined;
    outcome?: SecurityEvent['outcome'] | undefined;
    action?: string | undefined;
    actions?: readonly string[] | undefined;
    actorUserId?: string | undefined;
    subjectUserId?: string | undefined;
    correlationId?: string | undefined;
    from?: Date | undefined;
    to?: Date | undefined;
  }): Promise<number> {
    return this.prisma.client.securityEvent.count({
      where: {
        tenantId: filter.tenantId,
        ...(filter.category !== undefined
          ? { category: filter.category }
          : filter.categories === undefined || filter.categories.length === 0
            ? {}
            : { category: { in: [...filter.categories] } }),
        ...(filter.severity === undefined ? {} : { severity: filter.severity }),
        ...(filter.outcome === undefined ? {} : { outcome: filter.outcome }),
        ...(filter.action !== undefined
          ? { action: filter.action }
          : filter.actions === undefined || filter.actions.length === 0
            ? {}
            : { action: { in: [...filter.actions] } }),
        ...(filter.actorUserId === undefined ? {} : { actorUserId: filter.actorUserId }),
        ...(filter.subjectUserId === undefined ? {} : { subjectUserId: filter.subjectUserId }),
        ...(filter.correlationId === undefined ? {} : { correlationId: filter.correlationId }),
        ...(filter.from === undefined && filter.to === undefined
          ? {}
          : {
              occurredAt: {
                ...(filter.from === undefined ? {} : { gte: filter.from }),
                ...(filter.to === undefined ? {} : { lte: filter.to }),
              },
            }),
      },
    });
  }

  // -------------------------------------------------------------------------
  // Checkpoints
  // -------------------------------------------------------------------------

  /**
   * Seal a chain position.
   *
   * A checkpoint is only worth anything once it exists **outside** this database — which is why
   * `externalAnchorRef` is a column rather than an assumption, and why a checkpoint that has
   * never been anchored says so. Sealing one is still useful before that: it fixes a position
   * an operator can write down, and it is the state from which a partial verification is
   * meaningful.
   */
  async sealCheckpoint(input: {
    chainKey: string;
    trail: TrailName;
    sequence: bigint;
    rowHash: string;
    rowCount: bigint;
    sealedByUserId?: string | null;
    externalAnchorRef?: string | null;
  }): Promise<AuditChainCheckpoint> {
    return this.prisma.client.auditChainCheckpoint.create({
      data: {
        chainKey: input.chainKey,
        trail: input.trail,
        sequence: input.sequence,
        rowHash: input.rowHash,
        rowCount: input.rowCount,
        sealedByUserId: input.sealedByUserId ?? null,
        externalAnchorRef: input.externalAnchorRef ?? null,
        ...(input.externalAnchorRef ? { anchoredAt: new Date() } : {}),
      },
    });
  }

  async latestCheckpoint(chainKey: string, trail: TrailName): Promise<AuditChainCheckpoint | null> {
    return this.prisma.client.auditChainCheckpoint.findFirst({
      where: { chainKey, trail },
      orderBy: { sequence: 'desc' },
    });
  }

  async listCheckpoints(chainKey: string, trail?: TrailName): Promise<AuditChainCheckpoint[]> {
    return this.prisma.client.auditChainCheckpoint.findMany({
      where: { chainKey, ...(trail === undefined ? {} : { trail }) },
      orderBy: { sealedAt: 'desc' },
      take: 50,
    });
  }

  /** The hash-format version this build writes. Recorded on an export so it can be re-verified. */
  get chainVersion(): string {
    return AUDIT_CHAIN_VERSION;
  }
}
