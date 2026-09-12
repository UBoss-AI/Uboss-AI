import { Injectable } from '@nestjs/common';

import type {
  FeatureFlag,
  Plan,
  PlatformRoleAssignment,
  PlatformSetting,
  Prisma,
  ServiceAlert,
  TenantSubscription,
} from '../generated/prisma/client.js';
import { PrismaService } from './prisma.service.js';

/** A company with everything the Master Console lists it by, in one read. */
export interface CompanyOverviewRow {
  tenantId: string;
  slug: string;
  name: string;
  legalName: string | null;
  lifecycleState: string;
  createdAt: Date;
  /** Members with an active account. The numerator of the seats column. */
  seatsUsed: number;
  /** Every membership regardless of state, so an offboarded person is visible somewhere. */
  membershipsTotal: number;
  planCode: string | null;
  planName: string | null;
  planTier: string | null;
  seatsLicensed: number | null;
  subscriptionState: string | null;
  billingState: string | null;
  renewsAt: Date | null;
  aiAllowanceMinor: number;
  aiConsumedMinor: number;
  currency: string | null;
  pinnedFlag: string;
  /** Open security events at `Critical` severity. Real data, from Prompt 8. */
  criticalSecurityEvents: number;
  /** Break-glass records whose customer notification is still outstanding. Real data. */
  breakGlassPendingNotification: number;
  /** Break-glass grants in force right now. Real data. */
  breakGlassActive: number;
  /** Open service alerts naming this company. */
  openServiceAlerts: number;
}

/**
 * Platform-plane reads and writes for the Master Console.
 *
 * ## Self-scoping, like every repository since Prompt 6
 *
 * Each method opens the RLS scope it needs (ADR-037). Nearly all of it is
 * `runAsPlatformOperation`, because the Master Console is by definition cross-company work —
 * which is also why every method here is only reachable from a `@PlatformOnly` controller behind
 * a platform-role check.
 *
 * ## Why the dashboard is one SQL query and not an ORM loop
 *
 * `companyOverview` aggregates six per-company counts across four tables. Through Prisma that is
 * either one query per company per count — 5 companies × 4 counts = 20 round trips, and it grows
 * with the customer base — or `include` with in-memory counting, which loads every membership,
 * every security event and every break-glass record into the API to produce four integers.
 *
 * A single grouped query is the honest answer for a dashboard: the aggregation is what databases
 * are for, and the cost of writing it by hand is that the column list has to be kept in step with
 * `CompanyOverviewRow`. `platform-console.e2e.spec.ts` asserts the shape against real rows so a
 * drift fails a test rather than rendering `undefined` on a screen.
 */
@Injectable()
export class PlatformRepository {
  constructor(private readonly prisma: PrismaService) {}

  // -------------------------------------------------------------------------
  // Platform roles
  // -------------------------------------------------------------------------

  /**
   * Every live platform role assignment for one person.
   *
   * "Live" excludes revoked rows and rows whose `expiresAt` has passed, and expiry is evaluated
   * **here on read** rather than by a sweep — the same rule as break-glass. A role that expired
   * a minute ago and is still being honoured because no job has run is authority nobody granted.
   */
  async livePlatformRoles(userId: string): Promise<PlatformRoleAssignment[]> {
    return this.prisma.runAsPlatformOperation(() =>
      this.prisma.client.platformRoleAssignment.findMany({
        where: {
          userId,
          revokedAt: null,
          OR: [{ expiresAt: null }, { expiresAt: { gt: new Date() } }],
        },
        orderBy: { createdAt: 'asc' },
      }),
    );
  }

  /** Every assignment for one person including revoked and expired, for an access review. */
  async allPlatformRoles(userId: string): Promise<PlatformRoleAssignment[]> {
    return this.prisma.runAsPlatformOperation(() =>
      this.prisma.client.platformRoleAssignment.findMany({
        where: { userId },
        orderBy: { createdAt: 'desc' },
      }),
    );
  }

