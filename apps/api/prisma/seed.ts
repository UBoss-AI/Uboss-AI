import { PrismaService } from '../src/persistence/prisma.service.js';
import { AuditEventService } from '../src/audit/audit-event.service.js';
import { AuditTrailRepository } from '../src/persistence/audit-trail.repository.js';
import { TenantMembershipRepository } from '../src/persistence/tenant-membership.repository.js';
import { TenantRepository } from '../src/persistence/tenant.repository.js';
import { UserRepository } from '../src/persistence/user.repository.js';
import { TenantProvisioningService } from '../src/provisioning/tenant-provisioning.service.js';

/**
 * Development seed.
 *
 * Creates a demo Platform Admin plus one demo company with one member, using the same
 * provisioning service the application uses — so the seed exercises the real transaction path
 * rather than a parallel one that could drift.
 *
 * NO CREDENTIALS ARE SEEDED. There is no password, hash, invitation token or session here:
 * authentication does not exist until Prompt 5, and when it does, credentials are set by the
 * user during invitation activation. A seeded password would be exactly the "plaintext
 * credential in a normal database field" the locked rules forbid — and the client's UI
 * prototype's demo password must never be carried into the database.
 *
 * Idempotent: safe to run repeatedly.
 */

const DEMO_PLATFORM_ADMIN = {
  // Reserved example domain, so this can never collide with a real mailbox.
  email: 'platform.admin@uboss.example',
  displayName: 'Demo Platform Admin',
  ubossUniqueId: 'UB-DEMO-PLAT',
};

const DEMO_TENANT = {
  slug: 'demo-company',
  name: 'Demo Company',
  legalName: 'Demo Company Private Limited',
};

/**
 * The Master Console demo companies.
 *
 * Names, plans, seats, usage, billing state and flags are taken **verbatim** from the client's
 * UI prototype (`index.html`, `const COMPANIES`), so the Master Console shows exactly the rows
 * the client has already signed off on rather than data invented here. The reference's
 * `C-001`-style ids become slugs.
 *
 * These are the only rows in the whole seed whose *values* were chosen by the client. Everything
 * about them is marked as demo data by the API's `provenance` fields — see
 * `PlatformConsoleService` — because a seeded billing state must never be read as a fact.
 *
 * Seeded rather than migrated, unlike the plans and settings: plans are product configuration
 * that a fresh install needs, and these are illustrative customers that it does not.
 */
interface DemoCompany {
  slug: string;
  name: string;
  legalName: string;
  admin: { email: string; displayName: string };
  planCode: string;
  seatsLicensed: number;
  seatsToCreate: number;
  billingState: 'Current' | 'Grace' | 'Overdue';
  usagePercent: number;
  /** Negative for a renewal already past, which is what the Overdue company demonstrates. */
  renewsInDays: number;
  pinnedFlag: 'None' | 'Billing' | 'Budget' | 'Security' | 'Seats' | 'Renewal';
  suspend?: boolean;
}

