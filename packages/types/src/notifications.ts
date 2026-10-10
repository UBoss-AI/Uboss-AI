/**
 * The notification catalogue.
 *
 * Shared between the API and the web app so a kind's name, its severity floor and whether it can
 * be muted are one definition rather than three — the same reasoning as the settings catalogue
 * (ADR-069). A preference screen that let somebody mute an alert the server will send anyway
 * would be a lie told by the UI.
 */

export const NOTIFICATION_KINDS = [
  'Invitation',
  'ApprovalWaiting',
  'Overdue',
  'ConnectionExpiry',
  'BudgetThreshold',
  'SecurityEvent',
  'WorkReady',
  'Badge',
  'SubscriptionLapsed',
] as const;

export type NotificationKind = (typeof NOTIFICATION_KINDS)[number];

export const NOTIFICATION_SEVERITIES = ['Info', 'Warning', 'Critical'] as const;
export type NotificationSeverity = (typeof NOTIFICATION_SEVERITIES)[number];

export const NOTIFICATION_DIGESTS = ['Off', 'Daily', 'Weekly'] as const;
export type NotificationDigest = (typeof NOTIFICATION_DIGESTS)[number];

export interface NotificationKindDefinition {
  kind: NotificationKind;
  label: string;
  /** One sentence a preference screen shows under the label. */
  description: string;
  /**
   * **Cannot be muted, at any severity.** The client's rule names security alerts specifically;
   * a `Critical` event of any kind is also mandatory, decided by severity rather than by kind.
   */
  alwaysMandatory: boolean;
  /**
   * Whether this kind escalates when it goes unanswered, and which company setting supplies the
   * window. `null` means it does not escalate — a budget threshold is information, not a task
   * somebody is failing to do.
   */
  escalatesAfterSetting: string | null;
  /** Which module owns the resource, so a permission-aware screen can group them. */
  module: string;
  /**
   * False when this kind must never be emailed, because something else already emails the event.
   *
   * There is exactly one of these and it was found by reading a real inbox. An invitation has
   * its own email — the one carrying the activation link, sent by `IdentityMailService` — and
   * the notification beside it exists for the bell. With both going out, the invited person
   * received two messages: the real one, and a second saying *"the activation link was emailed
   * to you"* whose only link went to `/login`, a page they cannot use because the password they
   * are being invited to set does not exist yet.
   *
   * A property of the kind rather than of the call site: the reason holds wherever an
   * invitation is raised from, and a flag passed in by hand is a flag somebody forgets on the
   * second call site.
   *
   * It does **not** mute the bell, and it is not a preference. The person still gets the
   * notification; what they do not get is a second, worse email about it.
   */
  emailable: boolean;
  /**
   * Which prompt brings the module that *raises* this kind. Stated because three of the six
   * cannot fire yet, and a preference screen offering a control for something nothing produces
   * should say so rather than implying it is live.
   */
  producedBy: string;
}

/**
 * Every kind, with its governance.
 *
 * Six were the client's initial list. `WorkReady` is the seventh and was asked for later, by the
 * rule that a step unlocking its successor must tell the person: "Engine completes -> Sub-Engine
 * automatically becomes Ready -> notification generated". Without a kind of its own it would have
 * to borrow one, and `Overdue` telling somebody their work has *started* is the kind of lie that
 * makes a notification centre worth ignoring.
 */
