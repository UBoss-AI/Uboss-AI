import { Injectable } from '@nestjs/common';

import type {
  Department,
  EmploymentRecord,
  PersonIdentifier,
  PersonIdentifierKind,
} from '../generated/prisma/client.js';
import { PrismaService } from './prisma.service.js';
import type { TenantScope } from './tenant-context.js';

/** An employment record with the joined names a screen needs, and nothing more. */
export interface HierarchyRow {
  userId: string;
  ubossUniqueId: string;
  displayName: string;
  employeeId: string;
  designation: string;
  departmentId: string;
  departmentName: string;
  reportingManagerUserId: string | null;
  reportingManagerName: string | null;
  state: string;
  accountState: string | null;
  aadhaarLastFour: string | null;
}

/**
 * Repository for departments, employment records and the person registry.
 *
 * Follows the ADR-037 convention: every tenant-scoped method **declares** its scope to
 * PostgreSQL, so Row-Level Security enforces it alongside the `where` clause.
 *
 * ## The one deliberately platform-plane table
 *
 * `person_identifiers` has no `tenant_id`, because an identifier belongs to a *person* rather
 * than to a company — that is precisely what makes "the same human at their second employer
 * keeps one UBoss Unique ID" possible. Its methods are named `...ForPlatform` so a reader can
 * see at the call site that they cross the tenant boundary by design, and they return a
 * **decision** (this identifier resolves to this person) rather than rows, so a caller learns
 * nothing about where else that person works.
 */
@Injectable()
export class OrganizationRepository {
  constructor(private readonly prisma: PrismaService) {}

  // -------------------------------------------------------------------------
  // Departments
  // -------------------------------------------------------------------------

  async listDepartments(scope: TenantScope, includeArchived = false): Promise<Department[]> {
    return this.prisma.runInTenantTransaction(scope, () =>
      this.prisma.client.department.findMany({
        where: {
          tenantId: scope.tenantId,
          ...(includeArchived ? {} : { archivedAt: null }),
        },
        orderBy: [{ sortOrder: 'asc' }, { name: 'asc' }],
      }),
    );
  }

  async findDepartment(scope: TenantScope, departmentId: string): Promise<Department | null> {
    return this.prisma.runInTenantTransaction(scope, () =>
      this.prisma.client.department.findFirst({
        where: { id: departmentId, tenantId: scope.tenantId },
      }),
    );
  }

  async createDepartment(
    scope: TenantScope,
    input: {
      name: string;
      code?: string | undefined;
      parentDepartmentId?: string | undefined;
      headUserId?: string | undefined;
      description?: string | undefined;
      sortOrder?: number | undefined;
    },
  ): Promise<Department> {
    return this.prisma.runInTenantTransaction(scope, () =>
      this.prisma.client.department.create({
        data: {
          tenantId: scope.tenantId,
          name: input.name,
          ...(input.code === undefined ? {} : { code: input.code }),
          ...(input.parentDepartmentId === undefined
            ? {}
            : { parentDepartmentId: input.parentDepartmentId }),
          ...(input.headUserId === undefined ? {} : { headUserId: input.headUserId }),
          ...(input.description === undefined ? {} : { description: input.description }),
          ...(input.sortOrder === undefined ? {} : { sortOrder: input.sortOrder }),
        },
      }),
    );
  }

  async updateDepartment(
    scope: TenantScope,
    departmentId: string,
    data: Record<string, unknown>,
  ): Promise<number> {
    return this.prisma.runInTenantTransaction(scope, async () => {
      const result = await this.prisma.client.department.updateMany({
        where: { id: departmentId, tenantId: scope.tenantId },
        data: { ...data, version: { increment: 1 } },
      });
      return result.count;
    });
  }

  /** How many people are currently employed in a department. Blocks archiving a live one. */
  async countEmployedInDepartment(scope: TenantScope, departmentId: string): Promise<number> {
    return this.prisma.runInTenantTransaction(scope, () =>
      this.prisma.client.employmentRecord.count({
        where: { tenantId: scope.tenantId, departmentId, state: 'Active' },
      }),
    );
  }

