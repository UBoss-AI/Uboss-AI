import type { HealthStatus } from './health.js';

/**
 * Support, authorized support sessions and system health — Prompt 36.
 *
 * ## What the approved documents ask for
 *
 * UBoss_Final_1 §Master Console: **Support & Operations** is *"Tickets, support access requests,
 * issue history, service incidents and operational notes"*, and **System Health** is
 * *"Provider/tool/service health and major operational incidents visible to permitted UBoss
 * operations roles."*
 *
 * Technical Architecture §Modules: the `support` module owns *"support sessions, tickets,
 * incidents and system health"*. §30: *"Incident severity P0/P1/P2 with owner, acknowledgment,
 * customer impact, timeline, mitigation, postmortem and corrective action"*, and *"System Health
 * in Master Console shows provider/tool/service health and major incidents to permitted roles."*
 * §895: *"Cross-tenant support access requires explicit support session authorization."*
 *
 * ## The support session already exists, and this does not build a second one
 *
 * Prompt 8 built break-glass: a request with a mandatory reason, identity verification, approval
 * by somebody other than the requester, an explicit module/action/resource scope, a hard expiry,
 * revocation, usage counting and customer notification. **That is the support session** the prompt
 * describes, down to the fields it names, and building a parallel "support session" table beside
 * it would have given UBoss two answers to "who reached into this company and why".
 *
 * What this module adds to it is the one thing missing: **customer authorization where policy
 * requires**. Everything else here is tickets, incidents and health.
 *
 * ## What "must not automatically gain unrestricted tenant content access" means in code
 *
 * `PlatformSupport` holds `support: Administer`, `companies: View` and `system-health: View` —
 * and nothing on any company module. There is no path from a platform role to a tenant's
 * objectives, files, memory or runs; the only path is a break-glass grant, which is scoped,
 * expiring, approved by a second person and recorded. That was already true at Prompt 9, and a
 * test in this prompt pins it shut rather than leaving it to be true by accident.
 */

// ---------------------------------------------------------------------------
// Tickets
// ---------------------------------------------------------------------------

/**
 * What a ticket is about.
 *
 * §Support & Operations names *"tickets"*, *"support access requests"* and *"issue history"*
 * without enumerating kinds, so these are the defensible minimum that keeps a queue sortable.
 *
 * **`AccessRequest` is a ticket kind and not a second access mechanism.** A customer asking UBoss
 * to look at something is a support conversation; the *access* that may follow it is a break-glass
 * request, and the ticket carries the link. Collapsing the two would mean a ticket could grant
 * access, which is the thing this whole module exists to prevent.
 */
export const SUPPORT_TICKET_KINDS = [
  'Question',
  'Problem',
  'AccessRequest',
  'Billing',
  'Incident',
] as const;
export type SupportTicketKind = (typeof SUPPORT_TICKET_KINDS)[number];

export const SUPPORT_TICKET_KIND_LABELS: Record<SupportTicketKind, string> = {
  Question: 'A question',
  Problem: 'Something is not working',
  AccessRequest: 'Asking UBoss to look at something',
  Billing: 'Billing or plan',
  Incident: 'A service incident affecting us',
};

/**
 * Priority, in the customer's words rather than P-numbers.
 *
 * P0/P1/P2 belong to *incidents* (§30 names them there) and are an operations vocabulary. A
 * company raising a ticket is not grading UBoss's outage severity, so the two are deliberately
 * different scales — conflating them would put a customer in charge of the incident severity that
 * drives UBoss's own response.
 */
export const SUPPORT_PRIORITIES = ['Low', 'Normal', 'High', 'Urgent'] as const;
export type SupportPriority = (typeof SUPPORT_PRIORITIES)[number];

export const DEFAULT_SUPPORT_PRIORITY: SupportPriority = 'Normal';

/**
 * A ticket's lifecycle.
 *
 * `WaitingOnCustomer` is separate from `InProgress` because the two answer different questions
 * about the same ticket: one is "UBoss owes this company a reply", the other is the reverse. A
 * queue that cannot tell them apart reports an ageing backlog that is mostly waiting on somebody
 * else, and nobody trusts it twice.
 *
 * `Resolved` is not `Closed`. A resolved ticket is one UBoss believes is finished; a closed one is
 * finished. The gap between them is where a customer says "no it isn't", which is why `Resolved`
 * can go back to `InProgress` and `Closed` cannot.
 */
export const SUPPORT_TICKET_STATES = [
  'New',
  'Acknowledged',
  'InProgress',
  'WaitingOnCustomer',
  'Resolved',
  'Closed',
] as const;
export type SupportTicketState = (typeof SUPPORT_TICKET_STATES)[number];

