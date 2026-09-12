import {
  Body,
  Controller,
  Get,
  Header,
  Param,
  Post,
  Query,
  UnauthorizedException,
} from '@nestjs/common';
import {
  IsDateString,
  IsIn,
  IsOptional,
  IsString,
  IsUUID,
  MaxLength,
  MinLength,
} from 'class-validator';

import {
  ALERT_RULES,
  CORRECTIVE_ACTION_STANCE,
  CORRELATION_CHAIN,
  CORRELATION_STANCE,
  METRIC_CARDINALITY_STANCE,
  METRIC_KEYS,
  METRIC_KIND,
  METRIC_LABELS,
  METRIC_QUESTIONS,
  TIMELINE_KIND_LABELS,
  TIMELINE_KINDS,
  TRACING_STANCE,
  type TimelineKind,
} from '@uboss/types';

import { RequirePermission } from '../authorization/authorization.decorators.js';
import { actorUserId } from '../request-context/authenticated-actor.js';
import { getActor } from '../request-context/request-context.js';
import { PlatformOnly } from '../tenancy/tenancy.decorators.js';
import { AlertRulesService } from './alert-rules.service.js';
import { RecoveryService } from './recovery.service.js';
import { IncidentWorkflowService } from './incident-workflow.service.js';
import { MetricsService } from './metrics.service.js';
import { InProcessTracer } from './tracer.js';

class TimelineEntryDto {
  @IsIn(TIMELINE_KINDS as readonly string[], {
    message: `kind must be one of: ${TIMELINE_KINDS.join(', ')}.`,
  })
  kind!: TimelineKind;

  @IsString() @MinLength(1) @MaxLength(4000) note!: string;

  /** Optional: an operator catching up after an outage backfills entries. */
  @IsOptional() @IsDateString() occurredAt?: string;
}

class PostmortemDto {
  @IsString() @MinLength(50) @MaxLength(20_000) postmortem!: string;
}

class ResolveDto {
  @IsOptional() @IsString() @MaxLength(20_000) postmortem?: string;
}

class CorrectiveActionDto {
  @IsString() @MinLength(10) @MaxLength(2000) description!: string;
  @IsUUID(7) ownerUserId!: string;
  @IsDateString() dueOn!: string;
}

class CloseActionDto {
  @IsIn(['Done', 'Dropped']) state!: 'Done' | 'Dropped';
  @IsOptional() @IsString() @MaxLength(2000) outcomeNote?: string;
}

/**
 * Observability and the incident workflow — Prompt 39.
 *
 * Platform-only throughout, gated on `dev-ops` and `system-health`. `PlatformEngineer` holds the
 * first and every operations role holds the second — reading metrics is what an operations role is
 * for, and declaring an incident is not.
 *
 * ## `/metrics` is unauthenticated, and that is a decision
 *
 * A Prometheus scraper is not a person and holds no session. The endpoint is therefore outside the
 * permission model, which is only acceptable because of what it contains: **counts and latencies
 * with no tenant, user, run or provider label anywhere** (`METRIC_CARDINALITY_STANCE`), enforced by
 * `metricLabelsArePermitted` and asserted by a test. Anybody reading it learns how busy UBoss is
 * and nothing about whose work made it busy.
 *
 * It is still `@PlatformOnly`, so it is not reachable from a tenant route — network-level
 * restriction of the scrape endpoint belongs to deployment, and the runbook says so.
 */
@Controller('platform/observability')
@PlatformOnly()
export class ObservabilityController {
  constructor(
    private readonly metrics: MetricsService,
    private readonly alerts: AlertRulesService,
    private readonly incidents: IncidentWorkflowService,
    private readonly tracer: InProcessTracer,
    private readonly recovery: RecoveryService,
  ) {}