  /** Everyone holding platform authority, for the Security & Audit access review. */
  async platformRoleHolders(): Promise<
    (PlatformRoleAssignment & { user: { ubossUniqueId: string; email: string } })[]
  > {
    return this.prisma.runAsPlatformOperation(() =>
      this.prisma.client.platformRoleAssignment.findMany({
        where: { revokedAt: null },
        include: { user: { select: { ubossUniqueId: true, email: true } } },
        orderBy: [{ role: 'asc' }, { createdAt: 'asc' }],
      }),
    );
  }

  async findPlatformRole(id: string): Promise<PlatformRoleAssignment | null> {
    return this.prisma.runAsPlatformOperation(() =>
      this.prisma.client.platformRoleAssignment.findUnique({ where: { id } }),
    );
  }

  /**
   * Grant a platform role, or re-open a previously revoked grant of the same role.
   *
   * `(userId, role)` is unique, so a re-grant has to reuse the row. Prisma's `upsert` cannot be
   * used blindly here because the update must also clear the revocation fields — a re-grant that
   * left `revokedAt` set would create a row that the "revocation is attributed" constraint
   * accepts and `livePlatformRoles` silently ignores, which is the worst outcome: the grant
   * appears in an access review and confers nothing.
   */
  async grantPlatformRole(input: {
    userId: string;
    role: PlatformRoleAssignment['role'];
    grantedByUserId: string;
    justification?: string | undefined;
    expiresAt?: Date | undefined;
  }): Promise<PlatformRoleAssignment> {
    return this.prisma.runAsPlatformOperation(async () => {
      const existing = await this.prisma.client.platformRoleAssignment.findUnique({
        where: { userId_role: { userId: input.userId, role: input.role } },
      });

      const data = {
        grantedByUserId: input.grantedByUserId,
        justification: input.justification ?? null,
        expiresAt: input.expiresAt ?? null,
        revokedAt: null,
        revokedByUserId: null,
      };

      if (existing) {
        return this.prisma.client.platformRoleAssignment.update({
          where: { id: existing.id },
          data: { ...data, version: { increment: 1 } },
        });
      }

      return this.prisma.client.platformRoleAssignment.create({
        data: { userId: input.userId, role: input.role, ...data },
      });
    });
  }

  /**
   * Revoke a grant.
   *
   * The row is kept, not deleted: who *used* to hold platform authority is the first question an
   * access review asks, and a deleted row cannot answer it.
   */
  async revokePlatformRole(id: string, revokedByUserId: string): Promise<PlatformRoleAssignment> {
    return this.prisma.runAsPlatformOperation(() =>
      this.prisma.client.platformRoleAssignment.update({
        where: { id },
        data: { revokedAt: new Date(), revokedByUserId, version: { increment: 1 } },
      }),
    );
  }

  // -------------------------------------------------------------------------
  // Plans
  // -------------------------------------------------------------------------

  async listPlans(options: { includeRetired?: boolean } = {}): Promise<Plan[]> {
    return this.prisma.runAsPlatformOperation(() =>
      this.prisma.client.plan.findMany({
        where: options.includeRetired ? {} : { active: true },
        orderBy: [{ sortOrder: 'asc' }, { name: 'asc' }],
      }),
    );
  }

  async findPlanByCode(code: string): Promise<Plan | null> {
    return this.prisma.runAsPlatformOperation(() =>
      this.prisma.client.plan.findUnique({ where: { code } }),
    );
  }

  async findPlan(id: string): Promise<Plan | null> {
    return this.prisma.runAsPlatformOperation(() =>
      this.prisma.client.plan.findUnique({ where: { id } }),
    );
  }

  async createPlan(data: Prisma.PlanCreateInput): Promise<Plan> {
    return this.prisma.runAsPlatformOperation(() => this.prisma.client.plan.create({ data }));
  }

  async updatePlan(id: string, data: Prisma.PlanUpdateInput): Promise<Plan> {
    return this.prisma.runAsPlatformOperation(() =>
      this.prisma.client.plan.update({
        where: { id },
        data: { ...data, version: { increment: 1 } },
      }),
    );
  }

