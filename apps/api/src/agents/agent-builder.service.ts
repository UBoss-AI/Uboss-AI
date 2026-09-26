import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';

import {
  executionStages,
  type AgentObjectiveContext,

  agentTestProblems,
  ALLOWED_ENGINE_AGENT_TRANSITIONS,
  emptyAgentExecutionSetup,
  FORM3_JOB_LEVEL_FIELDS,
  MISSING_DATA_BEHAVIOURS,
  missingSetupFields,
  runTypeNeedsSchedule,
  setupIsComplete,
  type AgentExecutionSetup,
  type AgentRunType,
  type AgentSetupPrefill,
  type AgentTestRunView,
  type AgentTestStatus,
  type Form3ActionRow,
  type Form3JobLevelFieldKey,
  type Form3View,
  type MissingSetupField,
  type ToolActionCategory,
  type WorkflowDraft,
} from '@uboss/types';

import { AuditEventService } from '../audit/audit-event.service.js';
import { AuthorizationService } from '../authorization/authorization.service.js';
import { ConnectionService } from '../connections/connection.service.js';
import { ModelGateway } from '../model-gateway/model-gateway.js';
import { PrismaService } from '../persistence/prisma.service.js';
import type { TenantScope } from '../persistence/tenant-context.js';

/** One thing standing between the agent and activation. */
export interface AgentReadinessFinding {
  /** `Blocker` stops activation; `Warning` is shown and may be accepted. */
  severity: 'Blocker' | 'Warning';
  summary: string;
}

/** What the Agent Builder screen renders. */
export interface AgentBuilderView {
  assignmentId: string;
  status: string;

  /**
   * Where this work sits in the objective that asked for it.
   *
   * Null when the objective version behind it can no longer be read. The builder still opens:
   * an assignment whose objective was archived is still an assignment, and saying what is known
   * beats refusing to show anything.
   */
  context: AgentObjectiveContext | null;

  /** Prefilled and read-only: inherited from the objective, the workflow and policy. */
  prefill: AgentSetupPrefill;
  /** What has been answered so far. */
  setup: AgentExecutionSetup;

  /**
   * The zero-question rule's answer. Empty means the screen asks nothing and offers
   * *Ready to Test / Activate*.
   */
  missing: MissingSetupField[];
  /** True when this work needs a connection at all — drives whether one is even asked for. */
  needsConnection: boolean;

  readiness: {
    /** Connection state, from the connections module rather than re-derived here. */
    connection: { connectionId: string | null; state: string; reason: string } | null;
    findings: AgentReadinessFinding[];
    readyToTest: boolean;
    readyToActivate: boolean;
  };

  lastTest: {
    at: string | null;
    passed: boolean | null;
    summary: string | null;
    /** False for a mock run. Never presented as a real provider result. */
    wasReal: boolean | null;
  };

  /**
   * Every test of this agent, newest first, capped at what a person will actually read.
   *
   * `lastTest` above answers "is it ready"; this answers "does it do the right thing", which is
   * the question somebody is really asking when they press Test. They need the input they gave,
   * the output they got, and the run before it to compare against.
   */
  testHistory: AgentTestRunView[];

  engineAgent: { id: string; name: string; status: string; versionNumber: number } | null;

  /** The closed vocabularies, so the screen's controls cannot drift from the server's. */
  vocabulary: {
    runTypes: readonly string[];
    missingDataBehaviours: readonly string[];
  };

  note: string;
}

/**
 * Agent Builder — Prompt 24.
 *
 * ## It is not a form
 *
 * Prompt 23 already wrote an `AgentSetupPrefill` for every AI node it assigned, derived from the
 * objective, the edited workflow and company policy. This service's job is to show what is
 * already known and ask only for what genuinely is not. That is the client's ZERO-QUESTION RULE,
 * and it lives in one place — `missingSetupFields` in the shared types — so the screen and the
 * server cannot disagree about whether a question needs asking.
 *
 * The employee never re-enters the job method. The canonical Form 3 remains available to
 * authorized users as a **view** composed from records that already exist (`form3`), exactly as
 * the source document requires: "not a blank form every employee must re-enter".
 *
 * ## What activation does
 *
 * Creates or maps the reusable **Engine Agent**, per the source document: "Creates/activates the
 * reusable Engine Agent when readiness is satisfied." One agent, then Runs — recurring work never
 * mints a second agent for the same job.
 *
 * Readiness is what the document says it is: the setup complete, an approved published Skill
 * behind the work, and a usable connection where the work needs one. A passed test is **not**
 * part of it, because the document does not make it so; inventing that gate would block work the
 * client never said to block. The test result is recorded and shown, and a reviewer can see that
 * an agent was activated untested.
 *
 * ## Secrets
 *
 * Nothing here reads or returns a credential. The builder selects a *connection*, by id, and the
 * connections module answers whether it may be used. "Do not expose raw API keys" is satisfied
 * structurally: this service has no code path that could.
 */
