import {
  BadRequestException,
  Controller,
  Get,
  Post,
  Query,
  UnauthorizedException,
} from '@nestjs/common';

import { RequirePermission } from '../authorization/authorization.decorators.js';
import { actorUserId } from '../request-context/authenticated-actor.js';
import { getActor } from '../request-context/request-context.js';
import { TenantContextService } from '../tenancy/tenant-context.service.js';
import { PlatformOnly, TenantScoped } from '../tenancy/tenancy.decorators.js';
import type { AuditEvent, SecurityEvent } from '../generated/prisma/client.js';
import { AuditChainService } from './audit-chain.service.js';
import { AuditQueryService, type TrailPage } from './audit-query.service.js';
import { AuditFilterDto, SealCheckpointDto, SecurityFilterDto } from './audit.dto.js';
import { AUDIT_CHAIN_VERSION } from './audit-chain.js';

/**
 * A company's own audit and security trails.
 *
 * ## This is the first controller in the product a Company Admin actually reaches
 *
 * Every tenant-facing route on Prompts 5–7 is still `@PlatformOnly`, waiting for company
 * administration to be re-homed onto the Prompt 7 engine. These routes are not: they are
 * `@TenantScoped` with `@RequirePermission({ module: 'settings', action: 'Audit' })`, which is
 * the engine doing the job it was built for. A company reading its own trail needs no platform
 * involvement, and making it wait for the re-homing would have been an odd place to draw the
 * line.
 *
 * `@TenantScoped` establishes *which* company and that the caller belongs to it;
 * `@RequirePermission` establishes that their role could ever read a trail; and the service adds
 * the scope check the guard cannot make, because `audit_events` is not department-scoped.
 * All three, in that order.
 */
@Controller('tenants/:tenantId/audit')
@TenantScoped()
export class AuditController {
  constructor(
    private readonly queries: AuditQueryService,
    private readonly chains: AuditChainService,
    private readonly tenantContext: TenantContextService,
  ) {}

  /** The action vocabulary and the filter fields, so a screen renders from the server's list. */
  @Get('vocabulary')
  @RequirePermission({ module: 'settings', action: 'Audit' })
  vocabulary(): Record<string, unknown> {
    return {
      chainVersion: AUDIT_CHAIN_VERSION,
      securityCategories: ['Login', 'Session', 'Risk', 'Support', 'Access'],
      securitySeverities: ['Info', 'Notice', 'Warning', 'Critical'],
      securityOutcomes: ['Succeeded', 'Failed', 'Blocked'],
      guarantee:
        'Rows cannot be updated or deleted by the application. Any alteration is detectable by ' +
        'recomputing the chain. See the verify endpoint for the exact, current guarantee.',
    };
  }

  @Get('events')
  @RequirePermission({ module: 'settings', action: 'Audit' })
  async listAuditEvents(@Query() query: AuditFilterDto): Promise<unknown> {
    AuditController.rejectConflictingActionFilters(query);
    return serialisePage(
      await this.queries.listAuditEvents(
        this.tenantContext.requireScope(),
        this.currentUserId(),
        AuditController.toAuditFilter(query),
      ),
      serialiseAuditRow,
    );
  }

  /**
   * Export the audit trail. Requires `Audit` **and** `Export`.
   *
   * A `POST`, despite reading nothing: the export writes a security event recording who took a
   * copy of the company's history, so it is not a safe, idempotent, cacheable operation and
   * should not look like one. Filters travel as query parameters so an export and the list it
   * came from take the same shape.
   */
  @Post('events/export')
  @RequirePermission({ module: 'settings', action: 'Export' })
  async exportAuditEvents(@Query() query: AuditFilterDto): Promise<unknown> {
    AuditController.rejectConflictingActionFilters(query);
    return serialisePage(
      await this.queries.exportAuditEvents(
        this.tenantContext.requireScope(),
        this.currentUserId(),
        AuditController.toAuditFilter(query),
      ),
      serialiseAuditRow,
    );
  }

  @Get('security-events')
  @RequirePermission({ module: 'settings', action: 'Audit' })
  async listSecurityEvents(@Query() query: SecurityFilterDto): Promise<unknown> {
    return serialisePage(
      await this.queries.listSecurityEvents(
        this.tenantContext.requireScope(),
        this.currentUserId(),
        AuditController.toSecurityFilter(query),
      ),
      serialiseSecurityRow,
    );
  }

