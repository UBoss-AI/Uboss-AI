import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';

import {
  AGENT_MEMORY_MODES,
  emptyEngineAgentHealth,
  engineAgentActionsFor,
  mayMoveEngineAgent,
  memoryModePersistsBeyondRun,
  versionActivationNeedsApproval,
  type AgentExecutionSetup,
  type AgentMemoryMode,
  type AgentVersionImpact,
  type EngineAgentAction,
  type EngineAgentHealth,
  type EngineAgentStatus,
} from '@uboss/types';

import { ApprovalService } from '../approvals/approval.service.js';
import { AuditEventService } from '../audit/audit-event.service.js';
import { AuthorizationService } from '../authorization/authorization.service.js';
import { ModelGateway } from '../model-gateway/model-gateway.js';
import { PrismaService } from '../persistence/prisma.service.js';
import type { TenantScope } from '../persistence/tenant-context.js';

/** What one version looks like in the registry. */
export interface EngineAgentVersionView {
  id: string;
  versionNumber: number;
  status: string;
  isCurrent: boolean;
  memoryMode: AgentMemoryMode;
  skillVersionIds: string[];
  toolCategories: string[];
  setup: AgentExecutionSetup | null;
  impact: AgentVersionImpact | null;
  approvalRequired: boolean;
  test: { at: string | null; passed: boolean | null; wasReal: boolean | null };
  publishedAt: string | null;
  createdAt: string;
}

/**
 * One registry row.
 *
 * The field list is the source document's (§17): "Agent Name / Owner, Objective(s), Current
 * Version, Skills, Status, Schedule / Trigger, Last / Next Run, Health, Usage / Cost, Actions" —
 * plus the memory mode and tool grants the prompt names.
 */
export interface EngineAgentView {
  id: string;
  name: string;
  ownerUserId: string;
  status: EngineAgentStatus;
  memoryMode: AgentMemoryMode;
  pausedReason: string | null;

  /** Objectives currently relying on this agent. */
  objectiveIds: string[];

  currentVersion: EngineAgentVersionView | null;
  openDraft: EngineAgentVersionView | null;
  versions: EngineAgentVersionView[];

  /** From the version in force, so the registry and the configuration cannot disagree. */
  scheduleOrTrigger: string | null;
  skillVersionIds: string[];

  /** Tool categories the work needs, and the connection chosen for them. */
  toolCategories: string[];
  connectionId: string | null;

  health: EngineAgentHealth;

  /**
   * Permitted token and cost view.
   *
   * Null throughout until the cost ledger exists. A zero would read as "this agent has cost
   * nothing", which is a claim, not an absence of data.
   */
  usage: {
    hasData: boolean;
    promptTokens: number | null;
    completionTokens: number | null;
    note: string;
  };

  /** Derived from the status, so a screen cannot offer a button the service will refuse. */
  actions: EngineAgentAction[];

  activatedAt: string | null;
  archivedAt: string | null;
  note: string;
}

/**
 * The Engine Agent registry — Prompt 25.
 *
 * ## What this is separate from
 *
 * The locked relationship is **Agent → Assignment/Job → Run**. This service owns the *agent*: its
 * identity, its status, its versions and its governed memory mode. It does not run anything.
 * Recurring work creates Runs on the agent it already has, which is the next prompt's engine, and
 * the reason `Run Now` and `Open Runs` are absent here rather than stubbed: a route that accepted
 * "run now" and did nothing would be worse than one that does not exist.
 *
 * ## Versioning
 *
 * A published version is immutable, enforced by a database trigger, because Runs cite it as what
 * produced their output. A configuration change therefore drafts a **new** version, and the draft
 * carries an impact analysis computed against the version in force. Whether activating it needs an
 * approval is decided by `versionActivationNeedsApproval` — reach that widens, or an agent several
 * objectives depend on — and stored on the row, so a reviewer sees the same answer the service
 * will enforce.
 *
 * Only one open draft per agent, enforced by a partial unique index. Two drafts of one agent is a
 * state nobody can reason about.
 */