  // -------------------------------------------------------------------------
  // Employment records
  // -------------------------------------------------------------------------

  async findEmployment(scope: TenantScope, userId: string): Promise<EmploymentRecord | null> {
    return this.prisma.runInTenantTransaction(scope, () =>
      this.prisma.client.employmentRecord.findFirst({
        where: { tenantId: scope.tenantId, userId },
      }),
    );
  }

  /**
   * The same lookup for a platform-plane job that already knows which company it is working on.
   *
   * Added at Prompt 15 for the escalation sweeper, which runs once for the whole platform and
   * finds each recipient's reporting manager. The tenant is passed explicitly and used in the
   * `where` clause, so this reads one company's row even though it runs unscoped — the pattern
   * every `...ForPlatform` method here follows.
   */
  async findEmploymentForPlatform(
    tenantId: string,
    userId: string,
  ): Promise<EmploymentRecord | null> {
    return this.prisma.runAsPlatformOperation(() =>
      this.prisma.client.employmentRecord.findFirst({ where: { tenantId, userId } }),
    );
  }

  async findEmploymentByEmployeeId(
    scope: TenantScope,
    employeeId: string,
  ): Promise<EmploymentRecord | null> {
    return this.prisma.runInTenantTransaction(scope, () =>
      this.prisma.client.employmentRecord.findFirst({
        where: { tenantId: scope.tenantId, employeeId },
      }),
    );
  }

  async createEmployment(
    scope: TenantScope,
    input: {
      userId: string;
      employeeId: string;
      designation: string;
      departmentId: string;
      reportingManagerUserId?: string | undefined;
      joinedOn?: Date | undefined;
      employmentType?: string | undefined;
      workEmail?: string | undefined;
      workPhone?: string | undefined;
    },
  ): Promise<EmploymentRecord> {
    return this.prisma.runInTenantTransaction(scope, () =>
      this.prisma.client.employmentRecord.create({
        data: {
          tenantId: scope.tenantId,
          userId: input.userId,
          employeeId: input.employeeId,
          designation: input.designation,
          departmentId: input.departmentId,
          ...(input.reportingManagerUserId === undefined
            ? {}
            : { reportingManagerUserId: input.reportingManagerUserId }),
          ...(input.joinedOn === undefined ? {} : { joinedOn: input.joinedOn }),
          ...(input.employmentType === undefined ? {} : { employmentType: input.employmentType }),
          ...(input.workEmail === undefined ? {} : { workEmail: input.workEmail }),
          ...(input.workPhone === undefined ? {} : { workPhone: input.workPhone }),
        },
      }),
    );
  }

  async updateEmployment(
    scope: TenantScope,
    userId: string,
    data: Record<string, unknown>,
  ): Promise<number> {
    return this.prisma.runInTenantTransaction(scope, async () => {
      const result = await this.prisma.client.employmentRecord.updateMany({
        where: { tenantId: scope.tenantId, userId },
        data: { ...data, version: { increment: 1 } },
      });
      return result.count;
    });
  }

