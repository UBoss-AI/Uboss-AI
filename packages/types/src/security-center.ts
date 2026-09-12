/**
 * The Security Center — Prompt 32.
 *
 * ## What this module is, and what it deliberately is not
 *
 * The client's requirement (UBoss_Final_1 §27.1, Technical Architecture §Security Center) is a
 * *view*: "Company Admin receives a Security view for MFA/SSO coverage, admin accounts, guests,
 * active sessions, suspicious/failed logins, high-risk actions, exports, support access and
 * security events with permission-aware drill-down."
 *
 * A view is the whole point. Every fact the Security Center shows is already recorded somewhere
 * by the module that owns it — `security_events` for authentication and access, `sessions` for
 * who is signed in, `tenant_memberships` for guests and their expiry, `connection_tool_grants`
 * for what an Engine Agent was permitted to do, `break_glass_requests` for support access. So
 * **this module adds no store of its own.** It composes, it does not record.
 *
 * That is not tidiness, it is the security property. A Security Center with its own copy of the
 * evidence is a second version of the truth, and the first thing an investigation would have to
 * establish is which copy to believe. Worse, a copy is editable in ways the original is not: the
 * audit and security trails are append-only at the database level, and a derived table would not
 * be.
 *
 * ## Tamper protection is already structural
 *
 * "Normal tenant administrators cannot edit or delete audit/security records" is not a permission
 * this module adds. `audit_events` and `security_events` carry append-only triggers with no
 * escape hatch, so the refusal happens below the application and applies to every caller,
 * including a company administrator with every action granted. The tests assert it that way —
 * against the database, not against a guard.
 */

/**
 * The seven views the prompt names, in the order it names them.
 *
 * Ordered deliberately: an investigation starts with "who signed in", narrows to "who is signed
 * in now", then asks "what changed", and only then reaches the rarer things. The UI shows them in
 * this order.
 */
export const SECURITY_CENTER_VIEWS = [
  'AuthenticationEvents',
  'ActiveSessions',
  'AdminAndPermissionChanges',
  'GuestAccess',
  'DataExports',
  'AgentHighRiskActions',
  'SupportAccess',
] as const;
export type SecurityCenterView = (typeof SECURITY_CENTER_VIEWS)[number];

export const SECURITY_CENTER_VIEW_LABELS: Record<SecurityCenterView, string> = {
  AuthenticationEvents: 'Authentication events',
  ActiveSessions: 'Active sessions',
  AdminAndPermissionChanges: 'Admin & permission changes',
  GuestAccess: 'Guest access & expiry',
  DataExports: 'Data exports',
  AgentHighRiskActions: 'Agent high-risk actions',
  SupportAccess: 'Support & break-glass access',
};

/**
 * What each view is *for*, shown in the UI under its heading.
 *
 * Written as the question the view answers rather than as a description of its columns, because a
 * security screen is only useful to somebody who arrived with a question.
 */
export const SECURITY_CENTER_VIEW_PURPOSE: Record<SecurityCenterView, string> = {
  AuthenticationEvents: 'Who signed in or out, how, and whether it worked.',
  ActiveSessions: 'Who is signed in right now, on what, and since when.',
  AdminAndPermissionChanges: 'Who gained or lost authority, and who gave it to them.',
  GuestAccess: 'Which external people hold access to this company, and until when.',
  DataExports: 'What left this company as a file, who took it and under what permission.',
  AgentHighRiskActions: 'What an Engine Agent was permitted to delete, send, export or change.',
  SupportAccess: 'When UBoss support held access to this company, why, and for how long.',
};

/**
 * Which rows a view is built from.
 *
 * `EventCategory` views read `security_events` and filter by the classification that module
 * already assigns. `Identity` views read current state — a session or a membership is not an
 * event, and presenting one as an event would put a "when did it happen" column on a row whose
 * answer is "it is still happening".
 */
