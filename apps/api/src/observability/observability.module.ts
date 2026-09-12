import { Global, Module } from '@nestjs/common';

import { AlertRulesService } from './alert-rules.service.js';
import { IncidentWorkflowService } from './incident-workflow.service.js';
import { MetricsService } from './metrics.service.js';
import { RecoveryService } from './recovery.service.js';
import { ObservabilityController } from './observability.controller.js';
import { InProcessTracer, TRACER } from './tracer.js';

/**
 * Observability — Prompt 39.
 *
 * `@Global` because a metric is recorded from everywhere. Threading `MetricsService` through the
 * imports of every feature module would mean each one declaring a dependency on being observed,
 * which is true of all of them and therefore says nothing — the same reasoning as the audit and
 * authorization modules.
 *
 * ## Which tracer is bound, and why not the other one
 *
 * `InProcessTracer`. It works: it records spans, propagates the correlation id as the trace id and
 * bounds its buffer. `OpenTelemetryTracer` is in the same file, refuses every call, and is
 * **deliberately not bound** — there is no collector endpoint, no credential and no backend, so
 * binding it would break every traced path. It exists so the seam is demonstrably a seam and so
 * that wiring a real exporter is one line here rather than a refactor.
 *
 * Same shape as `S3StorageAdapter` at Prompt 35 and the provider adapters at Prompt 29. What must
 * not happen is a tracer reporting `exportsSpans: true` with nothing behind it.
 */
@Global()
@Module({
  controllers: [ObservabilityController],
  providers: [
    MetricsService,
    AlertRulesService,
    IncidentWorkflowService,
    // Prompt 41. Reports on recoverability; the backup and restore themselves are shell scripts
    // run where the database server is, because the application deliberately holds no owner
    // credentials.
    RecoveryService,
    { provide: TRACER, useClass: InProcessTracer },
    // Also bound as itself, so System Health can read `recent()` and a test can read a trace —
    // neither is on the `Tracer` abstraction, because exporting spans and browsing them in memory
    // are different capabilities and only one of them survives a real exporter.
    InProcessTracer,
  ],
  exports: [
    MetricsService,
    AlertRulesService,
    IncidentWorkflowService,
    RecoveryService,
    TRACER,
    InProcessTracer,
  ],
})
export class ObservabilityModule {}
