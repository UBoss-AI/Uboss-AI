import { Injectable } from '@nestjs/common';

import { notificationDedupeKey } from '@uboss/types';

import { NotificationService } from '../notifications/notification.service.js';
import { PrismaService } from '../persistence/prisma.service.js';
import type { TenantScope } from '../persistence/tenant-context.js';
import { SEAT_WARNING_FRACTION } from './seat.service.js';

/**
 * The AI allowance thresholds that raise an alert, and what each one means.
 *
 * Two, not five. A threshold at every ten percent is a threshold nobody reads, and the two that
 * matter are "you should plan" and "work is about to stop".
 */
export const AI_BUDGET_THRESHOLDS = [
  { percent: 80, severity: 'Warning' as const, label: 'four fifths' },
  { percent: 100, severity: 'Critical' as const, label: 'all' },
];

export interface BudgetAlertOutcome {
  tenantsChecked: number;
  raised: number;
  /** Already notified at this threshold, so nothing was raised. */
  alreadyNotified: number;
  /** Companies with nobody who could act on the alert. Reported rather than skipped silently. */
  noRecipients: number;
}

/**
 * Budget and seat threshold alerts.
 *
 * ## Why this is a separate service
 *
 * `CommercialService` already answers "what is this company's position". Raising alerts about it
 * is a different job with a different trigger — a sweep, not a request — and putting it there
 * would have grown a class that already carries plans, entitlements, allowance and pending
 * changes. It reads through the same models and invents no second source of truth for a ceiling.
 *
 * ## Who is told
 *
 * Everybody holding a `CompanyAdmin` role in that company. Not "the company", because a
 * notification needs a recipient, and not the person whose action crossed the threshold, because
 * an employee running one agent is not who decides to buy more allowance.
 *
 * A company with no Company Admin is **reported, not skipped silently** — it means an alert had
 * nobody to go to, which is itself a finding.
 *
 * ## Idempotency is the threshold, not the moment
 *
 * The dedupe key is `budget:<subscription>:<percent>`, so crossing 80% notifies once and crossing
 * 100% notifies again — and neither repeats however often the sweep runs. A key with a timestamp
 * would mail an administrator every few minutes for the rest of the billing period.
 *
 * **A consequence worth stating:** because the key has no period in it, a company that renews and
 * crosses 80% again in the *next* period is not notified again until the subscription row
 * changes. The AI cost lifecycle (Prompts 25–30) is what introduces a per-period consumption
 * record, and the key gains the period then. Until then a renewal resets `aiConsumedMinor` and
 * the old notification stands — which is visible in the center rather than lost.
 */
