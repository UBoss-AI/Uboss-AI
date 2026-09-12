import assert from 'node:assert/strict';
import { after, before, beforeEach, describe, it } from 'node:test';

import {
  tenantScopeForPlatformOperation,
  type TenantScope,
} from '../src/persistence/tenant-context.js';
import {
  activateTenant,
  closeTestContext,
  createTestContext,
  isTestDatabaseReachable,
  reachabilityFailureReason,
  migrateTestDatabase,
  resetTestDatabase,
  type TestContext,
} from './support/test-database.js';

/**
 * Tenant isolation integration tests.
 *
 * These prove the claim that matters most in a multi-tenant product: **a caller scoped to
 * Tenant A cannot read or modify Tenant B's rows, even when supplying a real, valid id from
 * Tenant B.** Guessing a UUID must get you nothing.
 *
 * Since Prompt 4 the suite runs as the unprivileged `uboss_app` role, so **both** layers are
 * exercised at once: the repository's `where tenant_id` clause and the PostgreSQL Row-Level
 * Security policy. The dedicated `rls-defence-in-depth` block below then removes the first
 * layer deliberately, to prove the second one alone still holds.
 */
describe('tenant isolation (integration)', () => {
  let ctx: TestContext;

  let tenantA: { id: string; membershipId: string; userId: string };
  let tenantB: { id: string; membershipId: string; userId: string };

  /** Run repository work inside a tenant scope, exactly as a guarded request would. */
  const asTenant = async <T>(tenantId: string, work: (scope: TenantScope) => Promise<T>) => {
    const scope = tenantScopeForPlatformOperation(tenantId);
    return ctx.prisma.runInTenantTransaction(scope, () => work(scope));
  };

  before(async () => {
    ctx = createTestContext();

    if (!(await isTestDatabaseReachable(ctx))) {
      throw new Error(
        `The test database is not reachable: ${reachabilityFailureReason()}\n` +
          'Start it with:\n' +
          '  docker compose -f infra/docker-compose.yml up -d\n' +
          'Then re-run the tests.',
      );
    }

    migrateTestDatabase();
  });

  after(async () => {
    await closeTestContext(ctx);
  });

  beforeEach(async () => {
    await resetTestDatabase(ctx);

    const a = await ctx.provisioning.provision({
      slug: 'tenant-a',
      name: 'Tenant A Devices',
      firstMember: { email: 'admin@tenant-a.example', displayName: 'Tenant A Admin' },
    });
    const b = await ctx.provisioning.provision({
      slug: 'tenant-b',
      name: 'Tenant B Diagnostics',
      firstMember: { email: 'admin@tenant-b.example', displayName: 'Tenant B Admin' },
    });

    await activateTenant(ctx, a.tenant.id);
    await activateTenant(ctx, b.tenant.id);

    tenantA = { id: a.tenant.id, membershipId: a.membership.id, userId: a.user.id };
    tenantB = { id: b.tenant.id, membershipId: b.membership.id, userId: b.user.id };
  });

  describe('memberships', () => {
    it('finds its own membership', async () => {
      const found = await asTenant(tenantA.id, (scope) =>
        ctx.memberships.findById(scope, tenantA.membershipId),
      );

      assert.ok(found);
      assert.equal(found.tenantId, tenantA.id);
    });

    it("returns null for another tenant's membership id", async () => {
      // Tenant A supplies a real, valid membership id — but it belongs to Tenant B.
      const found = await asTenant(tenantA.id, (scope) =>
        ctx.memberships.findById(scope, tenantB.membershipId),
      );

      assert.equal(found, null, "Tenant A must not be able to read Tenant B's membership");
    });

    it("returns null when looking up another tenant's user", async () => {
      const found = await asTenant(tenantA.id, (scope) =>
        ctx.memberships.findByUserId(scope, tenantB.userId),
      );

      assert.equal(found, null);
    });

    it('lists and counts only its own memberships', async () => {
      await ctx.provisioning.addMember(tenantA.id, {
        email: 'second@tenant-a.example',
        displayName: 'Tenant A Second',
      });

      const listA = await asTenant(tenantA.id, (scope) => ctx.memberships.listForTenant(scope));
      const listB = await asTenant(tenantB.id, (scope) => ctx.memberships.listForTenant(scope));

      assert.equal(listA.length, 2);
      assert.equal(listB.length, 1);
      assert.ok(listA.every((row) => row.tenantId === tenantA.id));
      assert.ok(listB.every((row) => row.tenantId === tenantB.id));
    });

    it("cannot delete another tenant's membership", async () => {
      const deleted = await asTenant(tenantA.id, (scope) =>
        ctx.memberships.deleteById(scope, tenantB.membershipId),
      );

      assert.equal(deleted, 0, 'the cross-tenant delete must affect no rows');

      const stillThere = await asTenant(tenantB.id, (scope) =>
        ctx.memberships.findById(scope, tenantB.membershipId),
      );
      assert.ok(stillThere, "Tenant B's membership must survive Tenant A's delete attempt");
    });

    it('can delete its own membership', async () => {
      const deleted = await asTenant(tenantA.id, (scope) =>
        ctx.memberships.deleteById(scope, tenantA.membershipId),
      );

      assert.equal(deleted, 1);
      assert.equal(
        await asTenant(tenantA.id, (scope) =>
          ctx.memberships.findById(scope, tenantA.membershipId),
        ),
        null,
      );
    });

    it("cannot bump the row version of another tenant's membership", async () => {
      const before = await asTenant(tenantB.id, (scope) =>
        ctx.memberships.findById(scope, tenantB.membershipId),
      );
      assert.ok(before);

      const updated = await asTenant(tenantA.id, (scope) =>
        ctx.memberships.touch(scope, tenantB.membershipId, before.version),
      );

      assert.equal(updated, 0);
      const after = await asTenant(tenantB.id, (scope) =>
        ctx.memberships.findById(scope, tenantB.membershipId),
      );
      assert.equal(after?.version, before.version, 'the row must be untouched');
    });
  });

  describe('rls defence-in-depth (application scoping removed on purpose)', () => {
    it('returns zero rows when no scope is declared — RLS fails closed', async () => {
      // No runInTenantTransaction, no runAsPlatformOperation. A code path that forgets to
      // declare its scope must read nothing rather than everything.
      const rows = await ctx.prisma.client.$queryRawUnsafe<{ count: bigint }[]>(
        'SELECT count(*)::bigint AS count FROM tenant_memberships',
      );

      assert.equal(Number(rows[0]?.count ?? -1), 0);
    });

    it('hides other tenants even from raw SQL with no WHERE clause', async () => {
      const rows = await ctx.prisma.runInTenantTransaction(
        tenantScopeForPlatformOperation(tenantA.id),
        () =>
          ctx.prisma.client.$queryRawUnsafe<{ tenant_id: string }[]>(
            'SELECT tenant_id FROM tenant_memberships',
          ),
      );

      // This is the bug RLS exists to catch: a query that forgot its tenant filter.
      assert.equal(rows.length, 1);
      assert.equal(rows[0]?.tenant_id, tenantA.id);
    });

    it("hides another tenant's row even when selected explicitly by primary key", async () => {
      const rows = await ctx.prisma.runInTenantTransaction(
        tenantScopeForPlatformOperation(tenantA.id),
        () =>
          ctx.prisma.client.$queryRawUnsafe<{ id: string }[]>(
            `SELECT id FROM tenant_memberships WHERE id = '${tenantB.membershipId}'`,
          ),
      );

      assert.equal(rows.length, 0);
    });

    it('blocks an INSERT that would plant a row in another tenant', async () => {
      // WITH CHECK must reject a write whose tenant_id is not the declared scope, so a
      // compromised or buggy write path cannot inject rows into someone else's company.
      await assert.rejects(() =>
        ctx.prisma.runInTenantTransaction(tenantScopeForPlatformOperation(tenantA.id), () =>
          ctx.prisma.client.auditEvent.create({
            data: {
              tenantId: tenantB.id,
              action: 'malicious.cross_tenant_write',
              resourceType: 'tenant',
            },
          }),
        ),
      );
    });

    it('refuses to nest a different tenant scope inside an open one', async () => {
      await assert.rejects(
        () =>
          ctx.prisma.runInTenantTransaction(tenantScopeForPlatformOperation(tenantA.id), () =>
            ctx.prisma.runInTenantTransaction(
              tenantScopeForPlatformOperation(tenantB.id),
              async () => 'should not happen',
            ),
          ),
        /Refusing to nest a tenant transaction/,
      );
    });

    it('refuses to escalate a tenant scope into a platform operation', async () => {
      await assert.rejects(
        () =>
          ctx.prisma.runInTenantTransaction(tenantScopeForPlatformOperation(tenantA.id), () =>
            ctx.prisma.runAsPlatformOperation(async () => 'should not happen'),
          ),
        /Refusing to escalate a tenant-scoped transaction/,
      );
    });

    it('lets a declared platform operation cross tenants, as provisioning must', async () => {
      const count = await ctx.prisma.runAsPlatformOperation(() =>
        ctx.prisma.client.tenantMembership.count(),
      );

      assert.equal(count, 2);
    });
  });

  describe('optimistic concurrency (row_version)', () => {
    it('applies an update when the expected version matches', async () => {
      const membership = await asTenant(tenantA.id, (scope) =>
        ctx.memberships.findById(scope, tenantA.membershipId),
      );
      assert.ok(membership);

      const updated = await asTenant(tenantA.id, (scope) =>
        ctx.memberships.touch(scope, tenantA.membershipId, membership.version),
      );

      assert.equal(updated, 1);
      const after = await asTenant(tenantA.id, (scope) =>
        ctx.memberships.findById(scope, tenantA.membershipId),
      );
      assert.equal(after?.version, membership.version + 1);
    });

    it('rejects a stale write rather than silently overwriting a concurrent one', async () => {
      const membership = await asTenant(tenantA.id, (scope) =>
        ctx.memberships.findById(scope, tenantA.membershipId),
      );
      assert.ok(membership);
      const staleVersion = membership.version;

      assert.equal(
        await asTenant(tenantA.id, (scope) =>
          ctx.memberships.touch(scope, tenantA.membershipId, staleVersion),
        ),
        1,
      );
      assert.equal(
        await asTenant(tenantA.id, (scope) =>
          ctx.memberships.touch(scope, tenantA.membershipId, staleVersion),
        ),
        0,
      );
    });

    it('guards a tenant rename with the expected version', async () => {
      const tenant = await asTenant(tenantA.id, (scope) => ctx.tenants.findInScope(scope));
      assert.ok(tenant);

      assert.equal(
        await asTenant(tenantA.id, (scope) =>
          ctx.tenants.rename(scope, 'Tenant A Renamed', tenant.version),
        ),
        1,
      );
      assert.equal(
        await asTenant(tenantA.id, (scope) =>
          ctx.tenants.rename(scope, 'Tenant A Again', tenant.version),
        ),
        0,
      );

      const after = await asTenant(tenantA.id, (scope) => ctx.tenants.findInScope(scope));
      assert.equal(after?.name, 'Tenant A Renamed');
    });
  });

  describe('users reached through membership', () => {
    it('finds a person who is a member of the tenant', async () => {
      const found = await asTenant(tenantA.id, (scope) =>
        ctx.users.findInTenant(scope, tenantA.userId),
      );

      assert.ok(found);
      assert.equal(found.id, tenantA.userId);
    });

    it('returns null for a person who is only a member of another tenant', async () => {
      const found = await asTenant(tenantA.id, (scope) =>
        ctx.users.findInTenant(scope, tenantB.userId),
      );

      assert.equal(found, null, "Tenant A must not read Tenant B's people");
    });

    it('lists only its own people', async () => {
      const peopleA = await asTenant(tenantA.id, (scope) => ctx.users.listInTenant(scope));
      const peopleB = await asTenant(tenantB.id, (scope) => ctx.users.listInTenant(scope));

      assert.deepEqual(
        peopleA.map((person) => person.email),
        ['admin@tenant-a.example'],
      );
      assert.deepEqual(
        peopleB.map((person) => person.email),
        ['admin@tenant-b.example'],
      );
    });

    it('shows a person shared across companies to both, without merging the companies', async () => {
      const shared = { email: 'consultant@example.example', displayName: 'Shared Consultant' };
      const inA = await ctx.provisioning.addMember(tenantA.id, shared);
      const inB = await ctx.provisioning.addMember(tenantB.id, shared);

      assert.equal(inA.user.id, inB.user.id, 'the same person must not be duplicated');
      assert.equal(inA.user.ubossUniqueId, inB.user.ubossUniqueId);

      const peopleA = await asTenant(tenantA.id, (scope) => ctx.users.listInTenant(scope));

      assert.equal(peopleA.length, 2);
      assert.ok(peopleA.some((person) => person.email === shared.email));
      assert.ok(!peopleA.some((person) => person.email === 'admin@tenant-b.example'));

      const tenantIds = await ctx.prisma.runAsPlatformOperation(() =>
        ctx.memberships.listTenantIdsForUser(inA.user.id),
      );
      assert.equal(tenantIds.length, 2);
    });
  });

  describe('tenants', () => {
    it('reads only the tenant it is scoped to', async () => {
      const tenant = await asTenant(tenantA.id, (scope) => ctx.tenants.findInScope(scope));

      assert.equal(tenant?.slug, 'tenant-a');
    });

    it('enforces a unique slug across the platform', async () => {
      await assert.rejects(
        () =>
          ctx.provisioning.provision({
            slug: 'tenant-a',
            name: 'Duplicate Slug Co',
            firstMember: { email: 'dupe@example.example', displayName: 'Dupe' },
          }),
        /Unique constraint|unique/i,
      );
    });

    it('starts a newly provisioned company in Provisioning, not Active', async () => {
      const fresh = await ctx.provisioning.provision({
        slug: 'tenant-fresh',
        name: 'Fresh Co',
        firstMember: { email: 'admin@fresh.example', displayName: 'Fresh Admin' },
      });

      assert.equal(
        fresh.tenant.lifecycleState,
        'Provisioning',
        'a company must not be usable before it is activated',
      );
    });

    it('activates a company through the version-guarded lifecycle transition', async () => {
      // This is the transition the Master Console performs, and the one the seed uses to make
      // the demo company usable.
      const fresh = await ctx.provisioning.provision({
        slug: 'tenant-activate',
        name: 'Activate Co',
        firstMember: { email: 'admin@activate.example', displayName: 'Activate Admin' },
      });

      const changed = await ctx.prisma.runAsPlatformOperation(() =>
        ctx.tenants.setLifecycleStateForPlatform(fresh.tenant.id, 'Active', fresh.tenant.version),
      );
      assert.equal(changed, 1);

      const after = await asTenant(fresh.tenant.id, (scope) => ctx.tenants.findInScope(scope));
      assert.equal(after?.lifecycleState, 'Active');
      assert.equal(after?.version, fresh.tenant.version + 1);

      // A second operator holding the stale version must not silently overwrite the first.
      assert.equal(
        await ctx.prisma.runAsPlatformOperation(() =>
          ctx.tenants.setLifecycleStateForPlatform(
            fresh.tenant.id,
            'Suspended',
            fresh.tenant.version,
          ),
        ),
        0,
      );

      const unchanged = await asTenant(fresh.tenant.id, (scope) => ctx.tenants.findInScope(scope));
      assert.equal(unchanged?.lifecycleState, 'Active');
    });

    it('supports every lifecycle state the product defines', async () => {
      const fresh = await ctx.provisioning.provision({
        slug: 'tenant-states',
        name: 'States Co',
        firstMember: { email: 'admin@states.example', displayName: 'States Admin' },
      });

      const states = [
        'PendingActivation',
        'Active',
        'ReadOnly',
        'Suspended',
        'Closed',
        'Provisioning',
      ] as const;

      let version = fresh.tenant.version;
      for (const state of states) {
        const changed = await ctx.prisma.runAsPlatformOperation(() =>
          ctx.tenants.setLifecycleStateForPlatform(fresh.tenant.id, state, version),
        );
        assert.equal(changed, 1, `transition to ${state} must apply`);
        version += 1;

        const current = await asTenant(fresh.tenant.id, (scope) => ctx.tenants.findInScope(scope));
        assert.equal(current?.lifecycleState, state);
      }
    });
  });

  describe('audit events', () => {
    it('records provisioning as a platform event and membership as a tenant event', async () => {
      const tenantTrail = await asTenant(tenantA.id, (scope) =>
        ctx.auditEvents.listForTenant(scope),
      );

      assert.ok(tenantTrail.some((event) => event.action === 'tenant_membership.created'));
      assert.ok(!tenantTrail.some((event) => event.action === 'tenant.provisioned'));
    });

    it("does not expose another tenant's audit trail", async () => {
      const trailA = await asTenant(tenantA.id, (scope) => ctx.auditEvents.listForTenant(scope));
      const trailB = await asTenant(tenantB.id, (scope) => ctx.auditEvents.listForTenant(scope));

      assert.ok(trailA.every((event) => event.tenantId === tenantA.id));
      assert.ok(trailB.every((event) => event.tenantId === tenantB.id));

      const someEventFromB = trailB[0];
      assert.ok(someEventFromB);
      assert.equal(
        await asTenant(tenantA.id, (scope) => ctx.auditEvents.findById(scope, someEventFromB.id)),
        null,
      );
    });

    it('counts only its own events', async () => {
      assert.equal(await asTenant(tenantA.id, (scope) => ctx.auditEvents.countForTenant(scope)), 1);

      await ctx.provisioning.addMember(tenantA.id, {
        email: 'another@tenant-a.example',
        displayName: 'Another',
      });

      assert.equal(await asTenant(tenantA.id, (scope) => ctx.auditEvents.countForTenant(scope)), 2);
      assert.equal(await asTenant(tenantB.id, (scope) => ctx.auditEvents.countForTenant(scope)), 1);
    });

    it('keeps platform-plane events out of every tenant trail', async () => {
      // A `tenant.provisioned` event has tenant_id NULL, so it must be invisible inside any
      // tenant session and visible only during a platform operation.
      const platformEvents = await ctx.prisma.runAsPlatformOperation(() =>
        ctx.prisma.client.auditEvent.count({ where: { tenantId: null } }),
      );
      assert.ok(platformEvents >= 2);

      const inTenantSession = await ctx.prisma.runInTenantTransaction(
        tenantScopeForPlatformOperation(tenantA.id),
        () => ctx.prisma.client.auditEvent.count(),
      );
      assert.equal(inTenantSession, 1, 'only this tenant’s own event is visible');
    });
  });

  describe('transaction convention', () => {
    it('rolls back every write when a later step fails', async () => {
      const tenantsBefore = await ctx.prisma.runAsPlatformOperation(() =>
        ctx.tenants.countForPlatform(),
      );
      const usersBefore = await ctx.prisma.runAsPlatformOperation(() =>
        ctx.users.countForPlatform(),
      );

      await assert.rejects(() =>
        ctx.provisioning.provision({
          slug: 'tenant-a',
          name: 'Will Fail',
          firstMember: { email: 'rollback@example.example', displayName: 'Rollback Probe' },
        }),
      );

      assert.equal(
        await ctx.prisma.runAsPlatformOperation(() => ctx.tenants.countForPlatform()),
        tenantsBefore,
      );
      assert.equal(
        await ctx.prisma.runAsPlatformOperation(() => ctx.users.countForPlatform()),
        usersBefore,
      );
      assert.equal(
        await ctx.prisma.runAsPlatformOperation(() =>
          ctx.users.findByEmailForPlatform('rollback@example.example'),
        ),
        null,
        'a failed provisioning must not leave a person behind',
      );
    });

    it('commits multi-table writes together', async () => {
      const result = await ctx.provisioning.provision({
        slug: 'tenant-c',
        name: 'Tenant C Labs',
        firstMember: { email: 'admin@tenant-c.example', displayName: 'Tenant C Admin' },
      });
      await activateTenant(ctx, result.tenant.id);

      assert.ok(await asTenant(result.tenant.id, (scope) => ctx.tenants.findInScope(scope)));
      assert.ok(
        await asTenant(result.tenant.id, (scope) => ctx.users.findInTenant(scope, result.user.id)),
      );
      assert.ok(
        await asTenant(result.tenant.id, (scope) =>
          ctx.memberships.findById(scope, result.membership.id),
        ),
      );
      assert.equal(
        await asTenant(result.tenant.id, (scope) => ctx.auditEvents.countForTenant(scope)),
        1,
      );
    });

    it('joins an outer transaction instead of opening a nested one', async () => {
      let sawTransaction = false;

      await ctx.prisma.runInTransaction(async () => {
        assert.equal(ctx.prisma.inTransaction, true);
        await ctx.prisma.runInTransaction(async () => {
          sawTransaction = ctx.prisma.inTransaction;
        });
      });

      assert.equal(sawTransaction, true);
      assert.equal(ctx.prisma.inTransaction, false, 'the store must not leak after the call');
    });

    it('reports the declared RLS scope, and clears it afterwards', async () => {
      assert.equal(ctx.prisma.declaredScope, undefined);

      await ctx.prisma.runInTenantTransaction(
        tenantScopeForPlatformOperation(tenantA.id),
        async () => {
          assert.deepEqual(ctx.prisma.declaredScope, { kind: 'tenant', tenantId: tenantA.id });
        },
      );

      await ctx.prisma.runAsPlatformOperation(async () => {
        assert.deepEqual(ctx.prisma.declaredScope, { kind: 'platform' });
      });

      assert.equal(ctx.prisma.declaredScope, undefined, 'the scope must not leak after the call');
    });
  });

  describe('identity rules', () => {
    it('assigns every person a permanent UBoss Unique ID', async () => {
      const user = await ctx.prisma.runAsPlatformOperation(() =>
        ctx.users.findByEmailForPlatform('admin@tenant-a.example'),
      );

      assert.ok(user);
      assert.match(user.ubossUniqueId, /^UB-[A-Z2-9]{4}-[A-Z2-9]{4}$/);
    });

    it('keys identity on the UUID, not the email', async () => {
      const user = await ctx.prisma.runAsPlatformOperation(() =>
        ctx.users.findByEmailForPlatform('admin@tenant-a.example'),
      );
      assert.ok(user);

      await ctx.admin.unsafeRootClient.user.update({
        where: { id: user.id },
        data: { email: 'renamed@tenant-a.example' },
      });

      const reloaded = await ctx.prisma.runAsPlatformOperation(() =>
        ctx.users.findByUbossUniqueIdForPlatform(user.ubossUniqueId),
      );
      assert.equal(reloaded?.id, user.id);
    });

    it('enforces a unique email and a unique UBoss Unique ID', async () => {
      await assert.rejects(
        () =>
          ctx.prisma.runAsPlatformOperation(() =>
            ctx.users.createForPlatform({
              ubossUniqueId: 'UB-TEST-0001',
              email: 'admin@tenant-a.example',
              displayName: 'Duplicate Email',
            }),
          ),
        /Unique constraint|unique/i,
      );

      const existing = await ctx.prisma.runAsPlatformOperation(() =>
        ctx.users.findByEmailForPlatform('admin@tenant-a.example'),
      );
      assert.ok(existing);
      await assert.rejects(
        () =>
          ctx.prisma.runAsPlatformOperation(() =>
            ctx.users.createForPlatform({
              ubossUniqueId: existing.ubossUniqueId,
              email: 'fresh@example.example',
              displayName: 'Duplicate UBoss ID',
            }),
          ),
        /Unique constraint|unique/i,
      );
    });

    it('allows one person only one membership per company', async () => {
      await assert.rejects(
        () =>
          asTenant(tenantA.id, (scope) =>
            ctx.memberships.create(scope, { userId: tenantA.userId }),
          ),
        /Unique constraint|unique/i,
      );
    });

    it('refuses to build a tenant scope from a non-UUID', () => {
      // `SET LOCAL` cannot be parameterised, so the scope type is the injection boundary.
      assert.throws(() => tenantScopeForPlatformOperation("' OR 1=1 --"), /must be a UUID/);
    });
  });
});
