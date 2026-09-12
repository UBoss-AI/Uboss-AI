import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  ALERT_RULES,
  CORRELATION_CHAIN,
  CORRECTIVE_ACTION_STATE_LABELS,
  CORRECTIVE_ACTION_STATES,
  evaluateRule,
  FORBIDDEN_LOG_FIELDS,
  FORBIDDEN_METRIC_LABELS,
  LATENCY_BUCKETS_MS,
  logFieldIsForbidden,
  METRIC_KEYS,
  METRIC_KIND,
  METRIC_LABELS,
  METRIC_LABELS_ALLOWED,
  METRIC_QUESTIONS,
  metricLabelsArePermitted,
  postmortemIsRequired,
  postmortemReadiness,
  redactLogFields,
  SEVERITIES_REQUIRING_POSTMORTEM,
  TIMELINE_KIND_LABELS,
  TIMELINE_KINDS,
} from './observability.js';

/**
 * Observability — Prompt 39.
 *
 * The weight is on the four things a wrong answer makes dangerous in production: **no secret in a
 * log**, **no unbounded metric label**, **the correlation chain reaching the money**, and **a P0
 * not closeable without a postmortem**.
 */
describe('metrics', () => {
  it('names, labels and explains every metric the prompt asks for', () => {
    for (const key of METRIC_KEYS) {
      assert.equal(typeof METRIC_LABELS[key], 'string');
      assert.equal(typeof METRIC_KIND[key], 'string');
      assert.equal(
        METRIC_QUESTIONS[key].length > 10,
        true,
        `${key} needs the question it answers — a metric nobody would look at in an outage is noise`,
      );
    }
  });

  it('covers each thing the prompt lists by name', () => {
    // latency/error, queue depth/age, run success/failure, provider/tool errors, connection
    // health, credit reservation drift, notifications.
    for (const expected of [
      'request_latency_ms',
      'request_errors',
      'queue_depth',
      'queue_oldest_age_ms',
      'run_outcomes',
      'provider_errors',
      'tool_errors',
      'connection_health',
      'credit_reservation_drift',
      'notification_failures',
    ] as const) {
      assert.equal(METRIC_KEYS.includes(expected), true, `${expected} is missing`);
    }
  });

  it('calls latency a histogram and depth a gauge', () => {
    // A latency *counter* would grow forever and mean nothing.
    assert.equal(METRIC_KIND.request_latency_ms, 'histogram');
    assert.equal(METRIC_KIND.queue_depth, 'gauge');
    assert.equal(METRIC_KIND.request_errors, 'counter');
  });

  /**
   * The one that would take the metrics system down, and the one that would leak.
   *
   * A `tenant_id` label multiplies every series by the number of customers, and makes a shared
   * dashboard a cross-tenant disclosure. "Which customer was affected" is an audit-trail question.
   */
  it('permits no high-cardinality or tenant-identifying label anywhere', () => {
    for (const key of METRIC_KEYS) {
      for (const label of METRIC_LABELS_ALLOWED[key]) {
        for (const forbidden of FORBIDDEN_METRIC_LABELS) {
          assert.equal(
            label.toLowerCase() === forbidden.toLowerCase(),
            false,
            `${key} permits the label "${label}", which is forbidden`,
          );
        }
      }
    }
  });

  it('does not let a provider name reach a dashboard label', () => {
    // The locked rule is that provider names do not leave the Model Gateway. A metric label is
    // exactly where one would leak into a shared screen.
    assert.equal(METRIC_LABELS_ALLOWED.provider_errors.includes('provider'), false);
    assert.equal(METRIC_LABELS_ALLOWED.provider_errors.includes('profile'), true);
  });

  it('refuses a label that is not on the allow-list', () => {
    assert.equal(metricLabelsArePermitted('request_errors', { route: '/x', status: '500' }), true);
    assert.equal(metricLabelsArePermitted('request_errors', { tenant_id: 'abc' }), false);
    assert.equal(metricLabelsArePermitted('credit_reservation_drift', {}), true);
    assert.equal(metricLabelsArePermitted('credit_reservation_drift', { anything: 'x' }), false);
  });

  it('uses latency buckets that ascend', () => {
    for (let index = 1; index < LATENCY_BUCKETS_MS.length; index += 1) {
      assert.equal(
        (LATENCY_BUCKETS_MS[index] ?? 0) > (LATENCY_BUCKETS_MS[index - 1] ?? 0),
        true,
        'histogram buckets have to ascend or the cumulative counts are nonsense',
      );
    }
  });
});