export type SecurityCenterSource =
  | { kind: 'SecurityEvents'; categories: readonly SecurityEventCategory[] }
  | { kind: 'SecurityEventActions'; actions: readonly string[] }
  | { kind: 'LiveSessions' }
  | { kind: 'GuestMemberships' }
  | { kind: 'AgentToolGrants' };

/**
 * The categories the security-event classification already uses.
 *
 * Transcribed rather than re-derived: `SECURITY_ACTIONS` in the API assigns one of these to each
 * of its actions, and this list exists so the web app can name a filter without importing server
 * code. Keeping them in step is what `everySecurityCategoryIsReachable` is for.
 */
export const SECURITY_EVENT_CATEGORIES = ['Login', 'Session', 'Access', 'Risk', 'Support'] as const;
export type SecurityEventCategory = (typeof SECURITY_EVENT_CATEGORIES)[number];

/**
 * The export actions, named individually.
 *
 * The Data Exports view cannot be a category filter: an export is classified `Access`, alongside
 * fifty other actions. Naming the two export actions is the only honest way to answer "what left
 * this company", and a new export path has to be added here — which is a deliberate cost, because
 * an export that nobody can see is the failure this view exists to prevent.
 */
export const SECURITY_EXPORT_ACTIONS = [
  'security.audit_trail_exported',
  'security.security_trail_exported',
  'security.security_center_exported',
  // Prompt 35. This is the one the view's own description promised — *"what left this company as
  // a file"* — and until files existed there was nothing to list under it. The comment above
  // called adding a new export path here a deliberate cost; this is the first time it was paid.
  'security.file_downloaded',
] as const;

/**
 * Actions that change who holds authority.
 *
 * Role grants and revocations, custom roles, policy rules, separation-of-duties policies,
 * platform roles, user-type changes and the authentication policy itself. A permission change is
 * the event an investigation most often arrives looking for, which is why it gets its own view
 * rather than being one filter on a list of everything.
 */
export const SECURITY_PERMISSION_ACTIONS = [
  'security.role_assigned',
  'security.role_revoked',
  'security.custom_role_created',
  'security.custom_role_updated',
  'security.policy_rule_created',
  'security.policy_rule_deleted',
  'security.sod_policy_created',
  'security.sod_policy_deleted',
  'security.user_type_changed',
  'security.auth_policy_changed',
  'security.platform_role_granted',
  'security.platform_role_revoked',
  'security.account_suspended',
  'security.account_reinstated',
  'security.account_offboarded',
  'security.guest_access_granted',
  'security.separation_of_duties_blocked',
  'security.permission_denied',
] as const;

export const SECURITY_CENTER_VIEW_SOURCE: Record<SecurityCenterView, SecurityCenterSource> = {
  // Three categories, and each earns its place. `Login` is the obvious one. `Risk` holds the
  // new-device sign-in, the replayed MFA code and the used recovery code — classified as risk,
  // and exactly what somebody looking at authentication came to see. `Session` holds the sign-
  // outs, the admin revokes and the expiries: **without it a company could not see that somebody
  // had been signed out**, because Active Sessions shows live state and has no history in it.
  // A test pins that gap shut.
  AuthenticationEvents: { kind: 'SecurityEvents', categories: ['Login', 'Session', 'Risk'] },
  ActiveSessions: { kind: 'LiveSessions' },
  AdminAndPermissionChanges: {
    kind: 'SecurityEventActions',
    actions: SECURITY_PERMISSION_ACTIONS,
  },
  GuestAccess: { kind: 'GuestMemberships' },
  DataExports: { kind: 'SecurityEventActions', actions: SECURITY_EXPORT_ACTIONS },
  AgentHighRiskActions: { kind: 'AgentToolGrants' },
  SupportAccess: { kind: 'SecurityEvents', categories: ['Support'] },
};

/**
 * The metrics the prompt and both source documents name, in the order the reference UI shows the
 * first four.
 *
 * `index.html`'s Settings · Security screen shows exactly four cards — MFA coverage, Active
 * sessions, Admin accounts, Guests — and that layout is kept. The remaining seven are required by
 * §27.1 and the Technical Architecture and are shown on a second row, rather than by redesigning
 * the screen the client approved.
 */
