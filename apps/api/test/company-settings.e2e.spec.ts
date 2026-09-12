import assert from 'node:assert/strict';
import { after, before, beforeEach, describe, it } from 'node:test';

import { type INestApplication, ValidationPipe } from '@nestjs/common';
import { APP_GUARD, APP_INTERCEPTOR, Reflector } from '@nestjs/core';
import { Test } from '@nestjs/testing';
import cookieParser from 'cookie-parser';
import request from 'supertest';

import {
  SETTING_DEFINITIONS,
  SETTINGS_CATEGORIES,
  settingDefinition,
  validateSetting,
  validateSettingCombination,
} from '@uboss/types';

import { AuditEventService } from '../src/audit/audit-event.service.js';
import { SecurityEventService } from '../src/audit/security-event.service.js';
import { AUTH_CONFIG, loadAuthConfig } from '../src/auth/auth.config.js';
import { SecurityEventPublisher } from '../src/auth/security-event.publisher.js';
import { AuthorizationService } from '../src/authorization/authorization.service.js';
import { PermissionGuard } from '../src/authorization/permission.guard.js';
import { AuditEventRepository } from '../src/persistence/audit-event.repository.js';
import { AuditTrailRepository } from '../src/persistence/audit-trail.repository.js';
import { AuthorizationRepository } from '../src/persistence/authorization.repository.js';
import { PlatformRepository } from '../src/persistence/platform.repository.js';
import { PrismaService } from '../src/persistence/prisma.service.js';
import { tenantScopeForPlatformOperation } from '../src/persistence/tenant-context.js';
import { TenantRepository } from '../src/persistence/tenant.repository.js';
import { UserRepository } from '../src/persistence/user.repository.js';
import { ActorResolver, DevHeaderActorResolver } from '../src/request-context/actor-resolver.js';
import { CorrelationIdMiddleware } from '../src/request-context/correlation-id.middleware.js';
import { CompanySettingsService } from '../src/settings/company-settings.service.js';
import { SettingsController } from '../src/settings/settings.controller.js';
import { RequestActorInterceptor } from '../src/tenancy/request-actor.interceptor.js';
import { TenantContextService } from '../src/tenancy/tenant-context.service.js';
import { TenantGuard, WORKSPACE_HEADER } from '../src/tenancy/tenant.guard.js';
import {
  activateMembership,
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
 * Company Settings: the shell, the typed store and the permission behind every value.
 *
 * Five properties carry this prompt:
 *
 *   1. **The catalogue is closed.** An unknown key is refused rather than stored.
 *   2. **Effective inheritance**: company row → platform default → code default, with the
 *      source on the wire so nobody mistakes a default for a decision.
 *   3. **The backend enforces every setting permission** — per setting, not per screen — and a
 *      mixed payload is refused whole.
 *   4. **Validation is typed**, and cross-setting rules are checked against the effective result.
 *   5. **Material changes need a reason and keep a version history**; the rest do not.
 */
describe('company settings (e2e)', () => {
  let ctx: TestContext;
  let app: INestApplication;

  let tenantId: string;
  let otherTenantId: string;
  let adminId: string;
  let adminUboss: string;
  let employeeId: string;
  let employeeUboss: string;
  let auditorId: string;
  let ownerId: string;

  const agent = () => request(app.getHttpServer());
  const scope = () => tenantScopeForPlatformOperation(tenantId);
  const settings = () => app.get(CompanySettingsService);

  before(async () => {
    ctx = createTestContext();
    if (!(await isTestDatabaseReachable(ctx))) {
      throw new Error(`The test database is not reachable: ${reachabilityFailureReason()}`);
    }
    migrateTestDatabase();

    process.env['AUTH_DEV_HEADERS_ENABLED'] = 'true';
    delete process.env['NODE_ENV'];
    process.env['AUTH_ENCRYPTION_KEYS'] ??=
      `test:${Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString('base64')}`;

    const moduleRef = await Test.createTestingModule({
      controllers: [SettingsController],
      providers: [
        { provide: PrismaService, useValue: ctx.prisma },
        { provide: AUTH_CONFIG, useFactory: loadAuthConfig },
        UserRepository,
        TenantRepository,
        AuditEventRepository,
        AuditTrailRepository,
        AuthorizationRepository,
        PlatformRepository,
        AuditEventService,
        SecurityEventService,
        SecurityEventPublisher,
        AuthorizationService,
        CompanySettingsService,
        TenantContextService,
        Reflector,
        {
          provide: ActorResolver,
          inject: [PrismaService],
          useFactory: (prisma: PrismaService) =>
            new DevHeaderActorResolver(async (ubossUniqueId) =>
              prisma.runAsPlatformOperation(() =>
                prisma.client.user.findUnique({
                  where: { ubossUniqueId },
                  select: { id: true, ubossUniqueId: true, isPlatformActor: true },
                }),
              ),
            ),
        },
        { provide: APP_GUARD, useClass: TenantGuard },
        { provide: APP_GUARD, useClass: PermissionGuard },
        { provide: APP_INTERCEPTOR, useClass: RequestActorInterceptor },
      ],
    }).compile();

    app = moduleRef.createNestApplication();
    const middleware = new CorrelationIdMiddleware();
    app.use(middleware.use.bind(middleware));
    app.use(cookieParser());
    app.useGlobalPipes(
      new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }),
    );
    await app.init();
  });

  after(async () => {
    await app.close();
    await closeTestContext(ctx);
  });

  beforeEach(async () => {
    await resetTestDatabase(ctx);

    const provisioned = await ctx.provisioning.provision({
      slug: 'settings-co',
      name: 'Settings Co',
      firstMember: { email: 'first@settings.example', displayName: 'First' },
    });
    await activateTenant(ctx, provisioned.tenant.id);
    await activateMembership(ctx, provisioned.user.id, provisioned.tenant.id);
    tenantId = provisioned.tenant.id;

    const other = await ctx.provisioning.provision({
      slug: 'other-settings-co',
      name: 'Other Settings Co',
      firstMember: { email: 'first@other-settings.example', displayName: 'Other First' },
    });
    await activateTenant(ctx, other.tenant.id);
    otherTenantId = other.tenant.id;

    const people = await ctx.prisma.runAsPlatformOperation(async () => {
      const member = async (unique: string, name: string) => {
        const user = await ctx.users.createForPlatform({
          ubossUniqueId: unique,
          email: `${unique.toLowerCase()}@settings.example`,
          displayName: name,
        });
        await ctx.prisma.client.tenantMembership.create({
          data: { tenantId: provisioned.tenant.id, userId: user.id, accountState: 'Active' },
        });
        return user;
      };

      return {
        admin: await member('UB-SADM-0001', 'Settings Admin'),
        employee: await member('UB-SEMP-0001', 'Settings Employee'),
        auditor: await member('UB-SAUD-0001', 'Settings Auditor'),
        owner: await ctx.users.createForPlatform({
          ubossUniqueId: 'UB-SOWN-0001',
          email: 'owner@uboss.example',
          displayName: 'Platform Owner',
          isPlatformActor: true,
        }),
      };
    });

    adminId = people.admin.id;
    adminUboss = people.admin.ubossUniqueId;
    employeeId = people.employee.id;
    employeeUboss = people.employee.ubossUniqueId;
    auditorId = people.auditor.id;
    ownerId = people.owner.id;

    await ctx.prisma.runAsPlatformOperation(async () => {
      await ctx.prisma.client.platformRoleAssignment.create({
        data: { userId: ownerId, role: 'PlatformOwner', justification: 'Fixture.' },
      });

      for (const [userId, roleKind, scopeKind] of [
        [adminId, 'CompanyAdmin', 'WholeCompany'],
        [employeeId, 'Employee', 'OwnWork'],
        [auditorId, 'Auditor', 'WholeCompany'],
      ] as const) {
        await ctx.prisma.client.roleAssignment.create({
          data: { tenantId, userId, roleKind, scopeKind, grantedByUserId: ownerId },
        });
      }
    });
  });

  const as = <T extends request.Test>(test: T, uboss: string, workspace = tenantId): T =>
    test.set('x-uboss-dev-actor', uboss).set(WORKSPACE_HEADER, workspace) as T;

  // =========================================================================
  describe('the catalogue', () => {
    it('declares all nineteen categories', () => {
      // Seventeen in the original Prompt 14 list, plus UBoss Profile Search Policy and
      // Performance & Reward Policy from the client's later amendments — which take precedence.
      assert.equal(SETTINGS_CATEGORIES.length, 19);
      assert.ok(SETTINGS_CATEGORIES.includes('uboss'));
      assert.ok(SETTINGS_CATEGORIES.includes('performance'));
    });

    it('gives every setting a category, a default and both permissions', () => {
      for (const definition of SETTING_DEFINITIONS) {
        assert.ok(
          SETTINGS_CATEGORIES.includes(definition.category),
          `${definition.key} has an unknown category`,
        );
        assert.notEqual(definition.defaultValue, undefined, `${definition.key} has no default`);
        assert.ok(definition.writePermission.module, `${definition.key} has no write permission`);
        assert.ok(definition.readPermission.module, `${definition.key} has no read permission`);
        // A default that does not satisfy its own type would be a setting that is invalid the
        // moment it is read.
        const validated = validateSetting(definition, definition.defaultValue);
        assert.equal(validated.ok, true, `${definition.key}'s default fails its own validator`);
      }
    });

    it('uses a dotted lower-snake key that matches the database constraint', () => {
      for (const definition of SETTING_DEFINITIONS) {
        assert.match(definition.key, /^[a-z][a-z0-9_]*\.[a-z][a-z0-9_]*$/, definition.key);
      }
    });

    it('has no duplicate keys', () => {
      const keys = SETTING_DEFINITIONS.map((definition) => definition.key);
      assert.equal(new Set(keys).size, keys.length);
    });

    it('returns undefined for an unknown key rather than a guess', () => {
      assert.equal(settingDefinition('general.not_a_setting'), undefined);
    });
  });

  // =========================================================================
  describe('typed validation', () => {
    it('accepts the string form of a boolean and an integer, and nothing else', () => {
      const boolean = settingDefinition('appearance.reduce_motion')!;
      // A checkbox posts "true"; refusing it would reject every real form submission.
      assert.deepEqual(validateSetting(boolean, 'true'), { ok: true, value: true });
      assert.deepEqual(validateSetting(boolean, false), { ok: true, value: false });
      assert.equal(validateSetting(boolean, 'yes').ok, false);

      const integer = settingDefinition('notifications.approval_reminder_hours')!;
      assert.deepEqual(validateSetting(integer, '24'), { ok: true, value: 24 });
      assert.equal(validateSetting(integer, '24.5').ok, false);
      assert.equal(validateSetting(integer, '-1').ok, false);
      assert.equal(validateSetting(integer, '9999').ok, false);
    });

    it('refuses a value outside an enum, naming the options', () => {
      const digest = settingDefinition('notifications.digest')!;
      const result = validateSetting(digest, 'Hourly');
      assert.equal(result.ok, false);
      assert.match(result.ok === false ? result.reason : '', /Off, Daily, Weekly/);
    });

    it('enforces a pattern where one is declared', () => {
      const colour = settingDefinition('appearance.accent_colour')!;
      assert.equal(validateSetting(colour, '#2563EB').ok, true);
      assert.equal(validateSetting(colour, 'blue').ok, false);
    });

    it('checks rules that exist only between settings', () => {
      // Escalating before reminding surprises both people. A per-field validator cannot see it.
      const problems = validateSettingCombination({
        'notifications.approval_reminder_hours': 48,
        'notifications.escalate_after_hours': 24,
      });
      assert.equal(problems.length, 1);
      assert.match(problems[0] as string, /before the reminder/i);

      assert.equal(
        validateSettingCombination({
          'notifications.approval_reminder_hours': 24,
          'notifications.escalate_after_hours': 72,
        }).length,
        0,
      );
    });
  });

  // =========================================================================
  describe('effective inheritance', () => {
    it('falls back to the code default and says so', async () => {
      const view = await settings().viewFor(scope(), adminId);
      const digest = view.categories
        .flatMap((category) => category.settings)
        .find((setting) => setting.key === 'notifications.digest');

      assert.equal(digest?.value, 'Daily');
      // "Nobody has chosen, so it is Daily" and "we chose Daily" are different facts.
      assert.equal(digest?.source, 'default');
    });

    it('prefers a platform default over the code default', async () => {
      await ctx.prisma.runAsPlatformOperation(() =>
        ctx.prisma.client.platformSetting.create({
          data: {
            key: 'notifications.digest',
            value: 'Weekly' as never,
            description: 'A platform floor for the digest.',
            section: 'Governance',
          },
        }),
      );

      const value = await settings().effectiveValue(scope(), 'notifications.digest');
      assert.equal(value, 'Weekly');
    });

    it('prefers the company value over both', async () => {
      await ctx.prisma.runAsPlatformOperation(() =>
        ctx.prisma.client.platformSetting.create({
          data: {
            key: 'notifications.digest',
            value: 'Weekly' as never,
            description: 'A platform floor.',
            section: 'Governance',
          },
        }),
      );
      await settings().update({
        scope: scope(),
        actorUserId: adminId,
        values: { 'notifications.digest': 'Off' },
      });

      const view = await settings().viewFor(scope(), adminId);
      const digest = view.categories
        .flatMap((category) => category.settings)
        .find((setting) => setting.key === 'notifications.digest');

      assert.equal(digest?.value, 'Off');
      assert.equal(digest?.source, 'company');
    });

    it('ignores a stored value that no longer validates, and falls back', async () => {
      // A setting's type can change in a release while old rows remain. Handing a screen an
      // integer where it expects an enum is worse than showing the default.
      await ctx.admin.unsafeRootClient.$executeRawUnsafe(
        `INSERT INTO company_settings (id, tenant_id, key, value, created_at, updated_at, row_version)
         VALUES (gen_random_uuid(), $1, 'notifications.digest', '"Hourly"'::jsonb, NOW(), NOW(), 1)`,
        tenantId,
      );

      const value = await settings().effectiveValue(scope(), 'notifications.digest');
      assert.equal(value, 'Daily');
    });

    it('leaves a company with no rows fully configured', async () => {
      const rows = await ctx.prisma.runAsPlatformOperation(() =>
        ctx.prisma.client.companySetting.count({ where: { tenantId } }),
      );
      assert.equal(rows, 0);

      const view = await settings().viewFor(scope(), adminId);
      const all = view.categories.flatMap((category) => category.settings);
      // Every setting resolves, with no migration having backfilled anything.
      assert.equal(all.length, SETTING_DEFINITIONS.length);
      assert.ok(all.every((setting) => setting.value !== undefined));
    });
  });

  // =========================================================================
  describe('the backend enforces every setting permission', () => {
    it('shows an admin every category and marks them editable', async () => {
      const view = await settings().viewFor(scope(), adminId);
      const editable = view.categories
        .flatMap((category) => category.settings)
        .filter((setting) => setting.editable);
      assert.equal(editable.length, SETTING_DEFINITIONS.length);
      assert.equal(view.withheldCategories, 0);
    });

    it('shows an employee a permitted subset, and none of it editable', async () => {
      const view = await settings().viewFor(scope(), employeeId);
      const all = view.categories.flatMap((category) => category.settings);

      // An Employee holds `settings` at read level, so they see the settings whose read
      // permission is satisfied — and can change none of them.
      assert.ok(all.length > 0);
      assert.ok(all.every((setting) => setting.editable === false));
    });

    it('refuses a write from somebody who may only read', async () => {
      await assert.rejects(
        () =>
          settings().update({
            scope: scope(),
            actorUserId: employeeId,
            values: { 'notifications.digest': 'Off' },
          }),
        /You cannot change/i,
      );
    });

    it('refuses a mixed payload whole rather than applying the permitted half', async () => {
      // Applying half a save is a change nobody asked for; silently dropping the rest tells them
      // it worked.
      await assert.rejects(
        () =>
          settings().update({
            scope: scope(),
            actorUserId: employeeId,
            values: {
              'appearance.density': 'Compact',
              'notifications.digest': 'Off',
            },
          }),
        /You cannot change/i,
      );

      const stored = await ctx.prisma.runAsPlatformOperation(() =>
        ctx.prisma.client.companySetting.count({ where: { tenantId } }),
      );
      assert.equal(stored, 0, 'nothing may be written when any key is refused');
    });

    it('refuses an unknown key rather than storing it', async () => {
      await assert.rejects(
        () =>
          settings().update({
            scope: scope(),
            actorUserId: adminId,
            values: { 'general.not_a_setting': 'x' },
          }),
        /is not a setting/i,
      );
    });

    it('is not authorized by hidden navigation', async () => {
      // The category list is the full information architecture regardless of who asks — the
      // enforcement is the per-setting check, not what the sidebar shows.
      const response = await as(
        agent().get(`/tenants/${tenantId}/settings/categories`),
        employeeUboss,
      ).expect(200);

      assert.equal((response.body as { categories: string[] }).categories.length, 19);

      // And a write is still refused.
      await as(agent().put(`/tenants/${tenantId}/settings`), employeeUboss)
        .send({ values: { 'notifications.digest': 'Off' } })
        .expect(400);
    });

    it('refuses the screen entirely to somebody with no role', async () => {
      const stranger = await ctx.prisma.runAsPlatformOperation(async () => {
        const user = await ctx.users.createForPlatform({
          ubossUniqueId: 'UB-STRG-0001',
          email: 'stranger@settings.example',
          displayName: 'Stranger',
        });
        await ctx.prisma.client.tenantMembership.create({
          data: { tenantId, userId: user.id, accountState: 'Active' },
        });
        return user;
      });

      await as(agent().get(`/tenants/${tenantId}/settings`), stranger.ubossUniqueId).expect(403);
    });
  });

  // =========================================================================
  describe('material changes', () => {
    it('requires a reason', async () => {
      await assert.rejects(
        () =>
          settings().update({
            scope: scope(),
            actorUserId: adminId,
            values: { 'notifications.approval_reminder_hours': 12 },
          }),
        /needs a recorded reason/i,
      );
    });

    it('does not require one for a setting that is not material', async () => {
      const changed = await settings().update({
        scope: scope(),
        actorUserId: adminId,
        values: { 'appearance.density': 'Compact' },
      });
      assert.equal(changed[0]?.value, 'Compact');
    });

    it('keeps a version history with the previous value', async () => {
      await settings().update({
        scope: scope(),
        actorUserId: adminId,
        values: { 'notifications.approval_reminder_hours': 12 },
        reason: 'Approvals were sitting too long over a weekend.',
      });
      await settings().update({
        scope: scope(),
        actorUserId: adminId,
        values: { 'notifications.approval_reminder_hours': 8 },
        reason: 'Tightened again after the March review.',
      });

      const history = await settings().historyFor({
        scope: scope(),
        actorUserId: auditorId,
        key: 'notifications.approval_reminder_hours',
      });

      assert.equal(history.length, 2);
      assert.equal(history[0]?.newValue, '8');
      assert.equal(history[0]?.previousValue, '12');
      // The first change had no company value — only the inherited default.
      assert.equal(history[1]?.previousValue, null);
      assert.match(history[1]?.reason ?? '', /sitting too long/);
    });

    it('keeps no history for a setting that is not material, and says why', async () => {
      await settings().update({
        scope: scope(),
        actorUserId: adminId,
        values: { 'appearance.density': 'Compact' },
      });

      await assert.rejects(
        () =>
          settings().historyFor({
            scope: scope(),
            actorUserId: auditorId,
            key: 'appearance.density',
          }),
        /not a material setting/i,
      );
    });

    it('needs settings:Audit to read the history', async () => {
      await settings().update({
        scope: scope(),
        actorUserId: adminId,
        values: { 'notifications.approval_reminder_hours': 12 },
        reason: 'Approvals were sitting too long.',
      });

      // An Employee may read some settings and may not read who changed a governance one and why.
      await assert.rejects(
        () =>
          settings().historyFor({
            scope: scope(),
            actorUserId: employeeId,
            key: 'notifications.approval_reminder_hours',
          }),
        /(forbidden|not allowed|cannot)/i,
      );
    });

    it('cannot be rewritten by the application', async () => {
      await settings().update({
        scope: scope(),
        actorUserId: adminId,
        values: { 'notifications.approval_reminder_hours': 12 },
        reason: 'Approvals were sitting too long.',
      });

      // The application role has UPDATE and DELETE revoked. A weaker guarantee than the Prompt 8
      // trails — there is no hash chain — and the claim is exactly "the application cannot
      // rewrite it", which this proves.
      await assert.rejects(
        () =>
          ctx.prisma.runAsPlatformOperation(() =>
            ctx.prisma.client.$executeRawUnsafe(
              `UPDATE company_setting_changes SET reason = 'rewritten' WHERE tenant_id = $1`,
              tenantId,
            ),
          ),
        /permission denied/i,
      );
    });
  });

  // =========================================================================
  describe('audit and isolation', () => {
    it('audits every change, material or not', async () => {
      await settings().update({
        scope: scope(),
        actorUserId: adminId,
        values: { 'appearance.density': 'Compact' },
      });

      const events = await ctx.prisma.runInTenantTransaction(scope(), () =>
        app.get(AuditTrailRepository).findAuditEvents({
          tenantId,
          action: 'settings.changed',
          take: 5,
        }),
      );

      assert.equal(events.length, 1);
      const metadata = events[0]?.metadata as { key: string; newValue: string; material: boolean };
      assert.equal(metadata.key, 'appearance.density');
      assert.equal(metadata.newValue, 'Compact');
      assert.equal(metadata.material, false);
    });

    it('never shows one company another’s settings', async () => {
      await settings().update({
        scope: scope(),
        actorUserId: adminId,
        values: { 'appearance.density': 'Compact' },
      });

      const otherRows = await ctx.prisma.runInTenantTransaction(
        tenantScopeForPlatformOperation(otherTenantId),
        () => ctx.prisma.client.companySetting.findMany({ where: { tenantId: otherTenantId } }),
      );
      assert.equal(otherRows.length, 0);
    });

    it('keeps one value per setting per company', async () => {
      await settings().update({
        scope: scope(),
        actorUserId: adminId,
        values: { 'appearance.density': 'Compact' },
      });
      await settings().update({
        scope: scope(),
        actorUserId: adminId,
        values: { 'appearance.density': 'Comfortable' },
      });

      const rows = await ctx.prisma.runAsPlatformOperation(() =>
        ctx.prisma.client.companySetting.findMany({
          where: { tenantId, key: 'appearance.density' },
        }),
      );
      assert.equal(rows.length, 1);
      assert.equal(rows[0]?.value, 'Comfortable');
    });

    it('refuses a nested value at the database, not only in the validator', async () => {
      await assert.rejects(
        () =>
          ctx.admin.unsafeRootClient.$executeRawUnsafe(
            `INSERT INTO company_settings (id, tenant_id, key, value, created_at, updated_at, row_version)
             VALUES (gen_random_uuid(), $1, 'appearance.density', '{"a":1}'::jsonb, NOW(), NOW(), 1)`,
            tenantId,
          ),
        /company_setting_value_is_a_scalar/i,
      );
    });

    it('refuses a key that is not catalogue-shaped, at the database', async () => {
      await assert.rejects(
        () =>
          ctx.admin.unsafeRootClient.$executeRawUnsafe(
            `INSERT INTO company_settings (id, tenant_id, key, value, created_at, updated_at, row_version)
             VALUES (gen_random_uuid(), $1, 'NotACatalogueKey', '"x"'::jsonb, NOW(), NOW(), 1)`,
            tenantId,
          ),
        /company_setting_key_is_dotted_lower_snake/i,
      );
    });
  });

  // =========================================================================
  describe('the shell', () => {
    it('renders a category with no settings of its own, with where it is configured', async () => {
      const view = await settings().viewFor(scope(), adminId);
      const users = view.categories.find((category) => category.key === 'users');

      // The client asked for the full information architecture. A category silently missing from
      // the sidebar reads as a permission problem, which is a different and misleading message.
      assert.ok(users);
      assert.equal(users!.settings.length, 0);
      assert.match(users!.note ?? '', /Users & Access/);
    });

    it('serves the whole screen over HTTP', async () => {
      const response = await as(agent().get(`/tenants/${tenantId}/settings`), adminUboss).expect(
        200,
      );

      const body = response.body as {
        categories: { key: string; settings: unknown[] }[];
        withheldCategories: number;
      };
      assert.equal(body.categories.length, 19);
      assert.equal(body.withheldCategories, 0);
    });

    it('saves several settings in one call', async () => {
      const changed = await settings().update({
        scope: scope(),
        actorUserId: adminId,
        values: {
          'appearance.density': 'Compact',
          'appearance.reduce_motion': true,
          'notifications.digest': 'Weekly',
        },
      });
      assert.equal(changed.length, 3);
    });

    it('refuses an invalid combination even when only one setting is changing', async () => {
      // Reminder is 24 by default; escalating at 12 would be before it.
      await assert.rejects(
        () =>
          settings().update({
            scope: scope(),
            actorUserId: adminId,
            values: { 'notifications.escalate_after_hours': 12 },
            reason: 'Trying to escalate before reminding.',
          }),
        /before the reminder/i,
      );
    });
  });
});