describe('alert rules', () => {
  it('gives every rule a real metric, a summary and a rationale', () => {
    for (const rule of ALERT_RULES) {
      assert.equal(METRIC_KEYS.includes(rule.metric), true, `${rule.key} names no real metric`);
      assert.equal(rule.summary.length > 10, true);
      assert.equal(
        rule.rationale.length > 40,
        true,
        `${rule.key} needs a rationale — an unexplained threshold gets tuned to silence`,
      );
    }
  });

  it('has unique keys', () => {
    const keys = ALERT_RULES.map((rule) => rule.key);
    assert.equal(new Set(keys).size, keys.length);
  });

  it('fires above and below correctly, and treats the threshold as exclusive', () => {
    const rule = ALERT_RULES.find((candidate) => candidate.key === 'queue-backed-up');
    assert.notEqual(rule, undefined);

    assert.equal(evaluateRule(rule!, 501).firing, true);
    assert.equal(evaluateRule(rule!, 500).firing, false, 'at the threshold is not over it');
    assert.equal(evaluateRule(rule!, 0).firing, false);
  });

  /**
   * The only zero-threshold rule, and it should be.
   *
   * Reservation drift means money was set aside and neither settled nor released. It fails no
   * request, so nothing surfaces it — and by the time somebody reconciles a quarter it is a large
   * number with no explanation.
   */
  it('alerts on any credit reservation drift at all', () => {
    const drift = ALERT_RULES.find((rule) => rule.key === 'reservation-drift');
    assert.equal(drift?.threshold, 0);
    assert.equal(drift?.severity, 'Critical');
    assert.equal(evaluateRule(drift!, 1).firing, true);
    assert.equal(evaluateRule(drift!, 0).firing, false);
  });

  it('keeps Critical for the handful that should wake somebody', () => {
    const critical = ALERT_RULES.filter((rule) => rule.severity === 'Critical').map(
      (rule) => rule.key,
    );
    // Three: a wedged queue, drift, and the API erroring. Anything more and Critical stops
    // meaning anything.
    assert.equal(critical.length <= 3, true, `too many Critical rules: ${critical.join(', ')}`);
  });
});

describe('structured logs', () => {
  it('forbids every field that could carry a secret', () => {
    for (const field of ['password', 'token', 'secret', 'credential', 'aadhaar', 'apiKey']) {
      assert.equal(FORBIDDEN_LOG_FIELDS.includes(field), true, `${field} must be forbidden`);
    }
  });

  it('matches a forbidden field however it is spelled or nested in a name', () => {
    assert.equal(logFieldIsForbidden('password'), true);
    assert.equal(logFieldIsForbidden('userPassword'), true);
    assert.equal(logFieldIsForbidden('API_KEY'), true);
    assert.equal(logFieldIsForbidden('refreshToken'), true);
    assert.equal(logFieldIsForbidden('aadhaarLastFour'), true);
    assert.equal(logFieldIsForbidden('api_key'), true, 'snake_case too');
    assert.equal(logFieldIsForbidden('API-KEY'), true, 'and kebab');
    assert.equal(logFieldIsForbidden('runId'), false);
  });

  it('redacts rather than deletes, so a reader can see something was withheld', () => {
    const redacted = redactLogFields({
      route: '/x',
      authorization: 'Bearer abc',
      count: 3,
    });
    assert.equal(redacted['route'], '/x');
    assert.equal(redacted['count'], 3);
    assert.equal(
      redacted['authorization'],
      '[redacted]',
      'a silently absent field looks like a bug in the producer',
    );
  });
});

describe('the correlation chain', () => {
  /**
   * The prompt's own chain: *"browser/API → queue → run → provider/tool → cost settlement"*.
   *
   * It stopped at the run before this prompt. The last two stages are the ones that matter —
   * they are where the money is.
   */
  it('names all five stages, ending at the money', () => {
    assert.deepEqual([...CORRELATION_CHAIN], ['request', 'queue', 'run', 'provider', 'settlement']);
  });
});

describe('the incident workflow', () => {
  it('labels every timeline kind', () => {
    for (const kind of TIMELINE_KINDS) {
      assert.equal(typeof TIMELINE_KIND_LABELS[kind], 'string');
    }
  });

  it('labels every corrective-action state, including a deliberate drop', () => {
    for (const state of CORRECTIVE_ACTION_STATES) {
      assert.equal(typeof CORRECTIVE_ACTION_STATE_LABELS[state], 'string');
    }
    assert.equal(CORRECTIVE_ACTION_STATES.includes('Dropped'), true);
  });

  it('refuses a postmortem on an unresolved incident', () => {
    const readiness = postmortemReadiness({
      state: 'Mitigated',
      timelineEntries: 3,
      severity: 'P1',
    });
    assert.equal(readiness.ready, false);
    assert.equal(
      readiness.ready === false && readiness.reasons.some((reason) => reason.includes('guess')),
      true,
    );
  });

  it('refuses a postmortem with no timeline', () => {
    const readiness = postmortemReadiness({
      state: 'Resolved',
      timelineEntries: 0,
      severity: 'P0',
    });
    assert.equal(readiness.ready, false);
    assert.equal(
      readiness.ready === false && readiness.reasons.some((reason) => reason.includes('happens')),
      true,
      'a postmortem written from memory is how the same incident happens twice',
    );
  });

  it('refuses a postmortem on an alert nobody declared an incident', () => {
    const readiness = postmortemReadiness({
      state: 'Resolved',
      timelineEntries: 2,
      severity: null,
    });
    assert.equal(readiness.ready, false);
  });

  it('accepts one on a resolved incident with a timeline', () => {
    assert.equal(
      postmortemReadiness({ state: 'Resolved', timelineEntries: 2, severity: 'P1' }).ready,
      true,
    );
  });

  it('requires a postmortem for P0 and P1 and not for P2', () => {
    assert.deepEqual([...SEVERITIES_REQUIRING_POSTMORTEM], ['P0', 'P1']);
    assert.equal(postmortemIsRequired('P0'), true);
    assert.equal(postmortemIsRequired('P1'), true);
    assert.equal(
      postmortemIsRequired('P2'),
      false,
      'most P2s are a configuration fix nobody needs to read about',
    );
    assert.equal(postmortemIsRequired(null), false);
  });
});
