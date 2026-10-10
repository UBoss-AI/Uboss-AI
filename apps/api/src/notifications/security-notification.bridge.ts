import { Injectable, Logger, type OnModuleInit } from '@nestjs/common';

import { SecurityEventService, type SecurityEventInput } from '../audit/security-event.service.js';
import { NotificationService } from './notification.service.js';

/**
 * Severity mapping from the security trail to a notification.
 *
 * `Critical` on the security trail becomes a `Critical` notification, which the engine makes
 * mandatory **and** acknowledgement-requiring. Everything else is a `Warning`, which is still
 * mandatory because the kind is `SecurityEvent` — the client's rule is that these cannot be
 * muted, not that they all demand a click.
 */
const SEVERITY: Record<string, 'Warning' | 'Critical'> = {
  Info: 'Warning',
  Warning: 'Warning',
  Critical: 'Critical',
};

/**
 * Wording per security action, for the notifications a person actually receives.
 *
 * A closed table rather than formatting the action key: `security.new_device_sign_in` is a
 * machine identifier and putting it in front of somebody would be the same defect as showing
 * `svgDashboard` in the sidebar. An unmapped action falls back to a sentence that says what
 * little is certain rather than inventing detail.
 */
const WORDING: Record<string, { title: string; body: string }> = {
  'security.new_device_sign_in': {
    title: 'A new device signed in to your account',
    body:
      'If this was you, nothing needs doing. If it was not, change your password and sign out ' +
      'of all devices from Login & Security.',
  },
  'security.account_locked': {
    title: 'Your account was locked',
    body:
      'Too many failed sign-in attempts locked the account. It unlocks automatically; if this ' +
      'was not you, somebody is trying your password.',
  },
  'security.login_blocked_lockout': {
    title: 'A sign-in to your account was blocked',
    body: 'The account is locked after repeated failed attempts, so this attempt was refused.',
  },
  'security.login_blocked_policy': {
    title: 'A sign-in to your account was blocked by policy',
    body: 'A security policy in this company refused the attempt.',
  },
  'security.password_changed': {
    title: 'Your password was changed',
    body: 'If you did not change it, contact your administrator immediately.',
  },
  'security.password_reset_completed': {
    title: 'Your password was reset',
    body: 'If you did not request this, contact your administrator immediately.',
  },
  'security.mfa_factor_revoked': {
    title: 'A second factor was removed from your account',
    body: 'If you did not remove it, your account may be compromised.',
  },
  'security.mfa_replay_rejected': {
    title: 'A reused verification code was rejected',
    body:
      'Somebody submitted a code that had already been used. If that was not you, your codes ' +
      'may be visible to somebody else.',
  },
  'security.session_revoked_by_admin': {
    title: 'An administrator signed you out',
    body: 'Your sessions were ended by a company administrator.',
  },

  /*
   * The rest of the events that actually send a message.
   *
   * Twenty-two actions reach this table and six had an entry, so sixteen of them arrived as *"A
   * security event on your account — something security-relevant happened on your account in
   * this workspace"*. A real administrator received one for granting somebody a role, which is
   * the most ordinary act there is, and it read like a breach.
   *
   * That is worse than no notification. An alarming sentence with no content cannot be acted on,
   * and a person who gets three of them stops reading the fourth — which is the one that
   * matters. The fallback below still exists for an action nobody has written words for yet, and
   * it should keep shrinking.
   */
  'security.role_assigned': {
    title: 'Your access in this company changed',
    body:
      'An administrator gave you a role. What you can see and do may have changed; Login & ' +
      'Security shows when it happened and who did it.',
  },
  'security.role_revoked': {
    title: 'A role was removed from your account',
    body:
      'An administrator removed one of your roles, so some screens may no longer be available ' +
      'to you. If that stops you working, ask them — it is reversible.',
  },
  'security.user_type_changed': {
    title: 'You are now an internal user of this company',
    body:
      'You were a guest and have been employed, so your access is no longer capped at reading ' +
      'and commenting, and no longer has an end date.',
  },
  'security.password_reset_requested': {
    title: 'A password reset was requested for your account',
    body:
      'If that was you, use the link in the email we sent. If it was not, nothing has changed ' +
      'yet and your password still works — but somebody knows your address.',
  },
  'security.mfa_failed': {
    title: 'A second-factor code was rejected',
    body:
      'Somebody entered a wrong code for your account. If it was not you, your password may be ' +
      'known to them: change it, and sign out of all devices.',
  },
  'security.mfa_recovery_code_used': {
    title: 'A recovery code was used on your account',
    body:
      'One of your single-use recovery codes signed in. Each works once. If it was not you, ' +
      'change your password and generate a new set immediately.',
  },
  'security.session_revoked_by_company_admin': {
    title: 'An administrator signed you out',
    body: 'A company administrator ended your sessions. Signing in again is all that is needed.',
  },
  'security.sso_login_failed': {
    title: 'A single sign-on attempt for your account failed',
    body:
      'Your identity provider refused the sign-in. If this keeps happening, your administrator ' +
      'can see the reason under Security.',
  },
  'security.sso_backchannel_logout': {
    title: 'Your identity provider signed you out',
    body: 'Your sessions here were ended because your provider ended the one it holds.',
  },
  'security.sso_connection_deleted': {
    title: 'Single sign-on was removed from this company',
    body:
      'An administrator deleted the connection. People who signed in through it will need a ' +
      'password, or a new connection.',
  },
  'security.scim_client_revoked': {
    title: 'An automated provisioning client was revoked',
    body:
      'A directory integration can no longer create or remove people here. Anybody it was ' +
      'keeping in step will stop being updated.',
  },
  'security.scim_user_deprovisioned': {
    title: 'Your access was ended by your company’s directory',
    body:
      'Your directory removed you from this company, so your access here has ended. Nothing has ' +
      'been deleted — your employment record and your work are kept.',
  },
  'security.separation_of_duties_blocked': {
    title: 'An action was refused because one person cannot do both halves',
    body:
      'Separation of duties stopped this: the same person may not both raise and approve it. ' +
      'Somebody else has to take the second half.',
  },
  'security.custom_role_created': {
    title: 'A custom role was created in this company',
    body:
      'An administrator wrote a new role. Roles decide what people can see and do, so it is ' +
      'worth a look under Roles & Permissions.',
  },
  'security.domain_claim_removed': {
    title: 'A domain claim was removed from this company',
    body:
      'Addresses at that domain can no longer be invited without confirming each one, and a ' +
      'single sign-on assertion carrying one is no longer believed on its own.',
  },
  'security.file_scan_found_malware': {
    title: 'A file you uploaded was found to contain malware',
    body:
      'The file was quarantined and is not available to anybody. Nothing else of yours is ' +
      'affected; the copy on the machine you sent it from may still be infected.',
  },
};

