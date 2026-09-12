import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { COMPANY_MODULES } from './authorization.js';
import { PLATFORM_ROLE_TEMPLATES } from './platform-roles.js';
import {
  ALLOWED_INCIDENT_TRANSITIONS,
  ALLOWED_TICKET_TRANSITIONS,
  CUSTOMER_AUTHORIZATION_STATES,
  decideSessionStart,
  DEFAULT_NOTE_IS_INTERNAL,
  DEFAULT_SUPPORT_AUTHORIZATION_MODE,
  HEALTH_COMPONENT_LABELS,
  HEALTH_COMPONENTS,
  INCIDENT_SEVERITIES,
  INCIDENT_STATES,
  incidentIsActive,
  initialAuthorizationState,
  mayMoveIncident,
  mayMoveTicket,
  OPEN_TICKET_STATES,
  overallStatus,
  statusFromIncidents,
  SUPPORT_AUTHORIZATION_MODES,
  SUPPORT_TICKET_KIND_LABELS,
  SUPPORT_TICKET_KINDS,
  SUPPORT_TICKET_STATE_LABELS,
  SUPPORT_TICKET_STATES,
  ticketIsOpen,
  worstStatus,
  type ComponentHealth,
  type IncidentState,
  type SupportTicketState,
} from './support.js';

/**
 * Support, support sessions and system health — Prompt 36.
 *
 * The weight is on the two things a wrong answer would make dangerous: **whether a support session
 * may begin**, and **what a customer is allowed to see about UBoss's health**. The ticket and
 * incident state machines are here because a transition table nobody tested is a transition table
 * with a hole in it.
 */
describe('support tickets', () => {
  it('labels every kind and every state', () => {
    for (const kind of SUPPORT_TICKET_KINDS) {
      assert.equal(typeof SUPPORT_TICKET_KIND_LABELS[kind], 'string');
    }
    for (const state of SUPPORT_TICKET_STATES) {
      assert.equal(typeof SUPPORT_TICKET_STATE_LABELS[state], 'string');
    }
  });

  it('reaches every state from New', () => {
    const seen = new Set<SupportTicketState>(['New']);
    const queue: SupportTicketState[] = ['New'];

    while (queue.length > 0) {
      const current = queue.shift() as SupportTicketState;
      for (const next of ALLOWED_TICKET_TRANSITIONS[current]) {
        if (!seen.has(next)) {
          seen.add(next);
          queue.push(next);
        }
      }
    }

    assert.equal(
      seen.size,
      SUPPORT_TICKET_STATES.length,
      `unreachable ticket states: ${SUPPORT_TICKET_STATES.filter((state) => !seen.has(state)).join(', ')}`,
    );
  });

  it('lets a resolved ticket go back to work and never reopens a closed one', () => {
    assert.equal(mayMoveTicket('Resolved', 'InProgress'), true);
    assert.equal(mayMoveTicket('Closed', 'InProgress'), false);
    assert.deepEqual(ALLOWED_TICKET_TRANSITIONS.Closed, []);
  });

  it('counts waiting-on-customer as open but not as UBoss’s queue', () => {
    assert.equal(ticketIsOpen('WaitingOnCustomer'), true);
    assert.equal(
      OPEN_TICKET_STATES.includes('WaitingOnCustomer'),
      false,
      'a ticket waiting on the company must not inflate UBoss’s own backlog',
    );
    assert.equal(ticketIsOpen('Resolved'), false);
    assert.equal(ticketIsOpen('Closed'), false);
  });

  it('keeps operational notes internal by default', () => {
    assert.equal(
      DEFAULT_NOTE_IS_INTERNAL,
      true,
      'a note must be private unless somebody deliberately shares it',
    );
  });
});

describe('customer authorization of a support session', () => {
  it('defaults to not required, which is what "where policy requires" means', () => {
    assert.equal(DEFAULT_SUPPORT_AUTHORIZATION_MODE, 'NotRequired');
    assert.deepEqual([...SUPPORT_AUTHORIZATION_MODES], ['NotRequired', 'Required']);
  });

  it('starts a request pending only when the company requires it', () => {
    assert.equal(initialAuthorizationState('Required'), 'Pending');
    assert.equal(initialAuthorizationState('NotRequired'), 'NotRequired');
  });

  it('lets a session start under NotRequired whatever the authorization says', () => {
    for (const authorization of CUSTOMER_AUTHORIZATION_STATES) {
      assert.equal(
        decideSessionStart({ mode: 'NotRequired', authorization }).mayStart,
        true,
        `NotRequired should not be blocked by ${authorization}`,
      );
    }
  });

  it('refuses to start a required session that nobody authorized', () => {
    const decision = decideSessionStart({ mode: 'Required', authorization: 'Pending' });
    assert.equal(decision.mayStart, false);
    assert.equal(
      decision.mayStart === false && decision.reason.includes('no emergency bypass'),
      true,
      'the absence of a bypass is the point, and it has to be said',
    );
  });

  it('treats a declined session as terminal rather than something to retry', () => {
    const decision = decideSessionStart({ mode: 'Required', authorization: 'Declined' });
    assert.equal(decision.mayStart, false);
    assert.equal(
      decision.mayStart === false && decision.reason.includes('not retried'),
      true,
      'a refusal that can be polled until somebody says yes is not a refusal',
    );
  });

  it('refuses a request raised before the policy was turned on', () => {
    // `NotRequired` on the request while the company now requires authorization: the request
    // predates the policy, so it has no authorization to rely on.
    const decision = decideSessionStart({ mode: 'Required', authorization: 'NotRequired' });
    assert.equal(decision.mayStart, false);
  });

  it('starts once the company authorizes', () => {
    assert.equal(
      decideSessionStart({ mode: 'Required', authorization: 'Authorized' }).mayStart,
      true,
    );
  });
});