export const NOTIFICATION_KIND_DEFINITIONS: readonly NotificationKindDefinition[] = [
  {
    kind: 'Invitation',
    label: 'Invitations',
    description: 'An invitation was sent to you, accepted, or has expired.',
    alwaysMandatory: false,
    escalatesAfterSetting: null,
    module: 'users',
    emailable: false,
    producedBy: 'live — Users & Access (Prompt 13)',
  },
  {
    kind: 'ApprovalWaiting',
    label: 'Approvals waiting on you',
    description: 'Something needs your approval decision.',
    alwaysMandatory: false,
    escalatesAfterSetting: 'notifications.escalate_after_hours',
    module: 'approvals',
    emailable: true,
    producedBy: 'the Approval Engine prompt',
  },
  {
    kind: 'Overdue',
    label: 'Overdue work',
    description: 'Work assigned to you has passed its required time.',
    alwaysMandatory: false,
    escalatesAfterSetting: 'notifications.escalate_after_hours',
    module: 'todo',
    emailable: true,
    producedBy: 'the Human To-do prompt',
  },
  {
    kind: 'ConnectionExpiry',
    label: 'Connection expiry',
    description: "A connection's credential is expiring or has expired.",
    alwaysMandatory: false,
    escalatesAfterSetting: 'notifications.escalate_after_hours',
    module: 'settings',
    emailable: true,
    producedBy: 'live — Connections & Secrets (Prompt 16)',
  },
  {
    kind: 'BudgetThreshold',
    label: 'AI budget thresholds',
    description: 'AI spend or seat usage has crossed a configured threshold.',
    alwaysMandatory: false,
    escalatesAfterSetting: null,
    module: 'settings',
    emailable: true,
    producedBy: 'live — Plans & Entitlements (Prompt 11)',
  },
  {
    kind: 'SubscriptionLapsed',
    label: 'Subscription and access',
    description:
      'This company’s subscription was not paid and the workspace has gone read-only, or has ' +
      'been paid and is working again.',
    /*
     * Mandatory, and this is the one commercial kind that is.
     *
     * Everything else under `settings` is a warning somebody may reasonably choose not to see.
     * This one says the workspace has stopped: a person who muted it would discover the fact by
     * failing to save their work, which is the outcome the whole read-only design exists to
     * avoid. The client's rule is that an alert may be mandatory when ignoring it costs the
     * company the product, and this is that case.
     */
    alwaysMandatory: true,
    /*
     * It does not escalate.
     *
     * Escalation chases somebody who is failing to act. There is nobody above a company
     * administrator to chase here — the next step is UBoss contacting the customer, which is a
     * commercial conversation and not a notification.
     */
    escalatesAfterSetting: null,
    module: 'settings',
    emailable: true,
    producedBy: 'live — the payment provider’s webhook',
  },
  {
    kind: 'WorkReady',
    label: 'Work ready for you',
    description: 'A step you own is no longer waiting on anything else, and can be started.',
    alwaysMandatory: false,
    /*
     * It does not escalate.
     *
     * Escalation is for something a person is failing to do, and at the moment this is raised they
     * have not failed at anything — they have just been handed the work. Being late with it
     * afterwards is what `Overdue` is for, and that one does escalate.
     */
    escalatesAfterSetting: null,
    module: 'todo',
    emailable: true,
    producedBy: 'live — dependency release (Phase 6/7)',
  },
  {
    kind: 'SecurityEvent',
    label: 'Security alerts',
    description:
      'A security event concerning your account or this company. These cannot be turned off.',
    alwaysMandatory: true,
    escalatesAfterSetting: null,
    module: 'settings',
    emailable: true,
    producedBy: 'live — Audit & Security (Prompt 8)',
  },
  {
    kind: 'Badge',
    label: 'Your badge changed',
    description: 'Your performance badge moved up or down a level.',
    /*
     * Mutable, and it escalates nothing.
     *
     * A badge is the person's own standing, not a task and not an alert — there is nothing to
     * chase and nobody to escalate to. Somebody who would rather not be told about it should be
     * able to say so, which is why this is not mandatory; the score itself is on their
     * performance screen either way, so turning the notification off hides an announcement
     * rather than a fact.
     */
    alwaysMandatory: false,
    escalatesAfterSetting: null,
    module: 'performance',
    emailable: true,
    producedBy: 'live — the performance engine, when a badge period closes',
  },
];