  @Post('security-events/export')
  @RequirePermission({ module: 'settings', action: 'Export' })
  async exportSecurityEvents(@Query() query: SecurityFilterDto): Promise<unknown> {
    return serialisePage(
      await this.queries.exportSecurityEvents(
        this.tenantContext.requireScope(),
        this.currentUserId(),
        AuditController.toSecurityFilter(query),
      ),
      serialiseSecurityRow,
    );
  }

  /**
   * Verify both chains and report the exact guarantee.
   *
   * A `POST` because it writes a security event either way — "somebody checked whether the trail
   * was intact" is itself worth recording, and a failed check is a `Critical` event.
   */
  @Post('verify')
  @RequirePermission({ module: 'settings', action: 'Audit' })
  async verify(): Promise<unknown> {
    return this.chains.verifyForTenant(this.tenantContext.requireScope(), this.currentUserId());
  }

  @Get('checkpoints')
  @RequirePermission({ module: 'settings', action: 'Audit' })
  async listCheckpoints(): Promise<unknown> {
    const checkpoints = await this.chains.listCheckpoints(
      this.tenantContext.requireScope(),
      this.currentUserId(),
    );
    return { checkpoints: checkpoints.map(serialiseCheckpoint) };
  }

  /**
   * Seal a checkpoint at the current head.
   *
   * Requires `Administer` on settings rather than `Audit`, because sealing *changes* something:
   * it fixes a baseline that later verifications are measured from. An auditor reads; sealing is
   * an administrative act.
   */
  @Post('checkpoints')
  @RequirePermission({ module: 'settings', action: 'Administer' })
  async sealCheckpoint(@Query() query: SealCheckpointDto): Promise<unknown> {
    const scope = this.tenantContext.requireScope();
    const checkpoint = await this.chains.sealCheckpoint({
      chainKey: scope.tenantId,
      trail: query.trail,
      scope,
      sealedByUserId: this.currentUserId(),
      ...(query.externalAnchorRef === undefined
        ? {}
        : { externalAnchorRef: query.externalAnchorRef }),
    });
    return serialiseCheckpoint(checkpoint);
  }

  private currentUserId(): string {
    const userId = actorUserId(getActor());
    if (!userId) {
      // Unreachable through the guards, which is why it throws rather than defaulting: a trail
      // read attributed to nobody is worse than a failed request.
      throw new UnauthorizedException('An audit read requires an identified user.');
    }
    return userId;
  }

  /**
   * Refuse `action` and `actionPrefix` together.
   *
   * They would both land in the same Prisma `where` key and one would silently win. On a normal
   * list that is a bug; on an audit export it is a result set that does not match what was
   * asked for, which is the one thing an export must never be.
   */
  private static rejectConflictingActionFilters(query: AuditFilterDto): void {
    if (query.action !== undefined && query.actionPrefix !== undefined) {
      throw new BadRequestException(
        'Use either action or actionPrefix, not both: they filter the same column, so one would ' +
          'be silently ignored.',
      );
    }
  }

  private static toAuditFilter(
    query: AuditFilterDto,
  ): Parameters<AuditQueryService['listAuditEvents']>[2] {
    return {
      action: query.action,
      actionPrefix: query.actionPrefix,
      actorUserId: query.actorUserId,
      resourceType: query.resourceType,
      resourceId: query.resourceId,
      from: query.from === undefined ? undefined : new Date(query.from),
      to: query.to === undefined ? undefined : new Date(query.to),
      before: query.before === undefined ? undefined : new Date(query.before),
      limit: query.limit,
    };
  }

  private static toSecurityFilter(
    query: SecurityFilterDto,
  ): Parameters<AuditQueryService['listSecurityEvents']>[2] {
    return {
      category: query.category,
      severity: query.severity,
      outcome: query.outcome,
      action: query.action,
      actorUserId: query.actorUserId,
      subjectUserId: query.subjectUserId,
      from: query.from === undefined ? undefined : new Date(query.from),
      to: query.to === undefined ? undefined : new Date(query.to),
      before: query.before === undefined ? undefined : new Date(query.before),
      limit: query.limit,
    };
  }
}

/**
 * The platform security plane: cross-tenant security events and the platform chains.
 *
 * Separate controller rather than a flag, so no tenant-scoped route can reach cross-tenant data
 * by passing a parameter. Tenant-less rows — a failed sign-in before any workspace was chosen —
 * exist only here.
 */
@Controller('platform/security')
@PlatformOnly()
export class PlatformSecurityController {
  constructor(
    private readonly queries: AuditQueryService,
    private readonly chains: AuditChainService,
  ) {}