const DEMO_COMPANIES: DemoCompany[] = [
  {
    slug: 'spm-medicare',
    name: 'SPM Medicare',
    legalName: 'SPM Medicare Private Limited',
    admin: { email: 'priya.nair@spm.example', displayName: 'Priya Nair' },
    planCode: 'enterprise',
    seatsLicensed: 60,
    seatsToCreate: 5,
    billingState: 'Current',
    usagePercent: 68,
    renewsInDays: 190,
    pinnedFlag: 'None',
  },
  {
    slug: 'aster-devices',
    name: 'Aster Devices Pvt Ltd',
    legalName: 'Aster Devices Private Limited',
    admin: { email: 'admin@aster.example', displayName: 'Rahul Menon' },
    planCode: 'growth',
    seatsLicensed: 25,
    seatsToCreate: 3,
    billingState: 'Current',
    usagePercent: 44,
    renewsInDays: 75,
    pinnedFlag: 'None',
  },
  {
    // The reference's Budget-flagged company: 91% of its allowance consumed and in grace. It is
    // here so the dashboard's attention panel has a row that is flagged for a *derived* reason
    // rather than a pinned one.
    slug: 'nordic-medtech',
    name: 'Nordic MedTech AB',
    legalName: 'Nordic MedTech AB',
    admin: { email: 'admin@nordic.example', displayName: 'Elin Sandberg' },
    planCode: 'enterprise',
    seatsLicensed: 120,
    seatsToCreate: 4,
    billingState: 'Grace',
    usagePercent: 91,
    renewsInDays: 20,
    pinnedFlag: 'None',
  },
  {
    // Suspended and overdue. Exercises the lifecycle path as well as the billing flag.
    slug: 'krishna-surgicals',
    name: 'Krishna Surgicals',
    legalName: 'Krishna Surgicals LLP',
    admin: { email: 'admin@krishna.example', displayName: 'Anand Rao' },
    planCode: 'starter',
    seatsLicensed: 10,
    seatsToCreate: 2,
    billingState: 'Overdue',
    usagePercent: 0,
    renewsInDays: -12,
    pinnedFlag: 'None',
    suspend: true,
  },
  {
    // Pinned as a Security matter by hand, which is the one case where the derivation is
    // deliberately overridden — so the "pinned beats derived" rule has a row behind it.
    slug: 'vitalis-care',
    name: 'Vitalis Care Systems',
    legalName: 'Vitalis Care Systems Ltd',
    admin: { email: 'admin@vitalis.example', displayName: 'Meera Iyer' },
    planCode: 'growth',
    seatsLicensed: 40,
    seatsToCreate: 3,
    billingState: 'Current',
    usagePercent: 57,
    renewsInDays: 140,
    pinnedFlag: 'Security',
  },
];

/**
 * Seeded platform service alerts.
 *
 * A real table with illustrative rows. The API reports these as `demo` provenance, because the
 * health checks that would write them are the System Health module's work — an alert here means
 * "somebody typed this", not "a probe observed it".
 */
interface DemoServiceAlert {
  service: string;
  severity: 'Info' | 'Warning' | 'Critical';
  summary: string;
  detail: string | null;
}

const DEMO_SERVICE_ALERTS: DemoServiceAlert[] = [
  {
    service: 'model-gateway',
    severity: 'Warning',
    summary: 'Two provider fallbacks in the last hour on the secondary route.',
    detail: 'Primary provider returned 429s; traffic shifted to the secondary pool automatically.',
  },
  {
    service: 'scheduler',
    severity: 'Info',
    summary: 'Queue depth briefly above the normal band, recovered without intervention.',
    detail: null,
  },
];

const DEMO_TENANT_MEMBER = {
  email: 'company.admin@demo-company.example',
  displayName: 'Demo Company Admin',
};