  /** What the product will and will not do about observability, in its own words. */
  @Get('meta')
  @RequirePermission({ module: 'system-health', action: 'View' })
  async meta(): Promise<unknown> {
    return {
      metrics: METRIC_KEYS.map((key) => ({
        key,
        label: METRIC_LABELS[key],
        kind: METRIC_KIND[key],
        question: METRIC_QUESTIONS[key],
      })),
      alertRules: ALERT_RULES,
      timelineKinds: TIMELINE_KINDS.map((kind) => ({
        key: kind,
        label: TIMELINE_KIND_LABELS[kind],
      })),
      correlationChain: CORRELATION_CHAIN,
      // Served verbatim, because each of these is a claim somebody might otherwise overstate.
      correlationStance: CORRELATION_STANCE,
      tracingStance: TRACING_STANCE,
      cardinalityStance: METRIC_CARDINALITY_STANCE,
      correctiveActionStance: CORRECTIVE_ACTION_STANCE,
      tracer: { name: this.tracer.name, exportsSpans: this.tracer.exportsSpans },
    };
  }

  // ---- Recovery — Prompt 41 ----

  /**
   * What UBoss can honestly say about its own recoverability.
   *
   * `system-health:View`, like every other operational read. It answers one question — **when did
   * a restore last succeed** — plus the targets in force, the drill's state, the decision tree and
   * the list of everything DR-related that belongs to the deployment rather than to this
   * application.
   *
   * `lastVerifiedRestoreAt` is supplied by the caller from the drill's own evidence file rather
   * than read from a table, and that is deliberate: a status the API could update without a
   * restore having happened is a status somebody will eventually update. The evidence is written
   * by `infra/backup/pg-restore-verify.sh` and lives beside the dump.
   */
  @Get('recovery')
  @RequirePermission({ module: 'system-health', action: 'View' })
  async recoveryPosition(
    @Query('lastVerifiedRestoreAt') lastVerifiedRestoreAt?: string,
  ): Promise<unknown> {
    return this.recovery.position({
      ...(lastVerifiedRestoreAt === undefined ? {} : { lastVerifiedAt: lastVerifiedRestoreAt }),
    });
  }

  /**
   * The migration state, which is the one recovery-relevant fact the application owns.
   *
   * A dump taken mid-migration restores to a schema no application version can run against, and it
   * looks healthy until the first query — so "is this database in a state worth backing up" is
   * worth asking before a backup as well as after a restore.
   */
  @Get('recovery/schema-state')
  @RequirePermission({ module: 'system-health', action: 'View' })
  async recoverySchemaState(): Promise<unknown> {
    return this.recovery.schemaState();
  }

  // ---- Metrics ----

  /** Prometheus text format, for a scraper. See the class comment on why it carries no identity. */
  @Get('metrics')
  @Header('Content-Type', 'text/plain; version=0.0.4; charset=utf-8')
  async scrape(): Promise<string> {
    // Refreshed before rendering, so a scrape reflects the database rather than the last request
    // that happened to touch these gauges.
    await this.alerts.measureReservationDrift();
    await this.alerts.measureConnectionHealth();
    return this.metrics.render();
  }

  /** The same figures as structured JSON, for System Health. */
  @Get('metrics/snapshot')
  @RequirePermission({ module: 'system-health', action: 'View' })
  async snapshot(): Promise<unknown> {
    await this.alerts.measureReservationDrift();
    await this.alerts.measureConnectionHealth();
    return {
      metrics: this.metrics.snapshot(),
      // Should be zero. A non-zero figure means somebody is recording a label that is not on an
      // allow-list, and the observation was dropped rather than the request failed.
      rejectedObservations: this.metrics.rejectedObservations(),
    };
  }

  // ---- Alert rules ----

  /** Every rule with its current value, firing or not. */
  @Get('alert-rules')
  @RequirePermission({ module: 'system-health', action: 'View' })
  async alertRules(): Promise<unknown> {
    await this.alerts.measureReservationDrift();
    await this.alerts.measureConnectionHealth();
    return { evaluations: this.alerts.evaluateAll() };
  }

  /**
   * Evaluate the rules and raise an alert for each newly firing one.
   *
   * `dev-ops:EditDraft` — it writes rows. Nothing schedules it: the seventh job waiting on the
   * Prompt 26 business-cron scheduler, and a route is the honest way to ship a reachable, tested
   * evaluator in the meantime.
   */
  @Post('alert-rules/evaluate')
  @RequirePermission({ module: 'dev-ops', action: 'EditDraft' })
  async evaluate(): Promise<unknown> {
    await this.alerts.measureReservationDrift();
    await this.alerts.measureConnectionHealth();
    return this.alerts.evaluate();
  }