describe('platform support holds nothing on a company', () => {
  /**
   * The prompt's own sentence, asserted rather than assumed: *"Platform support staff must not
   * automatically gain unrestricted tenant content access."*
   */
  it('grants PlatformSupport no action on any company module', () => {
    const support = PLATFORM_ROLE_TEMPLATES.PlatformSupport;

    for (const module of COMPANY_MODULES) {
      const granted = support.permissions[module] ?? [];
      assert.deepEqual(
        [...granted],
        [],
        `PlatformSupport was granted ${granted.join(', ')} on the company module "${module}"`,
      );
    }
  });

  it('grants it no Administer on companies either', () => {
    const onCompanies = PLATFORM_ROLE_TEMPLATES.PlatformSupport.permissions.companies ?? [];
    assert.equal(onCompanies.includes('Administer'), false);
    assert.equal(onCompanies.includes('View'), true, 'it still has to be able to find a company');
  });
});

describe('incidents', () => {
  it('uses exactly the three severities the architecture names', () => {
    assert.deepEqual([...INCIDENT_SEVERITIES], ['P0', 'P1', 'P2']);
  });

  it('reaches every state from Open and ends at Resolved', () => {
    const seen = new Set<IncidentState>(['Open']);
    const queue: IncidentState[] = ['Open'];

    while (queue.length > 0) {
      const current = queue.shift() as IncidentState;
      for (const next of ALLOWED_INCIDENT_TRANSITIONS[current]) {
        if (!seen.has(next)) {
          seen.add(next);
          queue.push(next);
        }
      }
    }

    assert.equal(seen.size, INCIDENT_STATES.length);
    assert.deepEqual(ALLOWED_INCIDENT_TRANSITIONS.Resolved, []);
  });

  it('lets a mitigation that did not hold go back to acknowledged', () => {
    assert.equal(mayMoveIncident('Mitigated', 'Acknowledged'), true);
  });

  it('counts everything but Resolved as active', () => {
    assert.equal(incidentIsActive('Open'), true);
    assert.equal(incidentIsActive('Mitigated'), true);
    assert.equal(incidentIsActive('Resolved'), false);
  });
});

describe('system health', () => {
  it('lets the worst component decide the whole', () => {
    assert.equal(worstStatus(['ok', 'ok', 'degraded']), 'degraded');
    assert.equal(worstStatus(['ok', 'down', 'degraded']), 'down');
    assert.equal(worstStatus(['ok', 'ok']), 'ok');
    assert.equal(worstStatus([]), 'ok');
  });

  it('does not average an outage away', () => {
    const components: ComponentHealth[] = [
      { component: 'Api', status: 'ok', detail: 'Serving.', measured: true },
      { component: 'Database', status: 'ok', detail: 'Reachable.', measured: true },
      { component: 'Queue', status: 'ok', detail: 'Draining.', measured: true },
      { component: 'Providers', status: 'ok', detail: 'Mock only.', measured: false },
      { component: 'Connections', status: 'down', detail: 'Every check failing.', measured: true },
    ];
    assert.equal(
      overallStatus(components),
      'down',
      'four healthy components must not out-vote one that is down',
    );
  });

  it('labels every component', () => {
    for (const component of HEALTH_COMPONENTS) {
      assert.equal(typeof HEALTH_COMPONENT_LABELS[component], 'string');
    }
  });

  it('derives the customer status from published incidents and nothing else', () => {
    assert.equal(statusFromIncidents([]), 'ok');
    assert.equal(statusFromIncidents([{ severity: 'P2', state: 'Open' }]), 'degraded');
    assert.equal(statusFromIncidents([{ severity: 'P0', state: 'Acknowledged' }]), 'down');
    assert.equal(
      statusFromIncidents([{ severity: 'P0', state: 'Resolved' }]),
      'ok',
      'a resolved incident is not an ongoing outage',
    );
  });

  it('exposes no way to put internal detail into a customer-facing status', () => {
    // `CustomerVisibleStatus` carries a status, an operator-written summary and published
    // incidents. It deliberately has no component list, no latency and no error text — asserted
    // by the shape of `statusFromIncidents`, which takes only severity and state and therefore
    // *cannot* leak a probe reading into the customer view.
    const derived = statusFromIncidents([{ severity: 'P1', state: 'Open' }]);
    assert.equal(derived, 'degraded');
  });
});
