import { Injectable } from '@nestjs/common';

import type {
  BulkOperation,
  BulkOperationKind,
  BulkOperationRow,
  Offboarding,
} from '../generated/prisma/client.js';
import { PrismaService } from './prisma.service.js';
import type { TenantScope } from './tenant-context.js';

/** One person as the Users & Access screen shows them, in one query. */
export interface AccessRow {
  userId: string;
  ubossUniqueId: string;
  displayName: string;
  email: string;
  userType: string;
  accountState: string;
  guestAccessExpiresAt: Date | null;
  employeeId: string | null;
  designation: string | null;
  departmentId: string | null;
  departmentName: string | null;
  reportingManagerUserId: string | null;
  reportingManagerName: string | null;
  employmentState: string | null;
  roleCount: number;
  /** The live invitation, when there is one. */
  invitationId: string | null;
  invitationExpiresAt: Date | null;
  invitationSentAt: Date | null;
}

/**
 * Repository for Users & Access: the roster, bulk operations and offboardings.
 *
 * Follows the ADR-037 convention — every method declares its tenant scope, so Row-Level Security
 * enforces it alongside the `where` clause. That matters here more than in most places: this is
 * the table of *who may act inside a company*, and a query that forgot its scope would list
 * another company's people.
 */
@Injectable()
export class AccessRepository {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * The whole roster in one query — memberships, employment, role counts and live invitations.
   *
   * Raw SQL rather than nested includes because the screen needs a **role count** and the
   * **manager's name**, which are an aggregate and a self-join. Building this from four Prisma
   * calls and stitching it in JavaScript is how a 400-person company gets a slow page.
   *
   * `LEFT JOIN` on everything except the membership, deliberately: a person with no employment
   * record (a guest), no role (not yet granted) and no invitation (never invited) is a real and
   * common state, and they must still appear. An `INNER JOIN` here would hide exactly the people
   * an administrator opened this screen to deal with.
   */
  async roster(scope: TenantScope): Promise<AccessRow[]> {
    return this.prisma.runInTenantTransaction(scope, () =>
      this.prisma.client.$queryRawUnsafe<AccessRow[]>(
        `SELECT
           m."user_id"                  AS "userId",
           u."uboss_unique_id"          AS "ubossUniqueId",
           u."display_name"             AS "displayName",
           u."email"                    AS "email",
           m."user_type"::text          AS "userType",
           m."account_state"::text      AS "accountState",
           m."guest_access_expires_at"  AS "guestAccessExpiresAt",
           e."employee_id"              AS "employeeId",
           e."designation"              AS "designation",
           e."department_id"            AS "departmentId",
           d."name"                     AS "departmentName",
           e."reporting_manager_user_id" AS "reportingManagerUserId",
           mgr."display_name"           AS "reportingManagerName",
           e."state"::text              AS "employmentState",
           COALESCE(r."role_count", 0)::int AS "roleCount",
           i."id"                       AS "invitationId",
           i."expires_at"               AS "invitationExpiresAt",
           i."created_at"               AS "invitationSentAt"
         FROM "tenant_memberships" m
         JOIN "users" u ON u."id" = m."user_id"
         LEFT JOIN "employment_records" e
                ON e."tenant_id" = m."tenant_id" AND e."user_id" = m."user_id"
         LEFT JOIN "departments" d ON d."id" = e."department_id"
         LEFT JOIN "users" mgr ON mgr."id" = e."reporting_manager_user_id"
         LEFT JOIN LATERAL (
           SELECT count(*) AS "role_count"
             FROM "role_assignments" ra
            WHERE ra."tenant_id" = m."tenant_id"
              AND ra."user_id" = m."user_id"
              AND (ra."expires_at" IS NULL OR ra."expires_at" > NOW())
         ) r ON true
         LEFT JOIN LATERAL (
           SELECT inv."id", inv."expires_at", inv."created_at"
             FROM "invitations" inv
            WHERE inv."tenant_id" = m."tenant_id"
              AND inv."user_id" = m."user_id"
              AND inv."accepted_at" IS NULL
              AND inv."cancelled_at" IS NULL
              AND inv."expires_at" > NOW()
            ORDER BY inv."created_at" DESC
            LIMIT 1
         ) i ON true
         WHERE m."tenant_id" = $1::uuid
         ORDER BY u."display_name" ASC`,
        scope.tenantId,
      ),
    );
  }

