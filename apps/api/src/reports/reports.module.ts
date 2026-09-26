import { Module } from '@nestjs/common';

import { DashboardService } from './dashboard.service.js';
import { OrchestrationService } from './orchestration.service.js';
import { ReportScopeService } from './report-scope.service.js';
import { ReportsController } from './reports.controller.js';
import { ReportsService } from './reports.service.js';

/**
 * Reports and the Company Workspace Dashboard — Prompt 37.
 *
 * `ReportScopeService` is the exception to the leaf reading below: Users & Access injects it to
 * decide whose rows a roster may contain, because "which people does this scope reach" is the same
 * question a report asks and there should not be two answers to it.
 *
 * **Not `@Global`**, unlike most modules from here on. Nothing else in the product reads a report:
 * reports are a leaf, they consume every other module's tables and are consumed by nothing. A
 * `@Global` module that nobody injects is noise in the graph, and the discipline of saying so is
 * what keeps the ones that *are* global meaningful.
 *
 * It owns no tables. Every row it returns belongs to another module, which is the whole point and
 * also the risk — so `ReportScopeService` resolves the caller's authorized scope once and every
 * query in `ReportsService` takes it as a parameter rather than resolving its own.
 */
@Module({
  controllers: [ReportsController],
  providers: [ReportsService, DashboardService, OrchestrationService, ReportScopeService],
  exports: [ReportsService, DashboardService, OrchestrationService, ReportScopeService],
})
export class ReportsModule {}