  /** How many companies are on each plan. Deleting a plan with subscribers must be refused. */
  async subscriberCounts(): Promise<Record<string, number>> {
    const grouped = await this.prisma.runAsPlatformOperation(() =>
      this.prisma.client.tenantSubscription.groupBy({
        by: ['planId'],
        _count: { _all: true },
      }),
    );
    return Object.fromEntries(grouped.map((row) => [row.planId, row._count._all]));
  }

  // -------------------------------------------------------------------------
  // Subscriptions
  // -------------------------------------------------------------------------

  async findSubscriptionForTenant(tenantId: string): Promise<TenantSubscription | null> {
    return this.prisma.runAsPlatformOperation(() =>
      this.prisma.client.tenantSubscription.findUnique({ where: { tenantId } }),
    );
  }

  async upsertSubscription(input: {
    tenantId: string;
    planId: string;
    data: Omit<Prisma.TenantSubscriptionUpdateInput, 'tenant' | 'plan' | 'version'>;
  }): Promise<TenantSubscription> {
    return this.prisma.runAsPlatformOperation(async () => {
      const existing = await this.prisma.client.tenantSubscription.findUnique({
        where: { tenantId: input.tenantId },
      });

      if (existing) {
        return this.prisma.client.tenantSubscription.update({
          where: { id: existing.id },
          data: {
            ...input.data,
            plan: { connect: { id: input.planId } },
            version: { increment: 1 },
          },
        });
      }

      return this.prisma.client.tenantSubscription.create({
        data: {
          ...(input.data as Prisma.TenantSubscriptionCreateInput),
          tenant: { connect: { id: input.tenantId } },
          plan: { connect: { id: input.planId } },
        },
      });
    });
  }

  // -------------------------------------------------------------------------
  // Feature flags
  // -------------------------------------------------------------------------

  async listFeatureFlags(): Promise<FeatureFlag[]> {
    return this.prisma.runAsPlatformOperation(() =>
      this.prisma.client.featureFlag.findMany({ orderBy: [{ stage: 'desc' }, { key: 'asc' }] }),
    );
  }

  async findFeatureFlag(key: string): Promise<FeatureFlag | null> {
    return this.prisma.runAsPlatformOperation(() =>
      this.prisma.client.featureFlag.findUnique({ where: { key } }),
    );
  }

  async createFeatureFlag(data: Prisma.FeatureFlagCreateInput): Promise<FeatureFlag> {
    return this.prisma.runAsPlatformOperation(() =>
      this.prisma.client.featureFlag.create({ data }),
    );
  }

  async updateFeatureFlag(key: string, data: Prisma.FeatureFlagUpdateInput): Promise<FeatureFlag> {
    return this.prisma.runAsPlatformOperation(() =>
      this.prisma.client.featureFlag.update({
        where: { key },
        data: { ...data, version: { increment: 1 } },
      }),
    );
  }

  // -------------------------------------------------------------------------
  // Platform settings
  // -------------------------------------------------------------------------

  async listSettings(): Promise<PlatformSetting[]> {
    return this.prisma.runAsPlatformOperation(() =>
      this.prisma.client.platformSetting.findMany({
        orderBy: [{ section: 'asc' }, { key: 'asc' }],
      }),
    );
  }

  async findSetting(key: string): Promise<PlatformSetting | null> {
    return this.prisma.runAsPlatformOperation(() =>
      this.prisma.client.platformSetting.findUnique({ where: { key } }),
    );
  }

  async updateSetting(
    key: string,
    value: Prisma.InputJsonValue,
    updatedByUserId: string,
  ): Promise<PlatformSetting> {
    return this.prisma.runAsPlatformOperation(() =>
      this.prisma.client.platformSetting.update({
        where: { key },
        data: { value, updatedByUserId, version: { increment: 1 } },
      }),
    );
  }

  // -------------------------------------------------------------------------
  // Service alerts
  // -------------------------------------------------------------------------

