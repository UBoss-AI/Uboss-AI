import { Injectable, Logger } from '@nestjs/common';

import { ALERT_RULES, evaluateRule, type AlertEvaluation, type MetricKey } from '@uboss/types';

import { PrismaService } from '../persistence/prisma.service.js';
import { MetricsService } from './metrics.service.js';

/**
 * Alert rules, and the thing that finally raises a service alert — Prompt 39.
 *
 * ## The gap this closes
 *
 * Prompt 36 shipped `service_alerts`, the declaration workflow and a System Health screen, and
 * recorded a limitation in its own words: *"Nothing raises a service alert automatically. Every
 * alert in the product is written by hand. §30's metrics are not collected, so no threshold can
 * fire."* This is the producer.
 *
 * ## Why evaluation is idempotent rather than event-driven
 *
 * `evaluate` reads the metric registry, compares each rule, and for a firing rule **opens an alert
 * only if that rule has no open alert already**. Run it every minute and a persistent problem
 * produces one alert, not sixty.
 *
 * The alternative — raise on the transition from not-firing to firing — needs remembered state,
 * and remembered state in a process that restarts means a restart during an outage loses the fact
 * that anybody was told. The row *is* the state, which is the same reasoning the run engine uses
 * for its own idempotency key.
 *
 * ## What it does not do
 *
 * It does not resolve an alert when the metric recovers. That is deliberate: a queue that drained
 * on its own still happened, and an operator acknowledging and resolving it is how anybody learns
 * it did. Auto-resolution would mean a 3am incident nobody ever saw.
 */
@Injectable()
export class AlertRulesService {
  private readonly logger = new Logger(AlertRulesService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly metrics: MetricsService,
  ) {}

  /** Every rule with its current value, whether or not it is firing. For System Health. */
  evaluateAll(): AlertEvaluation[] {
    return ALERT_RULES.map((rule) =>
      evaluateRule(rule, this.metrics.totalOf(rule.metric as MetricKey)),
    );
  }

  /**
   * Evaluate every rule and open an alert for each that is newly firing.
   *
   * Returns what it raised, so a caller — or a test — can see. Nothing schedules this: it is the
   * seventh job waiting on the Prompt 26 business-cron scheduler, and the honest way to ship a
   * reachable, tested evaluator in the meantime is a route.
   */
  async evaluate(): Promise<{
    evaluated: number;
    firing: string[];
    raised: string[];
    alreadyOpen: string[];
  }> {
    const evaluations = this.evaluateAll();
    const firing = evaluations.filter((evaluation) => evaluation.firing);

    const raised: string[] = [];
    const alreadyOpen: string[] = [];

    for (const evaluation of firing) {
      const existing = await this.prisma.runAsPlatformOperation(() =>
        this.prisma.client.serviceAlert.findFirst({
          where: {
            service: evaluation.rule.service,
            state: { not: 'Resolved' },
            // Matched on the rule's own summary, which is the closest thing to a rule identity the
            // table carries. A `rule_key` column would be tidier and is a schema change this
            // prompt did not need — recorded as a limitation rather than done in passing.
            summary: evaluation.rule.summary,
          },
          select: { id: true },
        }),
      );

      if (existing !== null) {
        alreadyOpen.push(evaluation.rule.key);
        continue;
      }

      await this.prisma.runAsPlatformOperation(() =>
        this.prisma.client.serviceAlert.create({
          data: {
            service: evaluation.rule.service,
            severity: evaluation.rule.severity,
            state: 'Open',
            summary: evaluation.rule.summary,
            // The reading and the threshold, so an operator does not have to go and find them —
            // and the rationale, so they know why this number was chosen before they tune it.
            detail:
              `${evaluation.rule.metric} was ${evaluation.value}, ` +
              `${evaluation.rule.comparison} the threshold of ${evaluation.rule.threshold}. ` +
              evaluation.rule.rationale,
          },
        }),
      );

      raised.push(evaluation.rule.key);
      this.logger.warn(
        `Alert rule "${evaluation.rule.key}" fired: ${evaluation.rule.metric} = ${evaluation.value}.`,
      );
    }

    return {
      evaluated: evaluations.length,
      firing: firing.map((evaluation) => evaluation.rule.key),
      raised,
      alreadyOpen,
    };
  }

  /**
   * Measure credit reservation drift, which nothing else surfaces.
   *
   * Drift is money reserved and neither settled nor released. It fails no request, appears on no
   * screen, and by the time anybody reconciles a quarter it is a large number with no explanation
   * — which is why its alert rule is the only one with a zero threshold.
   *
   * Measured as the total still-held reservation amount across every wallet whose reservation is
   * older than an hour. An hour because a legitimate in-flight reservation is seconds old; one
   * that has been held for an hour is a run that died between reserving and settling.
   */
  async measureReservationDrift(now?: Date): Promise<number> {
    const cutoff = new Date((now ?? new Date()).getTime() - 60 * 60_000);

    const stale = await this.prisma.runAsPlatformOperation(() =>
      this.prisma.client.budgetReservation.findMany({
        // `heldAt`, and `estimateMinor` — the reservation's own column names. A reservation holds
        // an *estimate* until it settles; `settledMinor` is what it turned out to cost.
        where: { state: 'Held', heldAt: { lt: cutoff } },
        select: { estimateMinor: true },
      }),
    );

    const drift = stale.reduce((total, reservation) => total + reservation.estimateMinor, 0);
    this.metrics.set('credit_reservation_drift', drift);
    return drift;
  }

  /**
   * Read connection health into its gauge.
   *
   * Prompt 36's System Health already reports this as a component. The metric is the same figure
   * in a form an alert rule can evaluate — one source, two readers, rather than two queries that
   * could disagree.
   */
  async measureConnectionHealth(): Promise<number> {
    const unhealthy = await this.prisma.runAsPlatformOperation(() =>
      this.prisma.client.connection.count({
        where: {
          disabledAt: null,
          OR: [{ needsReauthorization: true }, { lastError: { not: null } }],
        },
      }),
    );

    this.metrics.set('connection_health', unhealthy, { state: 'unhealthy' });
    return unhealthy;
  }
}
