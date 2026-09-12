import {
  BadRequestException,
  Controller,
  Get,
  Header,
  NotFoundException,
  Param,
  Query,
  UnauthorizedException,
} from '@nestjs/common';

import {
  DASHBOARD_CONTRACT,
  DASHBOARD_SLICE_DESTINATIONS,
  DASHBOARD_SLICE_LABELS,
  DEFAULT_REPORT_RANGE,
  permissionsForReport,
  REPORT_RANGE_LABELS,
  REPORT_RANGES,
  REPORT_SCOPE_STANCE,
  reportDefinition,
  REPORTS,
  resolveWindow,
  toCsv,
  type ReportDefinition,
  type ReportRange,
  type ReportScope,
  type ReportWindow,
} from '@uboss/types';

import { AuditEventService } from '../audit/audit-event.service.js';
import { AuthorizationService } from '../authorization/authorization.service.js';
import { RequirePermission } from '../authorization/authorization.decorators.js';
import { actorUserId } from '../request-context/authenticated-actor.js';
import { getActor } from '../request-context/request-context.js';
import { TenantContextService } from '../tenancy/tenant-context.service.js';
import { TenantScoped } from '../tenancy/tenancy.decorators.js';
import { DashboardService } from './dashboard.service.js';
import { ReportScopeService } from './report-scope.service.js';
import { ReportsService, type ReportResult } from './reports.service.js';

/**
 * Reports and the Company Workspace Dashboard — Prompt 37.
 *
 * ## The dashboard route returns two numbers
 *
 * `GET /dashboard` answers with `{ agents, pendingJobs, scope }` and nothing else. `scope` is the
 * one sentence describing what the counts cover, which the screen shows under the donut so a
 * reader knows whether they are looking at their own work or the company's. A test asserts the
 * response has exactly those keys, because the way this contract erodes is by addition.
 *
 * ## Every report checks two permissions
 *
 * `reports:View` **and** the source module's `View`. Gating on the first alone would make Reports
 * a way around every other module's permissions, which is the most likely leak in any enterprise
 * reporting feature. `ReportScopeService.forReport` applies both, so no route can forget.
 *
 * ## The catalogue is filtered, not the rows
 *
 * `GET /reports` returns only the reports this person may actually open. A report they cannot read
 * is **absent**, not present-and-empty: an empty Approval Aging table implies there is nothing
 * waiting, which is a different and wrong answer.
 */
@Controller('tenants/:tenantId')
@TenantScoped()
export class ReportsController {
  constructor(
    private readonly reports: ReportsService,
    private readonly dashboard: DashboardService,
    private readonly reportScope: ReportScopeService,
    private readonly authorization: AuthorizationService,
    private readonly auditEvents: AuditEventService,
    private readonly tenantContext: TenantContextService,
  ) {}

  // -------------------------------------------------------------------------
  // The locked dashboard
  // -------------------------------------------------------------------------

  /**
   * The Company Workspace Dashboard.
   *
   * `dashboard:View`, which every role template holds — this is the landing screen. The counts are
   * confined to the signed-in person's authorized scope, resolved on the server.
   */
  @Get('dashboard')
  @RequirePermission({ module: 'dashboard', action: 'View' })
  async companyDashboard(): Promise<unknown> {
    const scope = this.tenantContext.requireScope();
    const reportScope = await this.reportScope.forDashboard({
      scope,
      actorUserId: this.currentUserId(),
    });

    const counts = await this.dashboard.counts({ scope, reportScope });

    // Exactly these three keys. A fourth is a locked-contract violation, and a test asserts it.
    return {
      agents: counts.agents,
      pendingJobs: counts.pendingJobs,
      scope: reportScope.description,
    };
  }

  /** What the donut renders from: the two labels and where each slice drills to. */
  @Get('dashboard/meta')
  @RequirePermission({ module: 'dashboard', action: 'View' })
  async dashboardMeta(): Promise<unknown> {
    return {
      slices: [
        {
          key: 'agents',
          label: DASHBOARD_SLICE_LABELS.agents,
          href: DASHBOARD_SLICE_DESTINATIONS.agents,
        },
        {
          key: 'pendingJobs',
          label: DASHBOARD_SLICE_LABELS.pendingJobs,
          href: DASHBOARD_SLICE_DESTINATIONS.pendingJobs,
        },
      ],
      // Served so the screen cannot drift from the rule, and so anybody reading the API sees it.
      contract: DASHBOARD_CONTRACT,
    };
  }

  // -------------------------------------------------------------------------
  // Reports
  // -------------------------------------------------------------------------

  /** The reports this person may open. One they cannot read is absent, not empty. */
  @Get('reports')
  @RequirePermission({ module: 'reports', action: 'View' })
  async catalogue(): Promise<unknown> {
    const scope = this.tenantContext.requireScope();
    const userId = this.currentUserId();
    const context = await this.authorization.contextFor(scope, userId);

    const permitted: ReportDefinition[] = [];
    for (const report of REPORTS) {
      let allowed = true;
      for (const permission of permissionsForReport(report)) {
        const decision = await this.authorization.authorize(context, permission);
        if (!decision.allowed) {
          allowed = false;
          break;
        }
      }
      if (allowed) permitted.push(report);
    }

    const exportDecision = await this.authorization.authorize(context, {
      module: 'reports',
      action: 'Export',
    });

    return {
      reports: permitted,
      ranges: REPORT_RANGES.map((range) => ({ key: range, label: REPORT_RANGE_LABELS[range] })),
      defaultRange: DEFAULT_REPORT_RANGE,
      mayExport: exportDecision.allowed,
      // The scope the reader is about to see everything through, in one sentence.
      scope: (await this.reportScope.forDashboard({ scope, actorUserId: userId })).description,
      stance: REPORT_SCOPE_STANCE,
    };
  }

