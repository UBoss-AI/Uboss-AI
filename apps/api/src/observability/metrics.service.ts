import { Injectable, Logger } from '@nestjs/common';

import {
  LATENCY_BUCKETS_MS,
  METRIC_KIND,
  metricLabelsArePermitted,
  type MetricKey,
} from '@uboss/types';

interface Series {
  labels: Record<string, string>;
  /** For a counter or a gauge. */
  value: number;
  /** For a histogram: cumulative counts per bucket, plus a sum and a count. */
  buckets?: number[];
  sum?: number;
  count?: number;
}

/**
 * The metric registry — Prompt 39.
 *
 * ## In process, and honest about it
 *
 * No `prom-client`, no StatsD, no push gateway. Series live in a `Map` in this process and are
 * rendered in Prometheus text format on request. That is a real, working, scrapeable metrics
 * endpoint — and its limits are stated rather than discovered: **counters reset on restart, and a
 * multi-process deployment reports per-process figures**. A single-process API is what UBoss runs
 * today, so this is correct now and is one adapter away from correct later.
 *
 * ## Cardinality is enforced, not trusted
 *
 * `metricLabelsArePermitted` rejects any label not on the metric's allow-list, and the allow-lists
 * contain no tenant, user, run or provider (`METRIC_CARDINALITY_STANCE`). A rejected observation is
 * **dropped and logged**, not thrown: a metric must never be able to fail a request. That is the
 * one place in this file where swallowing an error is right, and it is the reason the log line
 * exists.
 *
 * An unbounded label is how a metrics system takes down the thing it was meant to observe, and a
 * `tenant_id` label would additionally make a shared operations dashboard a cross-tenant
 * disclosure.
 */
@Injectable()
export class MetricsService {
  private readonly logger = new Logger(MetricsService.name);

  /** `metric` → serialised labels → series. */
  private readonly series = new Map<MetricKey, Map<string, Series>>();

  /** Rejected observations, so a dropped metric is visible rather than silent. */
  private rejected = 0;

  increment(key: MetricKey, labels: Record<string, string> = {}, by = 1): void {
    const found = this.seriesFor(key, labels);
    if (found === null) return;
    found.value += by;
  }

  /** Set a gauge. A reading at an instant, not an accumulation. */
  set(key: MetricKey, value: number, labels: Record<string, string> = {}): void {
    const found = this.seriesFor(key, labels);
    if (found === null) return;
    found.value = value;
  }

  /** Record one latency observation into its buckets. */
  observe(key: MetricKey, milliseconds: number, labels: Record<string, string> = {}): void {
    const found = this.seriesFor(key, labels);
    if (found === null) return;

    found.buckets ??= LATENCY_BUCKETS_MS.map(() => 0);
    found.sum = (found.sum ?? 0) + milliseconds;
    found.count = (found.count ?? 0) + 1;

    // Cumulative: every bucket at or above the observation counts it, which is what Prometheus
    // histograms mean and what makes a quantile computable from them.
    LATENCY_BUCKETS_MS.forEach((bound, index) => {
      if (milliseconds <= bound) {
        found.buckets![index] = (found.buckets![index] ?? 0) + 1;
      }
    });
  }

  /** The current value of one series, for an alert rule to evaluate. */
  valueOf(key: MetricKey, labels: Record<string, string> = {}): number {
    return this.series.get(key)?.get(MetricsService.serialise(labels))?.value ?? 0;
  }

  /**
   * The sum across every series of a metric, whatever its labels.
   *
   * What an alert rule almost always wants: "how many provider errors", not "how many for this
   * one profile". A rule that had to enumerate label values would go stale the moment a new
   * profile was added.
   */
  totalOf(key: MetricKey): number {
    let total = 0;
    for (const series of this.series.get(key)?.values() ?? []) {
      total += series.value;
    }
    return total;
  }

