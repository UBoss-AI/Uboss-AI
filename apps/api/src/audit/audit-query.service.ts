import { ForbiddenException, Injectable } from '@nestjs/common';

import type { AuditEvent, SecurityEvent } from '../generated/prisma/client.js';
import { AuditTrailRepository } from '../persistence/audit-trail.repository.js';
import { PrismaService } from '../persistence/prisma.service.js';
import type { TenantScope } from '../persistence/tenant-context.js';
import { SECURITY_ACTIONS } from '../auth/security-event.publisher.js';
import { SecurityEventPublisher } from '../auth/security-event.publisher.js';
import { AuthorizationService } from '../authorization/authorization.service.js';
import { AUDIT_CHAIN_VERSION } from './audit-chain.js';

/** The largest page a filter query will return. */
export const MAX_TRAIL_PAGE = 200;

/**
 * The largest number of rows one export call will produce.
 *
 * A cap rather than "everything", because an unbounded export of a busy company's trail is both
 * a memory problem and the most efficient way for a compromised auditor account to exfiltrate a
 * company's entire operational history in one request. The cursor makes a genuine full export a
 * sequence of calls, each of which is separately audited — which is the property worth having.
 */
export const MAX_EXPORT_ROWS = 5_000;

export interface AuditFilter {
  action?: string | undefined;
  actionPrefix?: string | undefined;
  actorUserId?: string | undefined;
  resourceType?: string | undefined;
  resourceId?: string | undefined;
  from?: Date | undefined;
  to?: Date | undefined;
  before?: Date | undefined;
  limit?: number | undefined;
}

export interface SecurityFilter {
  category?: SecurityEvent['category'] | undefined;
  severity?: SecurityEvent['severity'] | undefined;
  outcome?: SecurityEvent['outcome'] | undefined;
  action?: string | undefined;
  actorUserId?: string | undefined;
  subjectUserId?: string | undefined;
  from?: Date | undefined;
  to?: Date | undefined;
  before?: Date | undefined;
  limit?: number | undefined;
}

export interface TrailPage<TRow> {
  rows: TRow[];
  /** Pass back as `before` to continue. Absent when the page is the last one. */
  nextCursor?: string;
  /** Total rows in this trail for this tenant, so a caller knows the size of what it is paging. */
  total: number;
  /** The hash format the rows were written under, so an export can be re-verified later. */
  chainVersion: string;
}

/**
 * Reading, filtering and exporting the trails, with authorization.
 *
 * ## Why an audit read requires whole-company scope
 *
 * `audit_events` has no `department_id`, and it cannot usefully have one: an event about a user
 * account or a company setting does not belong to a department. So a `Department`-scoped grant
 * of the `Audit` action **cannot be narrowed** — it would silently return the whole company's
 * trail.
 *
 * This service refuses that read rather than over-returning. Refusing is the only honest option:
 * silently returning everything makes a department-scoped grant a company-wide one, and silently
 * returning nothing makes a granted permission look like a bug. The same fail-closed reasoning
 * as `scope-unevaluable` in the Prompt 7 engine (ADR-044), applied to a different limit — and
 * the built-in role templates match, so the refusal is unreachable through them (ADR-047). It
 * exists for custom roles, which can be given `Audit` at any scope.
 *
 * ## Reading a trail is itself audited
 *
 * Every export writes a security event. "Who read the audit log" is a question auditors ask, and
 * a trail that records every change to the company but not who read it has a blind spot exactly
 * where a curious insider operates.
 *
 * Ordinary *filter* reads are not audited, deliberately: a screen that pages through the trail
 * would otherwise write an event per page and drown the thing it is reading. Export is the line,
 * because export is where data leaves the system.
 */
