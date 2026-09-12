import assert from 'node:assert/strict';
import { after, before, beforeEach, describe, it } from 'node:test';

import { type INestApplication, ValidationPipe } from '@nestjs/common';
import { APP_GUARD, APP_INTERCEPTOR, Reflector } from '@nestjs/core';
import { Test } from '@nestjs/testing';
import cookieParser from 'cookie-parser';
import request from 'supertest';

import { ROUTER_MAX_RESULTS, type SkillContent, type SkillRouterContext } from '@uboss/types';

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
import { SkillRouterController } from '../src/skills/skill-router.controller.js';
import { SkillRouterService } from '../src/skills/skill-router.service.js';
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

const CONTENT: SkillContent = {
  purpose: 'Screen an incoming tender notice for eligibility against our registrations.',
  category: 'Research',
  whenToUse: 'When a new tender notice arrives and somebody must decide whether to bid.',
  whenNotToUse: 'Never for pricing strategy or pricing floors.',
  inputs: [{ name: 'noticeReference', description: 'The portal reference.', required: true }],
  rules: [{ when: 'A certification is missing', then: 'Report ineligible.' }],
  steps: [{ order: 1, instruction: 'Read the notice and extract its mandatory qualifications.' }],
  allowedToolCategories: ['Read'],
  outputSchema: '{"type":"object","properties":{"eligible":{"type":"boolean"}}}',
  validation: 'A person confirms the eligibility conclusion before it is acted on.',
  failureHandling: 'If the notice cannot be read, escalate to the Skill owner.',
  requiresApproval: true,
  autonomy: 'ProposeForApproval',
  evidenceRequirement: 'Record the notice reference and each qualification compared.',
};

const CONTEXT: SkillRouterContext = {
  aiTask: 'Screen an incoming tender notice for eligibility against our registrations',
  availableInputs: ['noticeReference'],
  allowedToolCategories: ['Read', 'Write'],
  requiresApproval: true,
};

/**
 * Prompt 18 — Skill Router and Evaluation Foundation.
 *
 * Six properties carry this prompt:
 *
 *   1. **Only a published version is ever selected**, and a draft is not even a candidate.
 *   2. **A missing capability raises a Skill Candidate**, and there is no path from Candidate to
 *      published.
 *   3. **Every selection is explainable** and every rejection carries its rule.
 *   4. **Saved evaluation cases** belong to the Skill, so two versions can be compared.
 *   5. **A regression blocks**, and publishing over one is a signed decision.
 *   6. **The evaluation record is append-only**, and an unjudged case counts as neither.
 */