  /**
   * Everything the hierarchy screen needs, in one query.
   *
   * Raw SQL with explicit joins rather than nested Prisma includes: the screen needs the
   * manager's *name*, which is a self-join through `users`, and three round trips to render one
   * org chart is the kind of thing that looks harmless and shows up as a slow page on a company
   * with four hundred people.
   *
   * `aadhaar_last_four` is joined in because the list view shows the masked form. The full
   * number is not in the database at all, so there is nothing here that could leak it.
   */
  async listHierarchy(scope: TenantScope): Promise<HierarchyRow[]> {
    return this.prisma.runInTenantTransaction(scope, async () =>
      this.prisma.client.$queryRawUnsafe<HierarchyRow[]>(
        `SELECT
           e."user_id"                    AS "userId",
           u."uboss_unique_id"            AS "ubossUniqueId",
           u."display_name"               AS "displayName",
           e."employee_id"                AS "employeeId",
           e."designation"                AS "designation",
           e."department_id"              AS "departmentId",
           d."name"                       AS "departmentName",
           e."reporting_manager_user_id"  AS "reportingManagerUserId",
           m."display_name"               AS "reportingManagerName",
           e."state"::text                AS "state",
           tm."account_state"::text       AS "accountState",
           pi."last_four"                 AS "aadhaarLastFour"
         FROM "employment_records" e
         JOIN "users" u ON u."id" = e."user_id"
         JOIN "departments" d ON d."id" = e."department_id"
         LEFT JOIN "users" m ON m."id" = e."reporting_manager_user_id"
         LEFT JOIN "tenant_memberships" tm
                ON tm."user_id" = e."user_id" AND tm."tenant_id" = e."tenant_id"
         LEFT JOIN "person_identifiers" pi
                ON pi."user_id" = e."user_id" AND pi."kind" = 'AadhaarEnteredOnly'
         WHERE e."tenant_id" = $1::uuid
         ORDER BY d."sort_order" ASC, d."name" ASC, u."display_name" ASC`,
        scope.tenantId,
      ),
    );
  }

  /**
   * Is `subjectUserId` at or beneath `managerUserId` in this company's reporting tree?
   *
   * A single recursive CTE, because the alternative — walking the tree in application code —
   * is one query per level on every permission check. `TeamSubtree` authorization calls this,
   * so it runs on ordinary requests and its cost matters.
   *
   * `UNION` rather than `UNION ALL`: it de-duplicates, which bounds the walk even if a cycle
   * somehow existed. The database also refuses to create one (the Prompt 12 trigger), so this is
   * belt and braces on the query that would hang if the trigger were ever dropped.
   *
   * A manager is considered to be in their own subtree. That is the useful reading for
   * authorization: a `TeamSubtree` scope covers the manager's own work as well as their team's.
   */
  async isInReportingSubtree(input: {
    tenantId: string;
    managerUserId: string;
    subjectUserId: string;
  }): Promise<boolean> {
    if (input.managerUserId === input.subjectUserId) {
      return true;
    }

    // The scope is declared here rather than assumed. Authorization already runs inside a
    // tenant transaction so this normally re-enters the caller's, but the resolver is reachable
    // from anywhere — and with no scope declared, RLS would return no rows and this would
    // silently answer "not in the subtree". That is the safe direction, and declaring the scope
    // means it is also the correct one.
    return this.prisma.runInTenantTransaction({ tenantId: input.tenantId } as TenantScope, () =>
      this.subtreeContains(input),
    );
  }

  private async subtreeContains(input: {
    tenantId: string;
    managerUserId: string;
    subjectUserId: string;
  }): Promise<boolean> {
    const rows = await this.prisma.client.$queryRawUnsafe<{ found: boolean }[]>(
      `WITH RECURSIVE subtree AS (
         SELECT e."user_id"
           FROM "employment_records" e
          WHERE e."tenant_id" = $1::uuid AND e."user_id" = $2::uuid
         UNION
         SELECT child."user_id"
           FROM "employment_records" child
           JOIN subtree ON child."reporting_manager_user_id" = subtree."user_id"
          WHERE child."tenant_id" = $1::uuid
       )
       SELECT EXISTS (SELECT 1 FROM subtree WHERE "user_id" = $3::uuid) AS "found"`,
      input.tenantId,
      input.managerUserId,
      input.subjectUserId,
    );

    return rows[0]?.found ?? false;
  }

  /** Every user id at or beneath a manager. For list scoping, which needs the set. */
  async reportingSubtreeUserIds(input: {
    tenantId: string;
    managerUserId: string;
  }): Promise<string[]> {
    return this.prisma.runInTenantTransaction({ tenantId: input.tenantId } as TenantScope, () =>
      this.subtreeUserIds(input),
    );
  }