  @Get('events')
  async listPlatformSecurityEvents(@Query() query: SecurityFilterDto): Promise<unknown> {
    const rows = await this.queries.listPlatformSecurityEvents({
      category: query.category,
      severity: query.severity,
      outcome: query.outcome,
      action: query.action,
      actorUserId: query.actorUserId,
      subjectUserId: query.subjectUserId,
      from: query.from === undefined ? undefined : new Date(query.from),
      to: query.to === undefined ? undefined : new Date(query.to),
      before: query.before === undefined ? undefined : new Date(query.before),
      limit: query.limit,
    });
    return { rows: rows.map(serialiseSecurityRow), chainVersion: AUDIT_CHAIN_VERSION };
  }

  @Post('verify')
  async verifyPlatformChains(): Promise<unknown> {
    return this.chains.verifyPlatformChains();
  }
}

/**
 * The API shape of an audit row.
 *
 * Two reasons this is written out field by field rather than returned raw. The one that forced
 * it: `sequence` is a PostgreSQL `int8`, which Prisma hands back as a JavaScript `bigint`, and
 * `JSON.stringify` **throws** on a bigint — every read endpoint returned a 500 until this
 * existed. The one that matters more: adding a column to `audit_events` should not silently
 * publish it to every caller with `Audit` permission.
 *
 * `sequence` is rendered as a string, not a number: a chain position can exceed
 * `Number.MAX_SAFE_INTEGER`, and a position that silently loses precision would make an
 * exported row impossible to verify.
 */
function serialiseAuditRow(row: AuditEvent): Record<string, unknown> {
  return {
    id: row.id,
    tenantId: row.tenantId,
    action: row.action,
    resourceType: row.resourceType,
    resourceId: row.resourceId,
    actorUserId: row.actorUserId,
    summary: row.summary,
    reason: row.reason,
    resourceVersion: row.resourceVersion,
    resourceRef: row.resourceRef,
    correlationId: row.correlationId,
    metadata: row.metadata,
    occurredAt: row.occurredAt,
    chain: {
      key: row.chainKey,
      sequence: row.sequence === null ? null : row.sequence.toString(),
      prevHash: row.prevHash,
      rowHash: row.rowHash,
    },
  };
}

/** The API shape of a security row. Same reasoning as {@link serialiseAuditRow}. */
function serialiseSecurityRow(row: SecurityEvent): Record<string, unknown> {
  return {
    id: row.id,
    tenantId: row.tenantId,
    category: row.category,
    severity: row.severity,
    outcome: row.outcome,
    action: row.action,
    actorUserId: row.actorUserId,
    subjectUserId: row.subjectUserId,
    resourceType: row.resourceType,
    resourceId: row.resourceId,
    reason: row.reason,
    deviceLabel: row.deviceLabel,
    clientHint: row.clientHint,
    correlationId: row.correlationId,
    metadata: row.metadata,
    occurredAt: row.occurredAt,
    chain: {
      key: row.chainKey,
      sequence: row.sequence.toString(),
      prevHash: row.prevHash,
      rowHash: row.rowHash,
    },
  };
}

/** Replace a page's rows with their serialised form, keeping the cursor and totals. */
function serialisePage<TRow>(
  page: TrailPage<TRow>,
  serialiser: (row: TRow) => Record<string, unknown>,
): Record<string, unknown> {
  return { ...page, rows: page.rows.map(serialiser) };
}

/**
 * `BigInt` has no JSON representation, so `sequence` and `rowCount` are rendered as strings.
 *
 * Strings rather than numbers on purpose: a sequence can exceed `Number.MAX_SAFE_INTEGER`, and
 * a chain position that silently loses precision would make a checkpoint unverifiable.
 */
function serialiseCheckpoint(checkpoint: {
  id: string;
  chainKey: string;
  trail: string;
  sequence: bigint;
  rowHash: string;
  rowCount: bigint;
  externalAnchorRef: string | null;
  anchoredAt: Date | null;
  sealedByUserId: string | null;
  sealedAt: Date;
}): Record<string, unknown> {
  return {
    id: checkpoint.id,
    chainKey: checkpoint.chainKey,
    trail: checkpoint.trail,
    sequence: checkpoint.sequence.toString(),
    rowHash: checkpoint.rowHash,
    rowCount: checkpoint.rowCount.toString(),
    externalAnchorRef: checkpoint.externalAnchorRef,
    anchoredAt: checkpoint.anchoredAt,
    sealedByUserId: checkpoint.sealedByUserId,
    sealedAt: checkpoint.sealedAt,
    anchored: checkpoint.externalAnchorRef !== null,
  };
}