export const SUPPORT_TICKET_STATE_LABELS: Record<SupportTicketState, string> = {
  New: 'New',
  Acknowledged: 'Acknowledged',
  InProgress: 'Being worked on',
  WaitingOnCustomer: 'Waiting on the company',
  Resolved: 'Resolved',
  Closed: 'Closed',
};

export const ALLOWED_TICKET_TRANSITIONS: Record<SupportTicketState, readonly SupportTicketState[]> =
  {
    New: ['Acknowledged', 'InProgress', 'Resolved', 'Closed'],
    Acknowledged: ['InProgress', 'WaitingOnCustomer', 'Resolved', 'Closed'],
    InProgress: ['WaitingOnCustomer', 'Resolved', 'Closed'],
    WaitingOnCustomer: ['InProgress', 'Resolved', 'Closed'],
    // Back to work when the company says it is not fixed. This is the reason `Resolved` and
    // `Closed` are two states rather than one.
    Resolved: ['InProgress', 'Closed'],
    // Terminal. Reopening is a new ticket that references this one, so the history of what was
    // closed and when stays intact.
    Closed: [],
  };

export function mayMoveTicket(from: SupportTicketState, to: SupportTicketState): boolean {
  return ALLOWED_TICKET_TRANSITIONS[from].includes(to);
}

/** States in which UBoss owes the company something. Drives the operations queue. */
export const OPEN_TICKET_STATES: readonly SupportTicketState[] = [
  'New',
  'Acknowledged',
  'InProgress',
];

export function ticketIsOpen(state: SupportTicketState): boolean {
  return state !== 'Resolved' && state !== 'Closed';
}

/**
 * Whether a note may be shown to the company.
 *
 * §Support & Operations asks for *"operational notes"* alongside the ticket history, and the two
 * are different things: a reply to the customer and a note between operators. One table with a
 * flag rather than two tables, because they interleave in time and a reader needs them in order —
 * but **the flag defaults to internal**, so a note is private unless somebody deliberately shares
 * it. The opposite default would leak an operator's working notes to a customer the first time
 * anybody forgot.
 */
export const DEFAULT_NOTE_IS_INTERNAL = true;

// ---------------------------------------------------------------------------
// Customer authorization of a support session
// ---------------------------------------------------------------------------

/**
 * Whether this company requires its own authorization before UBoss support may enter.
 *
 * The prompt says *"customer authorization **where policy requires**"*, which is a configurable
 * control rather than a universal one — so this is a company setting with two values and no
 * emergency bypass.
 *
 * **There is no bypass, and that is the decision.** A "break in anyway for a P0" escape hatch
 * would make the control advisory, and an advisory control is worse than none because a company
 * believes it is protected. A company that turns this on accepts that a support session waits for
 * one of their administrators; a company that cannot accept that leaves it off.
 *
 * The default is `NotRequired`, matching the prompt's "where policy requires" — the protections
 * that apply to *every* session regardless are the ones break-glass already enforces: a mandatory
 * reason, verified identity, approval by a second platform person, an explicit scope, a hard
 * expiry, and customer notification.
 */
export const SUPPORT_AUTHORIZATION_MODES = ['NotRequired', 'Required'] as const;
export type SupportAuthorizationMode = (typeof SUPPORT_AUTHORIZATION_MODES)[number];

export const SUPPORT_AUTHORIZATION_MODE_LABELS: Record<SupportAuthorizationMode, string> = {
  NotRequired: 'UBoss support may enter under its own approval',
  Required: 'One of our administrators must authorize each session',
};

export const SUPPORT_AUTHORIZATION_MODE_DESCRIPTIONS: Record<SupportAuthorizationMode, string> = {
  NotRequired:
    'A session still needs a written reason, a verified identity, approval by a second UBoss ' +
    'person, an explicit scope and a hard expiry, and you are notified that it happened.',
  Required:
    'All of the above, and a session cannot begin until one of your administrators authorizes ' +
    'it. There is no emergency bypass: if nobody authorizes it, UBoss does not enter.',
};

export const DEFAULT_SUPPORT_AUTHORIZATION_MODE: SupportAuthorizationMode = 'NotRequired';

/** Where a company's authorization of one session stands. */
export const CUSTOMER_AUTHORIZATION_STATES = [
  'NotRequired',
  'Pending',
  'Authorized',
  'Declined',
] as const;
export type CustomerAuthorizationState = (typeof CUSTOMER_AUTHORIZATION_STATES)[number];

export const CUSTOMER_AUTHORIZATION_STATE_LABELS: Record<CustomerAuthorizationState, string> = {
  NotRequired: 'Not required by this company’s policy',
  Pending: 'Waiting for the company to authorize',
  Authorized: 'The company authorized this session',
  Declined: 'The company declined',
};