@Injectable()
export class EngineAgentService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly authorization: AuthorizationService,
    /**
     * The one Approval Engine — Prompt 28.
     *
     * Prompt 25 took `approvedByUserId` as a parameter and trusted it. Nothing behind it was ever
     * checked, so anybody holding `agents:Publish` could activate a reach-widening version by
     * naming a colleague who had never seen it — the four-eyes requirement was satisfied by
     * typing a uuid. This replaces the claim with evidence the service verifies.
     */
    private readonly approvals: ApprovalService,
    private readonly auditEvents: AuditEventService,
    /// The provider seam, for a version's controlled test.
    private readonly modelGateway: ModelGateway,
  ) {}

  // -------------------------------------------------------------------------
  // Reading
  // -------------------------------------------------------------------------

  async list(input: {
    scope: TenantScope;
    actorUserId: string;
    includeArchived?: boolean | undefined;
  }): Promise<{ agents: EngineAgentView[]; note: string }> {
    const context = await this.authorization.contextFor(input.scope, input.actorUserId);
    await this.authorization.assertCan(context, { module: 'agents', action: 'View' });

    return this.prisma.runInTenantTransaction(input.scope, async () => {
      const rows = await this.prisma.client.engineAgent.findMany({
        where: {
          tenantId: input.scope.tenantId,
          ...(input.includeArchived === true ? {} : { status: { not: 'Archived' } }),
        },
        orderBy: { createdAt: 'desc' },
      });

      const agents: EngineAgentView[] = [];
      for (const row of rows) {
        // Sequential, not `Promise.all`: concurrent work inside an open tenant transaction loses
        // the AsyncLocalStorage scope, and an unscoped read under RLS returns nothing rather than
        // failing loudly.
        if (!(await this.mayTouch(context, row, 'View'))) continue;
        agents.push(await this.viewOf(input.scope, row));
      }

      return {
        agents,
        note:
          'One agent per reusable job. Recurring work creates Runs on the agent it already has; ' +
          'it never creates another agent.',
      };
    });
  }

  async view(input: {
    scope: TenantScope;
    actorUserId: string;
    agentId: string;
  }): Promise<EngineAgentView> {
    const context = await this.authorization.contextFor(input.scope, input.actorUserId);
    await this.authorization.assertCan(context, { module: 'agents', action: 'View' });

    return this.prisma.runInTenantTransaction(input.scope, async () => {
      const agent = await this.load(input.scope, input.agentId);
      await this.assertMayTouch(context, agent, 'View');
      return this.viewOf(input.scope, agent);
    });
  }

  // -------------------------------------------------------------------------
  // Operational actions
  // -------------------------------------------------------------------------

  /** Pause an agent. The reason is required, because "why did this stop" is the first question. */
  async pause(input: {
    scope: TenantScope;
    actorUserId: string;
    agentId: string;
    reason: string;
  }): Promise<EngineAgentView> {
    if (input.reason.trim() === '') {
      throw new BadRequestException(
        'Pausing needs a reason. An agent that stopped for no recorded reason is the state ' +
          'nobody can act on.',
      );
    }

    return this.transition(input, 'Paused', 'Pause', {
      pausedReason: input.reason.trim(),
      summary: `Paused: ${input.reason.trim()}`,
      action: 'agent.paused',
    });
  }

  async resume(input: {
    scope: TenantScope;
    actorUserId: string;
    agentId: string;
  }): Promise<EngineAgentView> {
    return this.transition(input, 'Active', 'Pause', {
      // Cleared, not kept: a reason left behind would describe a state the agent is no longer in,
      // and a database constraint refuses it anyway.
      pausedReason: null,
      summary: 'Resumed.',
      action: 'agent.resumed',
    });
  }

  /**
   * Archive an agent.
   *
   * Terminal by design: reviving one would resurrect an identity the company retired, with its
   * history attached. Its runs and versions stay readable — that is the point of archiving rather
   * than deleting.
   */
  async archive(input: {
    scope: TenantScope;
    actorUserId: string;
    agentId: string;
    reason: string;
  }): Promise<EngineAgentView> {
    return this.transition(input, 'Archived', 'Publish', {
      pausedReason: null,
      archivedAt: new Date(),
      archivedByUserId: input.actorUserId,
      summary: `Archived: ${input.reason.trim() || 'no reason given'}`,
      action: 'agent.archived',
    });
  }

  // -------------------------------------------------------------------------
  // Versioning
  // -------------------------------------------------------------------------

  /**
   * Draft a new version from the one in force.
   *
   * The published version is never touched. The draft carries an impact analysis against what is
   * live, and whether activating it needs approval is decided and stored now rather than at
   * activation time, so a reviewer reads the same answer the service will enforce.
   */
  async createNewVersion(input: {
    scope: TenantScope;
    actorUserId: string;
    agentId: string;
    setup?: Partial<AgentExecutionSetup> | undefined;
    memoryMode?: AgentMemoryMode | undefined;
    skillVersionIds?: string[] | undefined;
    toolCategories?: string[] | undefined;
  }): Promise<EngineAgentVersionView> {
    const context = await this.authorization.contextFor(input.scope, input.actorUserId);
    await this.authorization.assertCan(context, { module: 'agents', action: 'Publish' });

    if (input.memoryMode !== undefined && !AGENT_MEMORY_MODES.includes(input.memoryMode)) {
      throw new BadRequestException(
        `Unknown memory mode "${String(input.memoryMode)}". One of: ${AGENT_MEMORY_MODES.join(', ')}.`,
      );
    }

    return this.prisma.runInTenantTransaction(input.scope, async () => {
      const agent = await this.load(input.scope, input.agentId);
      await this.assertMayTouch(context, agent, 'Publish');

      if (agent.status === 'Archived') {
        throw new ConflictException(
          'This agent is archived. Drafting a version would be a back door around a status the ' +
            'company chose as final — create a new agent instead.',
        );
      }

      const existingDraft = await this.prisma.client.engineAgentVersion.findFirst({
        where: { tenantId: input.scope.tenantId, engineAgentId: agent.id, status: 'Draft' },
      });
      if (existingDraft) {
        throw new ConflictException(
          `This agent already has an open draft (version ${existingDraft.versionNumber}). Two ` +
            'drafts of one agent is a state nobody can reason about — activate or discard that ' +
            'one first.',
        );
      }

      const live =
        agent.currentVersionId === null
          ? null
          : await this.prisma.client.engineAgentVersion.findFirst({
              where: { tenantId: input.scope.tenantId, id: agent.currentVersionId },
            });

      const liveConfig = this.configOf(live?.config ?? null);
      const nextSetup: AgentExecutionSetup = {
        ...(liveConfig.setup ?? this.blankSetup()),
        ...(input.setup ?? {}),
      };
      const nextMemoryMode = input.memoryMode ?? (agent.memoryMode as AgentMemoryMode);
      const nextSkills = input.skillVersionIds ?? liveConfig.skillVersionIds;
      const nextTools = input.toolCategories ?? liveConfig.toolCategories;

      const objectiveIds = await this.objectiveIdsFor(input.scope, agent.id);
      const impact = this.impactOf({
        liveConfig,
        liveMemoryMode: agent.memoryMode as AgentMemoryMode,
        nextSetup,
        nextMemoryMode,
        nextSkills,
        nextTools,
        objectiveIds,
      });

      const highest = await this.prisma.client.engineAgentVersion.findFirst({
        where: { tenantId: input.scope.tenantId, engineAgentId: agent.id },
        orderBy: { versionNumber: 'desc' },
        select: { versionNumber: true },
      });

      const created = await this.prisma.client.engineAgentVersion.create({
        data: {
          tenantId: input.scope.tenantId,
          engineAgentId: agent.id,
          versionNumber: (highest?.versionNumber ?? 0) + 1,
          status: 'Draft',
          config: {
            setup: nextSetup,
            memoryMode: nextMemoryMode,
            skillVersionIds: nextSkills,
            toolCategories: nextTools,
            assignedWork: liveConfig.assignedWork,
            approvalRequired: liveConfig.approvalRequired,
            completionEvidence: liveConfig.completionEvidence,
          } as unknown as object,
          impact: impact as unknown as object,
          approvalRequired: impact.approvalRequired,
          createdByUserId: input.actorUserId,
        },
      });

      await this.auditEvents.appendWithinCurrentScope(input.scope.tenantId, {
        action: 'agent.version_drafted',
        resourceType: 'engine-agent',
        resourceId: agent.id,
        actorUserId: input.actorUserId,
        resourceRef: agent.name,
        summary:
          `Drafted version ${created.versionNumber} of "${agent.name}". The live version is ` +
          'unchanged and stays the record of what produced past runs.',
        metadata: {
          versionNumber: created.versionNumber,
          approvalRequired: impact.approvalRequired,
          changedFields: impact.changedFields.join(', ') || 'nothing',
          widensReach: impact.widensReach,
          affectedObjectives: objectiveIds.length,
        },
      });

      return this.versionViewOf(created, agent.currentVersionId);
    });
  }

  /** A controlled test of a drafted configuration, before it goes live. */
  async testVersion(input: {
    scope: TenantScope;
    actorUserId: string;
    agentId: string;
    versionId: string;
  }): Promise<EngineAgentVersionView> {
    const context = await this.authorization.contextFor(input.scope, input.actorUserId);
    await this.authorization.assertCan(context, { module: 'agents', action: 'Publish' });

    const { agent, version } = await this.prisma.runInTenantTransaction(input.scope, async () => {
      const loaded = await this.load(input.scope, input.agentId);
      await this.assertMayTouch(context, loaded, 'Publish');
      const draft = await this.requireVersion(input.scope, loaded.id, input.versionId);
      if (draft.status !== 'Draft') {
        throw new ConflictException(
          'Only a draft version can be tested. A published one has already run.',
        );
      }
      return { agent: loaded, version: draft };
    });

    const config = this.configOf(version.config);

    // Outside the transaction: a provider call can be slow, and holding a transaction open across
    // it pins a connection for its duration.
    let passed: boolean;
    let summary: string;
    let wasReal = false;
    try {
      const response = await this.modelGateway.complete({
        // Same profile the version's real runs will use, for the same reason.
        profile: 'AGENT_STANDARD',
        purpose: 'EngineAgentVersionTest',
        instruction:
          'Perform this configuration once against the described input and report what you ' +
          'would produce. Do not deliver it anywhere.',
        context: [
          `Agent: ${agent.name}`,
          `Work: ${config.assignedWork ?? 'unspecified'}`,
          `Skill versions: ${config.skillVersionIds.join(', ') || 'none'}`,
          `Where the work happens: ${config.setup?.whereWorkHappens ?? 'unspecified'}`,
          `On missing or wrong data: ${config.setup?.missingDataBehaviour ?? 'unspecified'}`,
        ].join('\n'),
        maxTokens: 400,
        tenantId: input.scope.tenantId,
      });
      wasReal = response.producedByRealModel;
      passed = response.output.trim() !== '';
      summary = passed
        ? `Version ${version.versionNumber} produced output using ${response.capability}.`
        : `Version ${version.versionNumber} produced nothing.`;
    } catch (caught) {
      passed = false;
      summary = `The test could not complete: ${caught instanceof Error ? caught.message : String(caught)}`;
    }

    return this.prisma.runInTenantTransaction(input.scope, async () => {
      const saved = await this.prisma.client.engineAgentVersion.update({
        where: { id: version.id },
        data: {
          testedAt: new Date(),
          testPassed: passed,
          testWasReal: wasReal,
          version: { increment: 1 },
        },
      });

      await this.auditEvents.appendWithinCurrentScope(input.scope.tenantId, {
        action: 'agent.version_tested',
        resourceType: 'engine-agent',
        resourceId: agent.id,
        actorUserId: input.actorUserId,
        resourceRef: agent.name,
        summary,
        metadata: {
          versionNumber: saved.versionNumber,
          passed,
          producedByRealModel: wasReal,
          modelWasMocked: !wasReal,
        },
      });

      const reloaded = await this.load(input.scope, agent.id);
      return this.versionViewOf(saved, reloaded.currentVersionId);
    });
  }

  /**
   * Activate a drafted version.
   *
   * Where the impact analysis said an approval is required, this refuses until one is recorded.
   * The prompt's "approval before activation where required" is that check, and it is on the
   * server rather than in a screen's disabled button.
   */
  /**
   * Ask somebody to approve activating a draft version.
   *
   * Raised through the one Approval Engine, as an `AgentActivation` request whose `subjectId` is
   * the version — which is what `activateVersion` then verifies. Per version rather than per
   * agent, because the thing being judged is a specific impact analysis against a specific
   * configuration in force; an approval carried over from a previous version would be an approval
   * of something else.
   *
   * The approver is named where the caller names one and addressed to a Head otherwise. It is
   * never addressed to the requester: the mandatory platform `NoSelfApproval` control would
   * refuse them anyway, and offering it would be offering a control that does not work.
   */
  async requestActivationApproval(input: {
    scope: TenantScope;
    actorUserId: string;
    agentId: string;
    versionId: string;
    approverUserId?: string | undefined;
    note?: string | undefined;
  }): Promise<{ approvalRequestId: string; approvalRequired: boolean }> {
    const context = await this.authorization.contextFor(input.scope, input.actorUserId);
    await this.authorization.assertCan(context, { module: 'agents', action: 'Publish' });

    const prepared = await this.prisma.runInTenantTransaction(input.scope, async () => {
      const agent = await this.load(input.scope, input.agentId);
      await this.assertMayTouch(context, agent, 'Publish');

      const draft = await this.requireVersion(input.scope, agent.id, input.versionId);
      if (draft.status !== 'Draft') {
        throw new ConflictException(
          'That version is already published, so there is nothing left to approve.',
        );
      }

      const impact = draft.impact as unknown as AgentVersionImpact | null;
      return { agent, draft, impact };
    });

    if (input.approverUserId === input.actorUserId) {
      throw new ConflictException(
        'You cannot address the approval to yourself. Activating a version you approved is the ' +
          'one thing requiring an approval is meant to prevent.',
      );
    }

    const raised = await this.approvals.raise({
      scope: input.scope,
      type: 'AgentActivation',
      title: `Activate version ${prepared.draft.versionNumber} of "${prepared.agent.name}"`,
      detail:
        (input.note ?? '') +
        (prepared.impact === null
          ? ' No impact analysis is recorded for this version.'
          : ` Impact: ${prepared.impact.reasons.join(' ')}`),
      subjectType: 'EngineAgentVersion',
      subjectId: prepared.draft.id,
      requestedByUserId: input.actorUserId,
      ...(input.approverUserId === undefined
        ? { approverRoleKind: 'Head' }
        : { namedApproverUserId: input.approverUserId }),
    });

    return { approvalRequestId: raised.id, approvalRequired: prepared.draft.approvalRequired };
  }

  async activateVersion(input: {
    scope: TenantScope;
    actorUserId: string;
    agentId: string;
    versionId: string;
    /**
     * The approved `AgentActivation` request authorising this activation.
     *
     * Required whenever the version's impact analysis says an approval is needed. It is an id
     * this service looks up rather than a name it accepts: the request must exist, be
     * `Approved`, be for *this* version, and have been decided by somebody other than the person
     * activating. `requestActivationApproval` creates it.
     */
    approvalRequestId?: string | undefined;
  }): Promise<EngineAgentView> {
    const context = await this.authorization.contextFor(input.scope, input.actorUserId);
    await this.authorization.assertCan(context, { module: 'agents', action: 'Publish' });

    return this.prisma.runInTenantTransaction(input.scope, async () => {
      const agent = await this.load(input.scope, input.agentId);
      await this.assertMayTouch(context, agent, 'Publish');

      const draft = await this.requireVersion(input.scope, agent.id, input.versionId);
      if (draft.status !== 'Draft') {
        throw new ConflictException('That version is already published.');
      }

      if (draft.approvalRequired && input.approvalRequestId === undefined) {
        const impact = draft.impact as unknown as AgentVersionImpact | null;
        throw new ConflictException(
          'This version needs an approval before it can be activated. ' +
            (impact?.reasons.join(' ') ?? '') +
            ' Raise one with POST versions/:versionId/request-approval.',
        );
      }

      // The cited approval is verified, not believed. Every clause below is a way the old
      // parameter could be satisfied by somebody who had approved nothing.
      let approvedByUserId: string | null = null;
      if (input.approvalRequestId !== undefined) {
        const approval = await this.prisma.client.approvalRequest.findFirst({
          where: { tenantId: input.scope.tenantId, id: input.approvalRequestId },
        });

        if (!approval) {
          throw new NotFoundException('No such approval request.');
        }
        if (approval.type !== 'AgentActivation') {
          throw new ConflictException(
            `That is a ${approval.type} request, not an agent activation approval. An approval ` +
              'for one thing does not authorise another.',
          );
        }
        if (approval.subjectId !== draft.id) {
          throw new ConflictException(
            'That approval is for a different version. Each version needs its own decision, ' +
              'because the impact analysis it was judged against belongs to that version.',
          );
        }
        if (approval.status !== 'Approved') {
          throw new ConflictException(`That approval request is ${approval.status}, not Approved.`);
        }
        if (approval.decidedByUserId === input.actorUserId) {
          // Four-eyes on the reach-widening case, now anchored to a real decision record rather
          // than to a parameter the caller chose.
          throw new ConflictException(
            'The person activating a version cannot also be the one who approved it. That is ' +
              'the whole point of requiring an approval.',
          );
        }

        approvedByUserId = approval.decidedByUserId;
      }

      const config = this.configOf(draft.config);

      const published = await this.prisma.client.engineAgentVersion.update({
        where: { id: draft.id },
        data: {
          status: 'Published',
          publishedAt: new Date(),
          publishedByUserId: input.actorUserId,
          version: { increment: 1 },
        },
      });

      const nextStatus: EngineAgentStatus = agent.status === 'Archived' ? 'Archived' : 'Active';
      if (
        agent.status !== 'Active' &&
        !mayMoveEngineAgent(agent.status as EngineAgentStatus, nextStatus)
      ) {
        throw new ConflictException(
          `An agent that is ${agent.status} cannot be moved to ${nextStatus}.`,
        );
      }

      const updated = await this.prisma.client.engineAgent.update({
        where: { id: agent.id },
        data: {
          currentVersionId: published.id,
          // The memory mode the version declares becomes the agent's, so the registry and the
          // configuration in force cannot disagree about what it may remember.
          memoryMode: config.memoryMode,
          status: nextStatus,
          ...(agent.activatedAt === null
            ? { activatedAt: new Date(), activatedByUserId: input.actorUserId }
            : {}),
          ...(nextStatus === 'Active' ? { pausedReason: null } : {}),
          updatedByUserId: input.actorUserId,
          version: { increment: 1 },
        },
      });

      await this.auditEvents.appendWithinCurrentScope(input.scope.tenantId, {
        action: 'agent.version_activated',
        resourceType: 'engine-agent',
        resourceId: agent.id,
        actorUserId: input.actorUserId,
        resourceRef: agent.name,
        resourceVersion: updated.version,
        summary:
          `Version ${published.versionNumber} of "${agent.name}" is now the configuration in ` +
          'force. The version it replaced stays readable as what produced its runs.',
        metadata: {
          versionNumber: published.versionNumber,
          approvalWasRequired: draft.approvalRequired,
          ...(input.approvalRequestId === undefined
            ? {}
            : { approvalRequestId: input.approvalRequestId }),
          ...(approvedByUserId === null ? {} : { approvedByUserId }),
          memoryMode: config.memoryMode,
          testedBeforeActivation: draft.testedAt !== null,
          testPassed: draft.testPassed,
        },
      });

      return this.viewOf(input.scope, updated);
    });
  }

  // -------------------------------------------------------------------------
  // Internals
  // -------------------------------------------------------------------------

  private blankSetup(): AgentExecutionSetup {
    return {
      runType: null,
      triggerOrFrequency: null,
      inputConnectionId: null,
      whereWorkHappens: null,
      outputDestination: null,
      missingDataBehaviour: null,
    };
  }

  private configOf(stored: unknown): {
    setup: AgentExecutionSetup | null;
    memoryMode: AgentMemoryMode;
    skillVersionIds: string[];
    toolCategories: string[];
    assignedWork: string | null;
    approvalRequired: boolean;
    completionEvidence: string | null;
  } {
    const raw = (stored ?? {}) as Record<string, unknown>;
    return {
      setup: (raw['setup'] as AgentExecutionSetup | undefined) ?? null,
      // A version written before memory mode existed reads as the mode that persists nothing,
      // which is the safe direction to guess in.
      memoryMode:
        typeof raw['memoryMode'] === 'string' &&
        (AGENT_MEMORY_MODES as readonly string[]).includes(raw['memoryMode'])
          ? (raw['memoryMode'] as AgentMemoryMode)
          : 'CurrentRunOnly',
      skillVersionIds: Array.isArray(raw['skillVersionIds'])
        ? (raw['skillVersionIds'] as string[])
        : [],
      toolCategories: Array.isArray(raw['toolCategories'])
        ? (raw['toolCategories'] as string[])
        : [],
      assignedWork: typeof raw['assignedWork'] === 'string' ? raw['assignedWork'] : null,
      approvalRequired: raw['approvalRequired'] === true,
      completionEvidence:
        typeof raw['completionEvidence'] === 'string' ? raw['completionEvidence'] : null,
    };
  }

  private impactOf(input: {
    liveConfig: ReturnType<EngineAgentService['configOf']>;
    liveMemoryMode: AgentMemoryMode;
    nextSetup: AgentExecutionSetup;
    nextMemoryMode: AgentMemoryMode;
    nextSkills: string[];
    nextTools: string[];
    objectiveIds: string[];
  }): AgentVersionImpact {
    const changedFields: string[] = [];
    const liveSetup = input.liveConfig.setup ?? this.blankSetup();

    for (const key of Object.keys(liveSetup) as (keyof AgentExecutionSetup)[]) {
      if (liveSetup[key] !== input.nextSetup[key]) changedFields.push(key);
    }
    if (input.liveMemoryMode !== input.nextMemoryMode) changedFields.push('memoryMode');

    const addedSkillVersionIds = input.nextSkills.filter(
      (id) => !input.liveConfig.skillVersionIds.includes(id),
    );
    const removedSkillVersionIds = input.liveConfig.skillVersionIds.filter(
      (id) => !input.nextSkills.includes(id),
    );
    if (addedSkillVersionIds.length > 0 || removedSkillVersionIds.length > 0) {
      changedFields.push('skillVersionIds');
    }

    const addedToolCategories = input.nextTools.filter(
      (category) => !input.liveConfig.toolCategories.includes(category),
    );
    if (addedToolCategories.length > 0) changedFields.push('toolCategories');

    // Widening means the mode now keeps something beyond the run when it previously did not.
    // Going the other way — from Agent Memory back to Current Run Only — is a narrowing, and
    // narrowing must never need permission.
    const memoryModeWidens =
      memoryModePersistsBeyondRun(input.nextMemoryMode) &&
      !memoryModePersistsBeyondRun(input.liveMemoryMode);

    const decision = versionActivationNeedsApproval({
      addedToolCategories,
      memoryModeWidens,
      affectedObjectiveCount: input.objectiveIds.length,
    });

    return {
      changedFields,
      affectedObjectiveIds: input.objectiveIds,
      addedSkillVersionIds,
      removedSkillVersionIds,
      addedToolCategories,
      widensReach: addedToolCategories.length > 0 || memoryModeWidens,
      approvalRequired: decision.required,
      reasons: decision.reasons,
    };
  }

  private async objectiveIdsFor(scope: TenantScope, agentId: string): Promise<string[]> {
    const assignments = await this.prisma.client.aiWorkAssignment.findMany({
      where: { tenantId: scope.tenantId, engineAgentId: agentId },
      select: { objectiveId: true },
    });
    return [...new Set(assignments.map((row) => row.objectiveId))];
  }

  private async load(scope: TenantScope, agentId: string) {
    const row = await this.prisma.client.engineAgent.findFirst({
      where: { tenantId: scope.tenantId, id: agentId },
    });
    if (!row) {
      throw new NotFoundException('There is no such Engine Agent you can see.');
    }
    return row;
  }

  private async requireVersion(scope: TenantScope, agentId: string, versionId: string) {
    const row = await this.prisma.client.engineAgentVersion.findFirst({
      where: { tenantId: scope.tenantId, engineAgentId: agentId, id: versionId },
    });
    if (!row) {
      throw new NotFoundException('There is no such version of this agent.');
    }
    return row;
  }

  /** One place for the status move, the audit event and the reload. */
  private async transition(
    input: { scope: TenantScope; actorUserId: string; agentId: string },
    to: EngineAgentStatus,
    action: 'Pause' | 'Publish',
    change: {
      pausedReason: string | null;
      archivedAt?: Date;
      archivedByUserId?: string;
      summary: string;
      action: string;
    },
  ): Promise<EngineAgentView> {
    const context = await this.authorization.contextFor(input.scope, input.actorUserId);
    await this.authorization.assertCan(context, { module: 'agents', action });

    return this.prisma.runInTenantTransaction(input.scope, async () => {
      const agent = await this.load(input.scope, input.agentId);
      await this.assertMayTouch(context, agent, action);

      const from = agent.status as EngineAgentStatus;
      if (!mayMoveEngineAgent(from, to)) {
        throw new ConflictException(
          `An agent that is ${from} cannot become ${to}. Permitted from here: ` +
            `${engineAgentActionsFor(from).join(', ')}.`,
        );
      }

      const updated = await this.prisma.client.engineAgent.update({
        where: { id: agent.id },
        data: {
          status: to,
          pausedReason: change.pausedReason,
          ...(change.archivedAt === undefined ? {} : { archivedAt: change.archivedAt }),
          ...(change.archivedByUserId === undefined
            ? {}
            : { archivedByUserId: change.archivedByUserId }),
          updatedByUserId: input.actorUserId,
          version: { increment: 1 },
        },
      });

      await this.auditEvents.appendWithinCurrentScope(input.scope.tenantId, {
        action: change.action,
        resourceType: 'engine-agent',
        resourceId: agent.id,
        actorUserId: input.actorUserId,
        resourceRef: agent.name,
        resourceVersion: updated.version,
        summary: `"${agent.name}" moved from ${from} to ${to}. ${change.summary}`,
        metadata: { from, to },
      });

      return this.viewOf(input.scope, updated);
    });
  }

  private async viewOf(
    scope: TenantScope,
    agent: Awaited<ReturnType<EngineAgentService['load']>>,
  ): Promise<EngineAgentView> {
    const versions = await this.prisma.client.engineAgentVersion.findMany({
      where: { tenantId: scope.tenantId, engineAgentId: agent.id },
      orderBy: { versionNumber: 'desc' },
    });

    const views = versions.map((version) => this.versionViewOf(version, agent.currentVersionId));
    const current = views.find((version) => version.isCurrent) ?? null;
    const openDraft = views.find((version) => version.status === 'Draft') ?? null;
    const objectiveIds = await this.objectiveIdsFor(scope, agent.id);

    return {
      id: agent.id,
      name: agent.name,
      ownerUserId: agent.ownerUserId,
      status: agent.status as EngineAgentStatus,
      memoryMode: agent.memoryMode as AgentMemoryMode,
      pausedReason: agent.pausedReason,
      objectiveIds,
      currentVersion: current,
      openDraft,
      versions: views,
      scheduleOrTrigger: current?.setup?.triggerOrFrequency ?? current?.setup?.runType ?? null,
      skillVersionIds: current?.skillVersionIds ?? [],
      toolCategories: current?.toolCategories ?? [],
      connectionId: current?.setup?.inputConnectionId ?? null,
      // No runs exist until the run engine arrives, and an empty summary says so rather than
      // rendering a 0% success rate that reads as failure.
      health: emptyEngineAgentHealth(
        'No runs yet. The run engine and its history arrive with the next prompt, and this ' +
          'summary reports real runs only — it never estimates.',
      ),
      usage: {
        hasData: false,
        promptTokens: null,
        completionTokens: null,
        note:
          'No usage recorded. Null rather than zero: a zero would read as "this agent has cost ' +
          'nothing", which is a claim rather than an absence of data.',
      },
      actions: engineAgentActionsFor(agent.status as EngineAgentStatus),
      activatedAt: agent.activatedAt?.toISOString() ?? null,
      archivedAt: agent.archivedAt?.toISOString() ?? null,
      note:
        'A published version is immutable because Runs cite it as what produced their output. A ' +
        'configuration change drafts a new version with an impact analysis.',
    };
  }

  private versionViewOf(
    version: {
      id: string;
      versionNumber: number;
      status: string;
      config: unknown;
      impact: unknown;
      approvalRequired: boolean;
      testedAt: Date | null;
      testPassed: boolean | null;
      testWasReal: boolean | null;
      publishedAt: Date | null;
      createdAt: Date;
    },
    currentVersionId: string | null,
  ): EngineAgentVersionView {
    const config = this.configOf(version.config);
    return {
      id: version.id,
      versionNumber: version.versionNumber,
      status: version.status,
      isCurrent: version.id === currentVersionId,
      memoryMode: config.memoryMode,
      skillVersionIds: config.skillVersionIds,
      toolCategories: config.toolCategories,
      setup: config.setup,
      impact: (version.impact as unknown as AgentVersionImpact | null) ?? null,
      approvalRequired: version.approvalRequired,
      test: {
        at: version.testedAt?.toISOString() ?? null,
        passed: version.testPassed,
        wasReal: version.testWasReal,
      },
      publishedAt: version.publishedAt?.toISOString() ?? null,
      createdAt: version.createdAt.toISOString(),
    };
  }

  /**
   * The row-level decision, made by the scope engine.
   *
   * An agent's owner and the department of the objectives it serves are what the scope engine
   * needs; it decides, not this service. The same reasoning as Agent Builder: a bespoke "owner or
   * admin" rule in a module is a second authorization policy.
   */
  private async mayTouch(
    context: Awaited<ReturnType<AuthorizationService['contextFor']>>,
    agent: { id: string; ownerUserId: string },
    action: 'View' | 'Pause' | 'Publish' | 'Run' | 'Schedule',
  ): Promise<boolean> {
    // The department matters as much as the owner. Without it a Department-scoped Head — the role
    // that owns archiving and versioning — could never reach an agent owned by an employee, and
    // the refusal would look like the agent did not exist.
    const departmentId = await this.departmentOf(agent.id);

    const decision = await this.authorization.authorize(context, {
      module: 'agents',
      action,
      resource: {
        id: agent.id,
        ownerUserId: agent.ownerUserId,
        ...(departmentId === null ? {} : { departmentId }),
      },
    });
    return decision.allowed;
  }

  /**
   * The department this agent serves.
   *
   * Read through the work assigned to it rather than copied onto the agent: the department is the
   * objective's fact, and a stale copy here would decide access from something that had since
   * changed. An agent serving several departments resolves to the first — a real limitation, and
   * one worth stating rather than pretending a single column could express it.
   */
  private async departmentOf(agentId: string): Promise<string | null> {
    const assignment = await this.prisma.client.aiWorkAssignment.findFirst({
      where: { engineAgentId: agentId },
      select: { objectiveVersionId: true },
    });
    if (!assignment) return null;

    const version = await this.prisma.client.objectiveVersion.findFirst({
      where: { id: assignment.objectiveVersionId },
      select: { departmentId: true },
    });
    return version?.departmentId ?? null;
  }

  private async assertMayTouch(
    context: Awaited<ReturnType<AuthorizationService['contextFor']>>,
    agent: { id: string; ownerUserId: string },
    action: 'View' | 'Pause' | 'Publish' | 'Run' | 'Schedule',
  ): Promise<void> {
    if (!(await this.mayTouch(context, agent, action))) {
      // 404 rather than 403: whether a particular agent exists is itself something this person is
      // not entitled to learn.
      throw new NotFoundException('There is no such Engine Agent you can see.');
    }
  }
}