describe('skill router and evaluation (e2e)', () => {
  let ctx: TestContext;
  let app: INestApplication;

  let tenantId: string;
  let otherTenantId: string;
  let adminId: string;
  let adminUboss: string;
  let approverId: string;
  let employeeId: string;
  let employeeUboss: string;
  /** A second person who may run agents. Two different people hitting the same capability gap. */
  let colleagueId: string;
  let ownerId: string;

  const agent = () => request(app.getHttpServer());
  const scope = () => tenantScopeForPlatformOperation(tenantId);
  const otherScope = () => tenantScopeForPlatformOperation(otherTenantId);
  const router = () => app.get(SkillRouterService);
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
      controllers: [SkillRouterController],
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
        SkillRouterService,
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
      slug: 'router-co',
      name: 'Router Co',
      firstMember: { email: 'first@router.example', displayName: 'First' },
    });
    await activateTenant(ctx, provisioned.tenant.id);
    await activateMembership(ctx, provisioned.user.id, provisioned.tenant.id);
    tenantId = provisioned.tenant.id;

    const other = await ctx.provisioning.provision({
      slug: 'other-router-co',
      name: 'Other Router Co',
      firstMember: { email: 'first@other-router.example', displayName: 'Other First' },
    });
    await activateTenant(ctx, other.tenant.id);
    otherTenantId = other.tenant.id;

    const people = await ctx.prisma.runAsPlatformOperation(async () => {
      const member = async (unique: string, name: string) => {
        const user = await ctx.users.createForPlatform({
          ubossUniqueId: unique,
          email: `${unique.toLowerCase()}@router.example`,
          displayName: name,
        });
        await ctx.prisma.client.tenantMembership.create({
          data: { tenantId: provisioned.tenant.id, userId: user.id, accountState: 'Active' },
        });
        return user;
      };

      return {
        admin: await member('UB-RTAD-0001', 'Router Admin'),
        approver: await member('UB-RTAP-0001', 'Router Approver'),
        employee: await member('UB-RTEM-0001', 'Router Employee'),
        colleague: await member('UB-RTCO-0001', 'Router Colleague'),
        owner: await ctx.users.createForPlatform({
          ubossUniqueId: 'UB-RTOW-0001',
          email: 'owner@router-platform.example',
          displayName: 'Platform Owner',
          isPlatformActor: true,
        }),
      };
    });

    adminId = people.admin.id;
    adminUboss = people.admin.ubossUniqueId;
    approverId = people.approver.id;
    employeeId = people.employee.id;
    employeeUboss = people.employee.ubossUniqueId;
    colleagueId = people.colleague.id;
    ownerId = people.owner.id;

    await ctx.prisma.runAsPlatformOperation(async () => {
      await ctx.prisma.client.platformRoleAssignment.create({
        data: { userId: ownerId, role: 'PlatformOwner', justification: 'Fixture.' },
      });

      for (const [userId, roleKind, scopeKind] of [
        [adminId, 'CompanyAdmin', 'WholeCompany'],
        [approverId, 'Approver', 'WholeCompany'],
        // An Employee holds `agents:Run`, which is what routing needs — the point being that
        // finding out which Skills apply is part of doing the work.
        [employeeId, 'Employee', 'OwnWork'],
        [colleagueId, 'Employee', 'OwnWork'],
      ] as const) {
        await ctx.prisma.client.roleAssignment.create({
          data: { tenantId, userId, roleKind, scopeKind, grantedByUserId: ownerId },
        });
      }
    });
  });

  const as = <T extends request.Test>(test: T, uboss: string, workspace = tenantId): T =>
    test.set('x-uboss-dev-actor', uboss).set(WORKSPACE_HEADER, workspace) as T;

  /** A published company Skill, driven through the whole lifecycle. */
  const publishSkill = async (key = 'tender-screen', content: SkillContent = CONTENT) => {
    const skill = await skills().createCompanySkill({
      scope: scope(),
      actorUserId: adminId,
      key,
      name: 'Tender eligibility screen',
      content,
      creationMode: 'Manual',
    });
    const versionId = skill.openDraft!.id;

    for (const to of ['Review', 'Approved', 'Published'] as const) {
      await skills().transition({
        scope: scope(),
        actorUserId: to === 'Approved' ? approverId : adminId,
        versionId,
        to,
      });
    }
    return { skillId: skill.id, versionId };
  };

  // =========================================================================
  describe('the router never reaches an unapproved Skill', () => {
    it('selects a published Skill with reasons and a confidence', async () => {
      const published = await publishSkill();

      const result = await router().route({
        scope: scope(),
        actorUserId: employeeId,
        context: CONTEXT,
      });

      assert.equal(result.capabilityMissing, false);
      assert.equal(result.matches.length, 1);
      assert.equal(result.matches[0]?.skillVersionId, published.versionId);
      assert.ok((result.matches[0]?.confidence ?? 0) > 0);
      assert.ok((result.matches[0]?.reasons.length ?? 0) > 0);
      assert.equal(result.candidateId, null);
    });

    it('does not consider a draft at all', async () => {
      // Not "considers and rejects" — a draft is not in the candidate set, so no scoring
      // decision can reach one.
      await skills().createCompanySkill({
        scope: scope(),
        actorUserId: adminId,
        key: 'draft-only',
        name: 'Draft only',
        content: CONTENT,
        creationMode: 'Manual',
      });

      const result = await router().route({
        scope: scope(),
        actorUserId: employeeId,
        context: CONTEXT,
        raiseCandidateIfMissing: false,
      });

      assert.equal(result.capabilityMissing, true);
      assert.equal(result.matches.length, 0);
      assert.equal(result.rejected.length, 0, 'a draft is not even a candidate');
    });

    it('does not consider an approved-but-unpublished version', async () => {
      const skill = await skills().createCompanySkill({
        scope: scope(),
        actorUserId: adminId,
        key: 'approved-only',
        name: 'Approved only',
        content: CONTENT,
        creationMode: 'Manual',
      });
      await skills().transition({
        scope: scope(),
        actorUserId: adminId,
        versionId: skill.openDraft!.id,
        to: 'Review',
      });
      await skills().transition({
        scope: scope(),
        actorUserId: approverId,
        versionId: skill.openDraft!.id,
        to: 'Approved',
      });

      const result = await router().route({
        scope: scope(),
        actorUserId: employeeId,
        context: CONTEXT,
        raiseCandidateIfMissing: false,
      });

      // Approved is not published: the approval decided the content is right, publication
      // decides work may reference it.
      assert.equal(result.capabilityMissing, true);
    });

    it('does not consider a deprecated version', async () => {
      const published = await publishSkill();
      await skills().transition({
        scope: scope(),
        actorUserId: adminId,
        versionId: published.versionId,
        to: 'Deprecated',
        reason: 'The tender portal changed its notice format.',
      });

      const result = await router().route({
        scope: scope(),
        actorUserId: employeeId,
        context: CONTEXT,
        raiseCandidateIfMissing: false,
      });
      assert.equal(result.capabilityMissing, true);
    });

    it('never returns another company’s Skill', async () => {
      await publishSkill();

      const result = await router()
        .route({
          scope: otherScope(),
          actorUserId: employeeId,
          context: CONTEXT,
          raiseCandidateIfMissing: false,
        })
        .catch((error: unknown) => error);

      // The other company has no member with a role here, so the request is refused — which is
      // the right failure. What matters is that no path returns this company's Skill.
      const visible = await ctx.prisma.runInTenantTransaction(otherScope(), () =>
        ctx.prisma.client.skillVersion.count({}),
      );
      assert.equal(visible, 0);
      assert.ok(result instanceof Error);
    });

    it('records in the audit trail that only published versions were considered', async () => {
      await publishSkill();
      await router().route({ scope: scope(), actorUserId: employeeId, context: CONTEXT });

      const event = await ctx.prisma.runAsPlatformOperation(() =>
        ctx.prisma.client.auditEvent.findFirst({
          where: { tenantId, action: 'skill.routed' },
        }),
      );
      const metadata = event?.metadata as Record<string, unknown> | null;
      assert.equal(metadata?.['onlyPublishedConsidered'], true);
      assert.equal(metadata?.['selectedCount'], 1);
    });

    it('needs agents:Run, and an employee has it', async () => {
      await publishSkill();

      // Deliberate: routing is part of doing the work, not administering the catalogue.
      const result = await as(
        agent().post(`/tenants/${tenantId}/skill-router/route`),
        employeeUboss,
      )
        .send(CONTEXT)
        .expect(201);
      assert.equal(result.body.matches.length, 1);
    });

    it('refuses a route with no task', async () => {
      await assert.rejects(
        () =>
          router().route({
            scope: scope(),
            actorUserId: employeeId,
            context: { ...CONTEXT, aiTask: '   ' },
          }),
        /needs to know what the work is/i,
      );
    });

    it('returns at most a small set', async () => {
      for (let index = 0; index < 8; index += 1) {
        await publishSkill(`tender-screen-${index}`);
      }

      const result = await router().route({
        scope: scope(),
        actorUserId: employeeId,
        context: CONTEXT,
      });
      assert.equal(result.matches.length, ROUTER_MAX_RESULTS);
    });
  });

  // =========================================================================
  describe('a missing capability becomes a Candidate, never a publication', () => {
    it('raises a Candidate carrying the context and every rejection', async () => {
      // A published Skill that will be disqualified, so there is a rejection to record.
      await publishSkill('needs-delete', {
        ...CONTENT,
        allowedToolCategories: ['Read', 'Delete'],
        autonomy: 'ProposeForApproval',
      });

      const result = await router().route({
        scope: scope(),
        actorUserId: employeeId,
        context: { ...CONTEXT, allowedToolCategories: ['Read'] },
      });

      assert.equal(result.capabilityMissing, true);
      assert.ok(result.candidateId);
      assert.equal(result.rejected.length, 1);
      assert.match(result.rejected[0]?.disqualifier ?? '', /Delete/);

      const candidate = await ctx.prisma.runAsPlatformOperation(() =>
        ctx.prisma.client.skillCandidate.findFirst({ where: { tenantId } }),
      );
      assert.equal(candidate?.status, 'Suggested');
      assert.equal(candidate?.requestedCapability, CONTEXT.aiTask);
      assert.equal(candidate?.createdSkillId, null);
      // The rejections are on the row, so a reviewer sees what was tried.
      assert.ok(Array.isArray(candidate?.consideredAndRejected));
    });

    it('states in the audit trail that nothing was published and nothing auto-used', async () => {
      await router().route({ scope: scope(), actorUserId: employeeId, context: CONTEXT });

      const event = await ctx.prisma.runAsPlatformOperation(() =>
        ctx.prisma.client.auditEvent.findFirst({
          where: { tenantId, action: 'skill.candidate_raised' },
        }),
      );
      const metadata = event?.metadata as Record<string, unknown> | null;
      assert.equal(metadata?.['nothingPublished'], true);
      assert.equal(metadata?.['nothingAutoUsed'], true);
    });

    it('deduplicates while an earlier request is still open', async () => {
      const first = await router().route({
        scope: scope(),
        actorUserId: employeeId,
        context: CONTEXT,
      });
      const second = await router().route({
        scope: scope(),
        // A **colleague**, not the admin: a Company Admin deliberately holds no `agents:Run`,
        // because administering the company is not doing its work. Using the admin here would
        // have been testing the wrong person.
        actorUserId: colleagueId,
        context: CONTEXT,
      });

      // Forty people hitting the same gap should give a reviewer one thing to decide.
      assert.equal(second.candidateId, first.candidateId);
      const count = await ctx.prisma.runAsPlatformOperation(() =>
        ctx.prisma.client.skillCandidate.count({ where: { tenantId } }),
      );
      assert.equal(count, 1);
    });

    it('accepting a Candidate creates a draft, not a published Skill', async () => {
      const routed = await router().route({
        scope: scope(),
        actorUserId: employeeId,
        context: CONTEXT,
      });

      const accepted = await router().acceptCandidate({
        scope: scope(),
        actorUserId: adminId,
        candidateId: routed.candidateId!,
        key: 'from-candidate',
        name: 'From a candidate',
        content: CONTENT,
        reason: 'Three people have asked for tender screening this month.',
      });

      assert.match(accepted.note, /must go through Review and Approval/i);

      const skill = await skills().view({
        scope: scope(),
        actorUserId: adminId,
        skillId: accepted.skillId,
      });
      // Acceptance decides a capability is wanted, not that this version of it is correct.
      assert.equal(skill.publishedVersion, null);
      assert.equal(skill.openDraft?.status, 'Draft');

      const event = await ctx.prisma.runAsPlatformOperation(() =>
        ctx.prisma.client.auditEvent.findFirst({
          where: { tenantId, action: 'skill.candidate_accepted' },
        }),
      );
      const metadata = event?.metadata as Record<string, unknown> | null;
      assert.equal(metadata?.['createdAs'], 'Draft');
      assert.equal(metadata?.['requiresApprovalBeforeUse'], true);
    });

    it('will not accept a Candidate without a reason', async () => {
      const routed = await router().route({
        scope: scope(),
        actorUserId: employeeId,
        context: CONTEXT,
      });

      await assert.rejects(
        () =>
          router().acceptCandidate({
            scope: scope(),
            actorUserId: adminId,
            candidateId: routed.candidateId!,
            key: 'no-reason',
            name: 'No reason',
            content: CONTENT,
            reason: '  ',
          }),
        /needs a reason/i,
      );
    });

    it('will not reject a Candidate without a reason', async () => {
      const routed = await router().route({
        scope: scope(),
        actorUserId: employeeId,
        context: CONTEXT,
      });

      await assert.rejects(
        () =>
          router().decideCandidate({
            scope: scope(),
            actorUserId: adminId,
            candidateId: routed.candidateId!,
            to: 'Rejected',
          }),
        /they are owed an explanation/i,
      );

      const rejected = await router().decideCandidate({
        scope: scope(),
        actorUserId: adminId,
        candidateId: routed.candidateId!,
        to: 'Rejected',
        reason: 'A person reviews every tender; automating the screen is not wanted yet.',
      });
      assert.equal(rejected.status, 'Rejected');
    });

    it('treats accepted and rejected as final', async () => {
      const routed = await router().route({
        scope: scope(),
        actorUserId: employeeId,
        context: CONTEXT,
      });
      await router().decideCandidate({
        scope: scope(),
        actorUserId: adminId,
        candidateId: routed.candidateId!,
        to: 'Rejected',
        reason: 'Not wanted yet.',
      });

      await assert.rejects(
        () =>
          router().decideCandidate({
            scope: scope(),
            actorUserId: adminId,
            candidateId: routed.candidateId!,
            to: 'UnderReview',
          }),
        /cannot become UnderReview/i,
      );

      await assert.rejects(
        () =>
          router().acceptCandidate({
            scope: scope(),
            actorUserId: adminId,
            candidateId: routed.candidateId!,
            key: 'too-late',
            name: 'Too late',
            content: CONTENT,
            reason: 'Changing our mind after rejecting it.',
          }),
        /cannot be accepted/i,
      );
    });

    it('lets the database refuse an accepted Candidate with no draft', async () => {
      await assert.rejects(
        () =>
          ctx.prisma.runAsPlatformOperation(() =>
            ctx.prisma.client.skillCandidate.create({
              data: {
                tenantId,
                status: 'Accepted',
                requestedCapability: 'Something',
                routingContext: {},
                consideredAndRejected: [],
                reviewedByUserId: adminId,
                reviewedAt: new Date(),
                decisionReason: 'Because.',
              },
            }),
          ),
        /accepted_candidate_produced_a_draft/i,
      );
    });

    it('shows the governance queue with the moves the service will accept', async () => {
      await router().route({ scope: scope(), actorUserId: employeeId, context: CONTEXT });

      const queue = await router().listCandidates({ scope: scope(), actorUserId: adminId });
      assert.equal(queue.candidates.length, 1);
      assert.deepEqual(queue.candidates[0]?.nextStatuses, ['UnderReview', 'Accepted', 'Rejected']);
      assert.match(queue.note, /no path from here to published/i);
    });
  });

  // =========================================================================
  describe('saved evaluation cases', () => {
    it('saves a case against the Skill, not a version', async () => {
      const published = await publishSkill();

      const added = await router().addCase({
        scope: scope(),
        actorUserId: adminId,
        skillId: published.skillId,
        name: 'An eligible notice',
        description: 'A notice we clearly qualify for.',
        inputs: { noticeReference: 'T-1' },
        assertion: 'ExactMatch',
        expected: '{"eligible":true}',
      });
      assert.ok(added.id);

      const cases = await router().listCases({
        scope: scope(),
        actorUserId: adminId,
        skillId: published.skillId,
      });
      assert.equal(cases.cases.length, 1);
      assert.equal(cases.cases[0]?.expectationFrozen, false);
      assert.equal(cases.cases[0]?.runCount, 0);
    });

    it('refuses a case on a platform Skill, naming cloning', async () => {
      const platform = await skills().createPlatformSkill({
        actorUserId: ownerId,
        layer: 'UbossVerified',
        key: 'verified-screen',
        name: 'Verified screen',
        content: CONTENT,
      });

      await assert.rejects(
        () =>
          router().addCase({
            scope: scope(),
            actorUserId: adminId,
            skillId: platform.skillId,
            name: 'Ours',
            description: 'A case of our own.',
            inputs: {},
            assertion: 'ExactMatch',
            expected: 'x',
          }),
        /Clone it to keep your own cases/i,
      );
    });

    it('computes the verdict for a computable assertion', async () => {
      const published = await publishSkill();
      const added = await router().addCase({
        scope: scope(),
        actorUserId: adminId,
        skillId: published.skillId,
        name: 'An eligible notice',
        description: 'A notice we qualify for.',
        inputs: { noticeReference: 'T-1' },
        assertion: 'ExactMatch',
        expected: '{"eligible":true}',
      });

      const pass = await router().recordRun({
        scope: scope(),
        actorUserId: adminId,
        caseId: added.id,
        skillVersionId: published.versionId,
        actualOutput: '{"eligible":true}',
      });
      assert.equal(pass.passed, true);
      assert.equal(pass.computed, true);
    });

    it('leaves a human-judged case unjudged unless somebody judges it', async () => {
      const published = await publishSkill();
      const added = await router().addCase({
        scope: scope(),
        actorUserId: adminId,
        skillId: published.skillId,
        name: 'A borderline notice',
        description: 'A notice where the answer is arguable.',
        inputs: { noticeReference: 'T-2' },
        assertion: 'HumanJudged',
        expected: 'Did it reach a defensible conclusion?',
      });

      const unjudged = await router().recordRun({
        scope: scope(),
        actorUserId: adminId,
        caseId: added.id,
        skillVersionId: published.versionId,
        actualOutput: 'It concluded ineligible on the certification.',
      });
      // A case that silently passed because nobody judged it would be worse than one left open.
      assert.equal(unjudged.passed, null);
      assert.equal(unjudged.computed, false);

      await assert.rejects(
        () =>
          router().recordRun({
            scope: scope(),
            actorUserId: adminId,
            caseId: added.id,
            skillVersionId: published.versionId,
            actualOutput: 'Another attempt.',
            passed: true,
          }),
        /needs a note saying what the judgement was based on/i,
      );

      const judged = await router().recordRun({
        scope: scope(),
        actorUserId: adminId,
        caseId: added.id,
        skillVersionId: published.versionId,
        actualOutput: 'It concluded ineligible on the certification.',
        passed: true,
        note: 'The conclusion matches what the regulatory lead would have said.',
      });
      assert.equal(judged.passed, true);
    });

    it('refuses a run of a case against a different Skill', async () => {
      const first = await publishSkill('first-skill');
      const second = await publishSkill('second-skill');
      const added = await router().addCase({
        scope: scope(),
        actorUserId: adminId,
        skillId: first.skillId,
        name: 'A case',
        description: 'For the first Skill.',
        inputs: {},
        assertion: 'ExactMatch',
        expected: 'x',
      });

      await assert.rejects(
        () =>
          router().recordRun({
            scope: scope(),
            actorUserId: adminId,
            caseId: added.id,
            skillVersionId: second.versionId,
            actualOutput: 'x',
          }),
        /would produce a verdict about nothing/i,
      );
    });

    it('records that the output was supplied rather than generated', async () => {
      const published = await publishSkill();
      const added = await router().addCase({
        scope: scope(),
        actorUserId: adminId,
        skillId: published.skillId,
        name: 'A case',
        description: 'Any case.',
        inputs: {},
        assertion: 'ExactMatch',
        expected: 'x',
      });
      await router().recordRun({
        scope: scope(),
        actorUserId: adminId,
        caseId: added.id,
        skillVersionId: published.versionId,
        actualOutput: 'x',
      });

      const row = await ctx.prisma.runAsPlatformOperation(() =>
        ctx.prisma.client.skillEvaluationRun.findFirst({ where: { tenantId } }),
      );
      // A stub evaluator inventing plausible output would make every green comparison worthless.
      assert.equal(row?.producedBy, 'Recorded');

      const event = await ctx.prisma.runAsPlatformOperation(() =>
        ctx.prisma.client.auditEvent.findFirst({
          where: { tenantId, action: 'skill.evaluation_run_recorded' },
        }),
      );
      const metadata = event?.metadata as Record<string, unknown> | null;
      assert.match(String(metadata?.['note']), /no evaluator exists yet/i);
    });

    it('lets the database refuse a rewritten or deleted run', async () => {
      const published = await publishSkill();
      const added = await router().addCase({
        scope: scope(),
        actorUserId: adminId,
        skillId: published.skillId,
        name: 'A case',
        description: 'Any case.',
        inputs: {},
        assertion: 'ExactMatch',
        expected: 'x',
      });
      await router().recordRun({
        scope: scope(),
        actorUserId: adminId,
        caseId: added.id,
        skillVersionId: published.versionId,
        actualOutput: 'x',
      });

      // A verdict that could be edited afterwards is not evidence.
      await assert.rejects(
        () =>
          ctx.prisma.runAsPlatformOperation(() =>
            ctx.prisma.client.$executeRawUnsafe(
              `UPDATE skill_evaluation_runs SET passed = false WHERE tenant_id = $1`,
              tenantId,
            ),
          ),
        /permission denied/i,
      );
      await assert.rejects(
        () =>
          ctx.prisma.runAsPlatformOperation(() =>
            ctx.prisma.client.$executeRawUnsafe(
              `DELETE FROM skill_evaluation_runs WHERE tenant_id = $1`,
              tenantId,
            ),
          ),
        /permission denied/i,
      );
    });
  });

  // =========================================================================
  describe('regression comparison', () => {
    /** A published Skill with one case, plus a second draft version. */
    const withTwoVersions = async () => {
      const published = await publishSkill();
      const added = await router().addCase({
        scope: scope(),
        actorUserId: adminId,
        skillId: published.skillId,
        name: 'An eligible notice',
        description: 'A notice we qualify for.',
        inputs: { noticeReference: 'T-1' },
        assertion: 'ExactMatch',
        expected: '{"eligible":true}',
      });

      const second = await skills().startNewDraft({
        scope: scope(),
        actorUserId: adminId,
        skillId: published.skillId,
        changes: { validation: 'Two people confirm the conclusion.' },
      });

      return { ...published, caseId: added.id, candidateVersionId: second.id };
    };

    it('is inconclusive with nothing to compare, rather than clean', async () => {
      const setup = await withTwoVersions();

      const result = await router().compare({
        scope: scope(),
        actorUserId: adminId,
        candidateVersionId: setup.candidateVersionId,
      });

      // A comparison with no evidence is not a green light.
      assert.equal(result.verdict, 'Inconclusive');
      assert.equal(result.casesCompared, 0);
      assert.equal(result.unjudged, 1);
      assert.match(result.note, /not a green light/i);
    });

    it('reports a regression, and says it blocks', async () => {
      const setup = await withTwoVersions();

      await router().recordRun({
        scope: scope(),
        actorUserId: adminId,
        caseId: setup.caseId,
        skillVersionId: setup.versionId,
        actualOutput: '{"eligible":true}',
      });
      await router().recordRun({
        scope: scope(),
        actorUserId: adminId,
        caseId: setup.caseId,
        skillVersionId: setup.candidateVersionId,
        actualOutput: '{"eligible":false}',
      });

      const result = await router().compare({
        scope: scope(),
        actorUserId: adminId,
        candidateVersionId: setup.candidateVersionId,
      });

      assert.equal(result.verdict, 'Regressed');
      assert.equal(result.regressions, 1);
      assert.equal(result.blocksPublication, true);
      assert.match(result.note, /blocker until somebody accepts it deliberately/i);
    });

    it('reports no change when both pass', async () => {
      const setup = await withTwoVersions();

      for (const versionId of [setup.versionId, setup.candidateVersionId]) {
        await router().recordRun({
          scope: scope(),
          actorUserId: adminId,
          caseId: setup.caseId,
          skillVersionId: versionId,
          actualOutput: '{"eligible":true}',
        });
      }

      const result = await router().compare({
        scope: scope(),
        actorUserId: adminId,
        candidateVersionId: setup.candidateVersionId,
      });
      assert.equal(result.verdict, 'NoChange');
      assert.equal(result.blocksPublication, false);
    });

    it('freezes the expectations a comparison depended on', async () => {
      const setup = await withTwoVersions();
      for (const versionId of [setup.versionId, setup.candidateVersionId]) {
        await router().recordRun({
          scope: scope(),
          actorUserId: adminId,
          caseId: setup.caseId,
          skillVersionId: versionId,
          actualOutput: '{"eligible":true}',
        });
      }
      await router().compare({
        scope: scope(),
        actorUserId: adminId,
        candidateVersionId: setup.candidateVersionId,
      });

      const cases = await router().listCases({
        scope: scope(),
        actorUserId: adminId,
        skillId: setup.skillId,
      });
      // A case whose expectation could be edited after a comparison is evidence that can be made
      // to agree with whatever happened.
      assert.equal(cases.cases[0]?.expectationFrozen, true);
    });

    it('refuses to compare the published version with itself', async () => {
      const published = await publishSkill();

      await assert.rejects(
        () =>
          router().compare({
            scope: scope(),
            actorUserId: adminId,
            candidateVersionId: published.versionId,
          }),
        /already the published one/i,
      );
    });

    it('requires a real reason to publish over a regression, and records who', async () => {
      const setup = await withTwoVersions();
      await router().recordRun({
        scope: scope(),
        actorUserId: adminId,
        caseId: setup.caseId,
        skillVersionId: setup.versionId,
        actualOutput: '{"eligible":true}',
      });
      await router().recordRun({
        scope: scope(),
        actorUserId: adminId,
        caseId: setup.caseId,
        skillVersionId: setup.candidateVersionId,
        actualOutput: '{"eligible":false}',
      });
      const comparison = await router().compare({
        scope: scope(),
        actorUserId: adminId,
        candidateVersionId: setup.candidateVersionId,
      });

      await assert.rejects(
        () =>
          router().acceptRegression({
            scope: scope(),
            actorUserId: adminId,
            comparisonId: comparison.id,
            reason: 'fine',
          }),
        /needs a real reason/i,
      );

      await router().acceptRegression({
        scope: scope(),
        actorUserId: adminId,
        comparisonId: comparison.id,
        reason: 'The old case encoded a portal rule that no longer applies; it will be retired.',
      });

      const comparisons = await router().comparisonsFor({
        scope: scope(),
        actorUserId: adminId,
        skillId: setup.skillId,
      });
      assert.equal(comparisons.comparisons[0]?.acceptedDespiteRegression, true);
      assert.match(comparisons.comparisons[0]?.acceptanceReason ?? '', /no longer applies/);
    });

    it('refuses to accept a regression that does not exist', async () => {
      const setup = await withTwoVersions();
      for (const versionId of [setup.versionId, setup.candidateVersionId]) {
        await router().recordRun({
          scope: scope(),
          actorUserId: adminId,
          caseId: setup.caseId,
          skillVersionId: versionId,
          actualOutput: '{"eligible":true}',
        });
      }
      const comparison = await router().compare({
        scope: scope(),
        actorUserId: adminId,
        candidateVersionId: setup.candidateVersionId,
      });

      await assert.rejects(
        () =>
          router().acceptRegression({
            scope: scope(),
            actorUserId: adminId,
            comparisonId: comparison.id,
            reason: 'Accepting something that did not happen.',
          }),
        /found no regression/i,
      );
    });

    it('lets the database refuse a deleted comparison', async () => {
      const setup = await withTwoVersions();
      await router().compare({
        scope: scope(),
        actorUserId: adminId,
        candidateVersionId: setup.candidateVersionId,
      });

      await assert.rejects(
        () =>
          ctx.prisma.runAsPlatformOperation(() =>
            ctx.prisma.client.$executeRawUnsafe(
              `DELETE FROM skill_regression_comparisons WHERE tenant_id = $1`,
              tenantId,
            ),
          ),
        /permission denied/i,
      );
    });
  });

  // =========================================================================
  describe('the API surface', () => {
    it('publishes its own parameters, and the rules it enforces', async () => {
      const meta = await as(
        agent().get(`/tenants/${tenantId}/skill-router/meta`),
        employeeUboss,
      ).expect(200);

      assert.equal(meta.body.maxResults, ROUTER_MAX_RESULTS);
      assert.equal(meta.body.assertions.length, 3);
      assert.equal(meta.body.candidateStatuses.length, 4);
      assert.match(meta.body.note, /never publishes and never uses an unapproved version/i);
    });

    it('runs the whole evaluation flow over HTTP', async () => {
      const published = await publishSkill();

      const added = await as(
        agent().post(`/tenants/${tenantId}/skill-router/skills/${published.skillId}/cases`),
        adminUboss,
      )
        .send({
          name: 'An eligible notice',
          description: 'A notice we clearly qualify for.',
          inputs: { noticeReference: 'T-1' },
          assertion: 'ExactMatch',
          expected: '{"eligible":true}',
        })
        .expect(201);

      const run = await as(agent().post(`/tenants/${tenantId}/skill-router/runs`), adminUboss)
        .send({
          caseId: added.body.id,
          skillVersionId: published.versionId,
          actualOutput: '{"eligible":true}',
        })
        .expect(201);
      assert.equal(run.body.passed, true);
      assert.match(run.body.note, /computed from the assertion/i);

      const cases = await as(
        agent().get(`/tenants/${tenantId}/skill-router/skills/${published.skillId}/cases`),
        adminUboss,
      ).expect(200);
      assert.equal(cases.body.cases[0].runCount, 1);
    });

    it('lets an employee route and not administer cases', async () => {
      const published = await publishSkill();

      await as(agent().post(`/tenants/${tenantId}/skill-router/route`), employeeUboss)
        .send(CONTEXT)
        .expect(201);

      await as(
        agent().post(`/tenants/${tenantId}/skill-router/skills/${published.skillId}/cases`),
        employeeUboss,
      )
        .send({
          name: 'Mine',
          description: 'An employee adding a case.',
          inputs: {},
          assertion: 'ExactMatch',
          expected: 'x',
        })
        .expect(403);
    });

    it('refuses an unknown assertion and an unknown tool category at the boundary', async () => {
      const published = await publishSkill();

      await as(
        agent().post(`/tenants/${tenantId}/skill-router/skills/${published.skillId}/cases`),
        adminUboss,
      )
        .send({
          name: 'Bad assertion',
          description: 'Not a real assertion.',
          inputs: {},
          assertion: 'Vibes',
          expected: 'x',
        })
        .expect(400);

      await as(agent().post(`/tenants/${tenantId}/skill-router/route`), employeeUboss)
        .send({ ...CONTEXT, allowedToolCategories: ['Administer'] })
        .expect(400);
    });

    it('serves the candidate queue over HTTP and rejects one with a reason', async () => {
      const routed = await as(
        agent().post(`/tenants/${tenantId}/skill-router/route`),
        employeeUboss,
      )
        .send(CONTEXT)
        .expect(201);
      assert.ok(routed.body.candidateId);

      const queue = await as(
        agent().get(`/tenants/${tenantId}/skill-router/candidates?status=Suggested`),
        adminUboss,
      ).expect(200);
      assert.equal(queue.body.candidates.length, 1);

      await as(
        agent().post(
          `/tenants/${tenantId}/skill-router/candidates/${routed.body.candidateId}/decide`,
        ),
        adminUboss,
      )
        .send({ to: 'Rejected', reason: 'A person reviews every tender by policy.' })
        .expect(201);
    });

    it('never lets a Candidate be set to a published state, because there is none', async () => {
      const routed = await router().route({
        scope: scope(),
        actorUserId: employeeId,
        context: CONTEXT,
      });

      // The client's rule expressed as the absence of a value: the enum has no such member, so
      // the database itself refuses.
      await assert.rejects(
        () =>
          ctx.prisma.runAsPlatformOperation(() =>
            ctx.prisma.client.$executeRawUnsafe(
              `UPDATE skill_candidates SET status = 'Published' WHERE id = $1`,
              routed.candidateId,
            ),
          ),
        /invalid input value for enum|Published/i,
      );
    });
  });
});