export type SessionStartDecision = { mayStart: true } | { mayStart: false; reason: string };

/**
 * Whether a support session may begin.
 *
 * The one function that decides it, so the service and any screen that previews the answer cannot
 * disagree. **A `Declined` authorization is terminal for that session** — support does not get to
 * wait for a different administrator to say yes, because that is how a refusal becomes a poll.
 */
export function decideSessionStart(input: {
  mode: SupportAuthorizationMode;
  authorization: CustomerAuthorizationState;
}): SessionStartDecision {
  if (input.mode === 'NotRequired') {
    return { mayStart: true };
  }

  switch (input.authorization) {
    case 'Authorized':
      return { mayStart: true };
    case 'Declined':
      return {
        mayStart: false,
        reason:
          'This company declined the session. A declined session is not retried — raise a new ' +
          'request explaining what changed.',
      };
    case 'Pending':
      return {
        mayStart: false,
        reason:
          'This company requires one of its administrators to authorize a support session, and ' +
          'nobody has yet. There is no emergency bypass.',
      };
    case 'NotRequired':
      return {
        mayStart: false,
        reason:
          'This company’s policy now requires its authorization, and this request was raised ' +
          'before that. Ask for authorization on it.',
      };
  }
}

/** The authorization a new request starts in, given the company's policy. */
export function initialAuthorizationState(
  mode: SupportAuthorizationMode,
): CustomerAuthorizationState {
  return mode === 'Required' ? 'Pending' : 'NotRequired';
}

// ---------------------------------------------------------------------------
// Incidents
// ---------------------------------------------------------------------------

/**
 * Incident severity — **P0/P1/P2, exactly as §30 names them.**
 *
 * Not invented, not extended to a P3. The Technical Architecture lists three and the response
 * expectations differ meaningfully between them; a fourth would be a backlog label wearing an
 * incident's clothes.
 */
export const INCIDENT_SEVERITIES = ['P0', 'P1', 'P2'] as const;
export type IncidentSeverity = (typeof INCIDENT_SEVERITIES)[number];

export const INCIDENT_SEVERITY_LABELS: Record<IncidentSeverity, string> = {
  P0: 'P0 — the service is down or unusable',
  P1: 'P1 — a major function is broken or badly degraded',
  P2: 'P2 — a limited or worked-around problem',
};

export const INCIDENT_STATES = ['Open', 'Acknowledged', 'Mitigated', 'Resolved'] as const;
export type IncidentState = (typeof INCIDENT_STATES)[number];

export const INCIDENT_STATE_LABELS: Record<IncidentState, string> = {
  Open: 'Open',
  Acknowledged: 'Acknowledged',
  Mitigated: 'Mitigated — the impact has stopped',
  Resolved: 'Resolved',
};

export const ALLOWED_INCIDENT_TRANSITIONS: Record<IncidentState, readonly IncidentState[]> = {
  Open: ['Acknowledged', 'Mitigated', 'Resolved'],
  Acknowledged: ['Mitigated', 'Resolved'],
  // Back to acknowledged when a mitigation does not hold. An incident that could only move
  // forward would force an operator to open a second incident for the same outage.
  Mitigated: ['Resolved', 'Acknowledged'],
  Resolved: [],
};

export function mayMoveIncident(from: IncidentState, to: IncidentState): boolean {
  return ALLOWED_INCIDENT_TRANSITIONS[from].includes(to);
}

export function incidentIsActive(state: IncidentState): boolean {
  return state !== 'Resolved';
}

/**
 * What this prompt's incident record does **not** carry.
 *
 * §30 asks for *"owner, acknowledgment, customer impact, timeline, mitigation, postmortem and
 * corrective action"*. Owner, acknowledgement, customer impact and mitigation are here, because
 * System Health cannot show "active incidents" without them. **Timeline, postmortem and corrective
 * action are Prompt 39's**, which is the observability and incident-workflow prompt.
 *
 * The record is built here so Prompt 39 extends one table rather than introducing a second, and
 * this constant states the boundary so that prompt does not have to rediscover it.
 */
export const INCIDENT_WORKFLOW_BOUNDARY =
  'Prompt 36 records an incident so System Health can show it: severity, state, owner, affected ' +
  'components, customer impact and mitigation. The timeline, postmortem and corrective actions ' +
  'belong to the observability and incident-workflow prompt, which extends this record rather ' +
  'than adding a second one.';

// ---------------------------------------------------------------------------
// System health
// ---------------------------------------------------------------------------

/**
 * The components System Health reports on.
 *
 * §Final_1 names *"provider/tool/service health"*; the Technical Architecture's metrics list adds
 * *"queue depth/age"* and *"connection health"*. These five are those, plus the database, which is
 * the one dependency whose failure makes every other reading meaningless.
 */