  private async subtreeUserIds(input: {
    tenantId: string;
    managerUserId: string;
  }): Promise<string[]> {
    const rows = await this.prisma.client.$queryRawUnsafe<{ user_id: string }[]>(
      `WITH RECURSIVE subtree AS (
         SELECT e."user_id"
           FROM "employment_records" e
          WHERE e."tenant_id" = $1::uuid AND e."user_id" = $2::uuid
         UNION
         SELECT child."user_id"
           FROM "employment_records" child
           JOIN subtree ON child."reporting_manager_user_id" = subtree."user_id"
          WHERE child."tenant_id" = $1::uuid
       )
       SELECT "user_id" FROM subtree`,
      input.tenantId,
      input.managerUserId,
    );

    return rows.map((row) => row.user_id);
  }

  // -------------------------------------------------------------------------
  // The person registry — no tenant column, and deliberately not self-scoping
  // -------------------------------------------------------------------------
  //
  // ## Why these three methods declare no scope
  //
  // `person_identifiers` and `users` are **platform-plane tables with no Row-Level Security
  // policy at all**, for the same reason as `users` since Prompt 4: they have no `tenant_id` for
  // a policy to key on, because a person is not owned by a company. There is therefore nothing
  // to declare, and declaring something would be worse than useless —
  // `runAsPlatformOperation` **refuses** to escalate from inside a tenant transaction, which is
  // exactly the guard that should exist and exactly what these methods would trip over.
  //
  // So they join the caller's transaction, the same deliberate choice as `OutboxRepository`.
  // That is not a compromise: matching or creating a person and writing their employment record
  // *must* be atomic, or a failed employment record leaves a permanent UBoss identity belonging
  // to nobody.
  //
  // Nothing here is a hole. Only `PersonRegistryService` can produce a match hash — it needs the
  // server-side key and the number — so a tenant-scoped path cannot enumerate people, and the
  // lookup returns a decision rather than rows.

  /**
   * Find the person an identifier already belongs to. Joins the caller's transaction.
   *
   * Returns the person's id and permanent UBoss Unique ID and **nothing else** — not the
   * companies they work for, not their employment records, not who entered the identifier. A
   * company matching an existing person is entitled to know that one UBoss identity already
   * exists; it is not entitled to know where else that person works.
   */
  async findPersonByIdentifierWithinCurrentScope(input: {
    kind: PersonIdentifierKind;
    matchHash: string;
  }): Promise<{ userId: string; ubossUniqueId: string; displayName: string } | null> {
    const identifier = await this.prisma.client.personIdentifier.findUnique({
      where: { kind_matchHash: { kind: input.kind, matchHash: input.matchHash } },
      select: {
        user: { select: { id: true, ubossUniqueId: true, displayName: true } },
      },
    });

    return identifier
      ? {
          userId: identifier.user.id,
          ubossUniqueId: identifier.user.ubossUniqueId,
          displayName: identifier.user.displayName,
        }
      : null;
  }

  /** Attach an identifier to a person. Assumes an ambient platform operation. */
  async attachIdentifierWithinCurrentScope(input: {
    userId: string;
    kind: PersonIdentifierKind;
    matchHash: string;
    matchKeyId: string;
    lastFour?: string | undefined;
    enteredByTenantId?: string | undefined;
    enteredByUserId?: string | undefined;
  }): Promise<PersonIdentifier> {
    return this.prisma.client.personIdentifier.create({
      data: {
        userId: input.userId,
        kind: input.kind,
        matchHash: input.matchHash,
        matchKeyId: input.matchKeyId,
        ...(input.lastFour === undefined ? {} : { lastFour: input.lastFour }),
        ...(input.enteredByTenantId === undefined
          ? {}
          : { enteredByTenantId: input.enteredByTenantId }),
        ...(input.enteredByUserId === undefined ? {} : { enteredByUserId: input.enteredByUserId }),
      },
    });
  }

  /** The masked fragment for one person, for a profile screen. Joins the caller's transaction. */
  async aadhaarLastFourWithinCurrentScope(userId: string): Promise<string | null> {
    const row = await this.prisma.client.personIdentifier.findFirst({
      where: { userId, kind: 'AadhaarEnteredOnly' },
      select: { lastFour: true },
    });
    return row?.lastFour ?? null;
  }
}
