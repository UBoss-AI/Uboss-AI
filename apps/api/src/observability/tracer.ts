import { randomUUID } from 'node:crypto';

import { Injectable, Logger } from '@nestjs/common';

import { redactLogFields } from '@uboss/types';

import { getCorrelationId } from '../request-context/request-context.js';

export interface SpanAttributes {
  [key: string]: string | number | boolean | null | undefined;
}

export interface FinishedSpan {
  traceId: string;
  spanId: string;
  parentSpanId: string | null;
  name: string;
  startedAt: number;
  durationMs: number;
  attributes: SpanAttributes;
  error: string | null;
}

/**
 * The tracing seam — Prompt 39.
 *
 * ## There is no OpenTelemetry exporter, and that is stated rather than implied
 *
 * The prompt asks for *"OpenTelemetry traces"*. There is no collector to export to: no endpoint,
 * no credentials, no backend. Installing the SDK and pointing it at nothing would produce a
 * dependency, a startup cost and a claim — the same shape as an S3 adapter with no bucket
 * (ADR-198) or a provider adapter with no key.
 *
 * So this is the abstraction, with one working implementation that records spans in process and
 * **propagates the correlation id as the trace id**. That last part is the substance: the reason
 * traces matter is that one identifier links the whole chain, and that identifier already exists
 * and already travels. An OTel exporter is one class implementing `Tracer` — the shape is
 * deliberately the same as OTel's own, so the adapter is a mapping rather than a redesign.
 *
 * `TRACING_STANCE` says all of this in words a screen shows, because "we have tracing" is exactly
 * the kind of claim that gets made on a slide and then discovered to be false during an incident.
 *
 * ## Why the trace id is the correlation id
 *
 * A trace id that differed from the correlation id would mean an operator holding one had to
 * translate to find the other — which is the situation tracing exists to remove. Where there is no
 * ambient correlation id (a scheduled sweep, a worker started outside a request) a fresh one is
 * minted, so a span always has a trace.
 */
export abstract class Tracer {
  /** Whether spans are exported anywhere. **False for the in-process tracer.** */
  abstract readonly exportsSpans: boolean;

  abstract readonly name: string;

  /**
   * Run `work` inside a span.
   *
   * The span is recorded whether the work succeeds or throws, and a throw is re-raised — a tracer
   * that swallowed an exception would be worse than no tracer.
   */
  abstract span<T>(name: string, attributes: SpanAttributes, work: () => Promise<T>): Promise<T>;
}

/**
 * The working implementation: spans in memory, newest first, bounded.
 *
 * Bounded on purpose. An unbounded span buffer in a long-running process is a memory leak with a
 * respectable name, and the last few hundred spans are what an operator looks at — older ones
 * belong in a backend that does not exist yet.
 */
@Injectable()
export class InProcessTracer extends Tracer {
  private readonly logger = new Logger(InProcessTracer.name);

  readonly exportsSpans = false;
  readonly name = 'in-process';

  private static readonly CAPACITY = 500;

  private readonly spans: FinishedSpan[] = [];
  private depth = 0;
  private currentSpanId: string | null = null;

  async span<T>(name: string, attributes: SpanAttributes, work: () => Promise<T>): Promise<T> {
    // The correlation id *is* the trace id — see the class comment. A fresh one where there is no
    // ambient request, so a span always has a trace.
    const traceId = getCorrelationId() ?? randomUUID();
    const spanId = randomUUID();
    const parentSpanId = this.currentSpanId;

    const startedAt = Date.now();
    this.currentSpanId = spanId;
    this.depth += 1;

    try {
      const result = await work();
      this.finish({ traceId, spanId, parentSpanId, name, startedAt, attributes, error: null });
      return result;
    } catch (error) {
      this.finish({
        traceId,
        spanId,
        parentSpanId,
        name,
        startedAt,
        attributes,
        error: error instanceof Error ? error.message : 'unknown error',
      });
      // Re-raised. A tracer that swallowed an exception would be worse than no tracer.
      throw error;
    } finally {
      this.depth -= 1;
      this.currentSpanId = parentSpanId;
    }
  }

  /** The recent spans, newest first. For System Health and for a test. */
  recent(limit = 50): FinishedSpan[] {
    return this.spans.slice(0, Math.min(limit, InProcessTracer.CAPACITY));
  }

  /** Every span of one trace, oldest first — which is how a person reads a trace. */
  trace(traceId: string): FinishedSpan[] {
    return this.spans
      .filter((span) => span.traceId === traceId)
      .sort((left, right) => left.startedAt - right.startedAt);
  }

  reset(): void {
    this.spans.length = 0;
    this.depth = 0;
    this.currentSpanId = null;
  }

  private finish(input: {
    traceId: string;
    spanId: string;
    parentSpanId: string | null;
    name: string;
    startedAt: number;
    attributes: SpanAttributes;
    error: string | null;
  }): void {
    // **Attributes are redacted.** A span attribute is a log field by another name, and it ends up
    // wherever the spans end up — which one day is a third party's console.
    const safe = redactLogFields(input.attributes as Record<string, unknown>) as SpanAttributes;

    this.spans.unshift({
      traceId: input.traceId,
      spanId: input.spanId,
      parentSpanId: input.parentSpanId,
      name: input.name,
      startedAt: input.startedAt,
      durationMs: Date.now() - input.startedAt,
      attributes: safe,
      error: input.error,
    });

    if (this.spans.length > InProcessTracer.CAPACITY) {
      this.spans.length = InProcessTracer.CAPACITY;
    }
  }
}

/**
 * The adapter shape an OpenTelemetry exporter would take, and deliberately not registered.
 *
 * Present so the seam is demonstrably a seam rather than an aspiration: the day a collector
 * endpoint exists, this class gets a body and one line changes in the module. Every method refuses
 * with the reason, exactly as `S3StorageAdapter` does — nothing here silently succeeds, because a
 * tracer that appeared to export and exported nothing is the worst of the three options.
 */
@Injectable()
export class OpenTelemetryTracer extends Tracer {
  readonly exportsSpans = false;
  readonly name = 'opentelemetry (not configured)';

  async span<T>(_name: string, _attributes: SpanAttributes, _work: () => Promise<T>): Promise<T> {
    throw new Error(
      'The OpenTelemetry tracer is not configured. No collector endpoint or credential has been ' +
        'supplied, so this adapter exports nothing and says so rather than appearing to work. ' +
        'Register InProcessTracer, or give this class a body once a collector exists.',
    );
  }
}

/** DI token, so callers depend on the seam rather than on a class. */
export const TRACER = Symbol('TRACER');
