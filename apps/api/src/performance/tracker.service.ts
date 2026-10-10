import { Injectable } from '@nestjs/common';

import { TERMINAL_HUMAN_TASK_STATUSES } from '@uboss/types';

import type { BadgeLevel } from '../generated/prisma/client.js';
import { AccessRepository } from '../persistence/access.repository.js';
import { PrismaService } from '../persistence/prisma.service.js';
import type { TenantScope } from '../persistence/tenant-context.js';
import { BADGE_LEVEL_LABELS, PerformanceService } from './performance.service.js';

/**
 * Task & Tracker — one card per person, and what is behind each card.
 *
 * ## Why this is a read model and not a feature
 *
 * Everything on a card already exists somewhere: `HumanTask` knows what somebody was given,
 * `AgentRun` knows what they ran and when, `PerformanceEvent` knows what it was worth. What did
 * not exist was any screen that put a person's three answers side by side, which is the whole
 * request. So nothing here writes, nothing here derives a new number, and no table was added —
 * the one thing it adds is the join.
 *
 * ## Why it is `performance:Administer`, and what that cost to establish
 *
 * Everybody holds `performance:View`; the Employee template's own note says that grant is "this
 * person's own record rather than a company screen". This *is* a company screen — it shows every
 * colleague's workload, their failures and their account state on one grid — so it is gated on
 * `Administer`, which the CompanyAdmin template holds alone.
 *
 * The grant was never the whole answer. `visibleModules` is filtered by the company's **plan**
 * before any grant is consulted, and `performance` was entitled on Enterprise only — so signed in
 * as a real Company Administrator on a Growth company, with every grant this screen needs, the
 * sidebar had no entry and the route refused. Two layers, and reading the role templates showed
 * one of them.
 *
 * The client's answer was to entitle Performance on Growth as well, and on no other tier:
 * `20261009120000_growth_plan_includes_performance`. Starter and Pilot therefore do not have this
 * screen, which is a commercial decision rather than a permission one.
 *
 * ## Why every count is a grouped query
 *
 * A hundred and fifteen people is a real company and the obvious shape — walk the roster, ask
 * four questions per person — is four hundred and sixty queries for one screen. Each count below
 * is one `groupBy` over the whole tenant, folded into the roster in memory. The roster itself is
 * the query Users & Access already runs.
 */