  async listServiceAlerts(filter: {
    state?: ServiceAlert['state'] | undefined;
    openOnly?: boolean | undefined;
    take?: number | undefined;
  }): Promise<ServiceAlert[]> {
    return this.prisma.runAsPlatformOperation(() =>
      this.prisma.client.serviceAlert.findMany({
        where: {
          ...(filter.state === undefined ? {} : { state: filter.state }),
          ...(filter.openOnly ? { state: { in: ['Open', 'Acknowledged'] } } : {}),
        },
        orderBy: [{ severity: 'desc' }, { openedAt: 'desc' }],
        take: Math.min(filter.take ?? 50, 200),
      }),
    );
  }

  async findServiceAlert(id: string): Promise<ServiceAlert | null> {
    return this.prisma.runAsPlatformOperation(() =>
      this.prisma.client.serviceAlert.findUnique({ where: { id } }),
    );
  }

  async updateServiceAlert(
    id: string,
    data: Prisma.ServiceAlertUpdateInput,
  ): Promise<ServiceAlert> {
    return this.prisma.runAsPlatformOperation(() =>
      this.prisma.client.serviceAlert.update({
        where: { id },
        data: { ...data, version: { increment: 1 } },
      }),
    );
  }

  // -------------------------------------------------------------------------
  // The dashboard aggregate
  // -------------------------------------------------------------------------

  /**
   * Every company with the counts the Master Console lists it by.
   *
   * One query — see the class comment for why. The `LEFT JOIN LATERAL`s keep each count
   * independent: a plain join across four one-to-many tables would multiply the rows and every
   * count would be wrong in a way that looks plausible.
   *
   * `::int` on each count because PostgreSQL returns `count(*)` as `bigint`, which the driver
   * adapter hands back as a string and `JSON.stringify` refuses — the Prompt 8 lesson, applied
   * before it could bite again.
   */
  async companyOverview(): Promise<CompanyOverviewRow[]> {
    return this.prisma.runAsPlatformOperation(() =>
      this.prisma.client.$queryRawUnsafe<CompanyOverviewRow[]>(`
        SELECT
          t."id"                                        AS "tenantId",
          t."slug"                                      AS "slug",
          t."name"                                      AS "name",
          t."legal_name"                                AS "legalName",
          t."lifecycle_state"::text                     AS "lifecycleState",
          t."created_at"                                AS "createdAt",
          COALESCE(m."active_seats", 0)::int             AS "seatsUsed",
          COALESCE(m."total_seats", 0)::int              AS "membershipsTotal",
          p."code"                                      AS "planCode",
          p."name"                                      AS "planName",
          p."tier"::text                                AS "planTier",
          COALESCE(s."seats_licensed", p."seat_limit")   AS "seatsLicensed",
          s."state"::text                               AS "subscriptionState",
          s."billing_state"::text                       AS "billingState",
          s."renews_at"                                 AS "renewsAt",
          COALESCE(s."ai_allowance_minor", 0)::int       AS "aiAllowanceMinor",
          COALESCE(s."ai_consumed_minor", 0)::int        AS "aiConsumedMinor",
          s."currency"                                  AS "currency",
          COALESCE(s."pinned_flag"::text, 'None')       AS "pinnedFlag",
          COALESCE(sec."critical_events", 0)::int        AS "criticalSecurityEvents",
          COALESCE(bg."pending_notification", 0)::int    AS "breakGlassPendingNotification",
          COALESCE(bg."active_grants", 0)::int           AS "breakGlassActive",
          COALESCE(al."open_alerts", 0)::int             AS "openServiceAlerts"
        FROM "tenants" t
        LEFT JOIN LATERAL (
          SELECT
            count(*) FILTER (WHERE tm."account_state" = 'Active') AS "active_seats",
            count(*)                                              AS "total_seats"
          FROM "tenant_memberships" tm WHERE tm."tenant_id" = t."id"
        ) m ON TRUE
        LEFT JOIN "tenant_subscriptions" s ON s."tenant_id" = t."id"
        LEFT JOIN "plans" p ON p."id" = s."plan_id"
        LEFT JOIN LATERAL (
          SELECT count(*) AS "critical_events"
          FROM "security_events" se
          WHERE se."tenant_id" = t."id"
            AND se."severity" = 'Critical'
            AND se."occurred_at" > NOW() - INTERVAL '30 days'
        ) sec ON TRUE
        LEFT JOIN LATERAL (
          SELECT
            count(*) FILTER (WHERE b."customer_notification_state" = 'Pending') AS "pending_notification",
            count(*) FILTER (WHERE b."state" = 'Active')                        AS "active_grants"
          FROM "break_glass_requests" b WHERE b."tenant_id" = t."id"
        ) bg ON TRUE
        LEFT JOIN LATERAL (
          SELECT count(*) AS "open_alerts"
          FROM "service_alerts" a
          WHERE a."affected_tenant_id" = t."id" AND a."state" IN ('Open', 'Acknowledged')
        ) al ON TRUE
        ORDER BY t."name" ASC
      `),
    );
  }