  /** Everything, for the System Health screen. */
  snapshot(): {
    metric: MetricKey;
    kind: string;
    series: { labels: Record<string, string>; value: number; count?: number; mean?: number }[];
  }[] {
    return [...this.series.entries()].map(([metric, bySeries]) => ({
      metric,
      kind: METRIC_KIND[metric],
      series: [...bySeries.values()].map((series) => ({
        labels: series.labels,
        value: series.value,
        ...(series.count === undefined ? {} : { count: series.count }),
        ...(series.count === undefined || series.count === 0
          ? {}
          : { mean: Math.round((series.sum ?? 0) / series.count) }),
      })),
    }));
  }

  /** How many observations were dropped for a disallowed label. Should be zero. */
  rejectedObservations(): number {
    return this.rejected;
  }

  /**
   * Prometheus text format.
   *
   * Written by hand rather than pulled in with a library, because the format is a dozen lines and
   * a dependency for a dozen lines is a dependency to keep updated. `# TYPE` is emitted so a
   * scraper treats a histogram as one, and a gauge as one.
   */
  render(): string {
    const lines: string[] = [];

    for (const [metric, bySeries] of this.series.entries()) {
      const kind = METRIC_KIND[metric];
      lines.push(`# TYPE uboss_${metric} ${kind}`);

      for (const series of bySeries.values()) {
        const labels = MetricsService.renderLabels(series.labels);

        if (kind === 'histogram') {
          LATENCY_BUCKETS_MS.forEach((bound, index) => {
            const withBucket = MetricsService.renderLabels({
              ...series.labels,
              le: String(bound),
            });
            lines.push(`uboss_${metric}_bucket${withBucket} ${series.buckets?.[index] ?? 0}`);
          });
          // `+Inf` is required: without it a scraper cannot know the total, and every quantile
          // above the last bucket is unanswerable.
          const withInf = MetricsService.renderLabels({ ...series.labels, le: '+Inf' });
          lines.push(`uboss_${metric}_bucket${withInf} ${series.count ?? 0}`);
          lines.push(`uboss_${metric}_sum${labels} ${series.sum ?? 0}`);
          lines.push(`uboss_${metric}_count${labels} ${series.count ?? 0}`);
        } else {
          lines.push(`uboss_${metric}${labels} ${series.value}`);
        }
      }
    }

    return `${lines.join('\n')}\n`;
  }

  /** Test-only: forget everything. */
  reset(): void {
    this.series.clear();
    this.rejected = 0;
  }

  // -------------------------------------------------------------------------
  // Internals
  // -------------------------------------------------------------------------

  /**
   * Find or create a series, refusing a disallowed label.
   *
   * Returns `null` on a rejection, and every caller checks it. **Dropped and logged, never
   * thrown**: a metric must not be able to fail the request it is measuring, and a throw here
   * would mean an observability mistake taking down the feature it observes.
   */
  private seriesFor(key: MetricKey, labels: Record<string, string>): Series | null {
    if (!metricLabelsArePermitted(key, labels)) {
      this.rejected += 1;
      this.logger.warn(
        `Dropped an observation of ${key}: the labels ${Object.keys(labels).join(', ')} are not ` +
          'on its allow-list. An unbounded label is how a metrics system falls over, and a ' +
          'tenant label would make a shared dashboard a cross-tenant disclosure.',
      );
      return null;
    }

    const serialised = MetricsService.serialise(labels);
    let bySeries = this.series.get(key);
    if (bySeries === undefined) {
      bySeries = new Map();
      this.series.set(key, bySeries);
    }

    let found = bySeries.get(serialised);
    if (found === undefined) {
      found = { labels, value: 0 };
      bySeries.set(serialised, found);
    }
    return found;
  }

  /** Stable, so `{a,b}` and `{b,a}` are one series rather than two. */
  private static serialise(labels: Record<string, string>): string {
    return Object.keys(labels)
      .sort()
      .map((label) => `${label}=${labels[label] ?? ''}`)
      .join(',');
  }

  private static renderLabels(labels: Record<string, string>): string {
    const entries = Object.entries(labels);
    if (entries.length === 0) return '';
    const rendered = entries
      .map(
        ([label, value]) => `${label}="${value.replaceAll('\\', '\\\\').replaceAll('"', '\\"')}"`,
      )
      .join(',');
    return `{${rendered}}`;
  }
}