@Injectable()
export class TrackerService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly access: AccessRepository,
    private readonly performance: PerformanceService,
  ) {}

  async cards(scope: TenantScope): Promise<TrackerGrid> {
    const roster = await this.access.roster(scope);

    /*
     * Employed here, **and given access to the platform.**
     *
     * Not the whole org chart. The hierarchy holds everybody a company records — a factory roster
     * of a hundred and fifteen, of whom seventy-one have no work address at all and can never
     * sign in. Carding all of them makes a grid where most tiles report nothing about somebody who
     * is not a user of this product, and buries the handful who are.
     *
     * `InvitePending` counts as given, deliberately. Access **has** been shared; they simply have
     * not accepted it, and "I invited them on Monday and they still have not signed in" is one of
     * the things this screen exists to show. Keeping only `Active` would make somebody vanish the
     * moment they were invited, which is exactly when an administrator starts watching them.
     *
     * `NotInvited` is an org-chart entry and nothing more. They appear here the moment they are
     * invited, and the empty state says how many are waiting for that.
     */
    const employed = roster.filter(
      (person) =>
        person.employmentState === 'Active' &&
        (person.accountState === 'Active' || person.accountState === 'InvitePending'),
    );
    /*
     * Who is not on the grid, and how many of them could be.
     *
     * Reported rather than left to the screen to guess, because "nobody has been given access
     * yet" on its own is a dead end: the useful next sentence is how many people are waiting for
     * an invitation and how many cannot be sent one until somebody records an address.
     */
    const outside = roster.filter(
      (person) => person.employmentState === 'Active' && person.accountState === 'NotInvited',
    );
    const waiting = {
      notInvited: outside.length,
      invitable: outside.filter(
        (person) =>
          person.email.trim() !== '' &&
          !person.email.trim().toLowerCase().endsWith('@person.uboss.invalid'),
      ).length,
    };

    if (employed.length === 0) return { cards: [], ...waiting };

    const [tasks, overdue, runs, lastRuns, points, policy, withPassword] = await Promise.all([
      this.taskCounts(scope),
      this.overdueCounts(scope),
      this.runCounts(scope),
      this.lastRuns(scope),
      this.pointTotals(scope),
      this.performance.activePolicy(scope),
      this.withPassword(employed.map((person) => person.userId)),
    ]);

    const cards = employed.map((person) => {
      const byStatus = tasks.get(person.userId) ?? new Map<string, number>();
      const counted = (statuses: readonly string[]): number =>
        statuses.reduce((total, status) => total + (byStatus.get(status) ?? 0), 0);

      const assigned = [...byStatus.values()].reduce((total, count) => total + count, 0);
      const done = counted(TERMINAL_HUMAN_TASK_STATUSES);
      const runState = runs.get(person.userId) ?? new Map<string, number>();
      const runTotal = [...runState.values()].reduce((total, count) => total + count, 0);
      const score = points.get(person.userId) ?? 0;
      const level = PerformanceService.levelFor(score, policy);
      const last = lastRuns.get(person.userId) ?? null;

      return {
        userId: person.userId,
        name: person.displayName,
        employeeId: person.employeeId,
        designation: person.designation,
        department: person.departmentName,
        tasks: {
          assigned,
          // Everything that is not finished, which is the number somebody actually acts on. Not
          // `assigned - done`: that would count a cancelled task as outstanding work.
          open: assigned - done,
          overdue: overdue.get(person.userId) ?? 0,
          done,
        },
        runs: {
          total: runTotal,
          failed: runState.get('Failed') ?? 0,
          lastStartedAt: last?.startedAt ?? null,
          lastState: last?.state ?? null,
        },
        performance: { score, level, label: BADGE_LEVEL_LABELS[level] },
        account: TrackerService.accountAction(person, withPassword.has(person.userId)),
      };
    });

    return { cards, ...waiting };
  }

  /**
   * Which of these people have ever set a password.
   *
   * On the platform plane, like the reset service's own lookup: a credential belongs to the
   * human and not to one of their companies — the same person signing in to two workspaces has
   * one password — so there is no tenant row to read it under. The ids come from this tenant's
   * own roster, and only whether a row exists is read.
   */
  private async withPassword(userIds: readonly string[]): Promise<Set<string>> {
    if (userIds.length === 0) return new Set();

    const rows = await this.prisma.runAsPlatformOperation(() =>
      this.prisma.client.userCredential.findMany({
        where: { userId: { in: [...userIds] } },
        select: { userId: true },
      }),
    );

    return new Set(rows.map((row) => row.userId));
  }

  /**
   * What is behind one card: what they ran, and what is still on their desk.
   *
   * The run list is the answer to "who ran it and when", which is the part of this screen that
   * exists nowhere else in the product — a run is otherwise found through the agent that
   * performed it or the objective it served, never through the person who pressed the button.
   *
   * `null` when nobody by that id is employed here. Returned rather than thrown so the caller
   * can say "not in this company" with its own words, and so a stale card in somebody's browser
   * is a tidy empty panel rather than a stack trace.
   */
  async detail(
    scope: TenantScope,
    subjectUserId: string,
    runLimit = 50,
  ): Promise<TrackerDetail | null> {
    const roster = await this.access.roster(scope);
    const person = roster.find((row) => row.userId === subjectUserId);
    if (!person || person.employmentState !== 'Active') return null;

    const [runs, tasks, withPassword] = await Promise.all([
      this.prisma.runInTenantTransaction(scope, () =>
        this.prisma.client.agentRun.findMany({
          where: { tenantId: scope.tenantId, startedByUserId: subjectUserId },
          orderBy: { createdAt: 'desc' },
          take: runLimit,
        }),
      ),
      this.prisma.runInTenantTransaction(scope, () =>
        this.prisma.client.humanTask.findMany({
          where: {
            tenantId: scope.tenantId,
            assignedToUserId: subjectUserId,
            status: { notIn: [...TERMINAL_HUMAN_TASK_STATUSES] },
          },
          // Soonest first, and anything with no date after everything that has one: a task with
          // a deadline is the one being asked about.
          orderBy: [{ dueAt: { sort: 'asc', nulls: 'last' } }, { createdAt: 'asc' }],
          take: 200,
        }),
      ),
      this.withPassword([subjectUserId]),
    ]);

    /*
     * The agents' names, by id, in one query rather than a join.
     *
     * A run names its agent by id and the same agent performs most of them, so the set is tiny —
     * and fetching it separately keeps this free of a relation whose name would have to be
     * guessed from the schema.
     */
    const agentIds = [...new Set(runs.map((run) => run.engineAgentId))];
    const agents = await this.prisma.runInTenantTransaction(scope, () =>
      this.prisma.client.engineAgent.findMany({
        where: { tenantId: scope.tenantId, id: { in: agentIds } },
        select: { id: true, name: true },
      }),
    );
    const agentName = new Map(agents.map((agent) => [agent.id, agent.name]));

    return {
      userId: person.userId,
      name: person.displayName,
      employeeId: person.employeeId,
      designation: person.designation,
      department: person.departmentName,
      account: TrackerService.accountAction(person, withPassword.has(subjectUserId)),
      runs: runs.map((run) => ({
        id: run.id,
        agent: agentName.get(run.engineAgentId) ?? 'An agent that is no longer here',
        state: run.state,
        trigger: run.trigger,
        attempt: run.attempt,
        startedAt: run.startedAt,
        finishedAt: run.finishedAt,
        /*
         * How long it took, or how long it has been going.
         *
         * Null until it starts — a queued run has waited, but it has not *run* for any length of
         * time, and reporting the wait as a duration would make a run that never started look
         * like the slowest one on the screen.
         */
        elapsedMs:
          run.startedAt === null
            ? null
            : (run.finishedAt ?? new Date()).getTime() - run.startedAt.getTime(),
        stillGoing: run.startedAt !== null && run.finishedAt === null,
        failureReason: run.failureReason,
        progressMessage: run.progressMessage,
      })),
      openTasks: tasks.map((task) => ({
        id: task.id,
        title: task.title,
        status: task.status,
        dueAt: task.dueAt,
        overdue: task.dueAt !== null && task.dueAt.getTime() < Date.now(),
      })),
    };
  }

  /**
   * What the one button on a card should say, and whether it can do anything.
   *
   * Four answers rather than one, because "Reset password" is wrong for most of a freshly
   * imported company and would have done **nothing at all**: the reset service returns empty for
   * anybody with no credential — somebody who has never activated has no password to reset — so
   * the button would have reported success and sent no mail. A hundred and fifteen people
   * imported from a spreadsheet are all in exactly that state.
   *
   * The address is reported so the operator can see where it is going before they send it. The
   * token never is, to anybody: it goes to the person, which is the point.
   */
  static accountAction(
    person: { email: string; accountState: string; invitationId: string | null },
    hasPassword: boolean,
  ): TrackerAccount {
    const address = person.email.trim().toLowerCase();

    /*
     * The placeholder an import mints for somebody with no work address — see
     * `person-registry.service.ts`. It cannot receive mail, so offering to send to it is
     * offering a button that fails silently.
     */
    if (address === '' || address.endsWith('@person.uboss.invalid')) {
      return {
        state: person.accountState,
        action: 'None',
        email: null,
        reason:
          'No work address on file, so nothing can be sent. Add one from their profile, or on ' +
          'the next import.',
      };
    }

    /*
     * A credential, not an account state.
     *
     * `Active` was the obvious test and it is wrong: a membership becomes Active without anybody
     * ever setting a password — every person a spreadsheet import creates is Active with no
     * credential at all. Branching on it offered "Send password reset" to a hundred and fifteen
     * people for whom the reset service returns empty, which is the silent nothing this whole
     * decision exists to prevent. A test caught it; the fixtures are Active and passwordless,
     * exactly like the real roster.
     */
    if (hasPassword) {
      return { state: person.accountState, action: 'Reset', email: address, reason: null };
    }

    return {
      state: person.accountState,
      action: person.invitationId === null ? 'Invite' : 'Resend',
      email: address,
      reason: null,
    };
  }

  /** Every person's tasks, by status, in one query. */
  private async taskCounts(scope: TenantScope): Promise<Map<string, Map<string, number>>> {
    const rows = await this.prisma.runInTenantTransaction(scope, () =>
      this.prisma.client.humanTask.groupBy({
        by: ['assignedToUserId', 'status'],
        where: { tenantId: scope.tenantId },
        _count: { _all: true },
      }),
    );

    const counts = new Map<string, Map<string, number>>();
    for (const row of rows) {
      if (row.assignedToUserId === null) continue;
      const byStatus = counts.get(row.assignedToUserId) ?? new Map<string, number>();
      byStatus.set(row.status, row._count._all);
      counts.set(row.assignedToUserId, byStatus);
    }
    return counts;
  }

  /**
   * Past its due date and not finished.
   *
   * Its own query rather than a filter over the one above, because "overdue" is a question about
   * `dueAt` against now and a `groupBy` cannot express it per row. A task with no due date is
   * never overdue — there is nothing it is late for.
   */
  private async overdueCounts(scope: TenantScope): Promise<Map<string, number>> {
    const rows = await this.prisma.runInTenantTransaction(scope, () =>
      this.prisma.client.humanTask.groupBy({
        by: ['assignedToUserId'],
        where: {
          tenantId: scope.tenantId,
          dueAt: { lt: new Date() },
          status: { notIn: [...TERMINAL_HUMAN_TASK_STATUSES] },
        },
        _count: { _all: true },
      }),
    );

    return new Map(
      rows
        .filter((row) => row.assignedToUserId !== null)
        .map((row) => [row.assignedToUserId as string, row._count._all]),
    );
  }

  /** Every person's runs, by state, in one query. Keyed on who started it. */
  private async runCounts(scope: TenantScope): Promise<Map<string, Map<string, number>>> {
    const rows = await this.prisma.runInTenantTransaction(scope, () =>
      this.prisma.client.agentRun.groupBy({
        by: ['startedByUserId', 'state'],
        where: { tenantId: scope.tenantId, startedByUserId: { not: null } },
        _count: { _all: true },
      }),
    );

    const counts = new Map<string, Map<string, number>>();
    for (const row of rows) {
      if (row.startedByUserId === null) continue;
      const byState = counts.get(row.startedByUserId) ?? new Map<string, number>();
      byState.set(row.state, row._count._all);
      counts.set(row.startedByUserId, byState);
    }
    return counts;
  }

  /**
   * The most recent run per person, with the state it is in.
   *
   * `DISTINCT ON` rather than a `groupBy` with `_max`, because the card needs the *state of that
   * run* and not only its time — and a max over two columns independently would pair one run's
   * timestamp with another's outcome, which is a wrong answer that looks right.
   */
  private async lastRuns(
    scope: TenantScope,
  ): Promise<Map<string, { startedAt: Date | null; state: string }>> {
    const rows = await this.prisma.runInTenantTransaction(
      scope,
      () =>
        this.prisma.client.$queryRaw<
          { started_by_user_id: string; started_at: Date | null; state: string }[]
        >`
        SELECT DISTINCT ON (started_by_user_id)
               started_by_user_id, started_at, state
          FROM agent_runs
         WHERE tenant_id = ${scope.tenantId}::uuid
           AND started_by_user_id IS NOT NULL
         ORDER BY started_by_user_id, created_at DESC
      `,
    );

    return new Map(
      rows.map((row) => [row.started_by_user_id, { startedAt: row.started_at, state: row.state }]),
    );
  }

  /** Each person's score: the sum of their performance events, in one query. */
  private async pointTotals(scope: TenantScope): Promise<Map<string, number>> {
    const rows = await this.prisma.runInTenantTransaction(scope, () =>
      this.prisma.client.performanceEvent.groupBy({
        by: ['subjectUserId'],
        where: { tenantId: scope.tenantId },
        _sum: { points: true },
      }),
    );

    return new Map(rows.map((row) => [row.subjectUserId, row._sum.points ?? 0]));
  }
}