  @Get('reports/:reportKey')
  @RequirePermission({ module: 'reports', action: 'View' })
  async run(
    @Param('reportKey') reportKey: string,
    @Query('range') range?: string,
    @Query('from') from?: string,
    @Query('to') to?: string,
  ): Promise<unknown> {
    const { report, scope, reportScope, window } = await this.prepare(reportKey, range, from, to);
    const result = await this.execute(report, scope, reportScope, window);

    return {
      report,
      scope: reportScope.description,
      window: { from: window.from.toISOString(), to: window.to.toISOString() },
      ...result,
    };
  }

  /**
   * Export a report as CSV.
   *
   * A **separate grant** — `reports:Export`, held by Manager, Head and CompanyAdmin and not by
   * Employee or Approver. Taking a company's data out of UBoss is a different act from reading it
   * on a screen, and the role templates already say so.
   *
   * The export is audited. A read is not: reading a report is ordinary work and auditing every one
   * would bury the trail, but data leaving the building is the event an investigation looks for.
   */
  @Get('reports/:reportKey/export')
  @RequirePermission({ module: 'reports', action: 'View' })
  @Header('Content-Type', 'text/csv; charset=utf-8')
  async exportCsv(
    @Param('reportKey') reportKey: string,
    @Query('range') range?: string,
    @Query('from') from?: string,
    @Query('to') to?: string,
  ): Promise<string> {
    const userId = this.currentUserId();
    const { report, scope, reportScope, window } = await this.prepare(reportKey, range, from, to);

    await this.reportScope.assertMayExport(scope, userId);

    const result = await this.execute(report, scope, reportScope, window);

    await this.auditEvents.recordForTenant(scope, {
      action: 'report.exported',
      resourceType: 'report',
      resourceId: report.key,
      actorUserId: userId,
      summary: `Exported ${report.label} as CSV.`,
      metadata: {
        report: report.key,
        rows: result.rows.length,
        scopeKind: reportScope.kind,
        from: window.from.toISOString(),
        to: window.to.toISOString(),
      },
    });

    // Only the declared columns. A query that selected more cannot leak it through the file.
    return toCsv(result.rows, result.columns);
  }

  // -------------------------------------------------------------------------
  // Internals
  // -------------------------------------------------------------------------

  private async prepare(
    reportKey: string,
    range: string | undefined,
    from: string | undefined,
    to: string | undefined,
  ): Promise<{
    report: ReportDefinition;
    scope: ReturnType<TenantContextService['requireScope']>;
    reportScope: ReportScope;
    window: ReportWindow;
  }> {
    const report = reportDefinition(reportKey);
    if (report === undefined) {
      throw new NotFoundException(`There is no report called "${reportKey}".`);
    }

    const scope = this.tenantContext.requireScope();
    // Resolves the scope *and* asserts both permissions. One call, so no route can check one and
    // forget the other.
    const reportScope = await this.reportScope.forReport({
      scope,
      actorUserId: this.currentUserId(),
      report,
    });

    const resolved = resolveWindow({
      range: (range as ReportRange | undefined) ?? DEFAULT_REPORT_RANGE,
      now: new Date(),
      ...(from === undefined ? {} : { from: new Date(from) }),
      ...(to === undefined ? {} : { to: new Date(to) }),
    });
    if (!resolved.ok) {
      throw new BadRequestException(resolved.reason);
    }

    return { report, scope, reportScope, window: resolved.window };
  }

  private async execute(
    report: ReportDefinition,
    scope: ReturnType<TenantContextService['requireScope']>,
    reportScope: ReportScope,
    window: ReportWindow,
  ): Promise<ReportResult> {
    const now = new Date();

    switch (report.key) {
      case 'ObjectiveProgress':
        return this.reports.objectiveProgress({ scope, reportScope, window });
      case 'HumanVsAiWorkMix':
        return this.reports.humanVsAiWorkMix({ scope, reportScope, window });
      case 'EmployeeWorkload':
        return this.reports.employeeWorkload({ scope, reportScope, window, now });
      case 'EngineAgentHealth':
        return this.reports.engineAgentHealth({ scope, reportScope, window });
      case 'SkillUsageAndQuality':
        return this.reports.skillUsageAndQuality({ scope, window });
      case 'ExecutorExceptions':
        return this.reports.executorExceptions({ scope, reportScope, window });
      case 'ApprovalAging':
        return this.reports.approvalAging({ scope, reportScope, window, now });
      case 'AiUsageAndCost':
        return this.reports.aiUsageAndCost({ scope, window });
      case 'AuditActivity':
        return this.reports.auditActivity({ scope, window });
      case 'PerformanceAndBadges':
        return this.reports.performanceAndBadges({ scope, reportScope, window });
    }
  }

  private currentUserId(): string {
    const id = actorUserId(getActor());
    if (id === undefined || id === null) {
      throw new UnauthorizedException('Reports are for signed-in company members.');
    }
    return id;
  }
}