@Injectable()
export class BudgetAlertService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly notifications: NotificationService,
  ) {}

  /**
   * Check every active company and raise what has newly crossed a threshold.
   *
   * Platform-plane: one sweep for the platform, the same shape as the escalation sweeper and the
   * lifecycle `apply-due` job.
   */
  async raiseDueAlerts(): Promise<BudgetAlertOutcome> {
    const subscriptions = await this.prisma.runAsPlatformOperation(() =>
      this.prisma.client.tenantSubscription.findMany({
        // `Active` and `Suspended` only. A suspended subscription is included on purpose: it is
        // usually suspended *because* of billing, and telling the administrator that the
        // allowance is exhausted is exactly what they need to hear. `Pending`, `Expired` and
        // `Cancelled` are excluded — nobody needs a budget alert about a company that has not
        // started or has finished.
        where: { state: { in: ['Active', 'Suspended'] } },
        select: {
          id: true,
          tenantId: true,
          aiAllowanceMinor: true,
          aiConsumedMinor: true,
          seatsLicensed: true,
          currency: true,
        },
      }),
    );

    let raised = 0;
    let alreadyNotified = 0;
    let noRecipients = 0;

    for (const subscription of subscriptions) {
      const admins = await this.companyAdmins(subscription.tenantId);
      if (admins.length === 0) {
        noRecipients += 1;
        continue;
      }

      const alerts = await this.dueFor(subscription);

      for (const alert of alerts) {
        for (const recipientUserId of admins) {
          const result = await this.notifications.raise({
            tenantId: subscription.tenantId,
            recipientUserId,
            kind: 'BudgetThreshold',
            severity: alert.severity,
            title: alert.title,
            body: alert.body,
            // Billing is where somebody acts on this, so that is where the link goes.
            deepLink: '/settings/billing',
            resourceType: 'tenant_subscription',
            resourceId: subscription.id,
            // An administrator is being told, not assigned a task. Buying more allowance is a
            // decision, and putting it in their "assigned to me" queue would misrepresent it.
            isAssignedToRecipient: false,
            dedupeKey: alert.dedupeKey,
          });

          if (result.suppressedAsDuplicate) {
            alreadyNotified += 1;
          } else if (result.notification !== null) {
            raised += 1;
          }
        }
      }
    }

    return { tenantsChecked: subscriptions.length, raised, alreadyNotified, noRecipients };
  }

  /** Which thresholds this subscription has crossed, as alerts ready to raise. */
  private async dueFor(subscription: {
    id: string;
    tenantId: string;
    aiAllowanceMinor: number;
    aiConsumedMinor: number;
    seatsLicensed: number | null;
  }): Promise<
    { title: string; body: string; severity: 'Warning' | 'Critical'; dedupeKey: string }[]
  > {
    const alerts: {
      title: string;
      body: string;
      severity: 'Warning' | 'Critical';
      dedupeKey: string;
    }[] = [];

    // ---- AI allowance ----
    if (subscription.aiAllowanceMinor > 0) {
      const percent = Math.floor(
        (subscription.aiConsumedMinor / subscription.aiAllowanceMinor) * 100,
      );

      // Highest crossed threshold only. Crossing 100% would otherwise raise the 80% alert too,
      // and two notifications saying different things about the same fact is worse than one.
      const crossed = [...AI_BUDGET_THRESHOLDS]
        .reverse()
        .find((threshold) => percent >= threshold.percent);

      if (crossed) {
        alerts.push({
          severity: crossed.severity,
          title:
            crossed.percent >= 100
              ? 'The AI allowance for this company is exhausted'
              : `AI allowance is ${percent}% consumed`,
          body:
            crossed.percent >= 100
              ? 'AI work that needs allowance will be refused until more is added or the ' +
                'period renews. Request a top-up or a reallocation from Billing.'
              : `${crossed.label} of the contracted AI allowance has been consumed. Plan a ` +
                'top-up before work is refused.',
          dedupeKey: notificationDedupeKey.budgetThreshold(subscription.id, crossed.percent),
        });
      }
    }

    // ---- Seats ----
    // Read through the same counting rule the seat service enforces, rather than a second query
    // with its own idea of what a consumed seat is. `SEAT_WARNING_FRACTION` is Prompt 11's.
    if (subscription.seatsLicensed !== null && subscription.seatsLicensed > 0) {
      const used = await this.prisma.runAsPlatformOperation(() =>
        this.prisma.client.tenantMembership.count({
          where: {
            tenantId: subscription.tenantId,
            accountState: { in: ['Active', 'InvitePending', 'Suspended'] },
          },
        }),
      );
      const fraction = used / subscription.seatsLicensed;

      if (fraction >= 1) {
        alerts.push({
          severity: 'Warning',
          title: 'Every contracted seat is in use',
          body:
            `${used} of ${subscription.seatsLicensed} seats are consumed. No further person can ` +
            'be invited until a seat is freed or the contracted number is raised.',
          dedupeKey: `seats:${subscription.id}:100`,
        });
      } else if (fraction >= SEAT_WARNING_FRACTION) {
        alerts.push({
          severity: 'Warning',
          title: 'Seats are nearly exhausted',
          body: `${used} of ${subscription.seatsLicensed} contracted seats are consumed.`,
          dedupeKey: `seats:${subscription.id}:${Math.round(SEAT_WARNING_FRACTION * 100)}`,
        });
      }
    }

    return alerts;
  }

  /**
   * Everybody who could act on a budget alert.
   *
   * `CompanyAdmin` by role kind rather than by permission lookup: this runs on the platform plane
   * with no request context, and resolving effective permissions for every member of every
   * company on every sweep would be a great deal of work to answer a question the role kind
   * already answers.
   */
  private async companyAdmins(tenantId: string): Promise<string[]> {
    const rows = await this.prisma.runAsPlatformOperation(() =>
      this.prisma.client.roleAssignment.findMany({
        where: { tenantId, roleKind: 'CompanyAdmin' },
        select: { userId: true },
      }),
    );

    const active = await this.prisma.runAsPlatformOperation(() =>
      this.prisma.client.tenantMembership.findMany({
        where: {
          tenantId,
          userId: { in: rows.map((row) => row.userId) },
          accountState: 'Active',
        },
        select: { userId: true },
      }),
    );

    // Active memberships only: notifying somebody who has been offboarded would be telling a
    // person who has left about a company they can no longer reach.
    return [...new Set(active.map((row) => row.userId))];
  }

  /** For a company-facing read: which thresholds this company has already been alerted at. */
  async alertedThresholds(scope: TenantScope): Promise<string[]> {
    const rows = await this.prisma.runInTenantTransaction(scope, () =>
      this.prisma.client.notification.findMany({
        where: { tenantId: scope.tenantId, kind: 'BudgetThreshold' },
        select: { dedupeKey: true },
        distinct: ['dedupeKey'],
      }),
    );
    return rows.map((row) => row.dedupeKey);
  }
}
