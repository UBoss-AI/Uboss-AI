import { Injectable } from '@nestjs/common';

import { AuditTrailRepository } from '../persistence/audit-trail.repository.js';
import { PlatformRepository, type CompanyOverviewRow } from '../persistence/platform.repository.js';
import { PrismaService } from '../persistence/prisma.service.js';

/**
 * How close to a limit counts as "needs attention".
 *
 * Thresholds, not magic numbers scattered through the code: an operator asking "why is this
 * company flagged" deserves one place to look, and a product decision about when to warn should
 * be visible rather than buried in a comparison.
 */
export const ATTENTION_THRESHOLDS = {
  /** AI allowance consumed, as a fraction. 0.85 warns before the customer is cut off. */
  aiAllowanceWarn: 0.85,
  /** Seats used, as a fraction of licensed. 0.9 is late enough not to nag, early enough to sell. */
  seatsWarn: 0.9,
  /** Days before renewal that it becomes an operational concern. */
  renewalWindowDays: 30,
} as const;

/** The reference UI's `flag` column: one word for the thing most needing attention. */
export type AttentionFlag = 'None' | 'Billing' | 'Budget' | 'Security' | 'Seats' | 'Renewal';

/**
 * Where a number came from.
 *
 * This is the honesty mechanism for this prompt, and it is a field on the wire rather than a
 * comment. The client asked for a dashboard fed by "real database/demo data", and those are two
 * very different claims about a billing figure — so every panel says which it is, and the Master
 * Console prints it. A platform operator must never have to guess whether an AI spend figure is
 * metered or seeded.
 *
 *   * `measured`  — counted from data the product genuinely produces today.
 *   * `configured` — read from a row somebody set deliberately (a plan price, an allowance).
 *   * `demo`      — seeded illustrative data. No metering exists for it yet.
 */
export type DataProvenance = 'measured' | 'configured' | 'demo';

export interface CompanySummary {
  tenantId: string;
  /** The reference's `C-001`-style id is the slug; the UUID is `tenantId`. */
  reference: string;
  name: string;
  legalName: string | null;
  status: string;
  plan: string | null;
  planTier: string | null;
  /** The reference's `42 / 60`. Null licensed seats render as `42 / —`. */
  seatsUsed: number;
  seatsLicensed: number | null;
  seatsLabel: string;
  /** The reference's `68%`. Null when there is no allowance to measure against. */
  aiUsagePercent: number | null;
  aiUsageLabel: string;
  billing: string | null;
  renewsAt: string | null;
  daysToRenewal: number | null;
  flag: AttentionFlag;
  /** Every reason this company is flagged, so a screen can explain rather than just warn. */
  attentionReasons: string[];
  /** Real Prompt 8 signals, surfaced because they are the ones that are genuinely measured. */
  security: {
    criticalEvents: number;
    activeBreakGlass: number;
    breakGlassPendingNotification: number;
  };
  openServiceAlerts: number;
  createdAt: string;
}

export interface PlatformDashboard {
  kpis: {
    activeCompanies: { value: number; total: number; provenance: DataProvenance };
    platformSeats: {
      used: number;
      licensed: number;
      utilisationPercent: number | null;
      provenance: DataProvenance;
    };
    aiSpend: {
      consumedMinor: number;
      allowanceMinor: number;
      currency: string;
      provenance: DataProvenance;
    };
    openIncidents: { value: number; critical: number; provenance: DataProvenance };
  };
  /** The reference's "Companies needing attention" table. Only flagged companies. */
  companiesNeedingAttention: CompanySummary[];
  /** Everything, for the Companies list to reuse without a second aggregate. */
  companies: CompanySummary[];
  renewalsDue: CompanySummary[];
  serviceAlerts: {
    id: string;
    service: string;
    severity: string;
    state: string;
    summary: string;
    affectedTenantId: string | null;
    openedAt: string;
  }[];
  /** Real, from Prompt 8. The one panel on this dashboard that is entirely measured. */
  securityAttention: {
    criticalEventsLast30Days: number;
    activeBreakGlassGrants: number;
    pendingCustomerNotifications: number;
    platformRoleHolders: number;
    provenance: DataProvenance;
  };
  /**
   * Which panels are measured and which are seeded, restated as a list the UI can render.
   *
   * Redundant with the per-panel `provenance` on purpose: a screen that forgets to show one
   * field still has to show this, so the caveat cannot be lost by a rendering oversight.
   */
  provenanceNotes: { panel: string; provenance: DataProvenance; note: string }[];
  generatedAt: string;
}

