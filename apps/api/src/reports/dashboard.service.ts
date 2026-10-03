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
  /**
   * How many conversations have something in them this person has not read.
   *
   * ## Why this is two queries and not one `where`
   *
   * Because the comparison is between each message and **that participant row's own**
   * `lastReadAt`, and a nested filter cannot reach back to a column on the row it is nested
   * under. Expressed as one query it would have to compare every conversation against a single
   * timestamp, which is a different and wrong question.
   *
   * So: the person's live participations with their markers, then one count of conversations
   * holding a newer message from somebody else. Two round trips for a number on a tile, against
   * a list that is the conversations one person is in.
   *
   * A participation with no marker at all has never been opened, so everything in it is unread.
   */
  private async unreadConversations(tenantId: string, userId: string): Promise<number> {
    const participations = await this.prisma.client.chatParticipant.findMany({
      where: { tenantId, userId, leftAt: null },
      select: { conversationId: true, lastReadAt: true },
      take: 500,
    });

    if (participations.length === 0) return 0;

    const unread = await Promise.all(
      participations.map((participation) =>
        this.prisma.client.chatMessage.count({
          where: {
            tenantId,
            conversationId: participation.conversationId,
            // Never your own. Sending something and being told you have one unread is the oldest
            // bug in every chat application ever written.
            authorUserId: { not: userId },
            ...(participation.lastReadAt === null
              ? {}
              : { sentAt: { gt: participation.lastReadAt } }),
          },
          take: 1,
        }),
      ),
    );

    return unread.filter((count) => count > 0).length;
  }

  private async countFor(
    tile: DashboardTile,
    input: { scope: TenantScope; context: AuthorizationContext },
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

      /*
       * How much AI work is waiting to be turned into an agent.
       *
       * A real queue, and the one number that makes this tile worth a place: an administrator
       * wants to know there are three assignments still unbuilt without opening the builder to
       * find out. Counted the same way every other tile is — in this person's own scope.
       */
      case 'agent-builder':
        return this.prisma.client.aiWorkAssignment.count({
          where: {
            tenantId,
            status: 'AwaitingAgentSetup',
            /*
             * Scoped by who assigned the work, because that is the only person this row names.
             *
             * An `AiWorkAssignment` has no owner column — it is a node of an objective's workflow
             * that was given to AI, and the person on it is whoever assigned it. Scoping by that
             * keeps the tile answering "what is waiting on me and mine" for a manager, the same
             * way every other tile does, instead of showing a company-wide figure to somebody
             * whose other tiles are all narrowed.
             */
            ...(userFilter === undefined ? {} : { assignedByUserId: userFilter }),
          },
        });

      /*
       * How many people the company has in this person's scope.
       *
       * The measure line says "people" rather than the three things the screen lists, so the
       * figure cannot be read as a count of departments. Active only: somebody who has left is
       * still in the hierarchy's history and is not one of the people you have.
       */
      case 'hierarchy':
        return this.prisma.client.tenantMembership.count({
          where: {
            tenantId,
            accountState: 'Active',
            ...(userFilter === undefined ? {} : { userId: userFilter }),
          },
        });

      /*
       * Conversations with something in them this person has not read.
       *
       * Counted against their own `lastReadAt` marker, so it is their unread and nobody else's.
       * A conversation they do not belong to cannot be counted at all, because the query starts
       * from their participation rather than from the conversation list — which is the same
       * reason there is no `chat` permission module in this product.
       *
       * Their own messages never count. Sending something and then being told you have one
       * unread is the oldest bug in every chat application ever written.
       *
       * This tile is never narrowed by `userFilter`: a manager's scope widens what they may see
       * of *other people's* work, and nobody's scope includes somebody else's unread messages.
       */
      case 'chat':
        return this.unreadConversations(tenantId, input.context.userId);

      /*
       * Invitations an administrator has not yet got an answer to.
       *
       * The one thing on the Settings screen that is genuinely a queue: somebody was invited and
       * has not activated, and that waits on a person. The rest of Settings is configuration,
       * which does not pile up.
       */
      case 'settings':
        return this.prisma.client.invitation.count({
          where: { tenantId, acceptedAt: null, cancelledAt: null, expiresAt: { gt: new Date() } },
        });

      /*
       * No number, and that is the honest answer for these two.
       *
       * Performance and Reports are places you go, not things that pile up — a figure beside
       * either would have to be invented to exist. They show an arrow instead, which is what
       * `null` means to the screen.
       */
      case 'performance':
      case 'reports':
        return null;

      /*
       * The stage overview carries no count of its own.
       *
       * Its card is a table of where every piece of work has got to, and no single number
       * summarises it — "45" would be objectives, which the Objectives tile already says.
       */
      case 'stage':
        return null;
    }
  }
}

/** Zero, or nothing, depending on whether the tile carries a number at all. */
function zeroFor(tile: DashboardTile): number | null {
  return COUNTLESS_TILES.includes(tile) ? null : 0;
}

/**
 * The tiles that never carry a number.
 *
 * Kept beside `zeroFor` rather than repeated in the switch above, because the two have to agree:
 * a tile that counts null when it loads and zero when it is empty would flicker between an arrow
 * and a `0` depending on which path produced it.
 */
const COUNTLESS_TILES: readonly DashboardTile[] = ['performance', 'reports', 'stage'];
