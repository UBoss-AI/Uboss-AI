import assert from 'node:assert/strict';
import { after, before, beforeEach, describe, it } from 'node:test';

import { type INestApplication, ValidationPipe } from '@nestjs/common';
import { APP_GUARD, APP_INTERCEPTOR, Reflector } from '@nestjs/core';
import { Test } from '@nestjs/testing';
import cookieParser from 'cookie-parser';
import request from 'supertest';

import {
  ALLOWED_SKILL_TRANSITIONS,
  isSkillContentFrozen,
  mayTransitionSkill,
  SKILL_LAYERS,
  SKILL_STATUSES,
  validateSkillContent,
  validateSkillGovernance,
  type SkillContent,
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
import { PlatformSkillController, SkillController } from '../src/skills/skill.controller.js';
import { SkillService } from '../src/skills/skill.service.js';
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

/** A complete, valid Skill body. Named so a test can vary one field and mean it. */
const CONTENT: SkillContent = {
  purpose: 'Screen an incoming tender notice for eligibility against our registrations.',
  category: 'Research',
  whenToUse: 'When a new tender notice arrives and somebody must decide whether to bid.',
  whenNotToUse:
    'Never for a tender already in progress, and never to decide pricing — it reads eligibility only.',
  inputs: [
    {
      name: 'noticeReference',
      description: 'The portal reference for the notice.',
      required: true,
    },
  ],
  rules: [
    { when: 'The notice requires a certification we do not hold', then: 'Report ineligible.' },
  ],
  steps: [
    { order: 1, instruction: 'Read the notice and extract its mandatory qualifications.' },
    { order: 2, instruction: 'Compare each against our registration record.' },
  ],
  allowedToolCategories: ['Read'],
  outputSchema: '{"type":"object","properties":{"eligible":{"type":"boolean"}}}',
  validation: 'A person confirms the eligibility conclusion before it is acted on.',
  failureHandling: 'If the notice cannot be read, escalate to the Skill owner.',
  requiresApproval: true,
  autonomy: 'ProposeForApproval',
  evidenceRequirement: 'Record the notice reference and each qualification compared.',
};

/**
 * Prompt 17 — Skill Catalog and Company Skills & AI.
 *
 * Seven properties carry this prompt:
 *
 *   1. **A Skill is not a Template.** There is no instantiate path; cloning produces a governed
 *      draft with recorded provenance.
 *   2. **A company can read platform Skills and never write one** — asymmetric RLS.
 *   3. **The lifecycle is a closed table.** An unlisted move is impossible.
 *   4. **Approved content is immutable**, enforced by a database trigger. An edit creates a new
 *      version and the live one is untouched.
 *   5. **A high-risk Skill cannot be fully autonomous**, refused in three layers.
 *   6. **Impact analysis reports unknown, not zero**, for what it cannot count.
 *   7. **The governance trail is append-only** and tenant-isolated.
 */
describe('skills catalogue and governance (e2e)', () => {
  let ctx: TestContext;
  let app: INestApplication;

  let tenantId: string;
  let otherTenantId: string;
  let adminId: string;
  let adminUboss: string;
  let approverId: string;
  let approverUboss: string;
  let employeeId: string;
  let employeeUboss: string;
  let ownerId: string;
  let ownerUboss: string;
  /** The other company's own first member. Reading its catalogue needs somebody who is in it. */
  let otherMemberId: string;

  const agent = () => request(app.getHttpServer());
  const scope = () => tenantScopeForPlatformOperation(tenantId);
  const otherScope = () => tenantScopeForPlatformOperation(otherTenantId);
  const skills = () => app.get(SkillService);

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
      controllers: [SkillController, PlatformSkillController],
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
        SkillService,
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
      slug: 'skill-co',
      name: 'Skill Co',
      firstMember: { email: 'first@skill.example', displayName: 'First' },
    });
    await activateTenant(ctx, provisioned.tenant.id);
    await activateMembership(ctx, provisioned.user.id, provisioned.tenant.id);
    tenantId = provisioned.tenant.id;

    const other = await ctx.provisioning.provision({
      slug: 'other-skill-co',
      name: 'Other Skill Co',
      firstMember: { email: 'first@other-skill.example', displayName: 'Other First' },
    });
    await activateTenant(ctx, other.tenant.id);
    await activateMembership(ctx, other.user.id, other.tenant.id);
    otherTenantId = other.tenant.id;
    otherMemberId = other.user.id;

    const people = await ctx.prisma.runAsPlatformOperation(async () => {
      const member = async (unique: string, name: string) => {
        const user = await ctx.users.createForPlatform({
          ubossUniqueId: unique,
          email: `${unique.toLowerCase()}@skill.example`,
          displayName: name,
        });
        await ctx.prisma.client.tenantMembership.create({
          data: { tenantId: provisioned.tenant.id, userId: user.id, accountState: 'Active' },
        });
        return user;
      };

      return {
        admin: await member('UB-SKAD-0001', 'Skill Admin'),
        approver: await member('UB-SKAP-0001', 'Skill Approver'),
        employee: await member('UB-SKEM-0001', 'Skill Employee'),
        owner: await ctx.users.createForPlatform({
          ubossUniqueId: 'UB-SKOW-0001',
          email: 'owner@skill-platform.example',
          displayName: 'Platform Owner',
          isPlatformActor: true,
        }),
      };
    });

    adminId = people.admin.id;
    adminUboss = people.admin.ubossUniqueId;
    approverId = people.approver.id;
    approverUboss = people.approver.ubossUniqueId;
    employeeId = people.employee.id;
    employeeUboss = people.employee.ubossUniqueId;
    ownerId = people.owner.id;
    ownerUboss = people.owner.ubossUniqueId;

    await ctx.prisma.runAsPlatformOperation(async () => {
      await ctx.prisma.client.platformRoleAssignment.create({
        data: { userId: ownerId, role: 'PlatformOwner', justification: 'Fixture.' },
      });

      for (const [userId, roleKind, scopeKind] of [
        [adminId, 'CompanyAdmin', 'WholeCompany'],
        // The real `Approver` role, not a second admin. It holds `settings: View + Approve`
        // and **no** `Administer`, so the approval step is exercised by somebody who cannot
        // author — which is the separation this prompt relies on, tested rather than assumed.
        [approverId, 'Approver', 'WholeCompany'],
        [employeeId, 'Employee', 'OwnWork'],
      ] as const) {
        await ctx.prisma.client.roleAssignment.create({
          data: { tenantId, userId, roleKind, scopeKind, grantedByUserId: ownerId },
        });
      }

      // The other company's member needs a role too. Somebody with none is refused by the
      // Prompt 7 engine — correctly — and a cross-tenant visibility test that hit that refusal
      // would prove nothing about platform-Skill visibility.
      await ctx.prisma.client.roleAssignment.create({
        data: {
          tenantId: other.tenant.id,
          userId: otherMemberId,
          roleKind: 'CompanyAdmin',
          scopeKind: 'WholeCompany',
          grantedByUserId: ownerId,
        },
      });
    });
  });

  const as = <T extends request.Test>(test: T, uboss: string, workspace = tenantId): T =>
    test.set('x-uboss-dev-actor', uboss).set(WORKSPACE_HEADER, workspace) as T;

  /** A company Skill in Draft. */
  const createSkill = (key = 'tender-screen', content: SkillContent = CONTENT) =>
    skills().createCompanySkill({
      scope: scope(),
      actorUserId: adminId,
      key,
      name: 'Tender eligibility screen',
      content,
      creationMode: 'Manual',
    });

  /** A published platform Skill, created and published on the platform plane. */
  const publishPlatformSkill = async (key = 'verified-tender-screen') => {
    const created = await skills().createPlatformSkill({
      actorUserId: ownerId,
      layer: 'UbossVerified',
      key,
      name: 'UBoss tender screen',
      content: CONTENT,
    });
    for (const to of ['Review', 'Approved', 'Published'] as const) {
      await skills().transitionPlatformVersion({
        actorUserId: ownerId,
        versionId: created.versionId,
        to,
      });
    }
    return created;
  };

  /** Drive a company version to Published. */
  const publish = async (versionId: string) => {
    for (const to of ['Review', 'Approved', 'Published'] as const) {
      await skills().transition({
        scope: scope(),
        actorUserId: to === 'Approved' ? approverId : adminId,
        versionId,
        to,
      });
    }
  };

  // =========================================================================
  describe('the vocabulary', () => {
    it('declares the client’s three layers and seven statuses', () => {
      assert.deepEqual([...SKILL_LAYERS], ['UbossVerified', 'IndustryPack', 'CompanyCustom']);
      assert.deepEqual(
        [...SKILL_STATUSES],
        ['Draft', 'Test', 'Review', 'Approved', 'Published', 'Deprecated', 'Archived'],
      );
    });

    it('refuses a published version returning to draft, and makes archived terminal', () => {
      // The versioning rule: an authorised edit after publication creates a **new version**, it
      // never reopens the live one.
      assert.equal(mayTransitionSkill('Published', 'Draft'), false);
      assert.equal(mayTransitionSkill('Published', 'Deprecated'), true);

      // Un-archiving would mean a capability silently becoming available again.
      assert.deepEqual([...ALLOWED_SKILL_TRANSITIONS.Archived], []);

      // A reviewer who rejects must be able to send it back, or the lifecycle gets worked around
      // by cloning.
      assert.equal(mayTransitionSkill('Review', 'Draft'), true);
    });

    it('freezes content at Approved, not merely Published', () => {
      // Stricter than the client asked, on purpose: an approval is a decision about specific
      // content, so content that could change afterwards would make it worthless.
      assert.equal(isSkillContentFrozen('Approved'), true);
      assert.equal(isSkillContentFrozen('Published'), true);
      assert.equal(isSkillContentFrozen('Review'), false);
      assert.equal(isSkillContentFrozen('Draft'), false);
    });

    it('requires every field the client lists, reporting all problems at once', () => {
      const problems = validateSkillContent({ purpose: 'x' });
      // Being told one mistake at a time is how a review cycle takes four days.
      assert.ok(problems.length > 3);
      assert.ok(problems.some((problem) => /when \*\*not\*\* to use/.test(problem)));
      assert.ok(problems.some((problem) => /at least one step/.test(problem)));
    });

    it('refuses a fully autonomous high-risk Skill in the shared validator', () => {
      const problems = validateSkillGovernance({
        allowedToolCategories: ['Read', 'Delete'],
        autonomy: 'FullyAutonomous',
        requiresApproval: true,
      });
      assert.equal(problems.length, 1);
      assert.match(problems[0] as string, /cannot be fully autonomous/i);
      assert.match(problems[0] as string, /Executor Agent is not a substitute/i);
    });

    it('refuses a high-risk Skill that neither requires approval nor only suggests', () => {
      const problems = validateSkillGovernance({
        allowedToolCategories: ['FinancialChange'],
        autonomy: 'ActThenReport',
        requiresApproval: false,
      });
      assert.equal(problems.length, 1);
      assert.match(problems[0] as string, /on nobody’s decision/);
    });
  });

  // =========================================================================
  describe('authoring a company Skill', () => {
    it('creates it as a draft with every field stored', async () => {
      const skill = await createSkill();

      assert.equal(skill.layer, 'CompanyCustom');
      assert.equal(skill.editableHere, true);
      assert.equal(skill.publishedVersion, null);
      assert.equal(skill.openDraft?.status, 'Draft');
      assert.equal(skill.openDraft?.versionNumber, 1);
      assert.equal(skill.openDraft?.contentFrozen, false);
      assert.equal(skill.openDraft?.content.whenNotToUse, CONTENT.whenNotToUse);
      assert.deepEqual(skill.openDraft?.content.steps, CONTENT.steps);
      // The screen is told exactly which moves the service will accept.
      assert.deepEqual(skill.openDraft?.nextStatuses, ['Test', 'Review', 'Archived']);
    });

    it('refuses a fully autonomous high-risk Skill', async () => {
      await assert.rejects(
        () =>
          createSkill('risky-skill', {
            ...CONTENT,
            allowedToolCategories: ['Read', 'Delete'],
            autonomy: 'FullyAutonomous',
          }),
        /cannot be fully autonomous/i,
      );
    });

    it('lets the database refuse one too', async () => {
      const skill = await createSkill();

      await assert.rejects(
        () =>
          ctx.prisma.runAsPlatformOperation(() =>
            ctx.prisma.client.skillVersion.create({
              data: {
                tenantId,
                skillId: skill.id,
                versionNumber: 99,
                status: 'Draft',
                purpose: 'p',
                category: 'Research',
                whenToUse: 'w',
                whenNotToUse: 'n',
                inputs: [],
                rules: [],
                steps: [{ order: 1, instruction: 'do' }],
                allowedToolCategories: ['ProductionChange'],
                outputSchema: '{}',
                validation: 'v',
                failureHandling: 'f',
                autonomy: 'FullyAutonomous',
                evidenceRequirement: 'e',
              },
            }),
          ),
        /high_risk_skill_is_not_fully_autonomous/i,
      );
    });

    it('refuses a second Skill with the same handle', async () => {
      await createSkill();
      await assert.rejects(() => createSkill(), /already has a Skill called/i);
    });

    it('insists a document-sourced draft names its document', async () => {
      await assert.rejects(
        () =>
          skills().createCompanySkill({
            scope: scope(),
            actorUserId: adminId,
            key: 'from-sop',
            name: 'From an SOP',
            content: CONTENT,
            creationMode: 'FromDocument',
          }),
        /must say which document/i,
      );

      const ok = await skills().createCompanySkill({
        scope: scope(),
        actorUserId: adminId,
        key: 'from-sop',
        name: 'From an SOP',
        content: CONTENT,
        creationMode: 'FromDocument',
        sourceReference: 'SOP-QA-014 rev 3',
      });
      assert.equal(ok.openDraft?.sourceReference, 'SOP-QA-014 rev 3');
    });

    it('sends a clone through the clone route so provenance is recorded', async () => {
      await assert.rejects(
        () =>
          skills().createCompanySkill({
            scope: scope(),
            actorUserId: adminId,
            key: 'sneaky-clone',
            name: 'Sneaky',
            content: CONTENT,
            creationMode: 'Clone',
          }),
        /Use the clone route/i,
      );
    });

    it('needs settings:Administer to author', async () => {
      await assert.rejects(
        () =>
          skills().createCompanySkill({
            scope: scope(),
            actorUserId: employeeId,
            key: 'employee-skill',
            name: 'Mine',
            content: CONTENT,
            creationMode: 'Manual',
          }),
        /forbidden|not include/i,
      );
    });
  });

  // =========================================================================
  describe('the lifecycle', () => {
    it('runs Draft → Review → Approved → Published, recording who did each', async () => {
      const skill = await createSkill();
      const versionId = skill.openDraft!.id;

      await skills().transition({ scope: scope(), actorUserId: adminId, versionId, to: 'Review' });
      const approved = await skills().transition({
        scope: scope(),
        actorUserId: approverId,
        versionId,
        to: 'Approved',
      });
      assert.equal(approved.status, 'Approved');
      assert.equal(approved.approvedByUserId, approverId);
      // Frozen the moment it is approved.
      assert.equal(approved.contentFrozen, true);

      const published = await skills().transition({
        scope: scope(),
        actorUserId: adminId,
        versionId,
        to: 'Published',
      });
      assert.equal(published.status, 'Published');
      assert.equal(published.publishedByUserId, adminId);

      const view = await skills().view({ scope: scope(), actorUserId: adminId, skillId: skill.id });
      assert.equal(view.publishedVersion?.id, versionId);
      assert.equal(view.openDraft, null);
    });

    it('refuses a move the table does not permit', async () => {
      const skill = await createSkill();
      const versionId = skill.openDraft!.id;

      // Draft cannot jump to Published: the lifecycle exists so nothing goes live unreviewed.
      await assert.rejects(
        () =>
          skills().transition({ scope: scope(), actorUserId: adminId, versionId, to: 'Published' }),
        /cannot become Published/i,
      );
    });

    it('refuses to reopen a published version, naming the alternative', async () => {
      const skill = await createSkill();
      const versionId = skill.openDraft!.id;
      await publish(versionId);

      await assert.rejects(
        // The **approver**, not the admin: sending a version back is a reviewer's act and needs
        // `settings:Approve`. Asking as the admin would be refused for the wrong reason — a
        // permission failure rather than the immutability rule this test is about.
        () =>
          skills().transition({ scope: scope(), actorUserId: approverId, versionId, to: 'Draft' }),
        /immutable — start a new draft/i,
      );
    });

    it('requires a reason to send back, deprecate or archive', async () => {
      const skill = await createSkill();
      const versionId = skill.openDraft!.id;
      await skills().transition({ scope: scope(), actorUserId: adminId, versionId, to: 'Review' });

      await assert.rejects(
        () =>
          skills().transition({ scope: scope(), actorUserId: approverId, versionId, to: 'Draft' }),
        /needs a reason: the author has to know what to change/i,
      );

      const back = await skills().transition({
        scope: scope(),
        actorUserId: approverId,
        versionId,
        to: 'Draft',
        reason: 'The failure handling does not say who is escalated to.',
      });
      assert.equal(back.status, 'Draft');
    });

    it('will not let an administrator approve or reject, only an approver', async () => {
      /*
       * The Prompt 7 invariant, load-bearing here: a Company Admin carries **no** `Approve`
       * anywhere, including on `settings`. This prompt wanted to put it there and the invariant
       * test refused — correctly, because the client's model is that an administrator who must
       * also approve is *additionally* assigned the Approver role, so the second decision is
       * visible in the assignment record rather than implied by a job title.
       */
      const skill = await createSkill();
      const versionId = skill.openDraft!.id;
      await skills().transition({ scope: scope(), actorUserId: adminId, versionId, to: 'Review' });

      await assert.rejects(
        () =>
          skills().transition({ scope: scope(), actorUserId: adminId, versionId, to: 'Approved' }),
        /does not include "Approve"/i,
      );

      await assert.rejects(
        () =>
          skills().transition({
            scope: scope(),
            actorUserId: adminId,
            versionId,
            to: 'Draft',
            reason: 'Trying to reject as an administrator.',
          }),
        /does not include "Approve"/i,
      );

      // The approver can do both, and cannot author — which is what makes it a separation rather
      // than a formality.
      const approved = await skills().transition({
        scope: scope(),
        actorUserId: approverId,
        versionId,
        to: 'Approved',
      });
      assert.equal(approved.status, 'Approved');

      await assert.rejects(
        () =>
          skills().createCompanySkill({
            scope: scope(),
            actorUserId: approverId,
            key: 'approver-authored',
            name: 'Authored by an approver',
            content: CONTENT,
            creationMode: 'Manual',
          }),
        /does not include "Administer"/i,
      );
    });

    it('keeps the governance trail, with who and why', async () => {
      const skill = await createSkill();
      const versionId = skill.openDraft!.id;
      await skills().transition({ scope: scope(), actorUserId: adminId, versionId, to: 'Review' });
      await skills().transition({
        scope: scope(),
        actorUserId: approverId,
        versionId,
        to: 'Draft',
        reason: 'Needs a clearer evidence requirement.',
      });

      const history = await skills().historyOf({
        scope: scope(),
        actorUserId: adminId,
        versionId,
      });
      assert.equal(history.transitions.length, 2);
      const rejection = history.transitions.find((row) => row.to === 'Draft');
      assert.equal(rejection?.actorUserId, approverId);
      assert.match(rejection?.reason ?? '', /evidence requirement/);
    });

    it('lets the database refuse a rewritten trail', async () => {
      const skill = await createSkill();
      await skills().transition({
        scope: scope(),
        actorUserId: adminId,
        versionId: skill.openDraft!.id,
        to: 'Review',
      });

      await assert.rejects(
        () =>
          ctx.prisma.runAsPlatformOperation(() =>
            ctx.prisma.client.$executeRawUnsafe(
              `UPDATE skill_transitions SET reason = 'rewritten' WHERE tenant_id = $1`,
              tenantId,
            ),
          ),
        /permission denied/i,
      );
    });

    it('deprecates the previous version when a new one is published', async () => {
      const skill = await createSkill();
      const first = skill.openDraft!.id;
      await publish(first);

      const second = await skills().startNewDraft({
        scope: scope(),
        actorUserId: adminId,
        skillId: skill.id,
        changes: { validation: 'Two people confirm the eligibility conclusion.' },
      });
      await publish(second.id);

      const rows = await ctx.prisma.runAsPlatformOperation(() =>
        ctx.prisma.client.skillVersion.findMany({
          where: { skillId: skill.id },
          orderBy: { versionNumber: 'asc' },
        }),
      );
      assert.equal(rows[0]?.status, 'Deprecated');
      assert.match(rows[0]?.retirementReason ?? '', /Superseded by version 2/);
      assert.equal(rows[1]?.status, 'Published');
    });
  });

  // =========================================================================
  describe('published content is immutable', () => {
    it('refuses an edit to an approved version and names the alternative', async () => {
      const skill = await createSkill();
      const versionId = skill.openDraft!.id;
      await skills().transition({ scope: scope(), actorUserId: adminId, versionId, to: 'Review' });
      await skills().transition({
        scope: scope(),
        actorUserId: approverId,
        versionId,
        to: 'Approved',
      });

      await assert.rejects(
        () =>
          skills().updateDraft({
            scope: scope(),
            actorUserId: adminId,
            versionId,
            changes: { purpose: 'Something entirely different' },
          }),
        /Start a new draft instead/i,
      );
    });

    it('lets the database trigger refuse it too, even bypassing the service', async () => {
      const skill = await createSkill();
      const versionId = skill.openDraft!.id;
      await publish(versionId);

      // The service could be bypassed by a future caller. The trigger cannot.
      await assert.rejects(
        () =>
          ctx.prisma.runAsPlatformOperation(() =>
            ctx.prisma.client.skillVersion.update({
              where: { id: versionId },
              data: { allowedToolCategories: ['Read', 'Delete'] },
            }),
          ),
        /content cannot be changed/i,
      );
    });

    it('still allows the status to move, which is why it is a trigger and not a revoke', async () => {
      const skill = await createSkill();
      const versionId = skill.openDraft!.id;
      await publish(versionId);

      const deprecated = await skills().transition({
        scope: scope(),
        actorUserId: adminId,
        versionId,
        to: 'Deprecated',
        reason: 'The tender portal changed its notice format.',
      });
      assert.equal(deprecated.status, 'Deprecated');
    });

    it('leaves the published version untouched while a new draft is written', async () => {
      const skill = await createSkill();
      const first = skill.openDraft!.id;
      await publish(first);

      await skills().startNewDraft({
        scope: scope(),
        actorUserId: adminId,
        skillId: skill.id,
        changes: { purpose: 'A completely rewritten purpose for version two.' },
      });

      const view = await skills().view({ scope: scope(), actorUserId: adminId, skillId: skill.id });
      // The live version is still live, still saying what it said. Work carries on referencing it.
      assert.equal(view.publishedVersion?.id, first);
      assert.equal(view.publishedVersion?.content.purpose, CONTENT.purpose);
      assert.equal(view.openDraft?.versionNumber, 2);
      assert.match(view.openDraft?.content.purpose ?? '', /version two/);
    });

    it('refuses a second open draft', async () => {
      const skill = await createSkill();
      await publish(skill.openDraft!.id);
      await skills().startNewDraft({
        scope: scope(),
        actorUserId: adminId,
        skillId: skill.id,
        changes: {},
      });

      await assert.rejects(
        () =>
          skills().startNewDraft({
            scope: scope(),
            actorUserId: adminId,
            skillId: skill.id,
            changes: {},
          }),
        /still open/i,
      );
    });

    it('re-validates governance at the approval boundary', async () => {
      // A rule introduced after the draft was written must still apply, because approval is the
      // last moment the content can be refused.
      const skill = await createSkill();
      const versionId = skill.openDraft!.id;

      // Force a governance-invalid state past the service, the way a data fix might.
      await ctx.prisma.runAsPlatformOperation(() =>
        ctx.prisma.client.skillVersion.update({
          where: { id: versionId },
          data: { requiresApproval: false, allowedToolCategories: ['SensitiveExport'] },
        }),
      );

      await skills().transition({ scope: scope(), actorUserId: adminId, versionId, to: 'Review' });
      await assert.rejects(
        () =>
          skills().transition({
            scope: scope(),
            actorUserId: approverId,
            versionId,
            to: 'Approved',
          }),
        /nobody’s decision/,
      );
    });
  });

  // =========================================================================
  describe('platform Skills, and why cloning is not copying a template', () => {
    it('makes a published platform Skill readable by every company', async () => {
      await publishPlatformSkill();

      const here = await skills().catalogueFor({ scope: scope(), actorUserId: employeeId });
      const there = await skills().catalogueFor({
        scope: otherScope(),
        // The other company's **own** member. Passing this company's employee would be refused
        // for the right reason — they are not a member there — and would prove nothing about
        // platform-Skill visibility.
        actorUserId: otherMemberId,
      });

      // That *is* what "available to every company" means; without it the catalogue would be
      // empty for everyone.
      assert.equal(
        here.skills.some((skill) => skill.layer === 'UbossVerified'),
        true,
      );
      assert.equal(
        there.skills.some((skill) => skill.layer === 'UbossVerified'),
        true,
      );
    });

    it('marks a platform Skill as not editable here', async () => {
      await publishPlatformSkill();
      const catalogue = await skills().catalogueFor({ scope: scope(), actorUserId: adminId });
      const verified = catalogue.skills.find((skill) => skill.layer === 'UbossVerified');

      assert.equal(verified?.editableHere, false);
      assert.equal(verified?.ownerUserId, null);
    });

    it('refuses to edit a platform Skill, naming cloning as the alternative', async () => {
      const platform = await publishPlatformSkill();

      await assert.rejects(
        () =>
          skills().startNewDraft({
            scope: scope(),
            actorUserId: adminId,
            skillId: platform.skillId,
            changes: { purpose: 'Our own version' },
          }),
        /Clone it to make a version of your own/i,
      );

      await assert.rejects(
        () =>
          skills().updateDraft({
            scope: scope(),
            actorUserId: adminId,
            versionId: platform.versionId,
            changes: { purpose: 'Our own version' },
          }),
        /Clone the Skill/i,
      );
    });

    it('clones into a draft under this company’s own approval, with provenance', async () => {
      const platform = await publishPlatformSkill();

      const clone = await skills().cloneSkill({
        scope: scope(),
        actorUserId: adminId,
        sourceSkillId: platform.skillId,
        key: 'our-tender-screen',
        name: 'Our tender screen',
      });

      assert.equal(clone.layer, 'CompanyCustom');
      assert.equal(clone.clonedFromSkillId, platform.skillId);
      assert.equal(clone.editableHere, true);
      // **Not published.** Inheriting the source's status would mean this company's Skill was
      // live without anybody here approving it — which is the whole reason cloning is not
      // copying a template.
      assert.equal(clone.publishedVersion, null);
      assert.equal(clone.openDraft?.status, 'Draft');
      assert.equal(clone.openDraft?.creationMode, 'Clone');
      assert.equal(clone.openDraft?.clonedFromVersionId, platform.versionId);
      // The content came across.
      assert.equal(clone.openDraft?.content.purpose, CONTENT.purpose);
    });

    it('refuses to clone an unpublished version', async () => {
      const created = await skills().createPlatformSkill({
        actorUserId: ownerId,
        layer: 'UbossVerified',
        key: 'unpublished-verified',
        name: 'Not yet published',
        content: CONTENT,
      });

      await assert.rejects(
        () =>
          skills().cloneSkill({
            scope: scope(),
            actorUserId: adminId,
            sourceSkillId: created.skillId,
            key: 'our-copy',
            name: 'Our copy',
          }),
        /no published version to clone/i,
      );
    });

    it('refuses a company write to a platform Skill at the database, not just the service', async () => {
      await publishPlatformSkill();

      // The RLS `WITH CHECK` half. A company able to publish a "UBoss Verified" Skill would be
      // publishing something every other company reads as verified by UBoss.
      await assert.rejects(
        () =>
          ctx.prisma.runInTenantTransaction(scope(), () =>
            ctx.prisma.client.skill.create({
              data: {
                tenantId: null,
                layer: 'UbossVerified',
                key: 'forged-verified',
                name: 'Forged',
              },
            }),
          ),
        /row-level security|violates row-level/i,
      );
    });

    it('insists an Industry Pack names its industry', async () => {
      await assert.rejects(
        () =>
          skills().createPlatformSkill({
            actorUserId: ownerId,
            layer: 'IndustryPack',
            key: 'pack-without-industry',
            name: 'Pack',
            content: CONTENT,
          }),
        /must name its industry/i,
      );
    });

    it('refuses to create a company layer from the platform plane', async () => {
      await assert.rejects(
        () =>
          skills().createPlatformSkill({
            actorUserId: ownerId,
            layer: 'CompanyCustom',
            key: 'platform-custom',
            name: 'Wrong plane',
            content: CONTENT,
          }),
        /belongs to its company/i,
      );
    });
  });

  // =========================================================================
  describe('impact analysis', () => {
    it('reports unknown, not zero, for what it cannot count', async () => {
      const skill = await createSkill();
      const impact = await skills().impactOf({
        scope: scope(),
        actorUserId: adminId,
        versionId: skill.openDraft!.id,
      });

      assert.equal(impact.incomplete, true);

      for (const key of ['agents', 'objectives', 'activeRuns']) {
        const domain = impact.domains.find((row) => row.key === key);
        // A zero here would be read as "nothing is affected", and somebody would publish on the
        // strength of it.
        assert.equal(domain?.count, null, key);
        assert.match(domain?.detail ?? '', /Reported as unknown rather than zero/);
      }

      assert.match(impact.note, /worse than one that admits what it cannot see/);
    });

    it('counts what it can: Skills cloned from this one', async () => {
      const platform = await publishPlatformSkill();
      await skills().cloneSkill({
        scope: scope(),
        actorUserId: adminId,
        sourceSkillId: platform.skillId,
        key: 'our-clone',
        name: 'Our clone',
      });

      const impact = await skills().impactOf({
        scope: scope(),
        actorUserId: adminId,
        versionId: platform.versionId,
      });
      const clones = impact.domains.find((row) => row.key === 'clones');
      assert.equal(clones?.count, 1);
      // Independent: each clone has its own approval, so the upgrade does not reach them.
      assert.match(clones?.detail ?? '', /independent/);
    });

    it('names the version being replaced', async () => {
      const skill = await createSkill();
      const first = skill.openDraft!.id;
      await publish(first);
      const second = await skills().startNewDraft({
        scope: scope(),
        actorUserId: adminId,
        skillId: skill.id,
        changes: {},
      });

      const impact = await skills().impactOf({
        scope: scope(),
        actorUserId: adminId,
        versionId: second.id,
      });
      assert.equal(impact.fromVersion, 1);
      assert.equal(impact.toVersion, 2);
    });
  });

  // =========================================================================
  describe('tenant isolation and the API', () => {
    it('never shows one company’s custom Skill in another', async () => {
      await createSkill();

      const there = await skills().catalogueFor({
        scope: otherScope(),
        actorUserId: otherMemberId,
      });
      assert.equal(there.skills.length, 0);
    });

    it('serves the vocabulary and the catalogue over HTTP', async () => {
      const meta = await as(
        agent().get(`/tenants/${tenantId}/skills/catalogue-meta`),
        employeeUboss,
      ).expect(200);

      assert.equal(meta.body.layers.length, 3);
      assert.equal(meta.body.statuses.length, 7);
      // The locked rule, on the wire.
      assert.match(meta.body.note, /no Templates Library/i);
      assert.match(meta.body.note, /governed capability, not a template/i);

      await createSkill();
      const catalogue = await as(agent().get(`/tenants/${tenantId}/skills`), employeeUboss).expect(
        200,
      );
      assert.equal(catalogue.body.skills.length, 1);
      assert.match(catalogue.body.note, /not templates/i);
    });

    it('lets an employee read and not author', async () => {
      const skill = await createSkill();

      await as(agent().get(`/tenants/${tenantId}/skills/${skill.id}`), employeeUboss).expect(200);

      await as(agent().post(`/tenants/${tenantId}/skills`), employeeUboss)
        .send({
          key: 'employee-attempt',
          name: 'Mine',
          creationMode: 'Manual',
          content: CONTENT,
        })
        .expect(403);
    });

    it('runs the whole lifecycle over HTTP', async () => {
      const created = await as(agent().post(`/tenants/${tenantId}/skills`), adminUboss)
        .send({
          key: 'http-skill',
          name: 'Over HTTP',
          creationMode: 'Manual',
          content: CONTENT,
        })
        .expect(201);

      const versionId = created.body.openDraft.id;

      for (const to of ['Review', 'Approved', 'Published']) {
        await as(
          agent().post(`/tenants/${tenantId}/skills/versions/${versionId}/transition`),
          to === 'Approved' ? approverUboss : adminUboss,
        )
          .send({ to })
          .expect(201);
      }

      const impact = await as(
        agent().get(`/tenants/${tenantId}/skills/versions/${versionId}/impact`),
        adminUboss,
      ).expect(200);
      assert.equal(impact.body.incomplete, true);

      const history = await as(
        agent().get(`/tenants/${tenantId}/skills/versions/${versionId}/history`),
        adminUboss,
      ).expect(200);
      assert.equal(history.body.transitions.length, 3);
    });

    it('refuses a non-kebab handle and an unknown category at the boundary', async () => {
      await as(agent().post(`/tenants/${tenantId}/skills`), adminUboss)
        .send({ key: 'Bad_Key', name: 'Bad', creationMode: 'Manual', content: CONTENT })
        .expect(400);

      await as(agent().post(`/tenants/${tenantId}/skills`), adminUboss)
        .send({
          key: 'bad-category',
          name: 'Bad',
          creationMode: 'Manual',
          content: { ...CONTENT, category: 'Invented' },
        })
        .expect(400);
    });

    it('refuses a tool category outside the Prompt 16 vocabulary', async () => {
      // A Skill declares what it needs from the **connection** vocabulary. A human action would
      // be a category error in the most literal sense.
      await as(agent().post(`/tenants/${tenantId}/skills`), adminUboss)
        .send({
          key: 'bad-tools',
          name: 'Bad tools',
          creationMode: 'Manual',
          content: { ...CONTENT, allowedToolCategories: ['Administer'] },
        })
        .expect(400);
    });

    it('keeps the platform catalogue on the platform plane', async () => {
      await as(agent().post('/platform/skills'), adminUboss)
        .send({
          layer: 'UbossVerified',
          key: 'company-attempt',
          name: 'Attempt',
          creationMode: 'Manual',
          content: CONTENT,
        })
        .expect(403);

      await agent()
        .post('/platform/skills')
        .set('x-uboss-dev-actor', ownerUboss)
        .send({
          layer: 'UbossVerified',
          key: 'platform-created',
          name: 'From the console',
          creationMode: 'Manual',
          content: CONTENT,
        })
        .expect(201);
    });

    it('audits creation, cloning and every lifecycle move', async () => {
      const platform = await publishPlatformSkill();
      const skill = await createSkill();
      await publish(skill.openDraft!.id);
      await skills().cloneSkill({
        scope: scope(),
        actorUserId: adminId,
        sourceSkillId: platform.skillId,
        key: 'audited-clone',
        name: 'Audited clone',
      });

      const actions = await ctx.prisma.runAsPlatformOperation(() =>
        ctx.prisma.client.auditEvent.findMany({
          where: { action: { startsWith: 'skill.' } },
          select: { action: true },
        }),
      );
      const kinds = new Set(actions.map((row) => row.action));

      for (const action of [
        'skill.created',
        'skill.cloned',
        'skill.review',
        'skill.approved',
        'skill.published',
        'skill.platform_created',
        'skill.platform_published',
      ]) {
        assert.ok(kinds.has(action), `missing ${action}`);
      }
    });

    it('states in the audit trail that a new draft leaves the live version alone', async () => {
      const skill = await createSkill();
      await publish(skill.openDraft!.id);
      await skills().startNewDraft({
        scope: scope(),
        actorUserId: adminId,
        skillId: skill.id,
        changes: {},
      });

      const event = await ctx.prisma.runAsPlatformOperation(() =>
        ctx.prisma.client.auditEvent.findFirst({
          where: { tenantId, action: 'skill.new_draft_started' },
        }),
      );
      const metadata = event?.metadata as Record<string, unknown> | null;
      assert.equal(metadata?.['publishedVersionUnchanged'], true);
      assert.equal(metadata?.['supersedesVersion'], 1);
    });
  });
});