  /** Platform-wide counts the dashboard shows as KPIs. */
  async platformTotals(): Promise<{
    tenants: number;
    activeTenants: number;
    seatsUsed: number;
    seatsLicensed: number;
    openAlerts: number;
    criticalAlerts: number;
    criticalSecurityEvents: number;
    activeBreakGlass: number;
    pendingCustomerNotifications: number;
    platformRoleHolders: number;
  }> {
    const [row] = await this.prisma.runAsPlatformOperation(() =>
      this.prisma.client.$queryRawUnsafe<
        {
          tenants: number;
          activeTenants: number;
          seatsUsed: number;
          seatsLicensed: number;
          openAlerts: number;
          criticalAlerts: number;
          criticalSecurityEvents: number;
          activeBreakGlass: number;
          pendingCustomerNotifications: number;
          platformRoleHolders: number;
        }[]
      >(`
        SELECT
          (SELECT count(*) FROM "tenants")::int                                     AS "tenants",
          (SELECT count(*) FROM "tenants" WHERE "lifecycle_state" = 'Active')::int  AS "activeTenants",
          (SELECT count(*) FROM "tenant_memberships" WHERE "account_state" = 'Active')::int
                                                                                    AS "seatsUsed",
          (SELECT COALESCE(SUM(COALESCE(s."seats_licensed", p."seat_limit", 0)), 0)
             FROM "tenant_subscriptions" s
             LEFT JOIN "plans" p ON p."id" = s."plan_id")::int                      AS "seatsLicensed",
          (SELECT count(*) FROM "service_alerts" WHERE "state" IN ('Open','Acknowledged'))::int
                                                                                    AS "openAlerts",
          (SELECT count(*) FROM "service_alerts"
             WHERE "state" IN ('Open','Acknowledged') AND "severity" = 'Critical')::int
                                                                                    AS "criticalAlerts",
          (SELECT count(*) FROM "security_events"
             WHERE "severity" = 'Critical' AND "occurred_at" > NOW() - INTERVAL '30 days')::int
                                                                                    AS "criticalSecurityEvents",
          (SELECT count(*) FROM "break_glass_requests" WHERE "state" = 'Active')::int
                                                                                    AS "activeBreakGlass",
          (SELECT count(*) FROM "break_glass_requests"
             WHERE "customer_notification_state" = 'Pending')::int                  AS "pendingCustomerNotifications",
          (SELECT count(DISTINCT "user_id") FROM "platform_role_assignments"
             WHERE "revoked_at" IS NULL)::int                                       AS "platformRoleHolders"
      `),
    );

    return (
      row ?? {
        tenants: 0,
        activeTenants: 0,
        seatsUsed: 0,
        seatsLicensed: 0,
        openAlerts: 0,
        criticalAlerts: 0,
        criticalSecurityEvents: 0,
        activeBreakGlass: 0,
        pendingCustomerNotifications: 0,
        platformRoleHolders: 0,
      }
    );
  }

  /** One company, with the same shape the list uses, so a detail screen agrees with its row. */
  async companyOverviewFor(tenantId: string): Promise<CompanyOverviewRow | undefined> {
    const all = await this.companyOverview();
    return all.find((row) => row.tenantId === tenantId);
  }
}