/**
 * Security events become notifications nobody can turn off.
 *
 * ## Why a bridge rather than a call inside the security service
 *
 * `SecurityEventService` deliberately exposes `onSuspiciousActivity` and states in its own
 * comment that "notification delivery belongs to the notifications module and its queue" —
 * because sending mail inside a sign-in transaction would hold a database connection open on an
 * SMTP round-trip, and a mail outage would become a sign-in outage. This subscribes to that seam,
 * which is what it was built for.
 *
 * The handler contract is **synchronous and must not block**, so this starts the work and does
 * not await it. A failure is logged and never propagates: a notification that could not be raised
 * must not turn a refused sign-in into a 500, and the security trail has already recorded the
 * event either way.
 *
 * ## What it does not notify about
 *
 * A platform-plane security event has no company — a failed sign-in before a workspace was
 * chosen, for instance — and a company notification needs a company, so those are skipped. They
 * are on the security trail, which is where a cross-tenant event belongs (ADR-045); putting one
 * in a tenant's notification list would leak the fact that somebody tried.
 */
@Injectable()
export class SecurityNotificationBridge implements OnModuleInit {
  private readonly logger = new Logger(SecurityNotificationBridge.name);

  constructor(
    private readonly securityEvents: SecurityEventService,
    private readonly notifications: NotificationService,
  ) {}

  onModuleInit(): void {
    this.securityEvents.onSuspiciousActivity((event) => {
      void this.raise(event).catch((error: unknown) =>
        this.logger.error(
          'A security notification could not be raised: ' +
            (error instanceof Error ? error.message : 'unknown error'),
        ),
      );
    });
  }

  private async raise(event: SecurityEventInput): Promise<void> {
    const tenantId = event.tenantId;
    // The person it happened *to* where that is known, otherwise the actor. For a failed sign-in
    // the account may not have been identified at all, in which case there is nobody to tell.
    const recipientUserId = event.subjectUserId ?? event.actorUserId;

    if (!tenantId || !recipientUserId) {
      return;
    }

    const wording = WORDING[event.action] ?? {
      title: 'A security event on your account',
      body:
        'Something security-relevant happened on your account in this workspace. The details ' +
        'are in Settings → Security.',
    };

    await this.notifications.raise({
      tenantId,
      recipientUserId,
      kind: 'SecurityEvent',
      severity: SEVERITY[event.severity ?? 'Warning'] ?? 'Warning',
      title: wording.title,
      body:
        event.outcome === 'Blocked'
          ? `${wording.body}\n\nThe attempt was refused by a security control.`
          : wording.body,
      /*
       * `?section=`, because `/settings/security` is not a page.
       *
       * Settings has exactly three routes — itself, `billing` and `users`. Everything else is a
       * panel on the one page, chosen by `?section=`, and the key for this one is `security`.
       * The link sent `/settings/security` and the recipient got a 404: the worst possible
       * landing for a message whose whole point is "something happened to your account, go and
       * look". Found by an administrator following one.
       */
      deepLink: '/settings?section=security',
      resourceType: event.resourceType ?? 'security_event',
      ...(event.resourceId === undefined ? {} : { resourceId: event.resourceId }),
      // Not "assigned": a security alert is something to know about, not a task in a queue.
      isAssignedToRecipient: false,
      /*
       * Keyed per action, per person, **per minute**.
       *
       * The seam hands over the event *input*, not the written row, so there is no event id to
       * key on. A key with no time component would notify once about a new device and stay
       * silent for ever; one with a full timestamp would send a message per attempt during a
       * password-guessing run — training the recipient to ignore exactly the alerts that matter.
       * A minute bucket collapses a storm into one notification and still says something again
       * if it is still happening.
       */
      dedupeKey: `security:${event.action}:${recipientUserId}:${minuteBucket(
        event.occurredAt ?? new Date(),
      )}`,
      ...(event.occurredAt === undefined ? {} : { occurredAt: event.occurredAt }),
    });
  }
}

/** `2026-09-09T13:42` — the dedupe window for a security storm. */
function minuteBucket(when: Date): string {
  return when.toISOString().slice(0, 16);
}
