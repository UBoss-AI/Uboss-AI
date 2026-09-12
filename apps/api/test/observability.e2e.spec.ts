import assert from 'node:assert/strict';
import { after, before, beforeEach, describe, it } from 'node:test';

import { type INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';

import { ALERT_RULES, METRIC_KEYS } from '@uboss/types';

import { AuditEventService } from '../src/audit/audit-event.service.js';
import { AuditEventRepository } from '../src/persistence/audit-event.repository.js';
import { AuditTrailRepository } from '../src/persistence/audit-trail.repository.js';
import { PrismaService } from '../src/persistence/prisma.service.js';
import { tenantScopeForPlatformOperation } from '../src/persistence/tenant-context.js';
import { generateUbossUniqueId } from '../src/persistence/uboss-unique-id.js';
import { UserRepository } from '../src/persistence/user.repository.js';
import { AlertRulesService } from '../src/observability/alert-rules.service.js';
import { IncidentWorkflowService } from '../src/observability/incident-workflow.service.js';
import { MetricsService } from '../src/observability/metrics.service.js';
import { InProcessTracer } from '../src/observability/tracer.js';
import {
  createRequestContext,
  runWithRequestContext,
} from '../src/request-context/request-context.js';
import {
  activateMembership,
  activateTenant,
  closeTestContext,
  createTestContext,
  isTestDatabaseReachable,
  migrateTestDatabase,
  reachabilityFailureReason,
  resetTestDatabase,
  type TestContext,
} from './support/test-database.js';

/**
 * Observability, metrics and the incident workflow — Prompt 39, against real PostgreSQL.
 *
 * Four things carry this suite, in order of how much a wrong answer would cost:
 *
 *  * **the correlation chain reaching the money** — the gap this prompt found, where the id
 *    stopped at the run row;
 *  * **no tenant label on a metric**, enforced rather than trusted;
 *  * **alert rules raising an alert once**, not once a minute forever;
 *  * **a P0 that cannot be closed without a postmortem**.
 */
describe('observability and the incident workflow (e2e)', () => {
  let ctx: TestContext;
  let app: INestApplication;

  let tenantId: string;
  let operatorId: string;
  let ownerId: string;

  before(async () => {
    ctx = createTestContext();
    if (!(await isTestDatabaseReachable(ctx))) {
      throw new Error(
        `The test database is not reachable: ${reachabilityFailureReason()}\n` +
          'Start it with:\n' +
          '  docker compose -f infra/docker-compose.yml up -d',
      );
    }
    migrateTestDatabase();

    delete process.env['NODE_ENV'];

    const moduleRef = await Test.createTestingModule({
      providers: [
        { provide: PrismaService, useValue: ctx.prisma },
        UserRepository,
        AuditEventRepository,
        AuditTrailRepository,
        AuditEventService,
        MetricsService,
        AlertRulesService,
        IncidentWorkflowService,
        InProcessTracer,
      ],
    }).compile();

    app = moduleRef.createNestApplication();
    await app.init();
  });

  after(async () => {
    await app.close();
    await closeTestContext(ctx);
  });

  beforeEach(async () => {
    await resetTestDatabase(ctx);
    app.get(MetricsService).reset();
    app.get(InProcessTracer).reset();

    const provisioned = await ctx.provisioning.provision({
      slug: 'observed-co',
      name: 'Observed Co',
      firstMember: { email: 'first@observed.example', displayName: 'First' },
    });
    await activateTenant(ctx, provisioned.tenant.id);
    await activateMembership(ctx, provisioned.user.id, provisioned.tenant.id);
    tenantId = provisioned.tenant.id;

    const made = await ctx.prisma.runAsPlatformOperation(async () => ({
      operator: await ctx.users.createForPlatform({
        ubossUniqueId: generateUbossUniqueId(),
        email: 'operator@uboss.example',
        displayName: 'Operator',
        isPlatformActor: true,
      }),
      owner: await ctx.users.createForPlatform({
        ubossUniqueId: generateUbossUniqueId(),
        email: 'owner@uboss.example',
        displayName: 'Owner',
        isPlatformActor: true,
      }),
    }));

    operatorId = made.operator.id;
    ownerId = made.owner.id;
  });

  // ---- helpers ----

  const scope = (id = tenantId) => tenantScopeForPlatformOperation(id);
  const metrics = () => app.get(MetricsService);
  const alerts = () => app.get(AlertRulesService);
  const incidents = () => app.get(IncidentWorkflowService);
  const tracer = () => app.get(InProcessTracer);

  const seedAlert = async (
    options: { severity?: 'Info' | 'Warning' | 'Critical'; declared?: string } = {},
  ) =>
    ctx.prisma.runAsPlatformOperation(() =>
      ctx.prisma.client.serviceAlert.create({
        data: {
          service: 'api',
          severity: options.severity ?? 'Critical',
          state: 'Acknowledged',
          summary: 'Something broke',
          ...(options.declared === undefined
            ? {}
            : {
                incidentSeverity: options.declared,
                declaredAt: new Date(),
                declaredByUserId: operatorId,
                ownerUserId: ownerId,
              }),
        },
      }),
    );

  // -------------------------------------------------------------------------
  // The correlation chain — the gap this prompt found
  // -------------------------------------------------------------------------

  /**
   * *"browser/API → queue → run → provider/tool → cost settlement"*.
   *
   * Before this prompt the id reached the run row and stopped: `model_gateway_calls` and
   * `cost_ledger_entries` had no column for it, so "what did this click spend" could not be
   * answered. These are the two stages that were missing, and they are the ones with the money in
   * them.
   */
  it('carries one correlation id onto the provider call and the cost ledger entry', async () => {
    const correlationId = 'corr-test-0001';

    await ctx.prisma.runAsPlatformOperation(async () => {
      const wallet = await ctx.prisma.client.budgetWallet.create({
        data: {
          tenantId,
          scope: 'Company',
          currency: 'INR',
          allowanceMinor: 100_000,
          periodStart: new Date('2026-01-01'),
        },
      });

      // A `Settle` must name the reservation it settles
      // (`reservation_movements_name_their_reservation`), which is correct and more realistic than
      // a bare ledger row: money settles against something it was held for.
      const reservation = await ctx.prisma.client.budgetReservation.create({
        data: {
          tenantId,
          walletId: wallet.id,
          state: 'Settled',
          estimateMinor: 250,
          settledMinor: 250,
          currency: 'INR',
          logicalProfile: 'AGENT_STANDARD',
          purpose: 'EngineAgentRun',
          // `a_closed_reservation_says_when_and_why`: anything that is not `Held` records both.
          closedAt: new Date(),
          closeReason: 'Settled at the provider’s actual cost.',
        },
      });

      // Written inside the same ambient context a request or a run worker establishes — which is
      // exactly how the two production write sites obtain it.
      await runWithRequestContext(createRequestContext(correlationId), async () => {
        const { getCorrelationId } = await import('../src/request-context/request-context.js');

        await ctx.prisma.client.modelGatewayCall.create({
          data: {
            tenantId,
            profile: 'AGENT_STANDARD',
            purpose: 'EngineAgentRun',
            capability: 'text',
            // `Unroutable` rather than `Succeeded`: the constraint
            // `a_successful_call_names_the_model_that_answered` requires a `provider_model_id` on
            // a success, and seeding a provider profile and model to get one would test the
            // Prompt 29 fixtures rather than the correlation chain. The column under test is the
            // same either way.
            outcome: 'Unroutable',
            detail: 'Recorded for the correlation chain test.',
            producedByRealModel: false,
            correlationId: getCorrelationId() ?? null,
          },
        });

        await ctx.prisma.client.costLedgerEntry.create({
          data: {
            tenantId,
            walletId: wallet.id,
            kind: 'Settle',
            amountMinor: 250,
            currency: 'INR',
            reason: 'An agent run settled.',
            balanceAfterAllowanceMinor: 100_000,
            balanceAfterUsedMinor: 250,
            balanceAfterReservedMinor: 0,
            reservationId: reservation.id,
            correlationId: getCorrelationId() ?? null,
          },
        });
      });
    });

    // One id, both rows. This is the query an operator runs during an incident.
    const linked = await ctx.prisma.runInTenantTransaction(scope(), async () => ({
      calls: await ctx.prisma.client.modelGatewayCall.count({
        where: { tenantId, correlationId },
      }),
      ledger: await ctx.prisma.client.costLedgerEntry.count({
        where: { tenantId, correlationId },
      }),
    }));

    assert.equal(linked.calls, 1, 'stage four: the provider call');
    assert.equal(linked.ledger, 1, 'stage five: the money');
  });

  it('uses the correlation id as the trace id, so one identifier does both jobs', async () => {
    const correlationId = 'corr-trace-0002';

    await runWithRequestContext(createRequestContext(correlationId), () =>
      tracer().span('test.work', { route: '/x' }, async () => {
        await tracer().span('test.inner', {}, async () => undefined);
      }),
    );

    const spans = tracer().trace(correlationId);
    assert.equal(spans.length, 2);
    assert.equal(
      spans.every((span) => span.traceId === correlationId),
      true,
      'a trace id that differed from the correlation id would make an operator translate between them',
    );

    const inner = spans.find((span) => span.name === 'test.inner');
    const outer = spans.find((span) => span.name === 'test.work');
    assert.equal(inner?.parentSpanId, outer?.spanId, 'the nesting is recorded');
  });

  it('records a span for work that threw, and re-raises', async () => {
    await assert.rejects(
      () =>
        runWithRequestContext(createRequestContext('corr-fail-0003'), () =>
          tracer().span('test.fails', {}, async () => {
            throw new Error('deliberate');
          }),
        ),
      (error: Error) => error.message === 'deliberate',
    );

    const spans = tracer().trace('corr-fail-0003');
    assert.equal(spans.length, 1);
    assert.equal(spans[0]?.error, 'deliberate');
  });

  it('redacts a secret out of a span attribute', async () => {
    await runWithRequestContext(createRequestContext('corr-secret-0004'), () =>
      tracer().span(
        'test.secretive',
        { route: '/x', apiKey: 'sk-live-abc' },
        async () => undefined,
      ),
    );

    const span = tracer().trace('corr-secret-0004')[0];
    assert.equal(span?.attributes['route'], '/x');
    assert.equal(
      span?.attributes['apiKey'],
      '[redacted]',
      'a span attribute is a log field by another name and ends up wherever spans end up',
    );
  });

  it('reports that it exports nothing, rather than implying it does', async () => {
    assert.equal(tracer().exportsSpans, false);
    assert.equal(tracer().name, 'in-process');
  });

  // -------------------------------------------------------------------------
  // Metrics
  // -------------------------------------------------------------------------

  it('records counters, gauges and histograms, and renders them for a scraper', () => {
    metrics().increment('request_errors', { route: '/a', method: 'GET', status: '500' });
    metrics().increment('request_errors', { route: '/a', method: 'GET', status: '500' });
    metrics().set('queue_depth', 42, { queue: 'runs' });
    metrics().observe('request_latency_ms', 30, { route: '/a', method: 'GET' });
    metrics().observe('request_latency_ms', 3_000, { route: '/a', method: 'GET' });

    assert.equal(
      metrics().valueOf('request_errors', { route: '/a', method: 'GET', status: '500' }),
      2,
    );
    assert.equal(metrics().valueOf('queue_depth', { queue: 'runs' }), 42);

    const rendered = metrics().render();
    assert.equal(rendered.includes('# TYPE uboss_request_errors counter'), true);
    assert.equal(rendered.includes('# TYPE uboss_queue_depth gauge'), true);
    assert.equal(rendered.includes('# TYPE uboss_request_latency_ms histogram'), true);
    // `+Inf` is required, or no quantile above the last bucket is answerable.
    assert.equal(rendered.includes('le="+Inf"'), true);
    assert.equal(rendered.includes('uboss_request_latency_ms_count'), true);
  });

  /**
   * The one that would take the metrics system down, and the one that would leak.
   *
   * Rejected rather than thrown: a metric must never be able to fail the request it is measuring.
   * The rejection is counted so it is visible instead of silent.
   */
  it('drops an observation carrying a tenant label, and counts the drop', () => {
    metrics().increment('request_errors', { tenant_id: tenantId } as never);

    assert.equal(metrics().totalOf('request_errors'), 0, 'nothing was recorded');
    assert.equal(metrics().rejectedObservations(), 1, 'and the drop is visible, not silent');
  });

  it('treats differently-ordered labels as one series', () => {
    metrics().increment('request_errors', { route: '/a', method: 'GET' });
    metrics().increment('request_errors', { method: 'GET', route: '/a' });
    assert.equal(metrics().totalOf('request_errors'), 2);
    assert.equal(
      metrics()
        .snapshot()
        .find((entry) => entry.metric === 'request_errors')?.series.length,
      1,
    );
  });

  it('reports a mean for a histogram series', () => {
    metrics().observe('request_latency_ms', 100, { route: '/a' });
    metrics().observe('request_latency_ms', 200, { route: '/a' });
    const series = metrics()
      .snapshot()
      .find((entry) => entry.metric === 'request_latency_ms')?.series[0];
    assert.equal(series?.count, 2);
    assert.equal(series?.mean, 150);
  });

  // -------------------------------------------------------------------------
  // Alert rules — the producer Prompt 36 said was missing
  // -------------------------------------------------------------------------

  it('measures credit reservation drift from reservations nobody settled', async () => {
    await ctx.prisma.runAsPlatformOperation(async () => {
      const wallet = await ctx.prisma.client.budgetWallet.create({
        data: {
          tenantId,
          scope: 'Company',
          currency: 'INR',
          allowanceMinor: 100_000,
          periodStart: new Date('2026-01-01'),
        },
      });

      // Two hours old and still held — a run that died between reserving and settling.
      await ctx.prisma.client.budgetReservation.create({
        data: {
          tenantId,
          walletId: wallet.id,
          state: 'Held',
          estimateMinor: 700,
          currency: 'INR',
          heldAt: new Date(Date.now() - 2 * 60 * 60_000),
          logicalProfile: 'AGENT_STANDARD',
          purpose: 'EngineAgentRun',
        },
      });
    });

    const drift = await alerts().measureReservationDrift();
    assert.equal(drift, 700);
    assert.equal(metrics().totalOf('credit_reservation_drift'), 700);
  });

  it('raises an alert once for a firing rule, not once per evaluation', async () => {
    metrics().set('queue_depth', 900, { queue: 'runs' });

    const first = await alerts().evaluate();
    assert.equal(first.firing.includes('queue-backed-up'), true);
    assert.equal(first.raised.includes('queue-backed-up'), true);

    // Run it again, as a scheduler would every minute.
    const second = await alerts().evaluate();
    assert.equal(second.raised.includes('queue-backed-up'), false);
    assert.equal(
      second.alreadyOpen.includes('queue-backed-up'),
      true,
      'a persistent problem must produce one alert, not sixty',
    );

    const raised = await ctx.prisma.runAsPlatformOperation(() =>
      ctx.prisma.client.serviceAlert.findMany({ where: { service: 'run-queue' } }),
    );
    assert.equal(raised.length, 1);
    assert.equal(
      raised[0]?.detail?.includes('threshold of 500'),
      true,
      'the alert carries the reading and the threshold, so nobody has to go and find them',
    );
  });

  it('raises nothing when every metric is quiet', async () => {
    const outcome = await alerts().evaluate();
    assert.deepEqual(outcome.raised, []);
    assert.equal(outcome.evaluated, ALERT_RULES.length);
  });

  it('evaluates every rule against a real metric key', () => {
    for (const evaluation of alerts().evaluateAll()) {
      assert.equal(METRIC_KEYS.includes(evaluation.rule.metric), true);
    }
  });

  // -------------------------------------------------------------------------
  // The incident workflow
  // -------------------------------------------------------------------------

  it('records a timeline entry at the time it happened, not the time it was typed', async () => {
    const alert = await seedAlert({ declared: 'P1' });

    const backfilled = new Date('2026-09-14T02:00:00.000Z');
    await incidents().addTimelineEntry({
      alertId: alert.id,
      actorUserId: operatorId,
      kind: 'Detected',
      note: 'Paged at 02:00. The queue was not draining.',
      occurredAt: backfilled,
    });
    await incidents().addTimelineEntry({
      alertId: alert.id,
      actorUserId: operatorId,
      kind: 'Investigating',
      note: 'We thought it was the database. It was the connection pool.',
      occurredAt: new Date('2026-09-14T02:20:00.000Z'),
    });

    const timeline = await incidents().timelineFor(alert.id);
    assert.equal(timeline.length, 2);
    assert.equal(
      timeline[0]?.occurredAt,
      backfilled.toISOString(),
      'an operator catching up after an outage backfills, and the order has to reflect that',
    );
    assert.equal(timeline[0]?.kind, 'Detected');
  });

  it('refuses an empty timeline entry', async () => {
    const alert = await seedAlert({ declared: 'P2' });
    await assert.rejects(
      () =>
        incidents().addTimelineEntry({
          alertId: alert.id,
          actorUserId: operatorId,
          kind: 'Note',
          note: '   ',
        }),
      (error: Error) => error.message.includes('nobody can read'),
    );
  });

  /**
   * The rule that makes a severity scale mean something.
   *
   * Enforced in the service **and** by
   * `serious_incident_is_post_mortemed_before_resolving`, because "we'll write it up later" is the
   * pressure it exists to resist and later never comes once the incident is off the board.
   */
  it('refuses to resolve a P0 without a postmortem', async () => {
    const alert = await seedAlert({ declared: 'P0' });
    await incidents().addTimelineEntry({
      alertId: alert.id,
      actorUserId: operatorId,
      kind: 'Detected',
      note: 'Everything stopped.',
    });

    await assert.rejects(
      () => incidents().resolve({ alertId: alert.id, actorUserId: operatorId }),
      (error: Error) => error.message.includes('without a postmortem'),
    );

    const resolved = await incidents().resolve({
      alertId: alert.id,
      actorUserId: operatorId,
      postmortem:
        'The connection pool was sized for the old worker count. It exhausted under load and ' +
        'every run queued behind it. A depth alert would have caught this forty minutes sooner.',
    });
    assert.equal(resolved.state, 'Resolved');
    assert.equal(resolved.postmortemRequired, true);
  });

  it('refuses to resolve a P1 with no timeline at all', async () => {
    const alert = await seedAlert({ declared: 'P1' });

    await assert.rejects(
      () =>
        incidents().resolve({
          alertId: alert.id,
          actorUserId: operatorId,
          postmortem:
            'A long enough postmortem to pass the length check, written entirely from memory ' +
            'because nobody recorded anything while it was happening.',
        }),
      (error: Error) => error.message.includes('happens twice'),
    );
  });

  it('lets a P2 resolve on its mitigation alone', async () => {
    const alert = await seedAlert({ declared: 'P2' });
    const resolved = await incidents().resolve({ alertId: alert.id, actorUserId: operatorId });

    assert.equal(resolved.state, 'Resolved');
    assert.equal(
      resolved.postmortemRequired,
      false,
      'most P2s are a configuration fix nobody needs to read about',
    );

    // And a `Resolved` entry lands on the timeline, so the narrative ends where the record does.
    const timeline = await incidents().timelineFor(alert.id);
    assert.equal(
      timeline.some((entry) => entry.kind === 'Resolved'),
      true,
    );
  });

  it('refuses a postmortem on an alert nobody declared an incident', async () => {
    const alert = await seedAlert();
    const readiness = await incidents().readiness(alert.id);
    assert.equal(readiness.ready, false);
  });

  // -------------------------------------------------------------------------
  // Corrective actions
  // -------------------------------------------------------------------------

  it('gives a corrective action an owner and a due date, and flags it overdue', async () => {
    const alert = await seedAlert({ declared: 'P1' });

    await incidents().addCorrectiveAction({
      alertId: alert.id,
      actorUserId: operatorId,
      description: 'Add a queue-depth alert rule and wire it to the scheduler.',
      ownerUserId: ownerId,
      dueOn: new Date('2026-01-01'),
    });

    const actions = await incidents().actionsFor(alert.id);
    assert.equal(actions.length, 1);
    assert.equal(actions[0]?.ownerUserId, ownerId);
    assert.equal(
      actions[0]?.overdue,
      true,
      'an overdue action is what an incident process quietly stops doing',
    );
  });

  it('refuses a vague action', async () => {
    const alert = await seedAlert({ declared: 'P1' });
    await assert.rejects(
      () =>
        incidents().addCorrectiveAction({
          alertId: alert.id,
          actorUserId: operatorId,
          description: 'Do better',
          ownerUserId: ownerId,
          dueOn: new Date('2026-12-01'),
        }),
      (error: Error) => error.message.includes('not a corrective action'),
    );
  });

  /**
   * Doing what you said needs no explanation; deciding not to does.
   *
   * That asymmetry is the point — dropping an action a postmortem identified is the decision
   * somebody will be asked about.
   */
  it('closes an action as done without a note, and refuses to drop one without a reason', async () => {
    const alert = await seedAlert({ declared: 'P1' });

    const first = await incidents().addCorrectiveAction({
      alertId: alert.id,
      actorUserId: operatorId,
      description: 'Add the queue-depth alert rule.',
      ownerUserId: ownerId,
      dueOn: new Date('2026-12-01'),
    });
    const second = await incidents().addCorrectiveAction({
      alertId: alert.id,
      actorUserId: operatorId,
      description: 'Rewrite the worker pool from scratch.',
      ownerUserId: ownerId,
      dueOn: new Date('2026-12-01'),
    });

    const done = await incidents().closeCorrectiveAction({
      actionId: first.id,
      actorUserId: ownerId,
      state: 'Done',
    });
    assert.equal(done.state, 'Done');
    assert.equal(done.overdue, false);

    await assert.rejects(
      () =>
        incidents().closeCorrectiveAction({
          actionId: second.id,
          actorUserId: ownerId,
          state: 'Dropped',
        }),
      (error: Error) => error.message.includes('why this action is being dropped'),
    );

    const dropped = await incidents().closeCorrectiveAction({
      actionId: second.id,
      actorUserId: ownerId,
      state: 'Dropped',
      outcomeNote: 'The alert rule made it unnecessary. Revisit if the queue backs up again.',
    });
    assert.equal(dropped.state, 'Dropped');
  });

  it('refuses to close an action twice', async () => {
    const alert = await seedAlert({ declared: 'P1' });
    const action = await incidents().addCorrectiveAction({
      alertId: alert.id,
      actorUserId: operatorId,
      description: 'Add the queue-depth alert rule.',
      ownerUserId: ownerId,
      dueOn: new Date('2026-12-01'),
    });

    await incidents().closeCorrectiveAction({
      actionId: action.id,
      actorUserId: ownerId,
      state: 'Done',
    });

    await assert.rejects(
      () =>
        incidents().closeCorrectiveAction({
          actionId: action.id,
          actorUserId: ownerId,
          state: 'Done',
        }),
      (error: Error) => error.message.includes('already done'),
    );
  });

  it('lists every open action across incidents, for a weekly review', async () => {
    const one = await seedAlert({ declared: 'P1' });
    const two = await ctx.prisma.runAsPlatformOperation(() =>
      ctx.prisma.client.serviceAlert.create({
        data: {
          service: 'model-gateway',
          severity: 'Warning',
          state: 'Acknowledged',
          summary: 'Another incident',
          incidentSeverity: 'P2',
          declaredAt: new Date(),
          declaredByUserId: operatorId,
        },
      }),
    );

    for (const alertId of [one.id, two.id]) {
      await incidents().addCorrectiveAction({
        alertId,
        actorUserId: operatorId,
        description: 'Something that needs doing about this incident.',
        ownerUserId: ownerId,
        dueOn: new Date('2026-11-01'),
      });
    }

    const open = await incidents().openActions();
    assert.equal(open.length, 2);
  });
});