  /** Does this company have anybody at the top of its reporting tree? */
  async hasReportingRoot(scope: TenantScope): Promise<boolean> {
    return this.prisma.runInTenantTransaction(scope, async () => {
      const count = await this.prisma.client.employmentRecord.count({
        where: { tenantId: scope.tenantId, reportingManagerUserId: null },
      });
      return count > 0;
    });
  }

  // -------------------------------------------------------------------------
  // Bulk operations
  // -------------------------------------------------------------------------

  async createBulkOperation(
    scope: TenantScope,
    input: {
      kind: BulkOperationKind;
      requestedByUserId: string;
      sourceFileName?: string | undefined;
      parameters: Record<string, unknown>;
      reason?: string | undefined;
      totalRows: number;
    },
  ): Promise<BulkOperation> {
    return this.prisma.runInTenantTransaction(scope, () =>
      this.prisma.client.bulkOperation.create({
        data: {
          tenantId: scope.tenantId,
          kind: input.kind,
          requestedByUserId: input.requestedByUserId,
          ...(input.sourceFileName === undefined ? {} : { sourceFileName: input.sourceFileName }),
          parameters: input.parameters as never,
          ...(input.reason === undefined ? {} : { reason: input.reason }),
          totalRows: input.totalRows,
        },
      }),
    );
  }

  async findBulkOperation(
    scope: TenantScope,
    operationId: string,
  ): Promise<(BulkOperation & { rows: BulkOperationRow[] }) | null> {
    return this.prisma.runInTenantTransaction(scope, () =>
      this.prisma.client.bulkOperation.findFirst({
        where: { id: operationId, tenantId: scope.tenantId },
        include: { rows: { orderBy: { rowNumber: 'asc' } } },
      }),
    );
  }

  async listBulkOperations(scope: TenantScope, take = 50): Promise<BulkOperation[]> {
    return this.prisma.runInTenantTransaction(scope, () =>
      this.prisma.client.bulkOperation.findMany({
        where: { tenantId: scope.tenantId },
        orderBy: { createdAt: 'desc' },
        take,
      }),
    );
  }

  /** Assumes the caller's transaction. Rows are written with their operation. */
  async createBulkRowsWithinCurrentScope(
    rows: {
      bulkOperationId: string;
      tenantId: string;
      rowNumber: number;
      state: BulkOperationRow['state'];
      input: Record<string, unknown>;
      errors: string[];
      subjectUserId?: string | undefined;
    }[],
  ): Promise<void> {
    if (rows.length === 0) {
      return;
    }
    await this.prisma.client.bulkOperationRow.createMany({
      data: rows.map((row) => ({
        bulkOperationId: row.bulkOperationId,
        tenantId: row.tenantId,
        rowNumber: row.rowNumber,
        state: row.state,
        input: row.input as never,
        errors: row.errors,
        ...(row.subjectUserId === undefined ? {} : { subjectUserId: row.subjectUserId }),
      })),
    });
  }

  async updateBulkOperationWithinCurrentScope(
    operationId: string,
    data: Record<string, unknown>,
  ): Promise<void> {
    await this.prisma.client.bulkOperation.update({
      where: { id: operationId },
      data: { ...data, version: { increment: 1 } },
    });
  }

  async updateBulkRowWithinCurrentScope(
    rowId: string,
    data: Record<string, unknown>,
  ): Promise<void> {
    await this.prisma.client.bulkOperationRow.update({ where: { id: rowId }, data });
  }

  // -------------------------------------------------------------------------
  // Offboardings
  // -------------------------------------------------------------------------

  async findOpenOffboarding(
    scope: TenantScope,
    subjectUserId: string,
  ): Promise<Offboarding | null> {
    return this.prisma.runInTenantTransaction(scope, () =>
      this.prisma.client.offboarding.findFirst({
        where: { tenantId: scope.tenantId, subjectUserId, state: 'Requested' },
      }),
    );
  }

  async listOffboardings(scope: TenantScope, take = 50): Promise<Offboarding[]> {
    return this.prisma.runInTenantTransaction(scope, () =>
      this.prisma.client.offboarding.findMany({
        where: { tenantId: scope.tenantId },
        orderBy: { createdAt: 'desc' },
        take,
      }),
    );
  }
}