async function main(): Promise<void> {
  const prisma = new PrismaService();
  const tenants = new TenantRepository(prisma);
  const users = new UserRepository(prisma);
  const memberships = new TenantMembershipRepository(prisma);
  // The chained writer, not the read-only repository: a seeded row that could not be verified
  // would show up as an unchained row forever (ADR-046).
  const auditTrail = new AuditTrailRepository(prisma);
  const auditEvents = new AuditEventService(prisma, auditTrail);
  const provisioning = new TenantProvisioningService(
    prisma,
    tenants,
    users,
    memberships,
    auditEvents,
  );

  try {
    // ---- Demo Platform Admin (platform plane, belongs to no company) ----
    // Wrapped in a platform operation because it writes `audit_events`, which is under
    // Row-Level Security: a path that declares no scope reads and writes nothing.
    const platformAdmin = await prisma.runAsPlatformOperation(async () => {
      const existingAdmin = await users.findByEmailForPlatform(DEMO_PLATFORM_ADMIN.email);
      if (existingAdmin) {
        console.log(`Demo Platform Admin already present (${existingAdmin.ubossUniqueId})`);
        return existingAdmin;
      }

      const created = await users.createForPlatform({
        ubossUniqueId: DEMO_PLATFORM_ADMIN.ubossUniqueId,
        email: DEMO_PLATFORM_ADMIN.email,
        displayName: DEMO_PLATFORM_ADMIN.displayName,
        isPlatformActor: true,
      });
      await auditTrail.appendAuditEvent({
        tenantId: null,
        action: 'user.created',
        resourceType: 'user',
        resourceId: created.id,
        summary: 'Seeded the demo Platform Admin.',
        metadata: { seed: true },
      });
      console.log(`Created demo Platform Admin ${created.ubossUniqueId}`);
      return created;
    });

    // ---- Demo company with its first member ----
    const existingTenant = await tenants.findBySlugForPlatform(DEMO_TENANT.slug);
    let demoTenantId: string;

    if (existingTenant) {
      console.log(`Demo company already present (${existingTenant.slug})`);
      demoTenantId = existingTenant.id;
    } else {
      const result = await provisioning.provision({
        slug: DEMO_TENANT.slug,
        name: DEMO_TENANT.name,
        legalName: DEMO_TENANT.legalName,
        firstMember: DEMO_TENANT_MEMBER,
        actorUserId: platformAdmin.id,
      });
      demoTenantId = result.tenant.id;
      console.log(
        `Provisioned ${result.tenant.name} (${result.tenant.slug}) ` +
          `with first member ${result.user.displayName} (${result.user.ubossUniqueId})`,
      );
    }

    // New companies correctly start at `Provisioning`, which blocks workspace access. The demo
    // company is meant to be usable, so activate it explicitly — the same transition the Master
    // Console performs, rather than a special case in the schema default.
    await prisma.runAsPlatformOperation(async () => {
      const tenant = await tenants.findBySlugForPlatform(DEMO_TENANT.slug);
      if (!tenant || tenant.lifecycleState === 'Active') {
        return;
      }

      const changed = await tenants.setLifecycleStateForPlatform(
        demoTenantId,
        'Active',
        tenant.version,
      );
      if (changed === 1) {
        await auditTrail.appendAuditEvent({
          tenantId: null,
          action: 'tenant.lifecycle_state_changed',
          resourceType: 'tenant',
          resourceId: demoTenantId,
          actorUserId: platformAdmin.id,
          summary: `Demo company activated (${tenant.lifecycleState} -> Active).`,
          metadata: { from: tenant.lifecycleState, to: 'Active', seed: true },
        });
        console.log('Demo company activated.');
      }
    });

    // -----------------------------------------------------------------------
    // Prompt 9 — the Master Console's demo companies, subscriptions and alerts
    // -----------------------------------------------------------------------
    //
    // Idempotent throughout: a company that already exists is reused rather than duplicated, and
    // a subscription that already exists is updated. `npm run db:seed` twice must not create ten
    // companies.
    await prisma.runAsPlatformOperation(async () => {
      for (const company of DEMO_COMPANIES) {
        const existing = await tenants.findBySlugForPlatform(company.slug);

        let tenantId: string;
        if (existing) {
          tenantId = existing.id;
        } else {
          const result = await provisioning.provision({
            slug: company.slug,
            name: company.name,
            legalName: company.legalName,
            firstMember: { email: company.admin.email, displayName: company.admin.displayName },
            actorUserId: platformAdmin.id,
          });
          tenantId = result.tenant.id;

          // Extra members, so the seats column is a real count rather than always 1. Provisioned
          // through the same service the application uses, which also means each one writes its
          // own audit row into the company's trail.
          for (let index = 1; index < company.seatsToCreate; index += 1) {
            await provisioning.addMember(
              tenantId,
              {
                email: `member${index}@${company.slug}.example`,
                displayName: `${company.name} Member ${index}`,
              },
              platformAdmin.id,
            );
          }
        }

        const fresh = await tenants.findBySlugForPlatform(company.slug);
        const targetState = company.suspend ? 'Suspended' : 'Active';
        if (fresh && fresh.lifecycleState !== targetState) {
          await tenants.setLifecycleStateForPlatform(tenantId, targetState, fresh.version);
        }

        // Activate the memberships, or every company would show zero seats used — an account
        // still at `NotInvited` is not a used seat, which is correct and unhelpful in a demo.
        await prisma.client.tenantMembership.updateMany({
          where: { tenantId },
          data: { accountState: 'Active' },
        });

        const plan = await prisma.client.plan.findUnique({ where: { code: company.planCode } });
        if (!plan) {
          throw new Error(
            `Plan "${company.planCode}" is missing. It is seeded by the Prompt 9 migration, so ` +
              'this means the migration chain has not been applied.',
          );
        }

        const allowance = plan.aiAllowanceMinor ?? 400_000;
        const consumed = Math.round((allowance * company.usagePercent) / 100);
        const renewsAt = new Date(Date.now() + company.renewsInDays * 86_400_000);

        const existingSubscription = await prisma.client.tenantSubscription.findUnique({
          where: { tenantId },
        });
        const subscriptionData = {
          state: (company.suspend ? 'Suspended' : 'Active') as 'Suspended' | 'Active',
          billingState: company.billingState,
          seatsLicensed: company.seatsLicensed,
          renewsAt,
          aiAllowanceMinor: allowance,
          aiConsumedMinor: consumed,
          currency: plan.currency,
          pinnedFlag: company.pinnedFlag,
          notes: 'Seeded demo company. Values taken from the client UI reference.',
        };

        if (existingSubscription) {
          await prisma.client.tenantSubscription.update({
            where: { id: existingSubscription.id },
            data: { ...subscriptionData, plan: { connect: { id: plan.id } } },
          });
        } else {
          await prisma.client.tenantSubscription.create({
            data: {
              ...subscriptionData,
              tenant: { connect: { id: tenantId } },
              plan: { connect: { id: plan.id } },
            },
          });
        }
      }

      // ---- Departments for the demo companies (Prompt 12) ----
      //
      // Illustrative data belongs in the seed, not in a migration. The Prompt 12 migration
      // backfilled a `General` department for companies that existed when it ran, and the
      // Create Company wizard creates one for every new company — but `provision()` above is the
      // *narrow* primitive, which deliberately creates nothing beyond the tenant, the person and
      // the membership. So the demo companies need theirs here, or Add Employee has no
      // department to select and the Hierarchy screen is a dead end in the one environment where
      // it is easiest to try.
      //
      // Names taken from the client's approved UI reference, so the department colours in the org
      // chart are the reference's own rather than derived.
      for (const company of DEMO_COMPANIES) {
        const tenant = await prisma.client.tenant.findUnique({ where: { slug: company.slug } });
        if (!tenant) {
          continue;
        }

        const existing = await prisma.client.department.count({ where: { tenantId: tenant.id } });
        if (existing > 0) {
          continue;
        }

        for (const [index, name] of [
          'Executive',
          'Regulatory Affairs',
          'Exports & Tenders',
          'Quality Assurance',
          'Production',
        ].entries()) {
          await prisma.client.department.create({
            data: {
              tenantId: tenant.id,
              name,
              code: name.slice(0, 3).toUpperCase(),
              sortOrder: (index + 1) * 10,
              description: 'Seeded demo department. Rename or replace with your own structure.',
            },
          });
        }
      }

      for (const alert of DEMO_SERVICE_ALERTS) {
        const already = await prisma.client.serviceAlert.findFirst({
          where: { service: alert.service, summary: alert.summary },
        });
        if (!already) {
          await prisma.client.serviceAlert.create({
            data: {
              service: alert.service,
              severity: alert.severity,
              summary: alert.summary,
              detail: alert.detail,
            },
          });
        }
      }
    });

    // The demo platform admin keeps the `PlatformAdmin` role the migration backfilled. It is NOT
    // upgraded to `PlatformOwner` here, deliberately: a seed that hands out platform ownership
    // would make the Owner-only guards untested in the one environment where they are easiest to
    // exercise. Grant it by hand to try the Owner-only screens — the seed prints how.
    const platformRoles = await prisma.runAsPlatformOperation(() =>
      prisma.client.platformRoleAssignment.findMany({
        where: { userId: platformAdmin.id, revokedAt: null },
        select: { role: true },
      }),
    );
    console.log(
      `Demo platform actor ${DEMO_PLATFORM_ADMIN.ubossUniqueId} holds: ` +
        `${platformRoles.map((row) => row.role).join(', ') || '(no platform role)'}.`,
    );
    if (!platformRoles.some((row) => row.role === 'PlatformOwner')) {
      console.log(
        'It deliberately has no PlatformOwner role, so the Owner-only guards (Platform ' +
          'Settings, Release & Feature Control, granting platform roles) refuse it. To try ' +
          'those screens, insert a PlatformOwner assignment by hand.',
      );
    }

    console.log(
      `Seed complete: ${await tenants.countForPlatform()} tenant(s), ` +
        `${await users.countForPlatform()} user(s). No credentials were seeded.`,
    );
  } finally {
    await prisma.unsafeRootClient.$disconnect();
  }
}

main().catch((error: unknown) => {
  console.error('Seed failed:', error);
  process.exitCode = 1;
});