export interface TrackerAccount {
  /** The membership's own state — `NotInvited`, `InvitePending`, `Active`, and the rest. */
  state: string;
  /** What the single button on the card does. `None` means it is disabled, with `reason` saying why. */
  action: 'Invite' | 'Resend' | 'Reset' | 'None';
  /** Where it would be sent. Null when there is nowhere to send it. */
  email: string | null;
  reason: string | null;
}

export interface TrackerGrid {
  cards: TrackerCard[];
  /** Employed here, never invited — on the org chart but not users of this product. */
  notInvited: number;
  /** How many of those could be invited today: the rest have no work address to send one to. */
  invitable: number;
}

export interface TrackerRun {
  id: string;
  agent: string;
  state: string;
  trigger: string;
  attempt: number;
  startedAt: Date | null;
  finishedAt: Date | null;
  /** Milliseconds from start to finish, or to now while it is still going. Null before it starts. */
  elapsedMs: number | null;
  stillGoing: boolean;
  failureReason: string | null;
  progressMessage: string | null;
}

export interface TrackerDetail {
  userId: string;
  name: string;
  employeeId: string | null;
  designation: string | null;
  department: string | null;
  account: TrackerAccount;
  runs: TrackerRun[];
  openTasks: {
    id: string;
    title: string;
    status: string;
    dueAt: Date | null;
    overdue: boolean;
  }[];
}

export interface TrackerCard {
  userId: string;
  name: string;
  employeeId: string | null;
  designation: string | null;
  department: string | null;
  tasks: { assigned: number; open: number; overdue: number; done: number };
  runs: {
    total: number;
    failed: number;
    lastStartedAt: Date | null;
    lastState: string | null;
  };
  performance: { score: number; level: BadgeLevel; label: string };
  account: TrackerAccount;
}