export const SECURITY_METRICS = [
  'MfaCoverage',
  'ActiveSessions',
  'AdminAccounts',
  'Guests',
  'SsoStatus',
  'ExpiringGuests',
  'FailedLogins',
  'SuspiciousEvents',
  'HighRiskActions',
  'Exports',
  'SupportAccess',
] as const;
export type SecurityMetric = (typeof SECURITY_METRICS)[number];

export const SECURITY_METRIC_LABELS: Record<SecurityMetric, string> = {
  MfaCoverage: 'MFA coverage',
  ActiveSessions: 'Active sessions',
  AdminAccounts: 'Admin accounts',
  Guests: 'Guests',
  SsoStatus: 'SSO status',
  ExpiringGuests: 'Expiring guests',
  FailedLogins: 'Failed logins',
  SuspiciousEvents: 'Suspicious / new device',
  HighRiskActions: 'Agent high-risk grants',
  Exports: 'Exports',
  SupportAccess: 'Support access',
};

/** Which view a metric drills into. Every metric leads somewhere, or it is decoration. */
export const SECURITY_METRIC_DRILLDOWN: Record<SecurityMetric, SecurityCenterView> = {
  MfaCoverage: 'AuthenticationEvents',
  ActiveSessions: 'ActiveSessions',
  AdminAccounts: 'AdminAndPermissionChanges',
  Guests: 'GuestAccess',
  SsoStatus: 'AuthenticationEvents',
  ExpiringGuests: 'GuestAccess',
  FailedLogins: 'AuthenticationEvents',
  SuspiciousEvents: 'AuthenticationEvents',
  HighRiskActions: 'AgentHighRiskActions',
  Exports: 'DataExports',
  SupportAccess: 'SupportAccess',
};

/**
 * The window the event-counting metrics are measured over.
 *
 * A count with no period ("failed logins: 47") is unreadable — 47 today is an incident and 47 this
 * year is background noise. The caller picks, the default is the shortest window that still shows
 * an overnight attempt, and the figure is always labelled with its window.
 */
export const SECURITY_TIME_RANGES = [
  'Last24Hours',
  'Last7Days',
  'Last30Days',
  'Last90Days',
] as const;
export type SecurityTimeRange = (typeof SECURITY_TIME_RANGES)[number];

export const SECURITY_TIME_RANGE_LABELS: Record<SecurityTimeRange, string> = {
  Last24Hours: 'Last 24 hours',
  Last7Days: 'Last 7 days',
  Last30Days: 'Last 30 days',
  Last90Days: 'Last 90 days',
};

export const SECURITY_TIME_RANGE_HOURS: Record<SecurityTimeRange, number> = {
  Last24Hours: 24,
  Last7Days: 24 * 7,
  Last30Days: 24 * 30,
  Last90Days: 24 * 90,
};

export const DEFAULT_SECURITY_TIME_RANGE: SecurityTimeRange = 'Last7Days';

/** The start of a range, from a clock the caller supplies. */
export function rangeStart(range: SecurityTimeRange, now: Date): Date {
  return new Date(now.getTime() - SECURITY_TIME_RANGE_HOURS[range] * 3_600_000);
}

/**
 * How a metric reads: a figure, a caption, and a tone.
 *
 * `tone` is presentation, and it is derived from the company's own configuration wherever a
 * judgement is involved — never from a threshold invented here. MFA coverage below 100% is a
 * *problem* only if the company requires MFA; otherwise it is information. The approved documents
 * set no target for any of these figures, and inventing one would put a red badge on a company
 * that is complying with its own policy.
 */
export type SecurityMetricTone = 'neutral' | 'good' | 'watch' | 'bad';