const BY_KIND = new Map(
  NOTIFICATION_KIND_DEFINITIONS.map((definition) => [definition.kind, definition]),
);

export function notificationKind(kind: string): NotificationKindDefinition | undefined {
  return BY_KIND.get(kind as NotificationKind);
}

/** Kinds nobody may mute, whatever their severity. */
export const ALWAYS_MANDATORY_KINDS: readonly NotificationKind[] =
  NOTIFICATION_KIND_DEFINITIONS.filter((definition) => definition.alwaysMandatory).map(
    (definition) => definition.kind,
  );

/**
 * Is this notification one the recipient cannot turn off?
 *
 * **The one function that answers the client's "mandatory alerts cannot be muted" rule**, used by
 * the engine when deciding delivery and by the preference screen when deciding what to disable.
 * Two implementations of this rule would eventually disagree, and the version that mattered would
 * be the one in the engine — so the screen asks the same function.
 */
export function isMandatoryNotification(input: {
  kind: NotificationKind;
  severity: NotificationSeverity;
}): boolean {
  return input.severity === 'Critical' || ALWAYS_MANDATORY_KINDS.includes(input.kind);
}

export const SEVERITY_LABELS: Record<NotificationSeverity, string> = {
  Info: 'Information',
  Warning: 'Warning',
  Critical: 'Critical',
};

/**
 * Severity → the design system's `StatusTone`.
 *
 * `danger` for critical, and deliberately not `warn`: an alert somebody must acknowledge should
 * not look like one they may skim.
 */
export const SEVERITY_TONES: Record<NotificationSeverity, 'grey' | 'warn' | 'danger'> = {
  Info: 'grey',
  Warning: 'warn',
  Critical: 'danger',
};

/**
 * Dedupe key builders.
 *
 * **The key's shape decides what "duplicate" means**, so it is defined once per source rather
 * than assembled at each call site. Two of the six are deliberately different in kind:
 *
 *   * `approvalWaiting` has **no time component** — one notification per approval per person,
 *     however many times a queue re-runs. A second copy of "this is waiting on you" is noise.
 *   * `overdue` is keyed **per day** — a task still not done tomorrow is new information, and a
 *     key without the date would notify once and then stay silent for ever.
 *
 * Getting this backwards is the whole failure mode of a notification system: silent when it
 * matters, or a flood that trains people to ignore it.
 */
export const notificationDedupeKey = {
  invitationSent: (invitationId: string) => `invitation:sent:${invitationId}`,
  invitationAccepted: (invitationId: string) => `invitation:accepted:${invitationId}`,
  approvalWaiting: (approvalId: string) => `approval:${approvalId}`,
  /** Per day: still overdue tomorrow is worth saying again. */
  overdue: (workId: string, day: string) => `overdue:${workId}:${day}`,
  /** Per connection per state, so "expiring" and "expired" are two notifications, not one. */
  connectionExpiry: (connectionId: string, state: string) => `connection:${connectionId}:${state}`,
  /** Per threshold, so crossing 80% and later 100% both notify, and neither repeats. */
  budgetThreshold: (subscriptionId: string, percent: number) =>
    `budget:${subscriptionId}:${percent}`,
  /** Per security event: the event id is already unique and each one is worth saying once. */
  securityEvent: (eventId: string) => `security:${eventId}`,
  /**
   * Per task, so a step is announced as ready exactly once.
   *
   * The task id rather than the node id: a node is a line in a plan and may be re-published, while
   * the task is the actual piece of work this person was handed.
   */
  workReady: (taskId: string) => `work-ready:${taskId}`,
  /** An escalation is its own notification, keyed to what it escalated. */
  escalation: (fromNotificationId: string, toUserId: string) =>
    `escalation:${fromNotificationId}:${toUserId}`,
} as const;

/** `YYYY-MM-DD` in UTC, for a per-day dedupe key. */
export function utcDay(when: Date): string {
  return when.toISOString().slice(0, 10);
}