/**
 * The Master Console's read model.
 *
 * ## What is real here, and what is not
 *
 * The client asked for a dashboard showing companies, status, seats, renewals, AI usage/billing
 * attention and service alerts from real data. Being precise about which of those the product
 * can actually measure today:
 *
 *   * **Companies and status** — real. `tenants.lifecycleState`, since Prompt 3.
 *   * **Seats used** — real. Counted from `tenant_memberships` with an active account state.
 *   * **Seats licensed, plan, renewal, billing state, AI allowance** — *configured*. Real rows in
 *     `plans` and `tenant_subscriptions`, set deliberately, seeded with demo values for the demo
 *     companies. They are not invented at render time, and an operator can change them.
 *   * **AI consumed** — *demo*. There is no metering yet; it arrives with the AI modules. The
 *     column exists and is seeded, and the API says `demo` so nobody reads a spend figure as
 *     fact.
 *   * **Service alerts** — *demo* rows in a real table. Health checks that write them are the
 *     System Health module's work.
 *   * **Security attention** — **real**, and this is the part worth the most: critical security
 *     events, active break-glass grants and outstanding customer notifications all come from
 *     Prompt 8's trails, which are append-only and hash-chained.
 *
 * Marking the difference on the wire rather than in a comment is the point. A dashboard that
 * presents a seeded billing figure identically to a measured one teaches its operator to trust
 * both equally, and the first time that matters is an incident.
 */