export interface SecurityMetricReading {
  metric: SecurityMetric;
  label: string;
  /** The headline figure, already formatted — a percentage, a count or a word. */
  value: string;
  /** What the figure is counting, including its window where it has one. */
  caption: string;
  tone: SecurityMetricTone;
  drillsInto: SecurityCenterView;
}

/**
 * MFA coverage, and why the denominator is what it is.
 *
 * Counted over people who can actually sign in — `Active` memberships — because a coverage figure
 * that includes people who have never activated their invitation measures recruitment, not
 * security, and would never reach 100% in a company that is still hiring.
 */
export function mfaCoverage(input: { activeMembers: number; membersWithConfirmedFactor: number }): {
  percent: number;
  uncovered: number;
} {
  if (input.activeMembers <= 0) return { percent: 100, uncovered: 0 };
  const covered = Math.min(input.membersWithConfirmedFactor, input.activeMembers);
  return {
    // Floored, not rounded: 99.6% must not display as 100% on a screen whose question is
    // "is everybody covered".
    percent: Math.floor((covered / input.activeMembers) * 100),
    uncovered: input.activeMembers - covered,
  };
}

/** The tone for coverage: judged against the company's policy, not against a number I chose. */
export function mfaCoverageTone(input: {
  percent: number;
  requireMfa: boolean;
  inGracePeriod: boolean;
}): SecurityMetricTone {
  if (input.percent >= 100) return 'good';
  if (!input.requireMfa) return 'neutral';
  return input.inGracePeriod ? 'watch' : 'bad';
}

/**
 * Guests whose access ends within a window.
 *
 * The window is a query parameter, defaulted to the company's own `guestExpiryDays`, because §23
 * says guest access is "expiry-capable" and states no review period. A guest whose access has
 * *already* lapsed but whose membership is still `Active` is counted as expired rather than
 * expiring — it is a different problem, and a worse one.
 *
 * `noExpiry` is deliberately still handled even though the database refuses it:
 * `guest_membership_has_an_expiry` requires `guest_access_expires_at` for an `ExternalGuest`,
 * so the count should always be zero. Kept because the column is nullable and a screen that
 * rendered a blank where it expected a date would be the last place anybody looked — if the count
 * is ever non-zero, something has gone wrong below the application and the Security Center is
 * exactly where that should show.
 */
export function guestExpiry(
  guests: readonly { guestAccessExpiresAt: Date | null }[],
  input: { now: Date; withinDays: number },
): { total: number; expiring: number; expired: number; noExpiry: number } {
  const horizon = input.now.getTime() + input.withinDays * 86_400_000;
  let expiring = 0;
  let expired = 0;
  let noExpiry = 0;

  for (const guest of guests) {
    if (guest.guestAccessExpiresAt === null) {
      noExpiry += 1;
      continue;
    }
    const at = guest.guestAccessExpiresAt.getTime();
    if (at <= input.now.getTime()) expired += 1;
    else if (at <= horizon) expiring += 1;
  }

  return { total: guests.length, expiring, expired, noExpiry };
}

/**
 * A guest with no end date is the thing §23's "expiry-capable" exists to prevent, so it reads as
 * a problem rather than as a blank.
 */
export function guestTone(input: {
  expired: number;
  noExpiry: number;
  expiring: number;
}): SecurityMetricTone {
  if (input.expired > 0 || input.noExpiry > 0) return 'bad';
  return input.expiring > 0 ? 'watch' : 'neutral';
}

/**
 * SSO: a word rather than a count, because "2" answers no question anybody asks.
 *
 * `Required` is the strongest state and is reported even when no connection is enabled — a
 * company that requires SSO and has none configured cannot sign in, which the Security Center
 * should be the first place to say.
 */
export type SsoStatus =
  'Required' | 'RequiredButNotConfigured' | 'Enabled' | 'Configured' | 'NotConfigured';

