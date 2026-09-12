import { ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';

import {
  DEFAULT_SECURITY_TIME_RANGE,
  countTone,
  guestExpiry,
  guestTone,
  mfaCoverage,
  mfaCoverageTone,
  rangeStart,
  SECURITY_CENTER_EXPORT_ACTION,
  SECURITY_CENTER_MODULE,
  SECURITY_CENTER_READ_ACTION,
  SECURITY_CENTER_REVOKE_ACTION,
  SECURITY_CENTER_VIEW_LABELS,
  SECURITY_CENTER_VIEW_PURPOSE,
  SECURITY_CENTER_VIEW_SOURCE,
  SECURITY_CENTER_VIEWS,
  SECURITY_EXPORT_ACTIONS,
  SECURITY_METRIC_DRILLDOWN,
  SECURITY_METRIC_LABELS,
  SSO_STATUS_LABELS,
  ssoStatus,
  supportAccessTone,
  type SecurityCenterView,
  type SecurityMetricReading,
  type SecurityTimeRange,
} from '@uboss/types';

import { SECURITY_ACTIONS, SecurityEventPublisher } from '../auth/security-event.publisher.js';
import { SessionService } from '../auth/session.service.js';
import { AuthorizationService } from '../authorization/authorization.service.js';
import { AuditTrailRepository } from '../persistence/audit-trail.repository.js';
import { PrismaService } from '../persistence/prisma.service.js';
import type { TenantScope } from '../persistence/tenant-context.js';
import { AuditEventService } from './audit-event.service.js';

/** One row of whichever view was asked for, flattened so a client renders columns, not unions. */
export interface SecurityCenterRow {
  id: string;
  /** When it happened, or when the thing began. Always present so a table can sort. */
  occurredAt: string;
  /** The headline — an action name for an event, a person for a session or a guest. */
  title: string;
  /** Who did it, by display name where the person is still known. */
  actor: string | null;
  /** Who it was done to, where that is a different person. */
  subject: string | null;
  /** `Succeeded`, `Failed`, `Blocked`, or a state word for a session or a guest. */
  state: string;
  severity: string | null;
  detail: string | null;
  /** The request that produced the row, where it came from a request at all. */
  correlationId: string | null;
  resourceType: string | null;
  resourceId: string | null;
  /**
   * Whether this row can be acted on, and how. Only Active Sessions has an action, and the
   * client is told rather than left to infer it from the view name.
   */
  revocableSessionId: string | null;
}

export interface SecurityCenterPage {
  view: SecurityCenterView;
  label: string;
  purpose: string;
  rows: SecurityCenterRow[];
  /** Rows matching the filter, not rows in the trail. */
  total: number;
  nextCursor?: string;
  /** What this view cannot show, stated on the view rather than buried in a document. */
  limitation?: string;
}

export interface SecurityPosture {
  range: SecurityTimeRange;
  metrics: SecurityMetricReading[];
  /** Set when the caller may read but not export, so the UI can hide the button honestly. */
  mayExport: boolean;
  mayRevokeSessions: boolean;
}

/** A list page. The DTO caps `limit` too; this is the service refusing to depend on that. */
const MAX_PAGE = 100;
/** An export. Larger, because an export is the request that legitimately wants everything. */
const MAX_EXPORT_ROWS = 5_000;

/**
 * The Security Center — Prompt 32.
 *
 * ## It composes; it does not record
 *
 * Every figure and every row here comes from the module that owns the fact: `security_events` for
 * authentication, access and support, `sessions` for who is signed in, `tenant_memberships` for
 * guests, `connection_tool_grants` for what an Engine Agent may do, `mfa_factors` and
 * `sso_connections` for coverage. This service adds **no table**, and that is the security
 * property rather than a tidiness preference — a Security Center with its own copy of the
 * evidence gives an investigation two versions of the truth and a first question of which to
 * believe, and the copy would not inherit the append-only triggers that protect the originals.
 *
 * ## Why the authorization is checked here and not only at the route
 *
 * The route decorator establishes that the *role* may reach the module. What it cannot establish
 * is scope, and scope is the whole difference between an auditor who may read the company's
 * security history and a department head who may not. `assertWholeCompany` refuses a narrower
 * grant outright rather than narrowing the result, for the reason `AuditQueryService` already
 * gives: security events are not department-scoped, so there is nothing to narrow *to*, and
 * returning "what a department head is allowed to see" would mean returning everything.
 */
@Injectable()
export class SecurityCenterService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly trail: AuditTrailRepository,
    private readonly authorization: AuthorizationService,
    private readonly securityEvents: SecurityEventPublisher,
    private readonly auditEvents: AuditEventService,
    private readonly sessions: SessionService,
  ) {}

  // -------------------------------------------------------------------------
  // Posture
  // -------------------------------------------------------------------------

  /**
   * The eleven metrics §27.1 and the Technical Architecture name.
   *
   * Counted over a window the caller chooses, because a count with no period is unreadable: 47
   * failed logins today is an incident and 47 this quarter is background noise. Every figure that
   * has a window is captioned with it.
   */
  async posture(input: {
    scope: TenantScope;
    actorUserId: string;
    range?: SecurityTimeRange | undefined;
    guestHorizonDays?: number | undefined;
    now?: Date | undefined;
  }): Promise<SecurityPosture> {
    await this.assertWholeCompany(input.scope, input.actorUserId, SECURITY_CENTER_READ_ACTION);

    const range = input.range ?? DEFAULT_SECURITY_TIME_RANGE;
    const now = input.now ?? new Date();
    const from = rangeStart(range, now);

    const mayExport = await this.holds(
      input.scope,
      input.actorUserId,
      SECURITY_CENTER_EXPORT_ACTION,
    );
    const mayRevokeSessions = await this.holds(
      input.scope,
      input.actorUserId,
      SECURITY_CENTER_REVOKE_ACTION,
    );

    const identity = await this.identityPosture(input.scope, {
      now,
      guestHorizonDays: input.guestHorizonDays,
    });
    const events = await this.eventPosture(input.scope, from, now);

    const coverage = mfaCoverage({
      activeMembers: identity.activeMembers,
      membersWithConfirmedFactor: identity.membersWithFactor,
    });
    const sso = ssoStatus({
      connections: identity.ssoConnections,
      enabledConnections: identity.ssoEnabled,
      requireSso: identity.requireSso,
    });
    const guests = identity.guests;

    const metrics: SecurityMetricReading[] = [
      {
        metric: 'MfaCoverage',
        label: SECURITY_METRIC_LABELS.MfaCoverage,
        value: `${coverage.percent}%`,
        caption:
          coverage.uncovered === 0
            ? `All ${identity.activeMembers} active people have a confirmed factor.`
            : `${coverage.uncovered} of ${identity.activeMembers} active people have no confirmed factor.` +
              (identity.requireMfa
                ? ' MFA is required by policy.'
                : ' MFA is not required by policy.'),
        tone: mfaCoverageTone({
          percent: coverage.percent,
          requireMfa: identity.requireMfa,
          inGracePeriod: identity.mfaGraceActive,
        }),
        drillsInto: SECURITY_METRIC_DRILLDOWN.MfaCoverage,
      },
      {
        metric: 'ActiveSessions',
        label: SECURITY_METRIC_LABELS.ActiveSessions,
        value: String(identity.liveSessions),
        caption: `Signed in now, across ${identity.peopleWithSessions} people.`,
        tone: 'neutral',
        drillsInto: SECURITY_METRIC_DRILLDOWN.ActiveSessions,
      },
      {
        metric: 'AdminAccounts',
        label: SECURITY_METRIC_LABELS.AdminAccounts,
        value: String(identity.adminAccounts),
        caption:
          identity.adminAccounts === 1
            ? 'One Company Admin. A single administrator is a lockout risk.'
            : `${identity.adminAccounts} people hold Company Admin.`,
        // One administrator is the break-glass case the client asks for a recovery path for, so
        // it reads as something to look at rather than as a tidy number.
        tone: identity.adminAccounts <= 1 ? 'watch' : 'neutral',
        drillsInto: SECURITY_METRIC_DRILLDOWN.AdminAccounts,
      },
      {
        metric: 'Guests',
        label: SECURITY_METRIC_LABELS.Guests,
        value: String(guests.total),
        caption:
          guests.total === 0
            ? 'No external guests hold access.'
            : `${guests.expired} lapsed, ${guests.expiring} expiring soon, ${guests.noExpiry} with no end date.`,
        tone: guestTone(guests),
        drillsInto: SECURITY_METRIC_DRILLDOWN.Guests,
      },
      {
        metric: 'SsoStatus',
        label: SECURITY_METRIC_LABELS.SsoStatus,
        value: SSO_STATUS_LABELS[sso.status],
        caption:
          identity.ssoConnections === 0
            ? 'No identity provider is connected.'
            : `${identity.ssoEnabled} of ${identity.ssoConnections} connections enabled.`,
        tone: sso.tone,
        drillsInto: SECURITY_METRIC_DRILLDOWN.SsoStatus,
      },
      {
        metric: 'ExpiringGuests',
        label: SECURITY_METRIC_LABELS.ExpiringGuests,
        value: String(guests.expiring + guests.expired),
        caption: `Within ${identity.guestHorizonDays} days, or already lapsed.`,
        tone: guests.expired > 0 ? 'bad' : countTone(guests.expiring),
        drillsInto: SECURITY_METRIC_DRILLDOWN.ExpiringGuests,
      },
      {
        metric: 'FailedLogins',
        label: SECURITY_METRIC_LABELS.FailedLogins,
        value: String(events.failedLogins),
        caption: this.windowCaption(range),
        tone: countTone(events.failedLogins),
        drillsInto: SECURITY_METRIC_DRILLDOWN.FailedLogins,
      },
      {
        metric: 'SuspiciousEvents',
        label: SECURITY_METRIC_LABELS.SuspiciousEvents,
        value: String(events.suspicious),
        caption: `New devices and refused attempts. ${this.windowCaption(range)}`,
        tone: countTone(events.suspicious),
        drillsInto: SECURITY_METRIC_DRILLDOWN.SuspiciousEvents,
      },
      {
        metric: 'HighRiskActions',
        label: SECURITY_METRIC_LABELS.HighRiskActions,
        value: String(identity.highRiskGrants),
        caption:
          'Live grants letting an Engine Agent delete, bulk-send, export sensitive data or ' +
          'change a financial or production system.',
        tone: countTone(identity.highRiskGrants),
        drillsInto: SECURITY_METRIC_DRILLDOWN.HighRiskActions,
      },
      {
        metric: 'Exports',
        label: SECURITY_METRIC_LABELS.Exports,
        value: String(events.exports),
        caption: `Audit, security and Security Center exports. ${this.windowCaption(range)}`,
        tone: countTone(events.exports),
        drillsInto: SECURITY_METRIC_DRILLDOWN.Exports,
      },
      {
        metric: 'SupportAccess',
        label: SECURITY_METRIC_LABELS.SupportAccess,
        value: identity.liveBreakGlass > 0 ? 'Active now' : String(events.supportEvents),
        caption:
          identity.liveBreakGlass > 0
            ? `${identity.liveBreakGlass} live support grant(s) into this company.`
            : `Support access events. ${this.windowCaption(range)}`,
        tone: supportAccessTone({
          active: identity.liveBreakGlass,
          inWindow: events.supportEvents,
        }),
        drillsInto: SECURITY_METRIC_DRILLDOWN.SupportAccess,
      },
    ];

    return { range, metrics, mayExport, mayRevokeSessions };
  }

  // -------------------------------------------------------------------------
  // The seven views
  // -------------------------------------------------------------------------

  async view(input: {
    scope: TenantScope;
    actorUserId: string;
    view: SecurityCenterView;
    range?: SecurityTimeRange | undefined;
    actorFilter?: string | undefined;
    correlationId?: string | undefined;
    severity?: 'Info' | 'Notice' | 'Warning' | 'Critical' | undefined;
    outcome?: 'Succeeded' | 'Failed' | 'Blocked' | undefined;
    before?: Date | undefined;
    limit?: number | undefined;
    guestHorizonDays?: number | undefined;
    now?: Date | undefined;
  }): Promise<SecurityCenterPage> {
    await this.assertWholeCompany(input.scope, input.actorUserId, SECURITY_CENTER_READ_ACTION);
    return this.readView(input);
  }

  /**
   * Export a view.
   *
   * `settings:Export` **and** `settings:Audit`, for the reason the audit trail already gives:
   * `Export` alone is granted to roles that export reports and have no business reading the
   * security history, and `Audit` alone is read access. The export is the intersection, so
   * neither permission accidentally confers it.
   *
   * The export itself is recorded as a security event, which means it appears in the Data Exports
   * view — a company can see who has been taking its evidence away, including from here.
   */
  async exportView(input: {
    scope: TenantScope;
    actorUserId: string;
    view: SecurityCenterView;
    range?: SecurityTimeRange | undefined;
    actorFilter?: string | undefined;
    correlationId?: string | undefined;
    guestHorizonDays?: number | undefined;
    now?: Date | undefined;
  }): Promise<SecurityCenterPage> {
    await this.assertWholeCompany(input.scope, input.actorUserId, SECURITY_CENTER_READ_ACTION);
    await this.assertWholeCompany(input.scope, input.actorUserId, SECURITY_CENTER_EXPORT_ACTION);

    const page = await this.readView({
      ...input,
      limit: MAX_EXPORT_ROWS,
      maxRows: MAX_EXPORT_ROWS,
    });

    await this.securityEvents.record({
      action: SECURITY_ACTIONS.securityCenterExported,
      actorUserId: input.actorUserId,
      tenantId: input.scope.tenantId,
      resourceType: 'security-center-view',
      resourceId: input.view,
      summary: `${page.rows.length} row(s) exported from ${SECURITY_CENTER_VIEW_LABELS[input.view]}.`,
      metadata: {
        view: input.view,
        rows: page.rows.length,
        total: page.total,
        range: input.range ?? DEFAULT_SECURITY_TIME_RANGE,
      },
    });

    return page;
  }

  // -------------------------------------------------------------------------
  // The one act
  // -------------------------------------------------------------------------

  /**
   * Revoke a session, as a company administrator.
   *
   * This is the gap Prompt 5 left open in as many words: admin session revoke was
   * `@PlatformOnly` because "company-admin session revoke needs the role model, which arrives at
   * Prompt 7". The role model has been in place since then, and §27.1 asks for admin session
   * revoke inside the company's own Security Center.
   *
   * ## Two things it checks that the platform version does not
   *
   * **The session belongs to a member of this company.** A session row carries a `user_id` and no
   * `tenant_id`, because a session belongs to a *person* — so without this check a company
   * administrator could revoke the session of somebody who has never worked for them, by id.
   *
   * **And the caller is told what they are doing.** Since the session is person-level, revoking
   * it signs that person out of UBoss entirely, including any other company they belong to. The
   * alternative — refusing to revoke the session of anybody with a second membership — would
   * leave a compromised session alive, which is worse. So it proceeds, returns the number of
   * memberships affected, and records that number on the security event.
   */
  async revokeSession(input: {
    scope: TenantScope;
    actorUserId: string;
    sessionId: string;
    reason: string;
  }): Promise<{ revoked: true; signedOutOfCompanies: number; personDisplayName: string }> {
    await this.assertWholeCompany(input.scope, input.actorUserId, SECURITY_CENTER_REVOKE_ACTION);

    if (input.reason.trim() === '') {
      throw new ForbiddenException(
        'Say why the session is being revoked. Signing somebody out is a security act and an ' +
          'unexplained one cannot be reviewed.',
      );
    }

    // Read outside the tenant transaction: `sessions` has no `tenant_id` and is therefore not an
    // RLS-scoped table, and the membership check below is what confines it to this company.
    const session = await this.prisma.runAsPlatformOperation(() =>
      this.prisma.client.session.findUnique({
        where: { id: input.sessionId },
        select: {
          id: true,
          userId: true,
          revokedAt: true,
          user: { select: { displayName: true } },
        },
      }),
    );

    if (session === null || session.revokedAt !== null) {
      throw new NotFoundException('That session is not live.');
    }

    const memberships = await this.prisma.runAsPlatformOperation(() =>
      this.prisma.client.tenantMembership.findMany({
        where: { userId: session.userId },
        select: { tenantId: true, accountState: true },
      }),
    );

    const belongsHere = memberships.some(
      (membership) => membership.tenantId === input.scope.tenantId,
    );
    if (!belongsHere) {
      // Deliberately the same answer as a session that does not exist. Telling a company
      // administrator "that session belongs to somebody else's company" confirms the id is real.
      throw new NotFoundException('That session is not live.');
    }

    const revoked = await this.sessions.revokeByCompanyAdmin({
      sessionId: input.sessionId,
      tenantId: input.scope.tenantId,
      actorUserId: input.actorUserId,
      subjectUserId: session.userId,
      reason: input.reason,
      membershipCount: memberships.length,
    });

    if (!revoked) {
      throw new NotFoundException('That session is not live.');
    }

    await this.prisma.runInTenantTransaction(input.scope, () =>
      this.auditEvents.appendWithinCurrentScope(input.scope.tenantId, {
        action: 'security_center.session_revoked',
        resourceType: 'session',
        resourceId: input.sessionId,
        actorUserId: input.actorUserId,
        summary: `${session.user.displayName} was signed out. ${input.reason}`,
        metadata: {
          subjectUserId: session.userId,
          signedOutOfCompanies: memberships.length,
          reason: input.reason,
        },
      }),
    );

    return {
      revoked: true,
      signedOutOfCompanies: memberships.length,
      personDisplayName: session.user.displayName,
    };
  }

  // -------------------------------------------------------------------------
  // Reading
  // -------------------------------------------------------------------------

  private async readView(input: {
    scope: TenantScope;
    actorUserId: string;
    view: SecurityCenterView;
    range?: SecurityTimeRange | undefined;
    actorFilter?: string | undefined;
    correlationId?: string | undefined;
    severity?: 'Info' | 'Notice' | 'Warning' | 'Critical' | undefined;
    outcome?: 'Succeeded' | 'Failed' | 'Blocked' | undefined;
    before?: Date | undefined;
    limit?: number | undefined;
    /** The ceiling this read is allowed to reach. An export raises it; a list does not. */
    maxRows?: number | undefined;
    guestHorizonDays?: number | undefined;
    now?: Date | undefined;
  }): Promise<SecurityCenterPage> {
    const source = SECURITY_CENTER_VIEW_SOURCE[input.view];
    const now = input.now ?? new Date();
    const range = input.range ?? DEFAULT_SECURITY_TIME_RANGE;
    const take = Math.min(input.limit ?? 50, input.maxRows ?? MAX_PAGE);

    const shell = {
      view: input.view,
      label: SECURITY_CENTER_VIEW_LABELS[input.view],
      purpose: SECURITY_CENTER_VIEW_PURPOSE[input.view],
    };

    if (source.kind === 'SecurityEvents' || source.kind === 'SecurityEventActions') {
      const filter = {
        tenantId: input.scope.tenantId,
        ...(source.kind === 'SecurityEvents' ? { categories: source.categories } : {}),
        ...(source.kind === 'SecurityEventActions' ? { actions: source.actions } : {}),
        ...(input.actorFilter === undefined ? {} : { actorUserId: input.actorFilter }),
        ...(input.correlationId === undefined ? {} : { correlationId: input.correlationId }),
        ...(input.severity === undefined ? {} : { severity: input.severity }),
        ...(input.outcome === undefined ? {} : { outcome: input.outcome }),
        from: rangeStart(range, now),
        to: now,
      };

      const { rows, total } = await this.prisma.runInTenantTransaction(input.scope, async () => {
        const found = await this.trail.findSecurityEvents({
          ...filter,
          take: take + 1,
          ...(input.before === undefined ? {} : { before: input.before }),
        });
        const counted = await this.trail.countSecurityEventsMatching(filter);
        return { rows: found, total: counted };
      });

      const names = await this.displayNames([
        ...rows.map((row) => row.actorUserId),
        ...rows.map((row) => row.subjectUserId),
      ]);

      const page = rows.slice(0, take);
      const hasMore = rows.length > take;
      const last = page[page.length - 1];

      return {
        ...shell,
        rows: page.map((row) => ({
          id: row.id,
          occurredAt: row.occurredAt.toISOString(),
          title: row.action,
          actor: row.actorUserId === null ? null : (names.get(row.actorUserId) ?? 'Unknown'),
          subject: row.subjectUserId === null ? null : (names.get(row.subjectUserId) ?? 'Unknown'),
          state: row.outcome,
          severity: row.severity,
          detail: row.reason,
          correlationId: row.correlationId,
          resourceType: row.resourceType,
          resourceId: row.resourceId,
          revocableSessionId: null,
        })),
        total,
        ...(hasMore && last ? { nextCursor: last.occurredAt.toISOString() } : {}),
      };
    }

    if (source.kind === 'LiveSessions') {
      const rows = await this.liveSessions(input.scope, now, take);
      return {
        ...shell,
        rows,
        total: rows.length,
        limitation:
          'A session belongs to a person rather than to a company, so revoking one signs that ' +
          'person out of UBoss entirely — including any other company they belong to.',
      };
    }

    if (source.kind === 'GuestMemberships') {
      const rows = await this.guestRows(input.scope, {
        now,
        ...(input.guestHorizonDays === undefined
          ? {}
          : { guestHorizonDays: input.guestHorizonDays }),
        take,
      });
      return { ...shell, rows, total: rows.length };
    }

    const rows = await this.highRiskGrantRows({ scope: input.scope, take });
    return {
      ...shell,
      rows,
      total: rows.length,
      // Stated on the view, not only in a document: an operator reading this screen during an
      // incident needs to know it shows authority rather than use.
      limitation:
        'This shows what an Engine Agent has been *permitted* to do. UBoss records no ' +
        'tool-invocation log yet, because no Engine Agent run performs an external tool action — ' +
        'runs reach AI providers through the Model Gateway only. When tool execution arrives, ' +
        'each invocation becomes a row here.',
    };
  }

  /**
   * Live sessions held by members of this company.
   *
   * Two queries rather than a join, because `sessions` is not a tenant-scoped table: the
   * membership list defines "this company's people" and the session query is then confined to
   * them. Reading sessions inside a tenant transaction would return nothing at all — the table
   * has no `tenant_id` for RLS to match.
   */
  private async liveSessions(
    scope: TenantScope,
    now: Date,
    take: number,
  ): Promise<SecurityCenterRow[]> {
    const memberIds = await this.prisma.runInTenantTransaction(scope, async () => {
      const rows = await this.prisma.client.tenantMembership.findMany({
        where: { tenantId: scope.tenantId },
        select: { userId: true },
      });
      return rows.map((row) => row.userId);
    });

    if (memberIds.length === 0) return [];

    const sessions = await this.prisma.runAsPlatformOperation(() =>
      this.prisma.client.session.findMany({
        where: {
          userId: { in: memberIds },
          revokedAt: null,
          absoluteExpiresAt: { gt: now },
        },
        orderBy: [{ lastSeenAt: 'desc' }],
        take,
        select: {
          id: true,
          userId: true,
          createdAt: true,
          lastSeenAt: true,
          absoluteExpiresAt: true,
          deviceLabel: true,
          clientHint: true,
          primaryAuthMethod: true,
          mfaSatisfiedAt: true,
          user: { select: { displayName: true } },
        },
      }),
    );

    return sessions.map((session) => ({
      id: session.id,
      occurredAt: session.createdAt.toISOString(),
      title: session.user.displayName,
      actor: session.user.displayName,
      subject: null,
      state: 'Live',
      severity: session.mfaSatisfiedAt === null ? 'Notice' : null,
      detail:
        `${session.deviceLabel ?? 'Unknown device'} · ${session.primaryAuthMethod}` +
        `${session.mfaSatisfiedAt === null ? ' · no MFA on this session' : ''}` +
        ` · last seen ${session.lastSeenAt.toISOString()}` +
        ` · expires ${session.absoluteExpiresAt.toISOString()}`,
      correlationId: null,
      resourceType: 'user',
      resourceId: session.userId,
      revocableSessionId: session.id,
    }));
  }

  /** External guests and when their access ends. */
  private async guestRows(
    scope: TenantScope,
    input: { now: Date; guestHorizonDays?: number; take: number },
  ): Promise<SecurityCenterRow[]> {
    const { guests, horizonDays } = await this.prisma.runInTenantTransaction(scope, async () => {
      const policy = await this.prisma.client.tenantAuthPolicy.findUnique({
        where: { tenantId: scope.tenantId },
        select: { guestExpiryDays: true },
      });
      const rows = await this.prisma.client.tenantMembership.findMany({
        where: { tenantId: scope.tenantId, userType: 'ExternalGuest' },
        orderBy: [{ guestAccessExpiresAt: 'asc' }],
        take: input.take,
        select: {
          id: true,
          userId: true,
          accountState: true,
          guestAccessExpiresAt: true,
          createdAt: true,
          user: { select: { displayName: true, email: true } },
        },
      });
      return {
        guests: rows,
        horizonDays: input.guestHorizonDays ?? policy?.guestExpiryDays ?? 30,
      };
    });

    const horizon = input.now.getTime() + horizonDays * 86_400_000;

    return guests.map((guest) => {
      const expiresAt = guest.guestAccessExpiresAt;
      const state =
        expiresAt === null
          ? 'No end date'
          : expiresAt.getTime() <= input.now.getTime()
            ? 'Lapsed'
            : expiresAt.getTime() <= horizon
              ? 'Expiring'
              : guest.accountState;

      return {
        id: guest.id,
        occurredAt: guest.createdAt.toISOString(),
        title: guest.user.displayName,
        actor: null,
        subject: guest.user.displayName,
        state,
        // A guest with no end date is what §23's "expiry-capable" exists to prevent, and a
        // lapsed one that is still `Active` is worse — both read as something to act on.
        severity: expiresAt === null ? 'Warning' : state === 'Lapsed' ? 'Warning' : null,
        detail:
          `${guest.user.email} · ${guest.accountState}` +
          (expiresAt === null ? ' · no expiry set' : ` · access ends ${expiresAt.toISOString()}`),
        correlationId: null,
        resourceType: 'user',
        resourceId: guest.userId,
        revocableSessionId: null,
      };
    });
  }

  /**
   * What an Engine Agent has been permitted to do that the client calls high-risk.
   *
   * The five categories are the client's own, transcribed in `HIGH_RISK_TOOL_CATEGORIES`:
   * Delete, external bulk send, sensitive export, financial change, production change. A revoked
   * grant is still shown, because "who used to be able to delete from our CRM" is the question an
   * investigation asks.
   */
  private async highRiskGrantRows(input: {
    scope: TenantScope;
    take: number;
  }): Promise<SecurityCenterRow[]> {
    const { scope, take } = input;
    const grants = await this.prisma.runInTenantTransaction(scope, () =>
      this.prisma.client.connectionToolGrant.findMany({
        where: {
          tenantId: scope.tenantId,
          category: {
            in: [
              'Delete',
              'ExternalBulkSend',
              'SensitiveExport',
              'FinancialChange',
              'ProductionChange',
            ],
          },
        },
        orderBy: [{ grantedAt: 'desc' }],
        take,
        select: {
          id: true,
          agentId: true,
          category: true,
          reason: true,
          grantedAt: true,
          grantedByUserId: true,
          revokedAt: true,
          revokedReason: true,
          connectionId: true,
          connection: { select: { label: true } },
        },
      }),
    );

    const names = await this.displayNames(grants.map((grant) => grant.grantedByUserId));
    const agentNames = await this.agentNames(
      input.scope,
      grants.map((grant) => grant.agentId),
    );

    return grants.map((grant) => ({
      id: grant.id,
      occurredAt: grant.grantedAt.toISOString(),
      title: `${agentNames.get(grant.agentId) ?? 'Unknown agent'} — ${grant.category}`,
      actor: names.get(grant.grantedByUserId) ?? 'Unknown',
      subject: agentNames.get(grant.agentId) ?? null,
      state: grant.revokedAt === null ? 'Live' : 'Revoked',
      severity: grant.revokedAt === null ? 'Warning' : null,
      detail:
        `${grant.connection.label}` +
        (grant.reason === null ? '' : ` · ${grant.reason}`) +
        (grant.revokedAt === null
          ? ''
          : ` · revoked ${grant.revokedAt.toISOString()}${grant.revokedReason === null ? '' : `: ${grant.revokedReason}`}`),
      correlationId: null,
      resourceType: 'engine-agent',
      resourceId: grant.agentId,
      revocableSessionId: null,
    }));
  }

  // -------------------------------------------------------------------------
  // Posture inputs
  // -------------------------------------------------------------------------

  private async identityPosture(
    scope: TenantScope,
    input: { now: Date; guestHorizonDays?: number | undefined },
  ): Promise<{
    activeMembers: number;
    membersWithFactor: number;
    adminAccounts: number;
    liveSessions: number;
    peopleWithSessions: number;
    guests: { total: number; expiring: number; expired: number; noExpiry: number };
    guestHorizonDays: number;
    requireMfa: boolean;
    requireSso: boolean;
    mfaGraceActive: boolean;
    ssoConnections: number;
    ssoEnabled: number;
    highRiskGrants: number;
    liveBreakGlass: number;
  }> {
    const tenant = await this.prisma.runInTenantTransaction(scope, async () => {
      const policy = await this.prisma.client.tenantAuthPolicy.findUnique({
        where: { tenantId: scope.tenantId },
        select: { requireMfa: true, requireSso: true, mfaGraceUntil: true, guestExpiryDays: true },
      });

      const memberships = await this.prisma.client.tenantMembership.findMany({
        where: { tenantId: scope.tenantId },
        select: { userId: true, accountState: true, userType: true, guestAccessExpiresAt: true },
      });

      // The same live-grant predicate `AuthorizationRepository` uses, so "how many
      // administrators" and "who can administer" cannot give different answers.
      const adminAccounts = await this.prisma.client.roleAssignment.count({
        where: {
          tenantId: scope.tenantId,
          roleKind: 'CompanyAdmin',
          OR: [{ expiresAt: null }, { expiresAt: { gt: input.now } }],
        },
      });

      const ssoConnections = await this.prisma.client.ssoConnection.findMany({
        where: { tenantId: scope.tenantId },
        select: { enabled: true },
      });

      const highRiskGrants = await this.prisma.client.connectionToolGrant.count({
        where: {
          tenantId: scope.tenantId,
          revokedAt: null,
          category: {
            in: [
              'Delete',
              'ExternalBulkSend',
              'SensitiveExport',
              'FinancialChange',
              'ProductionChange',
            ],
          },
        },
      });

      const liveBreakGlass = await this.prisma.client.breakGlassRequest.count({
        where: {
          tenantId: scope.tenantId,
          state: 'Active',
          revokedAt: null,
          expiresAt: { gt: input.now },
        },
      });

      return { policy, memberships, adminAccounts, ssoConnections, highRiskGrants, liveBreakGlass };
    });

    const activeMemberIds = tenant.memberships
      .filter((membership) => membership.accountState === 'Active')
      .map((membership) => membership.userId);

    const guestRows = tenant.memberships
      .filter((membership) => membership.userType === 'ExternalGuest')
      .map((membership) => ({ guestAccessExpiresAt: membership.guestAccessExpiresAt }));

    const guestHorizonDays = input.guestHorizonDays ?? tenant.policy?.guestExpiryDays ?? 30;

    // MFA factors and sessions are person-level tables with no `tenant_id`, so they are read
    // outside the tenant transaction and confined by the membership list instead.
    const { membersWithFactor, liveSessions, peopleWithSessions } =
      await this.prisma.runAsPlatformOperation(async () => {
        if (activeMemberIds.length === 0) {
          return { membersWithFactor: 0, liveSessions: 0, peopleWithSessions: 0 };
        }

        const factors = await this.prisma.client.mfaFactor.findMany({
          where: {
            userId: { in: activeMemberIds },
            state: 'Active',
            revokedAt: null,
            confirmedAt: { not: null },
          },
          select: { userId: true },
          distinct: ['userId'],
        });

        const sessions = await this.prisma.client.session.findMany({
          where: {
            userId: { in: tenant.memberships.map((membership) => membership.userId) },
            revokedAt: null,
            absoluteExpiresAt: { gt: input.now },
          },
          select: { userId: true },
        });

        return {
          membersWithFactor: factors.length,
          liveSessions: sessions.length,
          peopleWithSessions: new Set(sessions.map((session) => session.userId)).size,
        };
      });

    return {
      activeMembers: activeMemberIds.length,
      membersWithFactor,
      adminAccounts: tenant.adminAccounts,
      liveSessions,
      peopleWithSessions,
      guests: guestExpiry(guestRows, { now: input.now, withinDays: guestHorizonDays }),
      guestHorizonDays,
      requireMfa: tenant.policy?.requireMfa ?? false,
      requireSso: tenant.policy?.requireSso ?? false,
      mfaGraceActive:
        tenant.policy?.mfaGraceUntil !== null &&
        tenant.policy?.mfaGraceUntil !== undefined &&
        tenant.policy.mfaGraceUntil.getTime() > input.now.getTime(),
      ssoConnections: tenant.ssoConnections.length,
      ssoEnabled: tenant.ssoConnections.filter((connection) => connection.enabled).length,
      highRiskGrants: tenant.highRiskGrants,
      liveBreakGlass: tenant.liveBreakGlass,
    };
  }

  private async eventPosture(
    scope: TenantScope,
    from: Date,
    to: Date,
  ): Promise<{
    failedLogins: number;
    suspicious: number;
    exports: number;
    supportEvents: number;
  }> {
    return this.prisma.runInTenantTransaction(scope, async () => {
      const base = { tenantId: scope.tenantId, from, to };

      const failedLogins = await this.trail.countSecurityEventsMatching({
        ...base,
        action: SECURITY_ACTIONS.loginFailed,
      });

      // "Suspicious" is not a category of its own: it is the `Risk` classification the security
      // publisher already assigns — a new device, a replayed MFA code, a used recovery code, a
      // locked account. Reusing that classification means the Security Center and the alerting
      // rules cannot drift apart about what counts as suspicious.
      const suspicious = await this.trail.countSecurityEventsMatching({
        ...base,
        category: 'Risk',
      });

      const exports = await this.trail.countSecurityEventsMatching({
        ...base,
        actions: SECURITY_EXPORT_ACTIONS,
      });

      const supportEvents = await this.trail.countSecurityEventsMatching({
        ...base,
        category: 'Support',
      });

      return { failedLogins, suspicious, exports, supportEvents };
    });
  }

  // -------------------------------------------------------------------------
  // Shared
  // -------------------------------------------------------------------------

  /**
   * The same scope rule the audit trail uses, and for the same reason.
   *
   * Security events are not department-scoped, so a `SelectedDepartments` grant cannot be
   * honoured by narrowing the result — there is nothing to narrow on. Refused rather than
   * over-returned.
   */
  private async assertWholeCompany(
    scope: TenantScope,
    userId: string,
    action: 'Audit' | 'Export' | 'Administer',
  ): Promise<void> {
    const context = await this.authorization.contextFor(scope, userId);
    await this.authorization.assertCan(context, { module: SECURITY_CENTER_MODULE, action });

    const effective = this.authorization.scopeForListing(context, SECURITY_CENTER_MODULE, action);
    if (effective !== 'WholeCompany') {
      throw new ForbiddenException(
        `The Security Center requires whole-company scope; this grant is "${effective}". ` +
          'Security events are not department-scoped, so a narrower grant cannot be honoured ' +
          'without returning more than it permits. Refused rather than over-returned.',
      );
    }
  }

  /** Whether the caller holds an action, for telling the UI what to offer. */
  private async holds(
    scope: TenantScope,
    userId: string,
    action: 'Audit' | 'Export' | 'Administer',
  ): Promise<boolean> {
    try {
      await this.assertWholeCompany(scope, userId, action);
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Display names for a set of user ids.
   *
   * One query for the page rather than one per row, and read as a platform operation because
   * `users` is a person-level table: a row there is not owned by a company. The ids come from
   * rows this company is already permitted to see, so nothing widens.
   */
  private async displayNames(ids: readonly (string | null)[]): Promise<Map<string, string>> {
    const wanted = [...new Set(ids.filter((id): id is string => id !== null))];
    if (wanted.length === 0) return new Map();

    const users = await this.prisma.runAsPlatformOperation(() =>
      this.prisma.client.user.findMany({
        where: { id: { in: wanted } },
        select: { id: true, displayName: true },
      }),
    );

    return new Map(users.map((user) => [user.id, user.displayName]));
  }

  /**
   * Engine Agent names for a set of ids.
   *
   * `connection_tool_grants.agent_id` is a bare uuid with no foreign key — the grant is written
   * against an agent in the same tenant and the composite-FK pattern is not used there — so the
   * name is looked up rather than included. One query for the page, inside the tenant
   * transaction, so an agent from another company could not be named even if an id leaked.
   */
  private async agentNames(
    scope: TenantScope,
    ids: readonly string[],
  ): Promise<Map<string, string>> {
    const wanted = [...new Set(ids)];
    if (wanted.length === 0) return new Map();

    const agents = await this.prisma.runInTenantTransaction(scope, () =>
      this.prisma.client.engineAgent.findMany({
        where: { tenantId: scope.tenantId, id: { in: wanted } },
        select: { id: true, name: true },
      }),
    );

    return new Map(agents.map((agent) => [agent.id, agent.name]));
  }

  private windowCaption(range: SecurityTimeRange): string {
    const hours = { Last24Hours: 24, Last7Days: 168, Last30Days: 720, Last90Days: 2_160 }[range];
    return hours === 24 ? 'In the last 24 hours.' : `In the last ${hours / 24} days.`;
  }

  /** The view list, for a client that wants to build its tabs from the server's vocabulary. */
  views(): { view: SecurityCenterView; label: string; purpose: string }[] {
    return SECURITY_CENTER_VIEWS.map((view) => ({
      view,
      label: SECURITY_CENTER_VIEW_LABELS[view],
      purpose: SECURITY_CENTER_VIEW_PURPOSE[view],
    }));
  }
}
