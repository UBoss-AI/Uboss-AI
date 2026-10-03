import { Injectable, Logger } from '@nestjs/common';

import { companyAdminUserIds } from '../commercial/company-admins.js';
import { NotificationService } from '../notifications/notification.service.js';
import { PrismaService } from '../persistence/prisma.service.js';

/**
 * Telling the company that its workspace stopped, or started again.
 *
 * ## The gap this closes
 *
 * The webhook moves an unpaid company to read-only and the request guard refuses the next write.
 * Until this existed, that was the whole of it: nobody was told beforehand and nobody was told
 * afterwards, so the first anyone learned of it was a person failing to save their work. A
 * company discovering a billing problem through a 403 is a support call that should have been an
 * email.
 *
 * ## Why administrators and not everybody
 *
 * Every employee feels it, but only an administrator can do anything about it — paying needs
 * `settings:Administer`. Telling a hundred people about a bill none of them can settle is noise
 * that teaches the company to ignore notifications. The refusal message each employee gets when
 * they try to save already names the cause and points at Settings → Billing, which is the right
 * amount to tell somebody who cannot act.
 *
 * ## Why it is raised outside the transaction that moved the company
 *
 * `applyBillingEntitlement` does its work inside one platform transaction, which holds row locks.
 * Raising notifications is a loop over administrators, each writing a row and possibly queueing
 * mail, and holding a lock across that would block the company's own requests for as long as it
 * took. The lifecycle move is the fact; the notice is a consequence of it, and a notice that
 * fails must not roll back a company's access state.
 */
@Injectable()
export class BillingNoticeService {
  private readonly logger = new Logger(BillingNoticeService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly notifications: NotificationService,
  ) {}

  /**
   * Tell the company's administrators that access changed because of a payment.
   *
   * `transitionId` is the dedupe key's distinguishing part, and it has to be: keyed on the tenant
   * alone, a company that lapsed, paid, and lapsed again a month later would be told once and
   * never again. Keyed on the transition, each episode is its own notice and a redelivered
   * webhook is still silent, because a redelivery produces no new transition.
   */
  async accessChanged(input: {
    tenantId: string;
    entitled: boolean;
    transitionId: string;
    providerStatus: string;
  }): Promise<{ told: number }> {
    const admins = await companyAdminUserIds(this.prisma, input.tenantId);

    if (admins.length === 0) {
      /*
       * Logged loudly, because it is a real operational hole rather than a quiet no-op.
       *
       * A company with no active administrator cannot be told and cannot pay. Somebody at UBoss
       * has to reach them another way, and the only way that becomes known is this line.
       */
      this.logger.warn(
        `Company ${input.tenantId} ${input.entitled ? 'regained' : 'lost'} access on provider ` +
          'status "' +
          input.providerStatus +
          '" but has no active administrator to tell. Nobody has been notified.',
      );
      return { told: 0 };
    }

    const wording = input.entitled
      ? {
          title: 'Your workspace is working again',
          body:
            'The subscription payment went through, so this company is out of read-only and ' +
            'everybody can save their work again. Nothing was lost while it was paused.',
        }
      : {
          title: 'This company is read-only — the subscription was not paid',
          body:
            'The payment provider could not collect the subscription, so work is paused: ' +
            'everything is still here and readable, but nothing can be saved. Settle it under ' +
            'Settings → Billing and work resumes as soon as the payment goes through.',
        };

    let told = 0;
    for (const recipientUserId of admins) {
      const result = await this.notifications.raise({
        tenantId: input.tenantId,
        recipientUserId,
        kind: 'SubscriptionLapsed',
        // A restored workspace is good news and does not need to shout; a stopped one does.
        severity: input.entitled ? 'Info' : 'Critical',
        title: wording.title,
        body: wording.body,
        deepLink: '/settings/billing',
        resourceType: 'tenant',
        resourceId: input.tenantId,
        /*
         * Not assigned work.
         *
         * Paying is a decision an administrator makes, not a task somebody handed them, and
         * putting it in their "assigned to me" queue would misrepresent it — the same reasoning
         * the budget alerts already follow.
         */
        isAssignedToRecipient: false,
        dedupeKey: `subscription-access:${input.transitionId}`,
      });

      if (result.notification !== null) told += 1;
    }

    return { told };
  }
}