export const HEALTH_COMPONENTS = ['Api', 'Database', 'Queue', 'Providers', 'Connections'] as const;
export type HealthComponent = (typeof HEALTH_COMPONENTS)[number];

export const HEALTH_COMPONENT_LABELS: Record<HealthComponent, string> = {
  Api: 'API',
  Database: 'Database',
  Queue: 'Run queue',
  Providers: 'AI providers',
  Connections: 'Customer connections',
};

export interface ComponentHealth {
  component: HealthComponent;
  status: HealthStatus;
  /** One sentence a person reads. Never a stack trace, a host name or a credential. */
  detail: string;
  /**
   * Whether a real probe produced this.
   *
   * **False when the reading is structural rather than measured** — a provider adapter that is
   * shaped and unconfigured reports its own absence rather than a latency. The same honesty rule
   * as `produced_by_real_model` and `scanned_by_real_scanner`: a green dot that nothing measured
   * must say so.
   */
  measured: boolean;
}

/**
 * The worst status wins.
 *
 * A system health page that averaged its components would show "mostly fine" during an outage.
 */
export function worstStatus(statuses: readonly HealthStatus[]): HealthStatus {
  if (statuses.includes('down')) return 'down';
  if (statuses.includes('degraded')) return 'degraded';
  return 'ok';
}

export function overallStatus(components: readonly ComponentHealth[]): HealthStatus {
  return worstStatus(components.map((component) => component.status));
}

/**
 * What a company is allowed to see about UBoss's own health.
 *
 * The prompt asks for *"permitted customer-visible status where appropriate"*, and "where
 * appropriate" is the whole of it. A customer sees **a status and a sentence**, and never:
 *
 *  * which internal component failed — that is an architecture disclosure;
 *  * an error message, host, queue name or latency figure;
 *  * any incident nobody has deliberately marked customer-visible.
 *
 * So the customer-facing view is computed from the *incidents an operator chose to publish*, not
 * from the component probes. An outage nobody published shows as `ok`, which is a deliberate
 * trade: UBoss says nothing rather than leaking an internal reading it did not mean to publish,
 * and the pressure to publish belongs on the incident process rather than on a scraper.
 */
export interface CustomerVisibleStatus {
  status: HealthStatus;
  /** Written by an operator for customers. Never assembled from internal detail. */
  summary: string;
  /**
   * Only the incidents an operator marked customer-visible.
   *
   * **There is deliberately no `title` and no `summary` here.** Both of those exist on the alert
   * as an operator's *internal* headline — "db-primary-2 exhausted its connection pool" — and an
   * early version of this type carried one, which published exactly the internal detail this
   * module exists to withhold. A test caught it by asserting on the words.
   *
   * So the shape itself is the control: the only free text a customer receives is
   * `customerImpact`, which a check constraint requires an operator to write before the incident
   * can be published. There is no field left for an internal string to travel in.
   */
  incidents: {
    id: string;
    severity: IncidentSeverity;
    state: IncidentState;
    startedAt: string;
    /** The operator's customer-facing wording. The only text a customer sees. */
    customerImpact: string;
  }[];
}

/** The status a published incident implies for customers. */
export function statusFromIncidents(
  incidents: readonly { severity: IncidentSeverity; state: IncidentState }[],
): HealthStatus {
  const active = incidents.filter((incident) => incidentIsActive(incident.state));
  if (active.length === 0) return 'ok';
  // A P0 is "down" by its own definition — §30 calls it the service being unusable. Anything
  // else active is a degradation.
  return active.some((incident) => incident.severity === 'P0') ? 'down' : 'degraded';
}

export const CUSTOMER_STATUS_STANCE =
  'A company sees UBoss’s overall status and the incidents UBoss has deliberately published. It ' +
  'never sees which internal component is failing, an error message, a host, a queue name or a ' +
  'latency figure — those are an architecture disclosure, not a status.';

/**
 * Platform support holds no company module, and this states it as a value a test can assert.
 *
 * The prompt's own sentence: *"Platform support staff must not automatically gain unrestricted
 * tenant content access."* The mechanism is that `PlatformSupport` is granted `support`,
 * `companies: View` and `system-health: View` and nothing else — so there is no company module on
 * which it holds any action at all, and the only route into a tenant is a scoped, expiring,
 * separately approved break-glass grant.
 */
export const SUPPORT_ACCESS_STANCE =
  'A UBoss support operator holds no permission on any company module. Reaching into a company ' +
  'requires a break-glass session: a written reason, a verified identity, approval by a second ' +
  'UBoss person, an explicit module and action scope, a hard expiry, and a notification to the ' +
  'company. Where the company’s policy requires it, one of their own administrators must ' +
  'authorize the session as well, and there is no bypass.';
