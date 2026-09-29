import { Injectable } from '@nestjs/common';

import {
  DASHBOARD_TILE_MODULE,
  DASHBOARD_TILES,
  TERMINAL_EXCEPTION_STATES,
  TERMINAL_HUMAN_TASK_STATUSES,
  type DashboardCounts,
  type DashboardTile,
  type DashboardTileCount,
  type ModuleKey,
  type ReportScope,
} from '@uboss/types';

import type { AuthorizationContext } from '../authorization/authorization.service.js';
import { PrismaService } from '../persistence/prisma.service.js';
import type { TenantScope } from '../persistence/tenant-context.js';

/**
 * The Company Workspace Dashboard — an orchestration view over the work somebody is responsible
 * for.
 *
 * ## What replaced the locked donut, and what did not
 *
 * This screen used to be one donut with two slices, and this service used to refuse to grow. The
 * client replaced that rule with an orchestration dashboard; what did not change is *why* the old
 * rule existed. The failure mode is still additive — nobody removes a tile, somebody adds one — so
 * the discipline moved rather than disappeared:
 *
 *   * **A tile is returned only if this person may see its module.** The decision is made here,
 *     against the authorization context, and a tile the person cannot see is absent from the
 *     payload rather than present and hidden. A browser that forgot to filter would therefore
 *     have nothing to leak.
 *   * **Every count is a real query in this person's own scope.** There is no estimate, no
 *     projection and no placeholder anywhere in this file. Two tiles carry no number at all,
 *     because no single honest number exists for them, and they say so by returning `null`.
 *   * **No tile carries cost, tokens or money.** Those need `settings:Audit` and a different
 *     screen, and a test asserts they can never appear in this payload.
 *
 * ## "Backend-authorized scope" is not a filter the browser sends
 *
 * Every count is computed from `ReportScope`, resolved on the server from the signed-in person's
 * role assignments. A client cannot ask for a wider count, because there is no parameter in which
 * to ask. Two people with different scopes legitimately see different numbers, which is why each
 * tile states what its number measures.
 */
@Injectable()
export class DashboardService {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * The tiles this person may see, each with its count.
   *
   * Counted in one transaction so every tile comes from the same instant. Across two round trips a
   * task can move between them, and a dashboard whose numbers disagree with each other is worse
   * than one that is a second old.
   */
  async counts(input: {
    scope: TenantScope;
    reportScope: ReportScope;
    context: AuthorizationContext;
  }): Promise<DashboardCounts> {
    /*
     * Which tiles this person is allowed at all. `visibleModules` is what the authorization engine
     * already computed for the navigation, so the dashboard and the sidebar cannot disagree about
     * what somebody may reach.
     */
    const permitted = DASHBOARD_TILES.filter((tile) =>
      input.context.visibleModules.includes(DASHBOARD_TILE_MODULE[tile] as ModuleKey),
    );

    if (permitted.length === 0) return { tiles: [] };

    /*
     * An empty scope means nobody, not everybody — the same rule the reports apply, restated here
     * because this is the one screen every signed-in person lands on. The tiles are still returned
     * so the person can see what exists and reach it; their counts are simply zero.
     */
    const noOne = input.reportScope.userIds !== null && input.reportScope.userIds.length === 0;
    const userFilter =
      input.reportScope.userIds === null ? undefined : { in: [...input.reportScope.userIds] };

    return this.prisma.runInTenantTransaction(input.scope, async () => {
      const tiles: DashboardTileCount[] = [];

      for (const tile of permitted) {
        tiles.push({
          tile,
          count: noOne ? zeroFor(tile) : await this.countFor(tile, input, userFilter),
        });
      }

      return { tiles };
    });
  }

  /**
   * One tile's number.
   *
   * `performance` and `reports` return `null` rather than a figure. There is no single honest
   * number for either — a performance score is per person and per period, and "reports" is a set of
   * screens, not a quantity — so the tile is a way in rather than a count. Inventing something to
   * put there is exactly what this screen is not allowed to do.
   */
  private async countFor(
    tile: DashboardTile,
    input: { scope: TenantScope },
    userFilter: { in: string[] } | undefined,
  ): Promise<number | null> {
    const tenantId = input.scope.tenantId;

    switch (tile) {
      case 'objectives':
        return this.prisma.client.objective.count({
          where: {
            tenantId,
            /*
             * Archived objectives are history, and counting them would make the number grow
             * forever and never match the list the tile opens.
             *
             * Archival lives on the version rather than on the objective — there is no
             * `archivedAt` here — so "archived" means every version it has is Archived. An
             * objective with any version that is not is still live work.
             */
            versions: { some: { status: { not: 'Archived' } } },
            ...(userFilter === undefined ? {} : { objectiveOwnerUserId: userFilter }),
          },
        });

      case 'tasks':
        return this.prisma.client.humanTask.count({
          where: {
            tenantId,
            /*
             * Everything that still needs somebody, expressed as **not terminal** rather than as a
             * list written out here. A status added later cannot then silently stop counting — the
             * failure this schema has already had with enumerated state lists.
             *
             * A blocked task is pending: it is waiting for a person to unblock it, and hiding it
             * would make the dashboard quieter than the truth.
             */
            status: { notIn: [...TERMINAL_HUMAN_TASK_STATUSES] },
            ...(userFilter === undefined ? {} : { assignedToUserId: userFilter }),
          },
        });

      case 'agents':
        return this.prisma.client.engineAgent.count({
          where: {
            tenantId,
            status: { not: 'Archived' },
            ...(userFilter === undefined ? {} : { ownerUserId: userFilter }),
          },
        });

      case 'approvals':
        return this.prisma.client.approvalRequest.count({
          where: {
            tenantId,
            status: 'Pending',
            // Addressed to somebody in scope. A request nobody in this person's reach has to
            // decide is not their pending approval.
            ...(userFilter === undefined ? {} : { namedApproverUserId: userFilter }),
          },
        });

      case 'exceptions':
        return this.prisma.client.executorException.count({
          where: {
            tenantId,
            state: { notIn: [...TERMINAL_EXCEPTION_STATES] },
            ...(userFilter === undefined ? {} : { ownerUserId: userFilter }),
          },
        });

      case 'performance':
      case 'reports':
        return null;
    }
  }
}

/** Zero, or nothing, depending on whether the tile carries a number at all. */
function zeroFor(tile: DashboardTile): number | null {
  return tile === 'performance' || tile === 'reports' ? null : 0;
}