@Injectable()
export class AuditQueryService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly trail: AuditTrailRepository,
    private readonly authorization: AuthorizationService,
    private readonly securityEvents: SecurityEventPublisher,
  ) {}

  /** Filter one company's audit trail. Requires `settings:Audit` at whole-company scope. */
  async listAuditEvents(
    scope: TenantScope,
    userId: string,
    filter: AuditFilter,
  ): Promise<TrailPage<AuditEvent>> {
    await this.assertTrailAccess(scope, userId, 'Audit');
    return this.readAudit(scope, filter, Math.min(filter.limit ?? 50, MAX_TRAIL_PAGE));
  }

  /**
   * Export one company's audit trail. Requires `settings:Export` **and** `settings:Audit`.
   *
   * Both, not either. `Export` alone is granted to roles that export reports and performance
   * data and have no business reading the audit trail; `Audit` alone is read access. Exporting
   * the trail is the intersection, and requiring both means neither permission accidentally
   * confers it.
   */
  async exportAuditEvents(
    scope: TenantScope,
    userId: string,
    filter: AuditFilter,
  ): Promise<TrailPage<AuditEvent>> {
    await this.assertTrailAccess(scope, userId, 'Audit');
    await this.assertTrailAccess(scope, userId, 'Export');

    const page = await this.readAudit(
      scope,
      filter,
      Math.min(filter.limit ?? 1_000, MAX_EXPORT_ROWS),
    );

    await this.securityEvents.record({
      action: SECURITY_ACTIONS.auditTrailExported,
      actorUserId: userId,
      tenantId: scope.tenantId,
      resourceType: 'audit_trail',
      summary: `Exported ${page.rows.length} audit event(s).`,
      metadata: {
        rows: page.rows.length,
        filtered: Object.values(filter).some((value) => value !== undefined),
        from: filter.from?.toISOString() ?? null,
        to: filter.to?.toISOString() ?? null,
      },
    });

    return page;
  }

  /**
   * Filter one company's security trail.
   *
   * A company sees only its **own** security events. Tenant-less rows — a failed sign-in before
   * any workspace was chosen — belong to the platform security plane and are not reachable here
   * at all, because `tenantId` is fixed from the verified scope rather than taken from a filter.
   */
  async listSecurityEvents(
    scope: TenantScope,
    userId: string,
    filter: SecurityFilter,
  ): Promise<TrailPage<SecurityEvent>> {
    await this.assertTrailAccess(scope, userId, 'Audit');
    return this.readSecurity(scope, filter, Math.min(filter.limit ?? 50, MAX_TRAIL_PAGE));
  }

  async exportSecurityEvents(
    scope: TenantScope,
    userId: string,
    filter: SecurityFilter,
  ): Promise<TrailPage<SecurityEvent>> {
    await this.assertTrailAccess(scope, userId, 'Audit');
    await this.assertTrailAccess(scope, userId, 'Export');

    const page = await this.readSecurity(
      scope,
      filter,
      Math.min(filter.limit ?? 1_000, MAX_EXPORT_ROWS),
    );

    await this.securityEvents.record({
      action: SECURITY_ACTIONS.securityTrailExported,
      actorUserId: userId,
      tenantId: scope.tenantId,
      resourceType: 'security_trail',
      summary: `Exported ${page.rows.length} security event(s).`,
      metadata: { rows: page.rows.length },
    });

    return page;
  }

  /**
   * The platform security plane: every trail, across every company, plus the tenant-less rows.
   *
   * Separate method rather than a flag on the tenant one, so a tenant-scoped code path cannot
   * reach cross-tenant data by passing a parameter. The caller must already be a platform actor
   * — enforced by `@PlatformOnly` on the route — and this runs as an explicit platform
   * operation, which is what lifts RLS.
   */
  async listPlatformSecurityEvents(filter: SecurityFilter): Promise<SecurityEvent[]> {
    return this.prisma.runAsPlatformOperation(() =>
      this.trail.findSecurityEvents({
        tenantId: null,
        ...filter,
        take: Math.min(filter.limit ?? 100, MAX_TRAIL_PAGE),
      }),
    );
  }

  private async readAudit(
    scope: TenantScope,
    filter: AuditFilter,
    take: number,
  ): Promise<TrailPage<AuditEvent>> {
    return this.prisma.runInTenantTransaction(scope, async () => {
      const rows = await this.trail.findAuditEvents({
        tenantId: scope.tenantId,
        ...filter,
        take: take + 1,
      });
      const total = await this.trail.countAuditEvents(scope.tenantId);
      return AuditQueryService.paginate(rows, take, total);
    });
  }

  private async readSecurity(
    scope: TenantScope,
    filter: SecurityFilter,
    take: number,
  ): Promise<TrailPage<SecurityEvent>> {
    return this.prisma.runInTenantTransaction(scope, async () => {
      const rows = await this.trail.findSecurityEvents({
        tenantId: scope.tenantId,
        ...filter,
        take: take + 1,
      });
      const total = await this.trail.countSecurityEvents(scope.tenantId);
      return AuditQueryService.paginate(rows, take, total);
    });
  }

  /**
   * Turn `take + 1` rows into a page plus a cursor.
   *
   * One row over the page size is fetched so "is there more" is a fact rather than a guess —
   * returning a cursor whenever the page is full would give a client one empty final request
   * every time the total is an exact multiple of the page size.
   */
  private static paginate<TRow extends { occurredAt: Date }>(
    rows: TRow[],
    take: number,
    total: number,
  ): TrailPage<TRow> {
    const page = rows.slice(0, take);
    const hasMore = rows.length > take;
    const last = page[page.length - 1];
    return {
      rows: page,
      ...(hasMore && last ? { nextCursor: last.occurredAt.toISOString() } : {}),
      total,
      chainVersion: AUDIT_CHAIN_VERSION,
    };
  }

  /**
   * The authorization gate for both trails.
   *
   * Phase 1 (the route decorator) has already established that the *role* could do this. This is
   * phase 2, and the thing it adds is the scope check the guard cannot make — see the class
   * comment on why a narrower scope is refused rather than narrowed.
   */
  private async assertTrailAccess(
    scope: TenantScope,
    userId: string,
    action: 'Audit' | 'Export',
  ): Promise<void> {
    const context = await this.authorization.contextFor(scope, userId);
    await this.authorization.assertCan(context, { module: 'settings', action });

    const effective = this.authorization.scopeForListing(context, 'settings', action);
    if (effective !== 'WholeCompany') {
      throw new ForbiddenException(
        `Reading the audit trail requires whole-company scope; this grant is "${effective}". ` +
          'Audit events are not department-scoped, so a narrower grant cannot be honoured ' +
          'without returning more than it permits. Refused rather than over-returned.',
      );
    }
  }
}