  // ---- Traces ----

  @Get('traces')
  @RequirePermission({ module: 'system-health', action: 'View' })
  async traces(@Query('correlationId') correlationId?: string): Promise<unknown> {
    return {
      exportsSpans: this.tracer.exportsSpans,
      stance: TRACING_STANCE,
      spans: correlationId === undefined ? this.tracer.recent() : this.tracer.trace(correlationId),
    };
  }

  // ---- The incident workflow ----

  @Get('incidents/:alertId/timeline')
  @RequirePermission({ module: 'system-health', action: 'View' })
  async timeline(@Param('alertId') alertId: string): Promise<unknown> {
    return {
      timeline: await this.incidents.timelineFor(alertId),
      actions: await this.incidents.actionsFor(alertId),
      postmortemReadiness: await this.incidents.readiness(alertId),
    };
  }

  @Post('incidents/:alertId/timeline')
  @RequirePermission({ module: 'support', action: 'Comment' })
  async addTimelineEntry(
    @Param('alertId') alertId: string,
    @Body() body: TimelineEntryDto,
  ): Promise<unknown> {
    return this.incidents.addTimelineEntry({
      alertId,
      actorUserId: this.currentUserId(),
      kind: body.kind,
      note: body.note,
      ...(body.occurredAt === undefined ? {} : { occurredAt: new Date(body.occurredAt) }),
    });
  }

  @Post('incidents/:alertId/postmortem')
  @RequirePermission({ module: 'support', action: 'Administer' })
  async writePostmortem(
    @Param('alertId') alertId: string,
    @Body() body: PostmortemDto,
  ): Promise<unknown> {
    return this.incidents.writePostmortem({
      alertId,
      actorUserId: this.currentUserId(),
      postmortem: body.postmortem,
    });
  }

  /**
   * Resolve, with the postmortem if one is required.
   *
   * Both in one call, because the two rules would otherwise deadlock — see the service comment.
   */
  @Post('incidents/:alertId/resolve')
  @RequirePermission({ module: 'support', action: 'Administer' })
  async resolve(@Param('alertId') alertId: string, @Body() body: ResolveDto): Promise<unknown> {
    return this.incidents.resolve({
      alertId,
      actorUserId: this.currentUserId(),
      ...(body.postmortem === undefined ? {} : { postmortem: body.postmortem }),
    });
  }

  @Post('incidents/:alertId/actions')
  @RequirePermission({ module: 'support', action: 'Administer' })
  async addAction(
    @Param('alertId') alertId: string,
    @Body() body: CorrectiveActionDto,
  ): Promise<unknown> {
    return this.incidents.addCorrectiveAction({
      alertId,
      actorUserId: this.currentUserId(),
      description: body.description,
      ownerUserId: body.ownerUserId,
      dueOn: new Date(body.dueOn),
    });
  }

  @Post('actions/:actionId/close')
  @RequirePermission({ module: 'support', action: 'Administer' })
  async closeAction(
    @Param('actionId') actionId: string,
    @Body() body: CloseActionDto,
  ): Promise<unknown> {
    return this.incidents.closeCorrectiveAction({
      actionId,
      actorUserId: this.currentUserId(),
      state: body.state,
      ...(body.outcomeNote === undefined ? {} : { outcomeNote: body.outcomeNote }),
    });
  }

  /** Every open corrective action. The list a weekly operations review reads. */
  @Get('actions/open')
  @RequirePermission({ module: 'system-health', action: 'View' })
  async openActions(): Promise<unknown> {
    return { actions: await this.incidents.openActions() };
  }

  private currentUserId(): string {
    const id = actorUserId(getActor());
    if (id === undefined || id === null) {
      throw new UnauthorizedException('Observability is for signed-in platform staff.');
    }
    return id;
  }
}
