import { Injectable } from '@nestjs/common';

import { TERMINAL_HUMAN_TASK_STATUSES, type DashboardCounts, type ReportScope } from '@uboss/types';

import { PrismaService } from '../persistence/prisma.service.js';
import type { TenantScope } from '../persistence/tenant-context.js';

/**
 * The Company Workspace Dashboard — Prompt 37, and a locked contract.
 *
 * > Exactly one donut/pie chart with **two slices only**: Agents and Pending Jobs. Counts must use
 * > the logged-in user's backend-authorized scope. Do **not** show KPI cards, report tables,
 * > cost/token cards, notification lists, hierarchy summaries or performance details.
 *
 * ## Why this service returns two numbers and refuses to grow
 *
 * The failure mode is additive. Nobody removes the donut; somebody adds "and while we're here, the
 * pending approvals count". So this service has two methods and one return type, and a test
 * asserts the endpoint's response has exactly the keys `DASHBOARD_ALLOWED_KEYS` permits. Adding a
 * third number is then a test failure rather than a quiet change to an approved screen.
 *
 * The Master Console dashboard is a separate thing and keeps its platform KPI cards — that is in
 * the same locked paragraph, and `PlatformConsoleService` is where it lives.
 *
 * ## "Backend-authorized scope" is not a filter the browser sends
 *
 * The counts are computed from `ReportScope`, resolved on the server from the signed-in person's
 * role assignments. A client cannot ask for a wider count, because there is no parameter in which
 * to ask.
 */
@Injectable()
export class DashboardService {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * The two counts.
   *
   * **Agents** are the Engine Agents this person owns or may see. **Pending Jobs** is work awaiting
   * action — human tasks assigned to them that are not finished. Both are counted in one
   * transaction so the donut's two slices come from the same instant; two round trips could show a
   * task that moved between them.
   */
  async counts(input: {
    scope: TenantScope;
    reportScope: ReportScope;
  }): Promise<DashboardCounts> {
    // An empty scope means nobody, not everybody — the same rule the reports apply, restated here
    // because this is the one screen every signed-in person lands on.
    if (input.reportScope.userIds !== null && input.reportScope.userIds.length === 0) {
      return { agents: 0, pendingJobs: 0 };
    }

    const userFilter =
      input.reportScope.userIds === null ? undefined : { in: [...input.reportScope.userIds] };

    return this.prisma.runInTenantTransaction(input.scope, async () => {
      const agents = await this.prisma.client.engineAgent.count({
        where: {
          tenantId: input.scope.tenantId,
          // Archived agents are not "my agents" — they are history, and counting them would make
          // the number grow forever and never match the list the slice drills into.
          status: { not: 'Archived' },
          ...(userFilter === undefined ? {} : { ownerUserId: userFilter }),
        },
      });

      const pendingJobs = await this.prisma.client.humanTask.count({
        where: {
          tenantId: input.scope.tenantId,
          // Everything that still needs somebody to act, expressed as **not terminal** rather
          // than as a list written out here. `TERMINAL_HUMAN_TASK_STATUSES` is the vocabulary's
          // own answer, so a status added later cannot silently start counting as pending — the
          // failure this schema has already had three times with enumerated state lists.
          //
          // A blocked task *is* pending: it is waiting for a person to unblock it, and hiding it
          // would make the dashboard quieter than the truth.
          status: { notIn: [...TERMINAL_HUMAN_TASK_STATUSES] },
          ...(userFilter === undefined ? {} : { assignedToUserId: userFilter }),
        },
      });

      return { agents, pendingJobs };
    });
  }
}
