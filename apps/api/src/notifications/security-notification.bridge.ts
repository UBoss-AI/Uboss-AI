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
      deepLink: '/settings/security',
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