@Injectable()
export class AgentBuilderService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly authorization: AuthorizationService,
    private readonly auditEvents: AuditEventService,
    private readonly connections: ConnectionService,
    /// The provider seam. A test runs through this, so a mock is visibly a mock.
    private readonly modelGateway: ModelGateway,
  ) {}

  // -------------------------------------------------------------------------
  // Reading
  // -------------------------------------------------------------------------

  /** The builder screen for one assigned piece of AI work. */
  async view(input: {
    scope: TenantScope;
    actorUserId: string;
    assignmentId: string;
  }): Promise<AgentBuilderView> {
    const context = await this.authorization.contextFor(input.scope, input.actorUserId);
    await this.authorization.assertCan(context, { module: 'agent-builder', action: 'View' });

    return this.prisma.runInTenantTransaction(input.scope, async () => {
      const assignment = await this.loadAssignment(input.assignmentId);
      await this.assertMayTouch(context, assignment, 'View');
      return this.viewOf(input.scope, assignment);
    });
  }

  /** Everything awaiting agent setup that this person may act on. */
  async list(input: {
    scope: TenantScope;
    actorUserId: string;
  }): Promise<{ assignments: AgentBuilderView[]; note: string }> {
    const context = await this.authorization.contextFor(input.scope, input.actorUserId);
    await this.authorization.assertCan(context, { module: 'agent-builder', action: 'View' });

    return this.prisma.runInTenantTransaction(input.scope, async () => {
      const rows = await this.prisma.client.aiWorkAssignment.findMany({
        where: { tenantId: input.scope.tenantId },
        orderBy: { createdAt: 'desc' },
      });

      const views: AgentBuilderView[] = [];
      for (const row of rows) {
        // Sequentially, not `Promise.all`: each of these reads inside the open tenant
        // transaction, and concurrent work inside one loses the AsyncLocalStorage scope, which
        // makes the reads unscoped. An unscoped read under RLS is not a loud failure — it
        // silently returns nothing, and the answer is quietly wrong.
        if (!(await this.mayTouch(context, row, 'View', await this.departmentOf(row)))) continue;
        views.push(await this.viewOf(input.scope, row));
      }

      return {
        assignments: views,
        note:
          'Only work you are permitted to set up is listed. Hidden navigation is presentation ' +
          'only — every route checks this again on the server.',
      };
    });
  }

  // -------------------------------------------------------------------------
  // Answering the questions that remain
  // -------------------------------------------------------------------------

  /**
   * Record part of the execution setup.
   *
   * A patch, not a replacement, so answering one question never blanks another. Each field is
   * validated against its closed vocabulary — the screen offers a select, but the route is what
   * protects the data.
   */
  /**
   * Add or replace the Skills attached to a piece of assigned AI work.
   *
   * ## Automatic matching is not replaced by this
   *
   * The objective analysis still proposes Skills, and what it proposed is what a builder opens.
   * This is the override: a person who knows the work can swap a matched Skill for a better one,
   * or attach one the analysis did not find. What they cannot do is reach past a control, and
   * every control the automatic path goes through is re-applied here rather than assumed:
   *
   *   • **Permission** — `agent-builder:EditDraft`, asserted here as well as on the route, and
   *     then `assertMayTouch` for this particular assignment. A standard Employee holds no Agent
   *     Builder grant at all, so this is not a second door into the catalogue.
   *   • **Tenant** — the version ids are resolved inside this company's scope, so a
   *     `CompanyCustom` Skill belonging to another company simply does not resolve.
   *   • **Entitlement** — an Industry Pack Skill is refused unless this company holds the pack.
   *   • **Lifecycle** — only a `Published` version may be attached. A draft is refused by name,
   *     because "why can I see it but not pick it" is the question that follows otherwise.
   *   • **Already live** — refused once the work is running on an Engine Agent, exactly as
   *     `saveSetup` refuses: changing a live agent is a new version of that agent.
   *
   * ## What is pinned
   *
   * A **version** id, not a Skill id. The agent keeps running that version when a newer one is
   * published, which is the whole point of pinning — an upgrade is a separate, deliberate act
   * with its own impact analysis.
   */
  async setSkills(input: {
    scope: TenantScope;
    actorUserId: string;
    assignmentId: string;
    skillVersionIds: string[];
  }): Promise<AgentBuilderView> {
    const context = await this.authorization.contextFor(input.scope, input.actorUserId);
    await this.authorization.assertCan(context, { module: 'agent-builder', action: 'EditDraft' });

    if (new Set(input.skillVersionIds).size !== input.skillVersionIds.length) {
      throw new BadRequestException('The same Skill version is listed twice.');
    }

    return this.prisma.runInTenantTransaction(input.scope, async () => {
      const assignment = await this.loadAssignment(input.assignmentId);
      await this.assertMayTouch(context, assignment, 'EditDraft');

      if (assignment.engineAgentId !== null) {
        throw new ConflictException(
          'This work is already running on an Engine Agent. Changing which Skills it uses is a ' +
            'new version of that agent, not an edit to the setup that created it.',
        );
      }

      if (input.skillVersionIds.length > 0) {
        const versions = await this.prisma.client.skillVersion.findMany({
          where: { id: { in: input.skillVersionIds } },
          include: { skill: true },
        });

        const found = new Set(versions.map((version) => version.id));
        const missing = input.skillVersionIds.filter((id) => !found.has(id));
        if (missing.length > 0) {
          // Not found and not-ours are the same answer on purpose: saying "that belongs to
          // another company" would confirm it exists.
          throw new NotFoundException(
            `No Skill version you can use: ${missing.join(', ')}.`,
          );
        }

        const packs = await this.prisma.client.tenantSkillPack.findMany({
          where: { tenantId: input.scope.tenantId },
          select: { industry: true },
        });
        const entitled = new Set(packs.map((pack) => pack.industry));

        for (const version of versions) {
          if (version.status !== 'Published') {
            throw new ConflictException(
              `"${version.skill.name}" is ${version.status}, not Published. Work may only ` +
                'reference an approved and published Skill version.',
            );
          }
          if (
            version.skill.layer === 'IndustryPack' &&
            !entitled.has(version.skill.industry ?? '')
          ) {
            throw new ForbiddenException(
              `"${version.skill.name}" belongs to the ${version.skill.industry} Industry Pack, ` +
                'which this company is not entitled to.',
            );
          }
        }
      }

      const prefill = this.prefillOf(assignment);
      const before = prefill.skillVersionIds;

      await this.prisma.client.aiWorkAssignment.update({
        where: { id: assignment.id },
        data: {
          setupPrefill: {
            ...prefill,
            skillVersionIds: input.skillVersionIds,
          } as unknown as object,
        },
      });

      await this.auditEvents.appendWithinCurrentScope(input.scope.tenantId, {
        action: 'agent-builder.skills_changed',
        resourceType: 'objective-assignment',
        resourceId: assignment.id,
        actorUserId: input.actorUserId,
        summary:
          `Attached Skills changed by hand: ${before.length} → ${input.skillVersionIds.length}.`,
        metadata: {
          assignmentId: assignment.id,
          from: before.join(','),
          to: input.skillVersionIds.join(','),
          // The record that says this was a person's choice rather than the analysis's.
          chosenManually: true,
        },
      });

      return this.viewOf(input.scope, await this.loadAssignment(input.assignmentId));
    });
  }

  async saveSetup(input: {
    scope: TenantScope;
    actorUserId: string;
    assignmentId: string;
    patch: Partial<AgentExecutionSetup>;
  }): Promise<AgentBuilderView> {
    const context = await this.authorization.contextFor(input.scope, input.actorUserId);
    await this.authorization.assertCan(context, { module: 'agent-builder', action: 'EditDraft' });

    return this.prisma.runInTenantTransaction(input.scope, async () => {
      const assignment = await this.loadAssignment(input.assignmentId);
      await this.assertMayTouch(context, assignment, 'EditDraft');

      if (assignment.engineAgentId !== null) {
        throw new ConflictException(
          'This work is already running on an Engine Agent. Changing how a live agent runs is a ' +
            'new version of that agent, not an edit to the setup that created it.',
        );
      }

      const current = this.setupOf(assignment);
      const next: AgentExecutionSetup = { ...current, ...input.patch };

      if (next.runType !== null && !this.isRunType(next.runType)) {
        throw new BadRequestException(
          `Unknown Run Type "${String(next.runType)}". One of: ${this.runTypes().join(', ')}.`,
        );
      }
      if (
        next.missingDataBehaviour !== null &&
        !MISSING_DATA_BEHAVIOURS.includes(next.missingDataBehaviour)
      ) {
        throw new BadRequestException(
          `Unknown Missing/Wrong Data behaviour "${String(next.missingDataBehaviour)}". ` +
            `One of: ${MISSING_DATA_BEHAVIOURS.join(', ')}.`,
        );
      }

      // A trigger on a run type that has no schedule is not an error to refuse — it is an answer
      // that stopped applying when the run type changed. Clearing it is the honest move; keeping
      // it would leave "Monday 10:30" attached to a manual agent.
      if (next.runType !== null && !runTypeNeedsSchedule(next.runType)) {
        next.triggerOrFrequency = null;
      }

      if (next.inputConnectionId !== null) {
        await this.assertConnectionUsable(input.scope, assignment, next.inputConnectionId);
      }

      const saved = await this.prisma.client.aiWorkAssignment.update({
        where: { id: assignment.id },
        data: {
          executionSetup: next as unknown as object,
          version: { increment: 1 },
        },
      });

      const answered = Object.keys(input.patch);
      await this.auditEvents.appendWithinCurrentScope(input.scope.tenantId, {
        action: 'agent.setup_recorded',
        resourceType: 'agent-builder',
        resourceId: assignment.id,
        actorUserId: input.actorUserId,
        resourceVersion: saved.version,
        summary:
          `Recorded ${answered.join(', ')} for "${assignment.title}". The job method itself is ` +
          'inherited from the objective and was not re-entered.',
        metadata: {
          answered: answered.join(', '),
          stillMissing:
            missingSetupFields(next, this.needsConnection(assignment))
              .map((entry) => entry.field)
              .join(', ') || 'nothing',
        },
      });

      return this.viewOf(input.scope, saved);
    });
  }

  // -------------------------------------------------------------------------
  // Test
  // -------------------------------------------------------------------------

  /**
   * A controlled test before activation.
   *
   * Runs the work through the Model Gateway once and records what came back, including whether a
   * real provider was involved. It writes nothing outside UBoss: a test that delivered to the
   * real output destination would not be a test.
   */
  async test(input: {
    scope: TenantScope;
    actorUserId: string;
    assignmentId: string;
    /** The admin's sample data. Required: an agent tested against nothing proves nothing. */
    sampleInput: string;
    /** What they expected. Recorded and shown, never machine-compared — see the type's note. */
    expectedOutcome?: string | null;
  }): Promise<AgentBuilderView> {
    const context = await this.authorization.contextFor(input.scope, input.actorUserId);
    await this.authorization.assertCan(context, { module: 'agent-builder', action: 'EditDraft' });

    // Checked before the permission work has any effect and before the clock starts: a refusal
    // for a reason the screen could have told them is not worth a row in the history.
    const problems = agentTestProblems({
      sampleInput: input.sampleInput,
      expectedOutcome: input.expectedOutcome ?? null,
    });
    if (problems.length > 0) {
      throw new BadRequestException(problems.join(' '));
    }

    const assignment = await this.prisma.runInTenantTransaction(input.scope, async () => {
      const row = await this.loadAssignment(input.assignmentId);
      await this.assertMayTouch(context, row, 'EditDraft');

      const setup = this.setupOf(row);
      if (!setupIsComplete(setup, this.needsConnection(row))) {
        throw new ConflictException(
          'This agent still has unanswered setup, so a test would not be testing what would ' +
            'actually run.',
        );
      }
      return row;
    });

    const prefill = this.prefillOf(assignment);
    const setup = this.setupOf(assignment);

    // Outside the transaction: the provider call can be slow, and holding a database transaction
    // open across it would pin a connection for its duration.
    const sampleInput = input.sampleInput.trim();
    const expectedOutcome = (input.expectedOutcome ?? '').trim() || null;

    /*
     * Said out loud rather than left for the reader to notice.
     *
     * Unanswered setup already stopped this above, so these are the things that are true but not
     * disqualifying — most often that the answer came from the mock gateway. They go on the run
     * because a result read a week later has to carry the conditions it was produced under.
     */
    const warnings: string[] = [];
    const errors: string[] = [];

    let passed: boolean;
    let summary: string;
    let wasReal = false;
    let threw = false;
    let output: string | null = null;
    let capability: string | null = null;
    const startedAt = Date.now();
    try {
      const response = await this.modelGateway.complete({
        // Section 18: AGENT_STANDARD is "normal AI work", which is what a builder test
        // rehearses. Not AGENT_FAST — a test whose answer came from a cheaper model than the
        // real runs would use is not a test of anything.
        profile: 'AGENT_STANDARD',
        purpose: 'AgentBuilderTest',
        instruction:
          'Perform this assigned AI work once, against the sample input below, and report what ' +
          'you would produce. Do not deliver it anywhere.',
        context: [
          `Objective: ${prefill.objectiveName}`,
          `Assigned AI work: ${prefill.assignedWork}`,
          `Skill versions: ${prefill.skillVersionIds.join(', ') || 'none'}`,
          `Where the work happens: ${setup.whereWorkHappens ?? 'unspecified'}`,
          `Output destination (not written to during a test): ${setup.outputDestination ?? 'unspecified'}`,
          `On missing or wrong data: ${setup.missingDataBehaviour ?? 'unspecified'}`,
          '',
          // Last, and labelled: everything above is configuration, and this is the thing being
          // worked on. A sample folded in among the settings gets read as another setting.
          'Sample input to work on:',
          sampleInput,
          ...(expectedOutcome === null
            ? []
            : [
                '',
                // Given as context, never as a target. An agent told the expected answer will
                // produce the expected answer, and the test would confirm nothing.
                'For context only, what the person running this test expects. Do not treat it ' +
                  'as the answer:',
                expectedOutcome,
              ]),
        ].join('\n'),
        maxTokens: 400,
        tenantId: input.scope.tenantId,
      });
      wasReal = response.producedByRealModel;
      capability = response.capability;
      output = response.output.trim() === '' ? null : response.output;
      passed = output !== null;
      summary = passed
        ? `The agent produced output for "${prefill.assignedWork}" using ${response.capability}.`
        : 'The agent produced nothing, so there is no evidence it can do this work.';
      if (!wasReal) {
        warnings.push(
          'This answer came from the mock gateway, not a provider. It shows the agent is wired ' +
            'up; it is not evidence about the quality of its work.',
        );
      }
      if (!passed) {
        errors.push('The agent returned nothing at all.');
      }
    } catch (caught) {
      passed = false;
      threw = true;
      // Recorded, not swallowed. A test that failed for an infrastructure reason must not read
      // as the work being impossible.
      const reason = caught instanceof Error ? caught.message : String(caught);
      summary = `The test could not complete: ${reason}`;
      errors.push(reason);
    }

    const durationMs = Date.now() - startedAt;
    // `Failed` is a fact about the agent; `Error` is a fact about the test. Keeping them apart is
    // the whole reason both exist — see AGENT_TEST_STATUSES.
    const status: AgentTestStatus = passed ? 'Passed' : threw ? 'Error' : 'Failed';

    return this.prisma.runInTenantTransaction(input.scope, async () => {
      const saved = await this.prisma.client.aiWorkAssignment.update({
        where: { id: assignment.id },
        data: {
          lastTestedAt: new Date(),
          lastTestPassed: passed,
          lastTestSummary: summary,
          lastTestWasReal: wasReal,
          version: { increment: 1 },
        },
      });

      /*
       * The run itself, kept.
       *
       * The four columns above are overwritten by the next test; this row is not. An admin
       * deciding whether to publish is comparing this attempt with the last one, and that
       * comparison needs both to still exist.
       */
      await this.prisma.client.agentBuilderTestRun.create({
        data: {
          tenantId: input.scope.tenantId,
          aiWorkAssignmentId: assignment.id,
          sampleInput,
          expectedOutcome,
          output,
          status,
          warnings,
          errors,
          durationMs,
          wasReal,
          capability,
          ranByUserId: input.actorUserId,
        },
      });

      await this.auditEvents.appendWithinCurrentScope(input.scope.tenantId, {
        action: 'agent.tested',
        resourceType: 'agent-builder',
        resourceId: assignment.id,
        actorUserId: input.actorUserId,
        resourceVersion: saved.version,
        summary,
        metadata: {
          passed,
          status,
          durationMs,
          // Stored on the event as well as the row, so an audit reader never has to assume.
          producedByRealModel: wasReal,
          modelWasMocked: !wasReal,
        },
      });

      return this.viewOf(input.scope, saved);
    });
  }

  // -------------------------------------------------------------------------
  // Activate
  // -------------------------------------------------------------------------

  /**
   * Create or map the reusable Engine Agent.
   *
   * One transaction: the agent, its first immutable version, and the assignment's mapping either
   * all exist afterwards or none of them do. A half-activated agent — a row with no configuration,
   * or work pointing at an agent that was never versioned — is the state that makes an operations
   * screen lie.
   */
  async activate(input: {
    scope: TenantScope;
    actorUserId: string;
    assignmentId: string;
    /** Rename at activation, where policy permits. Defaults to the suggested name. */
    agentName?: string | undefined;
  }): Promise<AgentBuilderView> {
    const context = await this.authorization.contextFor(input.scope, input.actorUserId);
    await this.authorization.assertCan(context, { module: 'agent-builder', action: 'Run' });

    const activated = await this.prisma.runInTenantTransaction(input.scope, async () => {
      const assignment = await this.loadAssignment(input.assignmentId);
      await this.assertMayTouch(context, assignment, 'Run');

      if (assignment.engineAgentId !== null) {
        throw new ConflictException(
          'This work already has an Engine Agent. Recurring work creates Runs on the agent it ' +
            'already has; it never creates a second agent for the same job.',
        );
      }

      const prefill = this.prefillOf(assignment);
      const setup = this.setupOf(assignment);
      const readiness = await this.readinessOf(input.scope, assignment, setup, prefill);

      const blockers = readiness.findings.filter((finding) => finding.severity === 'Blocker');
      if (blockers.length > 0) {
        throw new ConflictException(
          `This agent is not ready to activate. ${blockers.map((finding) => finding.summary).join(' ')}`,
        );
      }

      const name = (input.agentName ?? prefill.suggestedAgentName).trim();
      if (name === '') {
        throw new BadRequestException(
          'An Engine Agent needs a name; it is how people refer to it.',
        );
      }

      const clash = await this.prisma.client.engineAgent.findFirst({
        where: { tenantId: input.scope.tenantId, name },
      });
      if (clash) {
        throw new ConflictException(
          `This company already has an Engine Agent called "${name}". Two agents with one name ` +
            'makes an operations screen unreadable — choose another, or reuse that agent.',
        );
      }

      const owner = prefill.ownerUserId ?? input.actorUserId;

      const agent = await this.prisma.client.engineAgent.create({
        data: {
          tenantId: input.scope.tenantId,
          name,
          ownerUserId: owner,
          status: 'Ready',
          createdByUserId: input.actorUserId,
        },
      });

      const firstVersion = await this.prisma.client.engineAgentVersion.create({
        data: {
          tenantId: input.scope.tenantId,
          engineAgentId: agent.id,
          versionNumber: 1,
          status: 'Published',
          config: {
            setup,
            skillVersionIds: prefill.skillVersionIds,
            toolCategories: prefill.toolCategories,
            approvalRequired: prefill.approvalRequired,
            completionEvidence: prefill.completionEvidence,
            assignedWork: prefill.assignedWork,
          } as unknown as object,
          publishedAt: new Date(),
          publishedByUserId: input.actorUserId,
          createdByUserId: input.actorUserId,
        },
      });

      // `Ready` then `Active`: the status vocabulary says activation passes through readiness, and
      // skipping it would skip the check that `Ready` represents.
      if (!ALLOWED_ENGINE_AGENT_TRANSITIONS.Ready.includes('Active')) {
        throw new ConflictException('The Engine Agent lifecycle does not permit activation.');
      }

      const live = await this.prisma.client.engineAgent.update({
        where: { id: agent.id },
        data: {
          status: 'Active',
          currentVersionId: firstVersion.id,
          activatedAt: new Date(),
          activatedByUserId: input.actorUserId,
          version: { increment: 1 },
        },
      });

      const saved = await this.prisma.client.aiWorkAssignment.update({
        where: { id: assignment.id },
        data: {
          engineAgentId: live.id,
          status: 'MappedToEngineAgent',
          version: { increment: 1 },
        },
      });

      await this.auditEvents.appendWithinCurrentScope(input.scope.tenantId, {
        action: 'agent.activated',
        resourceType: 'engine-agent',
        resourceId: live.id,
        actorUserId: input.actorUserId,
        resourceRef: live.name,
        resourceVersion: live.version,
        summary:
          `Activated the reusable Engine Agent "${live.name}" for "${assignment.title}". ` +
          'Recurring work will create Runs on this agent, never another agent.',
        metadata: {
          assignmentId: assignment.id,
          versionNumber: firstVersion.versionNumber,
          // Recorded because activation does not require a passing test. A reviewer must be able
          // to see that this one went live untested rather than infer it.
          testedBeforeActivation: assignment.lastTestedAt !== null,
          lastTestPassed: assignment.lastTestPassed,
          lastTestUsedRealModel: assignment.lastTestWasReal ?? false,
        },
      });

      return { assignment: saved, agent: live };
    });

    return this.prisma.runInTenantTransaction(input.scope, () =>
      this.viewOf(input.scope, activated.assignment),
    );
  }

  // -------------------------------------------------------------------------
  // Form 3 — the advanced authorized view
  // -------------------------------------------------------------------------

  /**
   * The canonical job method, composed from records that already exist.
   *
   * The source document is explicit that this is a *view*: "the complete job-definition view for
   * authorized users. It is not a blank form every employee must re-enter." So nothing here is
   * stored and nothing is asked — Form 2 supplies the job-level context, the manager's edited
   * workflow supplies the action grid, and the agent's setup supplies where the work runs and
   * where its output goes.
   *
   * `composedFrom` travels with it because an authorized reader needs to know which record each
   * part came from; otherwise it reads as a single authored document nobody actually wrote.
   */
  async form3(input: {
    scope: TenantScope;
    actorUserId: string;
    assignmentId: string;
  }): Promise<Form3View> {
    const context = await this.authorization.contextFor(input.scope, input.actorUserId);
    // A higher bar than the builder itself: this is the whole job method, across every step,
    // including work belonging to other people.
    await this.authorization.assertCan(context, { module: 'agent-builder', action: 'Publish' });

    return this.prisma.runInTenantTransaction(input.scope, async () => {
      const assignment = await this.loadAssignment(input.assignmentId);
      await this.assertMayTouch(context, assignment, 'Publish');

      const version = await this.prisma.client.objectiveVersion.findFirst({
        where: { tenantId: input.scope.tenantId, id: assignment.objectiveVersionId },
        include: { steps: { orderBy: { position: 'asc' } } },
      });
      if (!version) {
        throw new NotFoundException('The objective version behind this work is not available.');
      }

      const objective = await this.prisma.client.objective.findFirst({
        where: { tenantId: input.scope.tenantId, id: assignment.objectiveId },
      });
      const department = version.departmentId
        ? await this.prisma.client.department.findFirst({
            where: { tenantId: input.scope.tenantId, id: version.departmentId },
          })
        : null;

      const draft = await this.prisma.client.objectiveWorkflowDraft.findFirst({
        where: { tenantId: input.scope.tenantId, id: assignment.workflowDraftId },
      });
      const graph = (draft?.graph ?? null) as WorkflowDraft | null;

      const prefill = this.prefillOf(assignment);
      const setup = this.setupOf(assignment);

      const jobLevel = {} as Record<Form3JobLevelFieldKey, string | null>;
      for (const field of FORM3_JOB_LEVEL_FIELDS) jobLevel[field.key] = null;

      jobLevel.objectiveNameDepartment = department
        ? `${version.objectiveName} / ${department.name}`
        : version.objectiveName;
      jobLevel.jobIdName = `${objective?.code ?? '—'} · ${prefill.suggestedAgentName}`;
      /*
       * The person, by name and designation.
       *
       * This printed the raw user id, which is what the prefill stores and what nobody can read.
       * The field's own label — "Job Owner / Current Person / Role" — asks for a person and their
       * role, so it answers with both, and falls back to the id only when the person cannot be
       * read at all rather than showing an empty box where a name should be.
       */
      const ownerPerson =
        prefill.ownerUserId === null
          ? null
          : await this.prisma.client.user.findUnique({
              where: { id: prefill.ownerUserId },
              select: { displayName: true },
            });
      const ownerEmployment =
        prefill.ownerUserId === null
          ? null
          : await this.prisma.client.employmentRecord.findFirst({
              where: {
                tenantId: input.scope.tenantId,
                userId: prefill.ownerUserId,
                endedAt: null,
              },
              select: { designation: true },
            });

      jobLevel.jobOwnerCurrentPersonRole =
        ownerPerson === null
          ? prefill.ownerUserId
          : ownerEmployment === null
            ? ownerPerson.displayName
            : `${ownerPerson.displayName} · ${ownerEmployment.designation}`;
      jobLevel.triggerFrequency =
        setup.triggerOrFrequency ??
        (setup.runType === null ? null : `${setup.runType} (no schedule required)`);
      jobLevel.highLevelWork = prefill.assignedWork;
      jobLevel.jobStartRequirement = version.expectedFinalResult;
      jobLevel.jobCompletionEvidence = prefill.completionEvidence;
      jobLevel.normalCompletionTime =
        version.targetCompletionTime === null
          ? null
          : `${version.targetCompletionTime} ${version.timeUnit ?? ''}`.trim();

      // The action grid is the manager's workflow where one exists, and Form 2's own grid
      // otherwise. Both are records that already exist; neither is re-entered here.
      const actions: Form3ActionRow[] = version.steps.map((step) => {
        const node = graph?.nodes.find((candidate) => candidate.fromStepPosition === step.position);
        return {
          step: step.position,
          whoPersonName: step.whoPersonName,
          whoRole: step.whoDesignation,
          whoEngine: step.whoEngine,
          whenTrigger: step.whenTrigger,
          whenFrequency: step.whenFrequency,
          whatExactWork: node?.label ?? step.whatExactWork,
          inputExactInput: step.inputWhatIsUsed,
          whereInputIsFound: step.inputReceivedFrom,
          // "HOW — Exact Method" is the Skill for AI work and the recorded method otherwise. UBoss
          // does not invent a method that was never written down.
          howExactMethod: node?.skillName ?? null,
          whereWorkIsPerformed: setup.whereWorkHappens ?? step.whereWorkIsDone,
          ruleFormulaCheck: node?.dod.criteria ?? null,
          output: node?.dod.expectedOutput ?? step.outputWhatIsProduced,
          outputDestination: setup.outputDestination ?? step.outputSentTo,
          approval: node?.dod.approval ?? step.approval ?? null,
          ifMissingOrWrong: setup.missingDataBehaviour ?? node?.dod.failureCondition ?? null,
          time: step.timeTaken,
        };
      });

      return {
        jobLevel,
        actions,
        composedFrom: {
          objectiveVersionId: assignment.objectiveVersionId,
          workflowDraftId: assignment.workflowDraftId,
          aiWorkAssignmentId: assignment.id,
          engineAgentId: assignment.engineAgentId,
        },
        note:
          'This is a read of the job method as it already exists — Form 2, the workflow the ' +
          'manager approved, and the execution setup. Nothing here is a form to fill in, and no ' +
          'employee re-enters it.',
      };
    });
  }

  // -------------------------------------------------------------------------
  // Internals
  // -------------------------------------------------------------------------

  private runTypes(): string[] {
    return ['RunOnce', 'Manual', 'Scheduled', 'EventBased'];
  }

  private isRunType(value: string): value is AgentRunType {
    return this.runTypes().includes(value);
  }

  private async loadAssignment(assignmentId: string) {
    const row = await this.prisma.client.aiWorkAssignment.findFirst({
      where: { id: assignmentId },
    });
    if (!row) {
      throw new NotFoundException('There is no such assigned AI work you can see.');
    }
    return row;
  }

  /**
   * Where this piece of AI work sits in the objective that asked for it.
   *
   * ## Why the builder resolves this rather than the screen
   *
   * Two of these answers are derivations the screen must not make for itself. The step's position
   * — Engine, Sub-Engine, Executor — comes from the dependency graph and nothing else, and what it
   * comes after is the same graph read backwards. A screen that worked either out locally would be
   * a second opinion about the plan, and the first time the two disagreed the product would be
   * telling somebody that a step is an Executor on one page and a Sub-Engine on another.
   *
   * Returns null rather than throwing when the version or its draft cannot be read: an assignment
   * whose objective has been archived is still an assignment, and the builder should say what it
   * knows rather than fail to open.
   */
  private async objectiveContextOf(
    scope: TenantScope,
    assignment: { objectiveId: string; objectiveVersionId: string; nodeId: string; updatedAt: Date },
  ): Promise<AgentObjectiveContext | null> {
    const version = await this.prisma.client.objectiveVersion.findFirst({
      where: { tenantId: scope.tenantId, id: assignment.objectiveVersionId },
      select: {
        objectiveName: true,
        status: true,
        expectedFinalResult: true,
        departmentId: true,
        objectiveOwnerUserId: true,
        objective: { select: { code: true } },
      },
    });
    if (version === null) return null;

    const [department, owner, draft] = [
      version.departmentId === null
        ? null
        : await this.prisma.client.department.findFirst({
            where: { tenantId: scope.tenantId, id: version.departmentId },
            select: { name: true },
          }),
      version.objectiveOwnerUserId === null
        ? null
        : await this.prisma.client.user.findUnique({
            where: { id: version.objectiveOwnerUserId },
            select: { displayName: true },
          }),
      await this.prisma.client.objectiveWorkflowDraft.findFirst({
        where: { tenantId: scope.tenantId, objectiveVersionId: assignment.objectiveVersionId },
        orderBy: { createdAt: 'desc' },
        select: { graph: true },
      }),
    ];

    const graph = draft?.graph as
      | { nodes?: { id: string; kind: string; label: string; dod?: { dependencies?: string[] } }[] }
      | null;
    const nodes = (graph?.nodes ?? []).map((node) => ({
      id: node.id,
      kind: node.kind,
      label: node.label,
      dod: { dependencies: node.dod?.dependencies ?? [] },
    }));

    const mine = nodes.find((node) => node.id === assignment.nodeId) ?? null;
    const labelOf = new Map(nodes.map((node) => [node.id, node.label]));
    const stages = executionStages(nodes);

    return {
      objectiveId: assignment.objectiveId,
      objectiveCode: version.objective.code,
      objectiveName: version.objectiveName,
      objectiveStatus: version.status,
      departmentName: department?.name ?? null,
      ownerName: owner?.displayName ?? null,
      expectedOutcome: version.expectedFinalResult,
      nodeId: assignment.nodeId,
      stepLabel: mine?.label ?? assignment.nodeId,
      stage: stages.get(assignment.nodeId) ?? null,
      comesAfter: (mine?.dod.dependencies ?? [])
        .map((id) => labelOf.get(id))
        .filter((label): label is string => label !== undefined),
      updatedAt: assignment.updatedAt.toISOString(),
    };
  }

  private prefillOf(assignment: { setupPrefill: unknown }): AgentSetupPrefill {
    return assignment.setupPrefill as AgentSetupPrefill;
  }

  private setupOf(assignment: { executionSetup: unknown }): AgentExecutionSetup {
    const stored = assignment.executionSetup;
    if (stored === null || typeof stored !== 'object') {
      return emptyAgentExecutionSetup();
    }
    // Merged over an empty setup so a stored record written before a field existed reads as
    // "not answered" rather than `undefined`, which nothing downstream expects.
    return { ...emptyAgentExecutionSetup(), ...(stored as Partial<AgentExecutionSetup>) };
  }

  /**
   * Whether this work needs a connection at all.
   *
   * Taken from the tool categories the step's Definition of Done recorded, not assumed. A step
   * that reads and writes nothing outside UBoss has nothing to connect, and asking it to choose a
   * connection is one of the unnecessary questions the zero-question rule forbids.
   */
  private needsConnection(assignment: { setupPrefill: unknown }): boolean {
    return this.prefillOf(assignment).toolCategories.length > 0;
  }

  private async assertConnectionUsable(
    scope: TenantScope,
    assignment: {
      setupPrefill: unknown;
      engineAgentId: string | null;
      id: string;
      objectiveVersionId: string;
    },
    connectionId: string,
  ): Promise<void> {
    const categories = this.prefillOf(assignment).toolCategories;
    const departmentId = await this.departmentOf(assignment);

    for (const category of categories) {
      // `mayBeUsedForSetup`, not `mayAgentUse`. The distinction is not cosmetic: an Agent Tool
      // Permission is granted *to an agent*, and at setup time the agent does not exist yet, so
      // `mayAgentUse` could only ever answer "no grant" and every piece of work needing a
      // connection would be permanently unable to activate. This asks the question that is
      // actually answerable now — is the connection healthy, capable and permitted here — and
      // leaves the per-agent grant to the administrator who owns that decision.
      const decision = await this.connections.mayBeUsedForSetup({
        scope,
        connectionId,
        category: category as ToolActionCategory,
        ...(departmentId === null ? {} : { departmentId }),
      });
      if (!decision.usable) {
        throw new BadRequestException(
          `That connection cannot be used for "${category}": ${decision.reason}`,
        );
      }
    }
  }

  private async readinessOf(
    scope: TenantScope,
    assignment: {
      setupPrefill: unknown;
      engineAgentId: string | null;
      id: string;
      objectiveVersionId: string;
      lastTestPassed: boolean | null;
      lastTestedAt: Date | null;
    },
    setup: AgentExecutionSetup,
    prefill: AgentSetupPrefill,
  ): Promise<AgentBuilderView['readiness']> {
    const findings: AgentReadinessFinding[] = [];
    const needsConnection = this.needsConnection(assignment);
    const missing = missingSetupFields(setup, needsConnection);

    for (const entry of missing) {
      findings.push({ severity: 'Blocker', summary: `${entry.label} is not set. ${entry.why}` });
    }

    if (prefill.skillVersionIds.length === 0) {
      findings.push({
        severity: 'Blocker',
        summary:
          'No approved, published Skill stands behind this work, so the agent would have nothing ' +
          'to perform. Author and approve a Skill first.',
      });
    }

    let connection: AgentBuilderView['readiness']['connection'] = null;
    if (setup.inputConnectionId !== null) {
      const category = prefill.toolCategories[0];
      const departmentId = await this.departmentOf(assignment);
      const decision = await this.connections.mayBeUsedForSetup({
        scope,
        connectionId: setup.inputConnectionId,
        category: (category ?? 'Read') as ToolActionCategory,
        ...(departmentId === null ? {} : { departmentId }),
      });
      connection = {
        connectionId: setup.inputConnectionId,
        state: decision.state,
        reason: decision.reason,
      };
      if (!decision.usable) {
        findings.push({ severity: 'Blocker', summary: decision.reason });
      } else {
        // Stated rather than left to be discovered at the first run. A healthy connection is not
        // the same as this agent being permitted to use it: the Agent Tool Permission is granted
        // to the agent, by an administrator, and cannot exist before the agent does. Without this
        // line the readiness panel would read as "all clear" and the first Run would refuse.
        findings.push({
          severity: 'Warning',
          summary:
            'The connection is healthy, but this agent has no tool permission on it yet. An ' +
            'administrator grants that once the agent exists; until then its runs will refuse.',
        });
      }
    } else if (needsConnection) {
      connection = {
        connectionId: null,
        state: 'NotConfigured',
        reason: 'This work needs a connection and none has been chosen.',
      };
    }

    // A warning, not a blocker: the source document makes readiness the condition for activation
    // and does not include a passed test. Saying so out loud is better than silently allowing it.
    if (assignment.lastTestedAt === null) {
      findings.push({
        severity: 'Warning',
        summary: 'This agent has not been tested. Activation is permitted, but untested.',
      });
    } else if (assignment.lastTestPassed === false) {
      findings.push({
        severity: 'Warning',
        summary: 'The last test did not succeed. Activation is permitted, but it is on record.',
      });
    }

    const blocked = findings.some((finding) => finding.severity === 'Blocker');
    return {
      connection,
      findings,
      readyToTest: missing.length === 0,
      readyToActivate: !blocked,
    };
  }

  private async viewOf(
    scope: TenantScope,
    assignment: Awaited<ReturnType<AgentBuilderService['loadAssignment']>>,
  ): Promise<AgentBuilderView> {
    const prefill = this.prefillOf(assignment);
    const setup = this.setupOf(assignment);
    const needsConnection = this.needsConnection(assignment);
    const readiness = await this.readinessOf(scope, assignment, setup, prefill);

    let engineAgent: AgentBuilderView['engineAgent'] = null;
    if (assignment.engineAgentId !== null) {
      const agent = await this.prisma.client.engineAgent.findFirst({
        where: { tenantId: scope.tenantId, id: assignment.engineAgentId },
        include: { versions: { orderBy: { versionNumber: 'desc' }, take: 1 } },
      });
      if (agent) {
        engineAgent = {
          id: agent.id,
          name: agent.name,
          status: agent.status,
          versionNumber: agent.versions[0]?.versionNumber ?? 1,
        };
      }
    }

    return {
      assignmentId: assignment.id,
      status: assignment.status,
      context: await this.objectiveContextOf(scope, assignment),
      prefill,
      setup,
      missing: missingSetupFields(setup, needsConnection),
      needsConnection,
      readiness,
      lastTest: {
        at: assignment.lastTestedAt?.toISOString() ?? null,
        passed: assignment.lastTestPassed,
        summary: assignment.lastTestSummary,
        wasReal: assignment.lastTestWasReal,
      },
      testHistory: await this.testHistoryOf(scope, assignment.id),
      engineAgent,
      vocabulary: {
        runTypes: this.runTypes(),
        missingDataBehaviours: MISSING_DATA_BEHAVIOURS,
      },
      note:
        'Only missing execution setup is requested — the job method is inherited from the ' +
        'objective. The canonical Form 3 is available to authorized users as a read, never as a ' +
        'form to re-enter.',
    };
  }

  /**
   * The recorded tests, newest first.
   *
   * Capped at twenty. Somebody comparing attempts is looking at the last few; a page of every
   * test ever run would be a different screen with a different purpose, and this one would load
   * slower for everybody to serve it.
   */
  private async testHistoryOf(
    scope: TenantScope,
    assignmentId: string,
  ): Promise<AgentTestRunView[]> {
    const rows = await this.prisma.client.agentBuilderTestRun.findMany({
      where: { tenantId: scope.tenantId, aiWorkAssignmentId: assignmentId },
      orderBy: { createdAt: 'desc' },
      take: 20,
      include: { ranBy: { select: { displayName: true } } },
    });

    return rows.map((row) => ({
      id: row.id,
      status: row.status as AgentTestStatus,
      sampleInput: row.sampleInput,
      expectedOutcome: row.expectedOutcome,
      output: row.output,
      // Stored as JSON, so narrowed rather than asserted: a malformed row shows an empty list
      // instead of crashing the screen that was opened to find out what went wrong.
      warnings: Array.isArray(row.warnings) ? row.warnings.map((entry) => String(entry)) : [],
      errors: Array.isArray(row.errors) ? row.errors.map((entry) => String(entry)) : [],
      durationMs: row.durationMs,
      wasReal: row.wasReal,
      capability: row.capability,
      ranByName: row.ranBy?.displayName ?? null,
      at: row.createdAt.toISOString(),
    }));
  }

  /**
   * The row-level decision, made by the scope engine rather than by a rule of this module's own.
   *
   * This is phase 2 of the two-phase pattern: the handler has already asserted the *role* may
   * perform the action at all, and this asks whether they may perform it on *this* work. Handing
   * the scope engine an owner and a department is what makes `OwnWork`, `TeamSubtree`,
   * `Department` and `WholeCompany` mean what the role templates say they mean.
   *
   * An earlier draft of this method said "the owner, or anyone with Administer" — which would
   * have been a second, disagreeing authorization policy living in this file, and would have
   * over-shared the moment a role gained a module-level action. Effective access is
   * User Type + Role + Scope + Module Visibility + Allowed Actions + Policy Constraints, and none
   * of those belong to a service.
   */
  private async mayTouch(
    context: Awaited<ReturnType<AuthorizationService['contextFor']>>,
    assignment: { id: string; setupPrefill: unknown; objectiveVersionId: string },
    action: 'View' | 'EditDraft' | 'Run' | 'Publish',
    departmentId: string | null,
  ): Promise<boolean> {
    const owner = this.prefillOf(assignment).ownerUserId;

    const decision = await this.authorization.authorize(context, {
      module: 'agent-builder',
      action,
      resource: {
        id: assignment.id,
        ...(owner === null ? {} : { ownerUserId: owner }),
        ...(departmentId === null ? {} : { departmentId }),
      },
    });
    return decision.allowed;
  }

  private async assertMayTouch(
    context: Awaited<ReturnType<AuthorizationService['contextFor']>>,
    assignment: { id: string; setupPrefill: unknown; objectiveVersionId: string },
    action: 'View' | 'EditDraft' | 'Run' | 'Publish',
  ): Promise<void> {
    const departmentId = await this.departmentOf(assignment);
    if (!(await this.mayTouch(context, assignment, action, departmentId))) {
      // 404, not 403: whether a particular piece of somebody else's work exists is itself
      // something this person is not entitled to learn.
      throw new NotFoundException('There is no such assigned AI work you can see.');
    }
  }

  /**
   * The department this work belongs to, for the scope decision.
   *
   * Read from the objective version rather than copied onto the assignment: a department is the
   * objective's fact, and a stale copy here would decide access from something that had since
   * changed.
   */
  private async departmentOf(assignment: { objectiveVersionId: string }): Promise<string | null> {
    const version = await this.prisma.client.objectiveVersion.findFirst({
      where: { id: assignment.objectiveVersionId },
      select: { departmentId: true },
    });
    return version?.departmentId ?? null;
  }
}