@Injectable()
export class PlatformConsoleService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly platform: PlatformRepository,
    private readonly trail: AuditTrailRepository,
  ) {}

  async dashboard(): Promise<PlatformDashboard> {
    const [rows, totals, alerts] = await Promise.all([
      this.platform.companyOverview(),
      this.platform.platformTotals(),
      this.platform.listServiceAlerts({ openOnly: true, take: 20 }),
    ]);

    const companies = rows.map((row) => PlatformConsoleService.summarise(row));
    const currency = rows.find((row) => row.currency)?.currency ?? 'USD';

    const aiConsumedMinor = rows.reduce((sum, row) => sum + row.aiConsumedMinor, 0);
    const aiAllowanceMinor = rows.reduce((sum, row) => sum + row.aiAllowanceMinor, 0);

    return {
      kpis: {
        activeCompanies: {
          value: totals.activeTenants,
          total: totals.tenants,
          provenance: 'measured',
        },
        platformSeats: {
          used: totals.seatsUsed,
          licensed: totals.seatsLicensed,
          utilisationPercent:
            totals.seatsLicensed > 0
              ? Math.round((totals.seatsUsed / totals.seatsLicensed) * 100)
              : null,
          // Used is measured; licensed is configured. The weaker of the two is what the panel
          // can honestly claim, so the pair is reported as configured.
          provenance: 'configured',
        },
        aiSpend: {
          consumedMinor: aiConsumedMinor,
          allowanceMinor: aiAllowanceMinor,
          currency,
          provenance: 'demo',
        },
        openIncidents: {
          value: totals.openAlerts,
          critical: totals.criticalAlerts,
          provenance: 'demo',
        },
      },

      // The reference shows only flagged companies here, and that is the right call: a table of
      // everything is the Companies screen, and a dashboard panel that lists every company
      // regardless of state tells an operator nothing about where to look first.
      companiesNeedingAttention: companies.filter((company) => company.flag !== 'None'),
      companies,
      renewalsDue: companies
        .filter(
          (company) =>
            company.daysToRenewal !== null &&
            company.daysToRenewal <= ATTENTION_THRESHOLDS.renewalWindowDays,
        )
        .sort((left, right) => (left.daysToRenewal ?? 0) - (right.daysToRenewal ?? 0)),

      serviceAlerts: alerts.map((alert) => ({
        id: alert.id,
        service: alert.service,
        severity: alert.severity,
        state: alert.state,
        summary: alert.summary,
        affectedTenantId: alert.affectedTenantId,
        openedAt: alert.openedAt.toISOString(),
      })),

      securityAttention: {
        criticalEventsLast30Days: totals.criticalSecurityEvents,
        activeBreakGlassGrants: totals.activeBreakGlass,
        pendingCustomerNotifications: totals.pendingCustomerNotifications,
        platformRoleHolders: totals.platformRoleHolders,
        provenance: 'measured',
      },

      provenanceNotes: [
        {
          panel: 'Companies and status',
          provenance: 'measured',
          note: 'Counted from tenants and their memberships.',
        },
        {
          panel: 'Seats',
          provenance: 'configured',
          note: 'Seats used is measured from active memberships; seats licensed comes from the plan or the subscription.',
        },
        {
          panel: 'Renewals and billing state',
          provenance: 'configured',
          note: 'Read from tenant_subscriptions. No payment provider is connected, so billing state is set by hand.',
        },
        {
          panel: 'AI usage and spend',
          provenance: 'demo',
          note: 'Allowance is configured; consumption is seeded. AI metering arrives with the AI modules — no figure here is metered.',
        },
        {
          panel: 'Service alerts',
          provenance: 'demo',
          note: 'Real table, seeded rows. Health checks that write alerts are the System Health module.',
        },
        {
          panel: 'Security attention',
          provenance: 'measured',
          note: 'From the Prompt 8 append-only trails: critical security events, active break-glass grants and outstanding customer notifications.',
        },
      ],
      generatedAt: new Date().toISOString(),
    };
  }

  /** Every company, for the Companies list. Same shape as the dashboard's rows. */
  async companies(): Promise<CompanySummary[]> {
    const rows = await this.platform.companyOverview();
    return rows.map((row) => PlatformConsoleService.summarise(row));
  }

  /**
   * One company, with its entitlements, recent platform-side activity and security position.
   *
   * The audit and security rows are read **as a platform operation with the tenant id**, so the
   * console sees the company's own trail rather than a platform-plane copy — this is the same
   * data the company's own Audit & Activity screen shows, which is what makes the two consistent.
   */
  async companyDetail(tenantId: string): Promise<{
    company: CompanySummary;
    entitlements: {
      planModules: string[];
      extraModules: string[];
      removedModules: string[];
      effectiveModules: string[];
    };
    subscription: {
      planCode: string | null;
      state: string | null;
      billingState: string | null;
      startedAt: string | null;
      renewsAt: string | null;
      aiAllowanceMinor: number;
      aiConsumedMinor: number;
      currency: string;
      notes: string | null;
    } | null;
    recentAudit: {
      action: string;
      resourceType: string;
      summary: string | null;
      reason: string | null;
      occurredAt: string;
    }[];
    recentSecurity: {
      action: string;
      category: string;
      severity: string;
      outcome: string;
      occurredAt: string;
    }[];
    provenance: { entitlements: DataProvenance; activity: DataProvenance };
  } | null> {
    const row = await this.platform.companyOverviewFor(tenantId);
    if (!row) {
      return null;
    }

    const subscription = await this.platform.findSubscriptionForTenant(tenantId);
    const plan = subscription ? await this.platform.findPlan(subscription.planId) : null;

    const planModules = plan?.entitledModules ?? [];
    const extraModules = subscription?.extraModules ?? [];
    const removedModules = subscription?.removedModules ?? [];
    // Removed wins over extra: an entitlement explicitly taken away must not be restorable by
    // also being listed as an extra, or the two columns would disagree and whichever the
    // consuming code read first would decide.
    const effectiveModules = [...new Set([...planModules, ...extraModules])].filter(
      (module) => !removedModules.includes(module),
    );

    const [recentAudit, recentSecurity] = await this.prisma.runAsPlatformOperation(() =>
      Promise.all([
        this.trail.findAuditEvents({ tenantId, take: 15 }),
        this.trail.findSecurityEvents({ tenantId, take: 15 }),
      ]),
    );

    return {
      company: PlatformConsoleService.summarise(row),
      entitlements: { planModules, extraModules, removedModules, effectiveModules },
      subscription: subscription
        ? {
            planCode: plan?.code ?? null,
            state: subscription.state,
            billingState: subscription.billingState,
            startedAt: subscription.startedAt.toISOString(),
            renewsAt: subscription.renewsAt?.toISOString() ?? null,
            aiAllowanceMinor: subscription.aiAllowanceMinor,
            aiConsumedMinor: subscription.aiConsumedMinor,
            currency: subscription.currency,
            notes: subscription.notes,
          }
        : null,
      recentAudit: recentAudit.map((event) => ({
        action: event.action,
        resourceType: event.resourceType,
        summary: event.summary,
        reason: event.reason,
        occurredAt: event.occurredAt.toISOString(),
      })),
      recentSecurity: recentSecurity.map((event) => ({
        action: event.action,
        category: event.category,
        severity: event.severity,
        outcome: event.outcome,
        occurredAt: event.occurredAt.toISOString(),
      })),
      provenance: { entitlements: 'configured', activity: 'measured' },
    };
  }

  // -------------------------------------------------------------------------
  // Derivation
  // -------------------------------------------------------------------------

  /**
   * Turn one aggregate row into the reference UI's columns.
   *
   * A pure static function, so the flag logic is testable without a database — and it needs to
   * be, because "why is this company flagged Budget rather than Billing" is a question with a
   * definite answer that a screen must not have to guess at.
   */
  static summarise(row: CompanyOverviewRow): CompanySummary {
    const seatsLicensed = row.seatsLicensed ?? null;
    const aiUsagePercent =
      row.aiAllowanceMinor > 0
        ? Math.round((row.aiConsumedMinor / row.aiAllowanceMinor) * 100)
        : null;

    const daysToRenewal =
      row.renewsAt === null ? null : Math.ceil((row.renewsAt.getTime() - Date.now()) / 86_400_000);

    const { flag, reasons } = PlatformConsoleService.attention({
      billingState: row.billingState,
      lifecycleState: row.lifecycleState,
      aiUsagePercent,
      seatsUsed: row.seatsUsed,
      seatsLicensed,
      daysToRenewal,
      criticalSecurityEvents: row.criticalSecurityEvents,
      activeBreakGlass: row.breakGlassActive,
      pendingNotification: row.breakGlassPendingNotification,
      pinnedFlag: row.pinnedFlag,
    });

    return {
      tenantId: row.tenantId,
      reference: row.slug,
      name: row.name,
      legalName: row.legalName,
      status: row.lifecycleState,
      plan: row.planName,
      planTier: row.planTier,
      seatsUsed: row.seatsUsed,
      seatsLicensed,
      // The reference renders `42 / 60`. An unlicensed company shows an em dash rather than `0`,
      // because zero licensed seats and "not on a plan yet" are different situations.
      seatsLabel: `${row.seatsUsed} / ${seatsLicensed ?? '—'}`,
      aiUsagePercent,
      aiUsageLabel: aiUsagePercent === null ? '—' : `${aiUsagePercent}%`,
      billing: row.billingState,
      renewsAt: row.renewsAt?.toISOString() ?? null,
      daysToRenewal,
      flag,
      attentionReasons: reasons,
      security: {
        criticalEvents: row.criticalSecurityEvents,
        activeBreakGlass: row.breakGlassActive,
        breakGlassPendingNotification: row.breakGlassPendingNotification,
      },
      openServiceAlerts: row.openServiceAlerts,
      createdAt: row.createdAt.toISOString(),
    };
  }

  /**
   * Decide the single flag, and collect every reason.
   *
   * ## Why one flag and a list of reasons rather than a set of badges
   *
   * The reference has one `Flag` column, and a table cell holding four badges is a table nobody
   * scans. But a company can genuinely have several problems at once, and dropping the others
   * would make the console lie by omission — so the flag is the *worst* one and
   * `attentionReasons` carries all of them for the detail view and the tooltip.
   *
   * ## The precedence, and why it is this order
   *
   * Security first. A critical security event or a break-glass grant whose customer has not been
   * told outranks a commercial problem, because the commercial problem gets worse slowly and the
   * security one does not. Then Billing (the company may be about to be cut off), then Budget
   * (they are about to hit their allowance), then Seats, then Renewal — roughly, how soon it
   * stops the customer working.
   *
   * A hand-pinned flag beats all of it: if a platform operator has said "this one is a Security
   * matter", the derivation does not get to disagree.
   */
  static attention(input: {
    billingState: string | null;
    lifecycleState: string;
    aiUsagePercent: number | null;
    seatsUsed: number;
    seatsLicensed: number | null;
    daysToRenewal: number | null;
    criticalSecurityEvents: number;
    activeBreakGlass: number;
    pendingNotification: number;
    pinnedFlag: string;
  }): { flag: AttentionFlag; reasons: string[] } {
    const reasons: string[] = [];

    if (input.criticalSecurityEvents > 0) {
      reasons.push(
        `${input.criticalSecurityEvents} critical security event(s) in the last 30 days.`,
      );
    }
    if (input.activeBreakGlass > 0) {
      reasons.push(`${input.activeBreakGlass} break-glass grant(s) active right now.`);
    }
    if (input.pendingNotification > 0) {
      reasons.push(
        `${input.pendingNotification} break-glass record(s) where the customer has not been notified.`,
      );
    }
    if (input.billingState === 'Overdue') {
      reasons.push('Payment is overdue beyond the grace period.');
    } else if (input.billingState === 'Grace') {
      reasons.push('Payment is past due, inside the grace period.');
    }
    if (
      input.aiUsagePercent !== null &&
      input.aiUsagePercent >= ATTENTION_THRESHOLDS.aiAllowanceWarn * 100
    ) {
      reasons.push(`AI allowance ${input.aiUsagePercent}% consumed.`);
    }
    if (
      input.seatsLicensed !== null &&
      input.seatsLicensed > 0 &&
      input.seatsUsed / input.seatsLicensed >= ATTENTION_THRESHOLDS.seatsWarn
    ) {
      reasons.push(`${input.seatsUsed} of ${input.seatsLicensed} seats used.`);
    }
    if (
      input.daysToRenewal !== null &&
      input.daysToRenewal <= ATTENTION_THRESHOLDS.renewalWindowDays
    ) {
      reasons.push(
        input.daysToRenewal < 0
          ? `Renewal was due ${Math.abs(input.daysToRenewal)} day(s) ago.`
          : `Renews in ${input.daysToRenewal} day(s).`,
      );
    }
    if (input.lifecycleState === 'Suspended') {
      reasons.push('The company is suspended.');
    }

    // A hand-pinned flag wins, and its reason is recorded as such so a reader can tell a pinned
    // flag from a derived one.
    if (input.pinnedFlag !== 'None') {
      return {
        flag: input.pinnedFlag as AttentionFlag,
        reasons: [`Pinned by a platform operator as ${input.pinnedFlag}.`, ...reasons],
      };
    }

    const flag: AttentionFlag =
      input.criticalSecurityEvents > 0 ||
      input.activeBreakGlass > 0 ||
      input.pendingNotification > 0
        ? 'Security'
        : input.billingState === 'Overdue' || input.billingState === 'Grace'
          ? 'Billing'
          : input.aiUsagePercent !== null &&
              input.aiUsagePercent >= ATTENTION_THRESHOLDS.aiAllowanceWarn * 100
            ? 'Budget'
            : input.seatsLicensed !== null &&
                input.seatsLicensed > 0 &&
                input.seatsUsed / input.seatsLicensed >= ATTENTION_THRESHOLDS.seatsWarn
              ? 'Seats'
              : input.daysToRenewal !== null &&
                  input.daysToRenewal <= ATTENTION_THRESHOLDS.renewalWindowDays
                ? 'Renewal'
                : 'None';

    // A suspended company with no other signal is still worth flagging, and Billing is the usual
    // cause — but saying so without evidence would be a guess, so it falls back to the reason
    // list and no flag rather than inventing a category.
    return { flag, reasons };
  }
}