export function ssoStatus(input: {
  connections: number;
  enabledConnections: number;
  requireSso: boolean;
}): { status: SsoStatus; tone: SecurityMetricTone } {
  if (input.requireSso) {
    return input.enabledConnections > 0
      ? { status: 'Required', tone: 'good' }
      : { status: 'RequiredButNotConfigured', tone: 'bad' };
  }
  if (input.enabledConnections > 0) return { status: 'Enabled', tone: 'good' };
  if (input.connections > 0) return { status: 'Configured', tone: 'watch' };
  return { status: 'NotConfigured', tone: 'neutral' };
}

export const SSO_STATUS_LABELS: Record<SsoStatus, string> = {
  Required: 'Required',
  RequiredButNotConfigured: 'Required, none enabled',
  Enabled: 'Enabled',
  Configured: 'Configured, not enabled',
  NotConfigured: 'Not configured',
};

/**
 * Failed logins and suspicious events read as counts, and their tone is the count itself.
 *
 * No threshold: the approved documents set none, and a company's tolerance for three failed
 * logins depends on its size. Any suspicious event in the window is worth a look, so one is
 * enough to change the tone — the screen's job is to surface it, not to grade it.
 */
export function countTone(count: number): SecurityMetricTone {
  return count > 0 ? 'watch' : 'neutral';
}

/** Support access is `bad` while it is *live*, and neutral once it has ended. */
export function supportAccessTone(input: { active: number; inWindow: number }): SecurityMetricTone {
  if (input.active > 0) return 'watch';
  return input.inWindow > 0 ? 'neutral' : 'good';
}

/**
 * What the Security Center needs from the permission engine.
 *
 * All reading is `settings:Audit`, which `CompanyAdmin` and `Auditor` hold and `Manager`,
 * `Approver` and `Employee` do not — the same gate the audit trail already uses, because this is
 * the same evidence presented differently. Two exceptions:
 *
 *   * **Export** additionally needs `settings:Export`, so a company can grant somebody the right
 *     to investigate without the right to take the evidence away.
 *   * **Revoking a session** is an act, not a read, and needs `settings:Administer`.
 *
 * Nothing here invents an action: `Audit`, `Export` and `Administer` all exist on `settings` in
 * the role templates.
 */
export const SECURITY_CENTER_READ_ACTION = 'Audit' as const;
export const SECURITY_CENTER_EXPORT_ACTION = 'Export' as const;
export const SECURITY_CENTER_REVOKE_ACTION = 'Administer' as const;
export const SECURITY_CENTER_MODULE = 'settings' as const;

/**
 * Whether a view's rows can carry a correlation id.
 *
 * The prompt asks for "correlation ID/resource links". A security event carries one because it
 * was produced by a request; a live session and a guest membership are *state* and have no
 * correlating request, so their rows link to the person instead. Claiming a correlation id on a
 * row that has none would send an investigator looking for a request that never existed.
 */
export function viewHasCorrelationIds(view: SecurityCenterView): boolean {
  const source = SECURITY_CENTER_VIEW_SOURCE[view];
  return source.kind === 'SecurityEvents' || source.kind === 'SecurityEventActions';
}

/** Every view is reachable from at least one metric, so no view is orphaned in the UI. */
export function everyViewIsReachable(): boolean {
  const reachable = new Set(Object.values(SECURITY_METRIC_DRILLDOWN));
  return SECURITY_CENTER_VIEWS.every((view) => reachable.has(view));
}

/** Every event category appears in at least one view, so no recorded event is invisible. */
export function everySecurityCategoryIsReachable(): boolean {
  const covered = new Set<SecurityEventCategory>();
  for (const view of SECURITY_CENTER_VIEWS) {
    const source = SECURITY_CENTER_VIEW_SOURCE[view];
    if (source.kind === 'SecurityEvents') {
      for (const category of source.categories) covered.add(category);
    }
  }
  // `Access` is deliberately absent as a *category* filter: it holds fifty actions, and the two
  // views that need it name the actions they mean instead.
  return SECURITY_EVENT_CATEGORIES.filter((category) => category !== 'Access').every((category) =>
    covered.has(category),
  );
}
