import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';

import {
  ALLOWED_OBJECTIVE_TRANSITIONS,
  diffObjectiveVersions,
  isObjectiveDraftEditable,
  isObjectiveWorkAssignable,
  mayTransitionObjective,
  OBJECTIVE_STATUS_LABELS,
  validateForm2Objective,
  validateForm2WorkflowSteps,
  validateObjectiveForSubmission,
  validateRewardPanel,
  VERSION_ORIGIN_LABELS,
  type Form2Objective,
  type Form2WorkflowStep,
  type ObjectiveRewardPanel,
  type ObjectiveStatus,
  type ObjectiveVersionDiff,
  type RewardType,
  type StepApprovalKind,
  type StepEngineKind,
  type TimeUnit,
  type VersionOrigin,
} from '@uboss/types';

import { AuditEventService } from '../audit/audit-event.service.js';
import { AuthorizationService } from '../authorization/authorization.service.js';
import type { AuthorizationContext } from '../authorization/authorization.service.js';
import type {
  Objective,
  ObjectiveReward,
  ObjectiveVersion,
  ObjectiveWorkflowStep,
} from '../generated/prisma/client.js';
import { OrganizationRepository } from '../persistence/organization.repository.js';
import { PrismaService } from '../persistence/prisma.service.js';
import type { TenantScope } from '../persistence/tenant-context.js';

// ---------------------------------------------------------------------------
// Views
// ---------------------------------------------------------------------------

export interface ObjectiveStepView extends Form2WorkflowStep {
  id: string;
}

export interface ObjectiveVersionView {
  id: string;
  versionNumber: number;
  status: ObjectiveStatus;
  statusLabel: string;
  content: Form2Objective;
  steps: ObjectiveStepView[];
  /** True once the content is live and may no longer be edited in place. */
  contentFrozen: boolean;
  /**
   * Whether this version's steps may be handed to people as actionable work.
   *
   * The client's rule that **employees receive no actionable work during review**, on the
   * wire. Only a live version is assignable, so a screen cannot offer to assign a plan that
   * is still waiting for a decision.
   */
  workAssignable: boolean;
  /** Derived: "Awaiting approval" and "Approved — awaiting publish" are different things. */
  reviewStage: string;
  sentBackAt: string | null;
  sentBackReason: string | null;
  executionTeamConfirmedAt: string | null;
  approvedAt: string | null;
  approvedByUserId: string | null;
  origin: VersionOrigin;
  copiedFromVersionId: string | null;
  submittedAt: string | null;
  submittedByUserId: string | null;
  publishedAt: string | null;
  /** Which statuses this version may move to next. The closed table, on the wire. */
  nextStatuses: ObjectiveStatus[];
}

/** One row of the client's Version History. */
export interface ObjectiveHistoryEntry {
  /** The exact version id. The client requires historical records to keep it. */
  versionId: string;
  versionNumber: number;
  status: ObjectiveStatus;
  statusLabel: string;
  /** Derived: distinguishes "awaiting approval" from "approved, awaiting publish". */
  reviewStage: string;
  origin: VersionOrigin;
  originLabel: string;
  copiedFromVersionId: string | null;
  copiedFromVersionNumber: number | null;
  live: boolean;
  submittedAt: string | null;
  submittedByUserId: string | null;
  sentBackAt: string | null;
  sentBackByUserId: string | null;
  sentBackReason: string | null;
  executionTeamConfirmedAt: string | null;
  executionTeamConfirmedByUserId: string | null;
  approvedAt: string | null;
  approvedByUserId: string | null;
  publishedAt: string | null;
  stepCount: number;
  createdAt: string;
  createdByUserId: string | null;
}

export interface ObjectiveRewardView extends ObjectiveRewardPanel {
  id: string;
  /**
   * Stated on every read, because the screen must not imply that saving this panel pays anybody.
   * The client's rule is that eligibility and approval are decided later, by the reward workflow.
   */
  note: string;
}

export interface ObjectiveView {
  id: string;
  code: string;
  departmentId: string;
  objectiveOwnerUserId: string;
  /** The version live work references, if any. */
  activeVersion: ObjectiveVersionView | null;
  /** The one open draft, if there is one. */
  openDraft: ObjectiveVersionView | null;
  versions: ObjectiveVersionView[];
  /** Null when no panel has been saved. Absent is different from "not applicable". */
  reward: ObjectiveRewardView | null;
  createdByUserId: string | null;
  createdAt: string;
  updatedAt: string;
}

/** One row of the objectives list. Deliberately smaller than `ObjectiveView`. */
export interface ObjectiveListRow {
  id: string;
  code: string;
  objectiveName: string;
  departmentId: string;
  /** The status a person means when they ask "what state is this objective in". */
  status: ObjectiveStatus;
  statusLabel: string;
  /** The live version number, or the latest draft's when nothing is live. */
  versionNumber: number;
  /** True when `versionNumber` refers to a published version. */
  live: boolean;
  responsibleOwnerUserId: string | null;
  targetCompletionTime: number | null;
  timeUnit: TimeUnit | null;
  updatedAt: string;
}

type VersionWithSteps = ObjectiveVersion & { steps: ObjectiveWorkflowStep[] };

/**
 * The Objective Builder — Form 2.
 *
 * ## What this service is responsible for, and what it is not
 *
 * It owns the business-intent screen: creating an objective, editing its draft, and submitting it
 * for review. It deliberately does **not** own AI decomposition, review routing or publication —
 * those are later, separate concerns, and building them here would put the analysis engine inside
 * the form's service.
 *
 * The transition *table* is nonetheless complete and shared (`ALLOWED_OBJECTIVE_TRANSITIONS`),
 * because two partial tables in two services is how they come to disagree. What this service
 * exposes is only the moves it owns; the rest of the table has no endpoint yet.
 *
 * ## Identity, version and the immutability rule
 *
 * An `Objective` is the stable thing; an `ObjectiveVersion` holds the Form 2 content. That split
 * is what makes the client's locked rule expressible: a published version is immutable, and an
 * authorized edit after Live creates a **new draft version** rather than overwriting the live one.
 * Both halves are enforced in the database — a trigger freezes a live version's content, a second
 * trigger freezes its workflow grid, and a partial unique index permits exactly one `Active`
 * version per objective.
 *
 * ## Form 2 is preserved exactly
 *
 * The field list is not written out here. It lives in `FORM2_OBJECTIVE_FIELDS` and
 * `FORM2_WORKFLOW_COLUMNS`, and validation walks those arrays, so a dropped or renamed source
 * field fails a test rather than quietly shipping. `Unit` and `Time Unit` stay separate columns;
 * the workflow grid keeps all fifteen columns; the row count is not fixed.
 *
 * ## The reward panel is outside Form 2, structurally
 *
 * Its own table, its own endpoint, its own permission (`objective:Assign` — promising a bonus is
 * part of assigning work, not part of drafting it). Nothing here pays anybody: there is no
 * approved, settled or paid state to reach, and saving a panel writes no performance event.
 */
@Injectable()
export class ObjectiveService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly authorization: AuthorizationService,
    private readonly auditEvents: AuditEventService,
    /// Prompt 20: the Responsible Owner / Send To check is hierarchy-aware.
    private readonly organization: OrganizationRepository,
  ) {}

  // -------------------------------------------------------------------------
  // Reading
  // -------------------------------------------------------------------------

  /**
   * The objectives list.
   *
   * Scope is applied **per row**, through the same `authorize` call a direct fetch makes, rather
   * than by translating each scope kind into a `where` clause. That is slower and it is the right
   * trade: a second implementation of scope in SQL is a second thing that can be wrong, and the
   * one that is wrong would be the one deciding what a manager may see.
   */
  async list(input: {
    scope: TenantScope;
    actorUserId: string;
    status?: ObjectiveStatus | undefined;
    departmentId?: string | undefined;
    search?: string | undefined;
  }): Promise<{ objectives: ObjectiveListRow[] }> {
    const context = await this.authorization.contextFor(input.scope, input.actorUserId);
    await this.authorization.assertCan(context, { module: 'objective', action: 'View' });

    const rows = await this.prisma.runInTenantTransaction(input.scope, async () => {
      const objectives = await this.prisma.client.objective.findMany({
        where: {
          ...(input.departmentId === undefined ? {} : { departmentId: input.departmentId }),
        },
        orderBy: { updatedAt: 'desc' },
      });

      if (objectives.length === 0) return [];

      const versions = await this.prisma.client.objectiveVersion.findMany({
        // The tenant is named so the planner can use `(tenant_id, objective_id, version_number)`.
        // RLS already confines this read; without the column the index is unusable (ADR-271).
        where: {
          tenantId: input.scope.tenantId,
          objectiveId: { in: objectives.map((objective) => objective.id) },
        },
        orderBy: { versionNumber: 'desc' },
      });

      return objectives.map((objective) => ({
        objective,
        versions: versions.filter((version) => version.objectiveId === objective.id),
      }));
    });

    const visible: ObjectiveListRow[] = [];

    for (const { objective, versions } of rows) {
      const decision = await this.authorization.authorize(context, {
        module: 'objective',
        action: 'View',
        resource: {
          id: objective.id,
          ownerUserId: objective.objectiveOwnerUserId,
          departmentId: objective.departmentId,
          ...(objective.createdByUserId === null
            ? {}
            : { createdByUserId: objective.createdByUserId }),
        },
      });
      if (!decision.allowed) continue;

      // The version a person means: the live one if there is one, otherwise the newest.
      const live = versions.find((version) => version.status === 'Active');
      const newest = versions[0];
      const shown = live ?? newest;
      if (!shown) continue;

      if (input.status !== undefined && shown.status !== input.status) continue;

      if (input.search !== undefined && input.search.trim() !== '') {
        const needle = input.search.trim().toLowerCase();
        const haystack = `${shown.objectiveName} ${objective.code}`.toLowerCase();
        if (!haystack.includes(needle)) continue;
      }

      visible.push({
        id: objective.id,
        code: objective.code,
        objectiveName: shown.objectiveName,
        departmentId: objective.departmentId,
        status: shown.status,
        statusLabel: OBJECTIVE_STATUS_LABELS[shown.status],
        versionNumber: shown.versionNumber,
        live: shown.status === 'Active',
        responsibleOwnerUserId: shown.responsibleOwnerUserId,
        targetCompletionTime: shown.targetCompletionTime,
        timeUnit: shown.timeUnit as TimeUnit | null,
        updatedAt: objective.updatedAt.toISOString(),
      });
    }

    return { objectives: visible };
  }

  async view(input: {
    scope: TenantScope;
    actorUserId: string;
    objectiveId: string;
  }): Promise<ObjectiveView> {
    const context = await this.authorization.contextFor(input.scope, input.actorUserId);
    await this.authorization.assertCan(context, { module: 'objective', action: 'View' });

    const loaded = await this.load(input.scope, input.objectiveId);
    await this.assertOnResource(context, loaded.objective, 'View');

    return this.viewOf(loaded.objective, loaded.versions, loaded.reward);
  }

  // -------------------------------------------------------------------------
  // Authoring
  // -------------------------------------------------------------------------

  /**
   * Create an objective and its first draft version.
   *
   * `objective:Create`. The department on the form is the scope anchor, so the check is made
   * against *that* department — creating an objective in a department you do not reach is
   * refused, which a coarse module-level check would have permitted.
   */
  async create(input: {
    scope: TenantScope;
    actorUserId: string;
    /** Optional: generated from the department and the year when the caller does not supply one. */
    code?: string | undefined;
    content: Form2Objective;
    steps?: readonly Form2WorkflowStep[] | undefined;
  }): Promise<ObjectiveView> {
    const context = await this.authorization.contextFor(input.scope, input.actorUserId);

    const problems = [
      ...validateForm2Objective(input.content),
      ...validateForm2WorkflowSteps(input.steps ?? []),
    ];
    if (problems.length > 0) {
      throw new BadRequestException(problems.join(' '));
    }

    await this.authorization.assertCan(context, {
      module: 'objective',
      action: 'Create',
      resource: {
        // Not yet persisted, so the id is the department it will live in — the only resource
        // dimension that exists before the row does.
        id: input.content.departmentId,
        ownerUserId: input.content.objectiveOwnerUserId,
        departmentId: input.content.departmentId,
        createdByUserId: input.actorUserId,
      },
    });

    return this.prisma.runInTenantTransaction(input.scope, async () => {
      await this.assertDepartmentIsOpen(input.content.departmentId);

      // Prompt 20: the Send To is hierarchy-aware.
      if (input.content.responsibleOwnerUserId !== null) {
        await this.checkResponsibleOwnerWithinCurrentScope({
          scope: input.scope,
          objectiveOwnerUserId: input.content.objectiveOwnerUserId,
          responsibleOwnerUserId: input.content.responsibleOwnerUserId,
        });
      }

      const code = input.code ?? (await this.nextCode(input.content.departmentId));

      const clash = await this.prisma.client.objective.findFirst({ where: { code } });
      if (clash) {
        throw new ConflictException(`An objective with the code ${code} already exists.`);
      }

      const objective = await this.prisma.client.objective.create({
        data: {
          tenantId: input.scope.tenantId,
          code,
          departmentId: input.content.departmentId,
          objectiveOwnerUserId: input.content.objectiveOwnerUserId,
          createdByUserId: input.actorUserId,
        },
      });

      const version = await this.prisma.client.objectiveVersion.create({
        data: {
          tenantId: input.scope.tenantId,
          objectiveId: objective.id,
          versionNumber: 1,
          status: 'Draft',
          ...this.contentColumns(input.content),
          createdByUserId: input.actorUserId,
        },
      });

      await this.writeSteps(input.scope, version.id, input.steps ?? []);

      await this.auditEvents.appendWithinCurrentScope(input.scope.tenantId, {
        action: 'objective.created',
        resourceType: 'objective',
        resourceId: objective.id,
        actorUserId: input.actorUserId,
        resourceRef: code,
        summary: `Created the objective "${input.content.objectiveName}" as a draft.`,
        metadata: {
          code,
          departmentId: input.content.departmentId,
          objectiveOwnerUserId: input.content.objectiveOwnerUserId,
          versionNumber: 1,
          stepCount: (input.steps ?? []).length,
        },
      });

      const loaded = await this.load(input.scope, objective.id, { alreadyInTransaction: true });
      return this.viewOf(loaded.objective, loaded.versions, loaded.reward);
    });
  }

  /**
   * Replace a draft's Form 2 content and its workflow grid.
   *
   * `objective:EditDraft`. The grid is written as a whole rather than patched row by row: the
   * approved UI edits it as a spreadsheet — insert, duplicate, delete, reorder — and reconciling
   * that into per-row operations would invent an ordering the screen never had.
   */
  async updateDraft(input: {
    scope: TenantScope;
    actorUserId: string;
    objectiveId: string;
    /** Defaults to the one open draft. Named explicitly when there is more than one candidate. */
    versionId?: string | undefined;
    content: Form2Objective;
    steps: readonly Form2WorkflowStep[];
  }): Promise<ObjectiveView> {
    const context = await this.authorization.contextFor(input.scope, input.actorUserId);
    await this.authorization.assertCan(context, { module: 'objective', action: 'EditDraft' });

    const problems = [
      ...validateForm2Objective(input.content),
      ...validateForm2WorkflowSteps(input.steps),
    ];
    if (problems.length > 0) {
      throw new BadRequestException(problems.join(' '));
    }

    return this.prisma.runInTenantTransaction(input.scope, async () => {
      const loaded = await this.load(input.scope, input.objectiveId, {
        alreadyInTransaction: true,
      });
      await this.assertOnResource(context, loaded.objective, 'EditDraft');

      // The client's strict rule: **any later edit by any authorized user automatically creates
      // V2 Draft copied from V1.** So editing an objective whose only versions are live or
      // finished is not refused — it opens the next draft and edits that. Prompt 19 refused here;
      // Prompt 20 is where the rule arrives, and this is the whole of it.
      //
      // A **minor** edit takes the same path. There is deliberately no "nothing really changed"
      // shortcut: that shortcut is how a live plan gets rewritten under the people executing it.
      const hasOpenDraft = loaded.versions.some((version) =>
        isObjectiveDraftEditable(version.status as ObjectiveStatus),
      );

      // **But not while somebody is reviewing.** The rule is about editing an objective that is
      // *finished with* — live, completed or archived. A version sitting in `UnderReview` or
      // `ReadyForApproval` is waiting on a decision, and quietly opening a new draft there would
      // let an author route around the reviewer: they would edit the copy, publish it, and the
      // review would have decided nothing. Editing that still requires a send-back first.
      //
      // The first version of this check omitted the condition and a Prompt 19 test caught it.
      const awaitingDecision = loaded.versions.some(
        (version) => version.status === 'UnderReview' || version.status === 'ReadyForApproval',
      );

      let versions = loaded.versions;
      let autoOpenedVersionId: string | null = null;

      if (!hasOpenDraft && !awaitingDecision && input.versionId === undefined) {
        const opened = await this.copyIntoNewDraftWithinCurrentScope({
          scope: input.scope,
          actorUserId: input.actorUserId,
          objective: loaded.objective,
          versions: loaded.versions,
          origin: 'Edit',
        });
        autoOpenedVersionId = opened.id;
        const reloaded = await this.load(input.scope, input.objectiveId, {
          alreadyInTransaction: true,
        });
        versions = reloaded.versions;
      }

      const target = this.editableVersion(
        versions,
        input.versionId ?? autoOpenedVersionId ?? undefined,
      );

      await this.assertDepartmentIsOpen(input.content.departmentId);

      // Prompt 20: the Send To is hierarchy-aware.
      if (input.content.responsibleOwnerUserId !== null) {
        await this.checkResponsibleOwnerWithinCurrentScope({
          scope: input.scope,
          objectiveOwnerUserId: input.content.objectiveOwnerUserId,
          responsibleOwnerUserId: input.content.responsibleOwnerUserId,
        });
      }

      await this.prisma.client.objectiveVersion.update({
        where: { id: target.id },
        data: {
          ...this.contentColumns(input.content),
          version: { increment: 1 },
        },
      });

      // Whole-grid replacement. Safe here because the version is a draft: the freeze trigger
      // would have refused this on a live one, which is the point of it being a trigger.
      await this.prisma.client.objectiveWorkflowStep.deleteMany({
        where: { objectiveVersionId: target.id },
      });
      await this.writeSteps(input.scope, target.id, input.steps);

      // The objective's scope anchor follows the draft while nothing is live. Once a version is
      // live it follows *that*, so a draft proposing a move cannot relocate a running objective.
      if (
        loaded.objective.activeVersionId === null &&
        (loaded.objective.departmentId !== input.content.departmentId ||
          loaded.objective.objectiveOwnerUserId !== input.content.objectiveOwnerUserId)
      ) {
        await this.prisma.client.objective.update({
          where: { id: loaded.objective.id },
          data: {
            departmentId: input.content.departmentId,
            objectiveOwnerUserId: input.content.objectiveOwnerUserId,
            version: { increment: 1 },
          },
        });
      }

      await this.auditEvents.appendWithinCurrentScope(input.scope.tenantId, {
        action: 'objective.draft_saved',
        resourceType: 'objective',
        resourceId: loaded.objective.id,
        actorUserId: input.actorUserId,
        resourceRef: `${loaded.objective.code} V${target.versionNumber}`,
        resourceVersion: target.version,
        summary: `Saved draft V${target.versionNumber} of "${input.content.objectiveName}".`,
        metadata: {
          versionNumber: target.versionNumber,
          stepCount: input.steps.length,
        },
      });

      const after = await this.load(input.scope, input.objectiveId, {
        alreadyInTransaction: true,
      });
      return this.viewOf(after.objective, after.versions, after.reward);
    });
  }

  /**
   * Submit a draft for review.
   *
   * `objective:EditDraft` — submitting your own draft is part of drafting it, not an approval.
   * The extra checks in `validateObjectiveForSubmission` apply here and nowhere else: drafting
   * stays permissive because a form that refuses to save is a form people keep in a spreadsheet,
   * and submitting is the moment the objective becomes somebody else's problem.
   */
  async submitForReview(input: {
    scope: TenantScope;
    actorUserId: string;
    objectiveId: string;
    versionId?: string | undefined;
  }): Promise<ObjectiveView> {
    const context = await this.authorization.contextFor(input.scope, input.actorUserId);
    await this.authorization.assertCan(context, { module: 'objective', action: 'EditDraft' });

    return this.prisma.runInTenantTransaction(input.scope, async () => {
      const loaded = await this.load(input.scope, input.objectiveId, {
        alreadyInTransaction: true,
      });
      await this.assertOnResource(context, loaded.objective, 'EditDraft');

      const target = this.editableVersion(loaded.versions, input.versionId);

      if (!mayTransitionObjective(target.status as ObjectiveStatus, 'UnderReview')) {
        throw new ConflictException(
          `A version that is ${OBJECTIVE_STATUS_LABELS[target.status as ObjectiveStatus]} ` +
            'cannot be submitted for review.',
        );
      }

      const problems = validateObjectiveForSubmission(
        this.contentOf(target),
        target.steps.map((step) => this.stepOf(step)),
      );
      if (problems.length > 0) {
        throw new BadRequestException(problems.join(' '));
      }

      await this.prisma.client.objectiveVersion.update({
        where: { id: target.id },
        data: {
          status: 'UnderReview',
          submittedAt: new Date(),
          submittedByUserId: input.actorUserId,
          version: { increment: 1 },
        },
      });

      await this.auditEvents.appendWithinCurrentScope(input.scope.tenantId, {
        action: 'objective.submitted_for_review',
        resourceType: 'objective',
        resourceId: loaded.objective.id,
        actorUserId: input.actorUserId,
        resourceRef: `${loaded.objective.code} V${target.versionNumber}`,
        resourceVersion: target.version,
        summary: `Submitted V${target.versionNumber} of "${target.objectiveName}" for review.`,
        metadata: {
          versionNumber: target.versionNumber,
          responsibleOwnerUserId: target.responsibleOwnerUserId,
          stepCount: target.steps.length,
        },
      });

      const after = await this.load(input.scope, input.objectiveId, {
        alreadyInTransaction: true,
      });
      return this.viewOf(after.objective, after.versions, after.reward);
    });
  }

  // -------------------------------------------------------------------------
  // Review routing (Prompt 20)
  // -------------------------------------------------------------------------

  /**
   * Confirm the execution team — the responsible manager accepting who will do the work.
   *
   * `objective:Assign`, and only the **responsible owner** the form named. Distinct from approving
   * the plan: agreeing the team and agreeing the objective are different findings, and the client
   * lists them as separate manager actions. This is a precondition of `completeReview`, so the
   * step is load-bearing rather than decorative.
   */
  async confirmExecutionTeam(input: {
    scope: TenantScope;
    actorUserId: string;
    objectiveId: string;
    versionId?: string | undefined;
    /** Optional correction to the team, which the manager may adjust as they accept it. */
    executionTeam?: string | undefined;
  }): Promise<ObjectiveView> {
    const context = await this.authorization.contextFor(input.scope, input.actorUserId);
    await this.authorization.assertCan(context, { module: 'objective', action: 'Assign' });

    return this.prisma.runInTenantTransaction(input.scope, async () => {
      const loaded = await this.load(input.scope, input.objectiveId, {
        alreadyInTransaction: true,
      });
      await this.assertOnResource(context, loaded.objective, 'Assign');

      const target = this.reviewableVersion(loaded.versions, input.versionId);
      this.assertIsResponsibleOwner(target, input.actorUserId, 'confirm the execution team for');

      await this.prisma.client.objectiveVersion.update({
        where: { id: target.id },
        data: {
          executionTeamConfirmedAt: new Date(),
          executionTeamConfirmedByUserId: input.actorUserId,
          ...(input.executionTeam === undefined ? {} : { executionTeam: input.executionTeam }),
          version: { increment: 1 },
        },
      });

      await this.auditEvents.appendWithinCurrentScope(input.scope.tenantId, {
        action: 'objective.execution_team_confirmed',
        resourceType: 'objective',
        resourceId: loaded.objective.id,
        actorUserId: input.actorUserId,
        resourceRef: `${loaded.objective.code} V${target.versionNumber}`,
        resourceVersion: target.version,
        summary: `Confirmed the execution team for V${target.versionNumber}.`,
        metadata: {
          versionId: target.id,
          versionNumber: target.versionNumber,
          executionTeam: input.executionTeam ?? target.executionTeam,
        },
      });

      const after = await this.load(input.scope, input.objectiveId, {
        alreadyInTransaction: true,
      });
      return this.viewOf(after.objective, after.versions, after.reward);
    });
  }

  /**
   * Send back / request changes: the version returns to `Draft` with the reviewer's reason.
   *
   * `objective:Approve` and only the responsible owner. A reason is required, and a constraint
   * insists too — a send-back with no reason is the one that comes straight back unchanged.
   *
   * **Any approval is cleared.** An approval is a decision about specific content, and content
   * that is about to change makes it worthless. Leaving it would let the next publish go live on
   * an approval nobody gave for what it now says.
   */
  async sendBack(input: {
    scope: TenantScope;
    actorUserId: string;
    objectiveId: string;
    versionId?: string | undefined;
    reason: string;
  }): Promise<ObjectiveView> {
    if (input.reason.trim() === '') {
      throw new BadRequestException(
        'A send-back needs a reason. Without one the author cannot act on it, and it comes ' +
          'straight back unchanged.',
      );
    }

    const context = await this.authorization.contextFor(input.scope, input.actorUserId);
    await this.authorization.assertCan(context, { module: 'objective', action: 'Approve' });

    return this.prisma.runInTenantTransaction(input.scope, async () => {
      const loaded = await this.load(input.scope, input.objectiveId, {
        alreadyInTransaction: true,
      });
      await this.assertOnResource(context, loaded.objective, 'Approve');

      // `ReadyForApproval` is included, unlike the other review actions: the transition table
      // already permits `ReadyForApproval -> Draft`, and a reviewer who changes their mind after
      // sending something for approval — or after it was approved — must be able to pull it back.
      // That is exactly the case where clearing the approval below matters.
      const target = this.reviewableVersion(loaded.versions, input.versionId, {
        includeReadyForApproval: true,
      });
      this.assertIsResponsibleOwner(target, input.actorUserId, 'send back');

      if (!mayTransitionObjective(target.status as ObjectiveStatus, 'Draft')) {
        throw new ConflictException(
          `A version that is ${OBJECTIVE_STATUS_LABELS[target.status as ObjectiveStatus]} ` +
            'cannot be sent back.',
        );
      }

      await this.prisma.client.objectiveVersion.update({
        where: { id: target.id },
        data: {
          status: 'Draft',
          sentBackAt: new Date(),
          sentBackByUserId: input.actorUserId,
          sentBackReason: input.reason,
          // See the method comment: an approval cannot survive the content changing.
          approvedAt: null,
          approvedByUserId: null,
          version: { increment: 1 },
        },
      });

      await this.auditEvents.appendWithinCurrentScope(input.scope.tenantId, {
        action: 'objective.sent_back',
        resourceType: 'objective',
        resourceId: loaded.objective.id,
        actorUserId: input.actorUserId,
        resourceRef: `${loaded.objective.code} V${target.versionNumber}`,
        resourceVersion: target.version,
        reason: input.reason,
        summary: `Sent V${target.versionNumber} back for changes.`,
        metadata: {
          versionId: target.id,
          versionNumber: target.versionNumber,
          clearedApproval: target.approvedAt !== null,
        },
      });

      const after = await this.load(input.scope, input.objectiveId, {
        alreadyInTransaction: true,
      });
      return this.viewOf(after.objective, after.versions, after.reward);
    });
  }

  /**
   * Finish the review: the version moves to `ReadyForApproval`.
   *
   * `objective:Assign` and only the responsible owner — this is the reviewer saying "I have read
   * it and it is ready for a decision", not the decision itself. Requires the execution team to
   * have been confirmed first, which is what makes that step matter.
   */
  async completeReview(input: {
    scope: TenantScope;
    actorUserId: string;
    objectiveId: string;
    versionId?: string | undefined;
  }): Promise<ObjectiveView> {
    const context = await this.authorization.contextFor(input.scope, input.actorUserId);
    await this.authorization.assertCan(context, { module: 'objective', action: 'Assign' });

    return this.prisma.runInTenantTransaction(input.scope, async () => {
      const loaded = await this.load(input.scope, input.objectiveId, {
        alreadyInTransaction: true,
      });
      await this.assertOnResource(context, loaded.objective, 'Assign');

      const target = this.reviewableVersion(loaded.versions, input.versionId);
      this.assertIsResponsibleOwner(target, input.actorUserId, 'complete the review of');

      if (target.executionTeamConfirmedAt === null) {
        throw new ConflictException(
          'Confirm the execution team before sending this for approval. Approving a plan with ' +
            'nobody agreed to do it is how an objective goes live unassignable.',
        );
      }

      if (!mayTransitionObjective(target.status as ObjectiveStatus, 'ReadyForApproval')) {
        throw new ConflictException(
          `A version that is ${OBJECTIVE_STATUS_LABELS[target.status as ObjectiveStatus]} ` +
            'cannot be sent for approval.',
        );
      }

      await this.prisma.client.objectiveVersion.update({
        where: { id: target.id },
        data: { status: 'ReadyForApproval', version: { increment: 1 } },
      });

      await this.auditEvents.appendWithinCurrentScope(input.scope.tenantId, {
        action: 'objective.review_completed',
        resourceType: 'objective',
        resourceId: loaded.objective.id,
        actorUserId: input.actorUserId,
        resourceRef: `${loaded.objective.code} V${target.versionNumber}`,
        resourceVersion: target.version,
        summary: `Reviewed V${target.versionNumber} and sent it for approval.`,
        metadata: { versionId: target.id, versionNumber: target.versionNumber },
      });

      const after = await this.load(input.scope, input.objectiveId, {
        alreadyInTransaction: true,
      });
      return this.viewOf(after.objective, after.versions, after.reward);
    });
  }

  /**
   * Approve the version. **This does not publish it and it does not change the status.**
   *
   * The client's chain is `... -> Approved -> Published -> LIVE`: two acts. The status enum is the
   * client's own eight-state list with no `Approved` member, so approval is recorded as a fact on
   * the version — `approvedAt` set while the status stays `ReadyForApproval`. `reviewStage` on the
   * view reports "Approved — awaiting publish" so a screen can say so plainly. See ADR-104.
   *
   * `objective:Approve`. The separation-of-duties engine additionally refuses somebody approving
   * what they created, which is why no explicit self-approval check is written here: one already
   * runs, and a second would be a second thing to keep correct.
   */
  async approve(input: {
    scope: TenantScope;
    actorUserId: string;
    objectiveId: string;
    versionId?: string | undefined;
    reason?: string | undefined;
  }): Promise<ObjectiveView> {
    const context = await this.authorization.contextFor(input.scope, input.actorUserId);
    await this.authorization.assertCan(context, { module: 'objective', action: 'Approve' });

    return this.prisma.runInTenantTransaction(input.scope, async () => {
      const loaded = await this.load(input.scope, input.objectiveId, {
        alreadyInTransaction: true,
      });
      await this.assertOnResource(context, loaded.objective, 'Approve');

      const target = this.namedVersion(loaded.versions, input.versionId, 'ReadyForApproval');

      if (target.approvedAt !== null) {
        throw new ConflictException(`V${target.versionNumber} has already been approved.`);
      }

      await this.prisma.client.objectiveVersion.update({
        where: { id: target.id },
        data: {
          approvedAt: new Date(),
          approvedByUserId: input.actorUserId,
          version: { increment: 1 },
        },
      });

      await this.auditEvents.appendWithinCurrentScope(input.scope.tenantId, {
        action: 'objective.approved',
        resourceType: 'objective',
        resourceId: loaded.objective.id,
        actorUserId: input.actorUserId,
        resourceRef: `${loaded.objective.code} V${target.versionNumber}`,
        resourceVersion: target.version,
        ...(input.reason === undefined ? {} : { reason: input.reason }),
        summary:
          `Approved V${target.versionNumber}. It is **not yet live**: publishing is a separate ` +
          'act, and until it happens the currently live version keeps running.',
        metadata: { versionId: target.id, versionNumber: target.versionNumber, published: false },
      });

      const after = await this.load(input.scope, input.objectiveId, {
        alreadyInTransaction: true,
      });
      return this.viewOf(after.objective, after.versions, after.reward);
    });
  }

  /**
   * Publish an approved version: it becomes `Active` and the objective's live version.
   *
   * `objective:Publish`, and the version must already be approved — a constraint enforces that
   * too, so it holds even against a direct database write.
   *
   * **The previously live version is archived in the same transaction.** The client's rule is
   * that V1 remains live until V2 is published, which means the moment V2 publishes V1 stops
   * being live. `one_active_version_per_objective` would refuse otherwise, so the constraint is
   * what forced this to be explicit rather than left to chance.
   */
  async publish(input: {
    scope: TenantScope;
    actorUserId: string;
    objectiveId: string;
    versionId?: string | undefined;
  }): Promise<ObjectiveView> {
    const context = await this.authorization.contextFor(input.scope, input.actorUserId);
    await this.authorization.assertCan(context, { module: 'objective', action: 'Publish' });

    return this.prisma.runInTenantTransaction(input.scope, async () => {
      const loaded = await this.load(input.scope, input.objectiveId, {
        alreadyInTransaction: true,
      });
      await this.assertOnResource(context, loaded.objective, 'Publish');

      const target = this.namedVersion(loaded.versions, input.versionId, 'ReadyForApproval');

      if (target.approvedAt === null) {
        throw new ConflictException(
          `V${target.versionNumber} has not been approved. Nothing goes live without an ` +
            'approval — approving and publishing are separate acts.',
        );
      }

      const previous = loaded.versions.find((version) => version.status === 'Active');

      // The live pointer is cleared first: it holds a foreign key to the version being archived,
      // and the archive is a status move rather than a delete, so order matters only for
      // readability here — but the pointer must end up on the new version either way.
      if (previous) {
        await this.prisma.client.objective.update({
          where: { id: loaded.objective.id },
          data: { activeVersionId: null },
        });
        await this.prisma.client.objectiveVersion.update({
          where: { id: previous.id },
          data: { status: 'Archived', version: { increment: 1 } },
        });
      }

      const published = await this.prisma.client.objectiveVersion.update({
        where: { id: target.id },
        data: { status: 'Active', publishedAt: new Date(), version: { increment: 1 } },
      });

      await this.prisma.client.objective.update({
        where: { id: loaded.objective.id },
        data: {
          activeVersionId: published.id,
          // The scope anchor follows the live version, so a draft that proposed a move only
          // takes effect once that draft is the one running.
          departmentId: published.departmentId,
          objectiveOwnerUserId: published.objectiveOwnerUserId,
          version: { increment: 1 },
        },
      });

      await this.auditEvents.appendWithinCurrentScope(input.scope.tenantId, {
        action: 'objective.published',
        resourceType: 'objective',
        resourceId: loaded.objective.id,
        actorUserId: input.actorUserId,
        resourceRef: `${loaded.objective.code} V${target.versionNumber}`,
        resourceVersion: published.version,
        summary:
          `Published V${target.versionNumber}. It is now the live version` +
          (previous ? `, superseding V${previous.versionNumber}.` : '.'),
        metadata: {
          // The client requires that historical records keep exact version ids.
          versionId: target.id,
          versionNumber: target.versionNumber,
          approvedByUserId: target.approvedByUserId,
          supersededVersionId: previous?.id ?? null,
          supersededVersionNumber: previous?.versionNumber ?? null,
        },
      });

      const after = await this.load(input.scope, input.objectiveId, {
        alreadyInTransaction: true,
      });
      return this.viewOf(after.objective, after.versions, after.reward);
    });
  }

  // -------------------------------------------------------------------------
  // Strict versioning (Prompt 20)
  // -------------------------------------------------------------------------

  /**
   * Open a new draft version, copied from the live version (or the newest if none is live).
   *
   * The client's rule in full: *any later edit by any authorized user automatically creates V2
   * Draft copied from V1; V1 remains live until V2 is approved/published; minor edits also create
   * a new version.* So this copies content **and** the whole grid, and there is no
   * "nothing-changed" shortcut — a version created by an edit that changed nothing is still a
   * version, and the compare view says "nothing changed" rather than pretending it does not
   * exist.
   *
   * `objective:EditDraft`.
   */
  async startNewDraft(input: {
    scope: TenantScope;
    actorUserId: string;
    objectiveId: string;
    /** Copy from a specific version. Defaults to the live one, then the newest. */
    fromVersionId?: string | undefined;
    origin?: 'Edit' | 'Rollback' | undefined;
  }): Promise<ObjectiveView> {
    const context = await this.authorization.contextFor(input.scope, input.actorUserId);
    await this.authorization.assertCan(context, { module: 'objective', action: 'EditDraft' });

    return this.prisma.runInTenantTransaction(input.scope, async () => {
      const loaded = await this.load(input.scope, input.objectiveId, {
        alreadyInTransaction: true,
      });
      await this.assertOnResource(context, loaded.objective, 'EditDraft');

      const created = await this.copyIntoNewDraftWithinCurrentScope({
        scope: input.scope,
        actorUserId: input.actorUserId,
        objective: loaded.objective,
        versions: loaded.versions,
        ...(input.fromVersionId === undefined ? {} : { fromVersionId: input.fromVersionId }),
        origin: input.origin ?? 'Edit',
      });

      const after = await this.load(input.scope, input.objectiveId, {
        alreadyInTransaction: true,
      });
      void created;
      return this.viewOf(after.objective, after.versions, after.reward);
    });
  }

  /**
   * Roll back to an older version.
   *
   * The client's rule is that a rollback **creates a new version based on an older version** — so
   * this is a forward move, not a resurrection. V1's row is never reopened; V4 is created as a
   * copy of V1 with `origin: 'Rollback'` and `copiedFromVersionId` pointing at V1, and it goes
   * through the ordinary review and approval before it can go live. The history stays append-only
   * and every historical record keeps its exact version id.
   *
   * `objective:EditDraft` — a rollback produces a draft, and the decision to make that draft live
   * is still an approval.
   */
  async rollbackTo(input: {
    scope: TenantScope;
    actorUserId: string;
    objectiveId: string;
    versionId: string;
    reason: string;
  }): Promise<ObjectiveView> {
    if (input.reason.trim() === '') {
      throw new BadRequestException(
        'A rollback needs a reason. Replacing the plan people are working to is a decision ' +
          'somebody has to account for.',
      );
    }

    const context = await this.authorization.contextFor(input.scope, input.actorUserId);
    await this.authorization.assertCan(context, { module: 'objective', action: 'EditDraft' });

    return this.prisma.runInTenantTransaction(input.scope, async () => {
      const loaded = await this.load(input.scope, input.objectiveId, {
        alreadyInTransaction: true,
      });
      await this.assertOnResource(context, loaded.objective, 'EditDraft');

      const source = loaded.versions.find((version) => version.id === input.versionId);
      if (!source) {
        throw new NotFoundException('There is no such version of this objective.');
      }

      const created = await this.copyIntoNewDraftWithinCurrentScope({
        scope: input.scope,
        actorUserId: input.actorUserId,
        objective: loaded.objective,
        versions: loaded.versions,
        fromVersionId: source.id,
        origin: 'Rollback',
        reason: input.reason,
      });
      void created;

      const after = await this.load(input.scope, input.objectiveId, {
        alreadyInTransaction: true,
      });
      return this.viewOf(after.objective, after.versions, after.reward);
    });
  }

  /**
   * The version history.
   *
   * Every version, newest first, with its origin, its parent's number and every act recorded
   * against it. This is the client's Version History, and the exact version ids are on the wire
   * because historical records have to keep them.
   */
  async history(input: {
    scope: TenantScope;
    actorUserId: string;
    objectiveId: string;
  }): Promise<{ code: string; entries: ObjectiveHistoryEntry[]; note: string }> {
    const context = await this.authorization.contextFor(input.scope, input.actorUserId);
    await this.authorization.assertCan(context, { module: 'objective', action: 'View' });

    const loaded = await this.load(input.scope, input.objectiveId);
    await this.assertOnResource(context, loaded.objective, 'View');

    const byId = new Map(loaded.versions.map((version) => [version.id, version]));

    const entries: ObjectiveHistoryEntry[] = loaded.versions.map((version) => {
      const parent =
        version.copiedFromVersionId === null
          ? null
          : (byId.get(version.copiedFromVersionId) ?? null);

      return {
        versionId: version.id,
        versionNumber: version.versionNumber,
        status: version.status as ObjectiveStatus,
        statusLabel: OBJECTIVE_STATUS_LABELS[version.status as ObjectiveStatus],
        reviewStage: this.reviewStageOf(version),
        origin: version.origin as VersionOrigin,
        originLabel: VERSION_ORIGIN_LABELS[version.origin as VersionOrigin],
        copiedFromVersionId: version.copiedFromVersionId,
        copiedFromVersionNumber: parent?.versionNumber ?? null,
        live: version.status === 'Active',
        submittedAt: version.submittedAt?.toISOString() ?? null,
        submittedByUserId: version.submittedByUserId,
        sentBackAt: version.sentBackAt?.toISOString() ?? null,
        sentBackByUserId: version.sentBackByUserId,
        sentBackReason: version.sentBackReason,
        executionTeamConfirmedAt: version.executionTeamConfirmedAt?.toISOString() ?? null,
        executionTeamConfirmedByUserId: version.executionTeamConfirmedByUserId,
        approvedAt: version.approvedAt?.toISOString() ?? null,
        approvedByUserId: version.approvedByUserId,
        publishedAt: version.publishedAt?.toISOString() ?? null,
        stepCount: version.steps.length,
        createdAt: version.createdAt.toISOString(),
        createdByUserId: version.createdByUserId,
      };
    });

    return {
      code: loaded.objective.code,
      entries,
      note:
        'Every version is kept with its exact id. An edit never rewrites a version — it creates ' +
        'a new draft copied from the one it came from, and a rollback does the same from an older ' +
        'one. The live version keeps running until a successor is approved and published.',
    };
  }

  /**
   * Compare two versions of an objective.
   *
   * The diff itself is `diffObjectiveVersions` from the shared package, walking the Form 2 field
   * and column arrays rather than the objects' own keys — so a field one version is missing shows
   * as a real difference instead of being skipped.
   */
  async compareVersions(input: {
    scope: TenantScope;
    actorUserId: string;
    objectiveId: string;
    fromVersionId: string;
    toVersionId: string;
  }): Promise<{
    from: { versionId: string; versionNumber: number; statusLabel: string };
    to: { versionId: string; versionNumber: number; statusLabel: string };
    diff: ObjectiveVersionDiff;
  }> {
    const context = await this.authorization.contextFor(input.scope, input.actorUserId);
    await this.authorization.assertCan(context, { module: 'objective', action: 'View' });

    const loaded = await this.load(input.scope, input.objectiveId);
    await this.assertOnResource(context, loaded.objective, 'View');

    const from = loaded.versions.find((version) => version.id === input.fromVersionId);
    const to = loaded.versions.find((version) => version.id === input.toVersionId);

    if (!from || !to) {
      throw new NotFoundException('There is no such version of this objective.');
    }

    const diff = diffObjectiveVersions(
      { content: this.contentOf(from), steps: from.steps.map((step) => this.stepOf(step)) },
      { content: this.contentOf(to), steps: to.steps.map((step) => this.stepOf(step)) },
    );

    return {
      from: {
        versionId: from.id,
        versionNumber: from.versionNumber,
        statusLabel: OBJECTIVE_STATUS_LABELS[from.status as ObjectiveStatus],
      },
      to: {
        versionId: to.id,
        versionNumber: to.versionNumber,
        statusLabel: OBJECTIVE_STATUS_LABELS[to.status as ObjectiveStatus],
      },
      diff,
    };
  }

  // -------------------------------------------------------------------------
  // The Performance & Reward panel
  // -------------------------------------------------------------------------

  /**
   * Save the optional Performance & Reward panel.
   *
   * `objective:Assign`, not `EditDraft`. Promising a bonus is part of *assigning* work, and the
   * distinction has teeth: an Employee's role carries `Create` and `EditDraft` on objectives but
   * not `Assign`, so somebody cannot attach a reward to their own objective. No new vocabulary
   * was invented for this — the client's existing action already draws the line in the right
   * place.
   *
   * Saving this **pays nobody and records no performance event.** The panel is a declaration; the
   * reward workflow that decides eligibility and approval comes later and does not exist yet.
   */
  async saveReward(input: {
    scope: TenantScope;
    actorUserId: string;
    objectiveId: string;
    panel: ObjectiveRewardPanel;
  }): Promise<ObjectiveRewardView> {
    const context = await this.authorization.contextFor(input.scope, input.actorUserId);
    await this.authorization.assertCan(context, { module: 'objective', action: 'Assign' });

    const problems = validateRewardPanel(input.panel);
    if (problems.length > 0) {
      throw new BadRequestException(problems.join(' '));
    }

    return this.prisma.runInTenantTransaction(input.scope, async () => {
      const loaded = await this.load(input.scope, input.objectiveId, {
        alreadyInTransaction: true,
      });
      await this.assertOnResource(context, loaded.objective, 'Assign');

      const columns = {
        applicable: input.panel.applicable,
        rewardType: input.panel.rewardType,
        amountMinorUnits: input.panel.amountMinorUnits,
        eligibilityCondition: input.panel.eligibilityCondition,
        completionDeadline:
          input.panel.completionDeadline === null
            ? null
            : new Date(`${input.panel.completionDeadline}T00:00:00.000Z`),
        evidence: input.panel.evidence,
        approverUserId: input.panel.approverUserId,
      };

      const saved = loaded.reward
        ? await this.prisma.client.objectiveReward.update({
            where: { id: loaded.reward.id },
            data: { ...columns, version: { increment: 1 } },
          })
        : await this.prisma.client.objectiveReward.create({
            data: {
              tenantId: input.scope.tenantId,
              objectiveId: loaded.objective.id,
              ...columns,
              createdByUserId: input.actorUserId,
            },
          });

      await this.auditEvents.appendWithinCurrentScope(input.scope.tenantId, {
        action: 'objective.reward_panel_saved',
        resourceType: 'objective',
        resourceId: loaded.objective.id,
        actorUserId: input.actorUserId,
        resourceRef: loaded.objective.code,
        resourceVersion: saved.version,
        summary: input.panel.applicable
          ? `Recorded a ${input.panel.rewardType ?? 'reward'} on "${loaded.objective.code}". ` +
            'Nothing is payable: eligibility and approval are decided by the reward workflow.'
          : `Recorded that no reward applies to "${loaded.objective.code}".`,
        metadata: {
          applicable: input.panel.applicable,
          rewardType: input.panel.rewardType,
          amountMinorUnits: input.panel.amountMinorUnits,
          approverUserId: input.panel.approverUserId,
          // Stated in the trail so an auditor reading it later does not have to infer it.
          autoPaid: false,
        },
      });

      return this.rewardViewOf(saved);
    });
  }

  async readReward(input: {
    scope: TenantScope;
    actorUserId: string;
    objectiveId: string;
  }): Promise<ObjectiveRewardView | null> {
    const context = await this.authorization.contextFor(input.scope, input.actorUserId);
    await this.authorization.assertCan(context, { module: 'objective', action: 'View' });

    const loaded = await this.load(input.scope, input.objectiveId);
    await this.assertOnResource(context, loaded.objective, 'View');

    return loaded.reward === null ? null : this.rewardViewOf(loaded.reward);
  }

  // -------------------------------------------------------------------------
  // Internals
  // -------------------------------------------------------------------------

  private async load(
    scope: TenantScope,
    objectiveId: string,
    options: { alreadyInTransaction?: boolean } = {},
  ): Promise<{
    objective: Objective;
    versions: VersionWithSteps[];
    reward: ObjectiveReward | null;
  }> {
    const read = async () => {
      const objective = await this.prisma.client.objective.findUnique({
        where: { id: objectiveId },
      });
      if (!objective) {
        throw new NotFoundException('There is no such objective you can see.');
      }

      const versions = await this.prisma.client.objectiveVersion.findMany({
        // Named for the index, not for the scoping — RLS does that. See ADR-271.
        where: { tenantId: scope.tenantId, objectiveId },
        include: { steps: { orderBy: { position: 'asc' } } },
        orderBy: { versionNumber: 'desc' },
      });

      const reward = await this.prisma.client.objectiveReward.findUnique({
        where: { objectiveId },
      });

      return { objective, versions, reward };
    };

    // Reading outside a tenant transaction returns nothing under Row-Level Security, so the
    // caller either already holds one or one is opened here.
    return options.alreadyInTransaction === true
      ? read()
      : this.prisma.runInTenantTransaction(scope, read);
  }

  /** The row-level half of the check. Phase 1 has already run at the route and in the caller. */
  private async assertOnResource(
    context: AuthorizationContext,
    objective: Objective,
    action: 'View' | 'EditDraft' | 'Assign' | 'Approve' | 'Publish',
  ): Promise<void> {
    await this.authorization.assertCan(context, {
      module: 'objective',
      action,
      resource: {
        id: objective.id,
        ownerUserId: objective.objectiveOwnerUserId,
        departmentId: objective.departmentId,
        ...(objective.createdByUserId === null
          ? {}
          : { createdByUserId: objective.createdByUserId }),
      },
    });
  }

  /**
   * Pick the version an edit applies to.
   *
   * Refusing to guess when there is more than one candidate is deliberate: silently editing the
   * newer of two drafts is the kind of helpfulness that loses somebody's work.
   */
  private editableVersion(
    versions: readonly VersionWithSteps[],
    versionId: string | undefined,
  ): VersionWithSteps {
    if (versionId !== undefined) {
      const named = versions.find((version) => version.id === versionId);
      if (!named) {
        throw new NotFoundException('There is no such version of this objective.');
      }
      if (!isObjectiveDraftEditable(named.status as ObjectiveStatus)) {
        throw new ConflictException(
          `V${named.versionNumber} is ${OBJECTIVE_STATUS_LABELS[named.status as ObjectiveStatus]} ` +
            'and cannot be edited. An authorised change creates a new draft version.',
        );
      }
      return named;
    }

    const editable = versions.filter((version) =>
      isObjectiveDraftEditable(version.status as ObjectiveStatus),
    );

    if (editable.length === 0) {
      throw new ConflictException(
        'This objective has no editable draft. An authorised change to a live objective creates ' +
          'a new draft version.',
      );
    }
    if (editable.length > 1) {
      throw new ConflictException(
        'This objective has more than one open draft. Name the version you mean.',
      );
    }

    return editable[0] as VersionWithSteps;
  }

  private async assertDepartmentIsOpen(departmentId: string): Promise<void> {
    const department = await this.prisma.client.department.findUnique({
      where: { id: departmentId },
    });
    if (!department) {
      throw new BadRequestException('That department is not in this company.');
    }
    if (department.archivedAt !== null) {
      throw new BadRequestException(
        `${department.name} is archived. An objective cannot be filed under a closed department.`,
      );
    }
  }

  /**
   * The next objective code for a department, e.g. `REG-2026-003`.
   *
   * Derived rather than random so that a person can say it out loud. Uses the department's code
   * when it has one and the first three letters of its name otherwise, because not every company
   * uses department codes.
   */
  private async nextCode(departmentId: string): Promise<string> {
    const department = await this.prisma.client.department.findUnique({
      where: { id: departmentId },
    });

    const stem = (department?.code ?? department?.name ?? 'OBJ')
      .replace(/[^A-Za-z0-9]/g, '')
      .slice(0, 3)
      .toUpperCase()
      .padEnd(3, 'X');

    const year = new Date().getUTCFullYear();
    const prefix = `${stem}-${year}-`;

    const existing = await this.prisma.client.objective.findMany({
      where: { code: { startsWith: prefix } },
      select: { code: true },
    });

    const highest = existing.reduce((best, row) => {
      const tail = Number.parseInt(row.code.slice(prefix.length), 10);
      return Number.isNaN(tail) ? best : Math.max(best, tail);
    }, 0);

    return `${prefix}${String(highest + 1).padStart(3, '0')}`;
  }

  private async writeSteps(
    scope: TenantScope,
    versionId: string,
    steps: readonly Form2WorkflowStep[],
  ): Promise<void> {
    if (steps.length === 0) return;

    await this.prisma.client.objectiveWorkflowStep.createMany({
      data: steps.map((step) => ({
        tenantId: scope.tenantId,
        objectiveVersionId: versionId,
        position: step.position,
        whoPersonName: step.whoPersonName,
        whoDesignation: step.whoDesignation,
        whoEngine: step.whoEngine,
        whenTrigger: step.whenTrigger,
        whenFrequency: step.whenFrequency,
        whatExactWork: step.whatExactWork,
        inputWhatIsUsed: step.inputWhatIsUsed,
        inputReceivedFrom: step.inputReceivedFrom,
        whereWorkIsDone: step.whereWorkIsDone,
        outputWhatIsProduced: step.outputWhatIsProduced,
        outputSentTo: step.outputSentTo,
        timeTaken: step.timeTaken,
        currentProblem: step.currentProblem,
        approval: step.approval,
      })),
    });
  }

  /** Form 2 content, as database columns. One place, so the field list cannot drift per method. */
  private contentColumns(content: Form2Objective) {
    return {
      objectiveName: content.objectiveName,
      departmentId: content.departmentId,
      objectiveOwnerUserId: content.objectiveOwnerUserId,
      expectedFinalResult: content.expectedFinalResult,
      currentWorkload: content.currentWorkload,
      unit: content.unit,
      targetCompletionTime: content.targetCompletionTime,
      timeUnit: content.timeUnit,
      preparedBy: content.preparedBy,
      formDate: content.formDate === null ? null : new Date(`${content.formDate}T00:00:00.000Z`),
      responsibleOwnerUserId: content.responsibleOwnerUserId,
      executionTeam: content.executionTeam,
    };
  }

  private contentOf(version: ObjectiveVersion): Form2Objective {
    return {
      objectiveName: version.objectiveName,
      departmentId: version.departmentId,
      objectiveOwnerUserId: version.objectiveOwnerUserId,
      expectedFinalResult: version.expectedFinalResult,
      currentWorkload: version.currentWorkload,
      unit: version.unit,
      targetCompletionTime: version.targetCompletionTime,
      timeUnit: version.timeUnit as TimeUnit | null,
      preparedBy: version.preparedBy,
      formDate: version.formDate === null ? null : version.formDate.toISOString().slice(0, 10),
      responsibleOwnerUserId: version.responsibleOwnerUserId,
      executionTeam: version.executionTeam,
    };
  }

  private stepOf(step: ObjectiveWorkflowStep): ObjectiveStepView {
    return {
      id: step.id,
      position: step.position,
      whoPersonName: step.whoPersonName,
      whoDesignation: step.whoDesignation,
      whoEngine: step.whoEngine as StepEngineKind,
      whenTrigger: step.whenTrigger,
      whenFrequency: step.whenFrequency,
      whatExactWork: step.whatExactWork,
      inputWhatIsUsed: step.inputWhatIsUsed,
      inputReceivedFrom: step.inputReceivedFrom,
      whereWorkIsDone: step.whereWorkIsDone,
      outputWhatIsProduced: step.outputWhatIsProduced,
      outputSentTo: step.outputSentTo,
      timeTaken: step.timeTaken,
      currentProblem: step.currentProblem,
      approval: step.approval as StepApprovalKind,
    };
  }

  private versionViewOf(version: VersionWithSteps): ObjectiveVersionView {
    const status = version.status as ObjectiveStatus;
    return {
      id: version.id,
      versionNumber: version.versionNumber,
      status,
      statusLabel: OBJECTIVE_STATUS_LABELS[status],
      content: this.contentOf(version),
      steps: version.steps.map((step) => this.stepOf(step)),
      contentFrozen: !isObjectiveDraftEditable(status),
      workAssignable: isObjectiveWorkAssignable(status),
      reviewStage: this.reviewStageOf(version),
      sentBackAt: version.sentBackAt?.toISOString() ?? null,
      sentBackReason: version.sentBackReason,
      executionTeamConfirmedAt: version.executionTeamConfirmedAt?.toISOString() ?? null,
      approvedAt: version.approvedAt?.toISOString() ?? null,
      approvedByUserId: version.approvedByUserId,
      origin: version.origin as VersionOrigin,
      copiedFromVersionId: version.copiedFromVersionId,
      submittedAt: version.submittedAt?.toISOString() ?? null,
      submittedByUserId: version.submittedByUserId,
      publishedAt: version.publishedAt?.toISOString() ?? null,
      // Straight from the shared closed table. Not a second list: the screen must offer exactly
      // the moves the server will accept, and a copy here is how those two come to differ.
      nextStatuses: [...ALLOWED_OBJECTIVE_TRANSITIONS[status]],
    };
  }

  private rewardViewOf(reward: ObjectiveReward): ObjectiveRewardView {
    return {
      id: reward.id,
      applicable: reward.applicable,
      rewardType: reward.rewardType as RewardType | null,
      amountMinorUnits: reward.amountMinorUnits,
      eligibilityCondition: reward.eligibilityCondition,
      completionDeadline:
        reward.completionDeadline === null
          ? null
          : reward.completionDeadline.toISOString().slice(0, 10),
      evidence: reward.evidence,
      approverUserId: reward.approverUserId,
      note:
        'This panel is separate from the canonical Form 2 fields and never edits them. Recording ' +
        'a reward does not pay it: eligibility and approval are decided by the reward workflow, ' +
        'and nothing is settled automatically on completion.',
    };
  }

  /**
   * A version currently under review, for a reviewer's action.
   *
   * `UnderReview` and `WorkflowDraft` both count: the AI-analysis route ends in `WorkflowDraft`
   * and the reviewer's actions apply there too.
   */
  private reviewableVersion(
    versions: readonly VersionWithSteps[],
    versionId: string | undefined,
    options: { includeReadyForApproval?: boolean } = {},
  ): VersionWithSteps {
    const reviewable = versions.filter(
      (version) =>
        version.status === 'UnderReview' ||
        version.status === 'WorkflowDraft' ||
        (options.includeReadyForApproval === true && version.status === 'ReadyForApproval'),
    );

    if (versionId !== undefined) {
      const named = versions.find((version) => version.id === versionId);
      if (!named) {
        throw new NotFoundException('There is no such version of this objective.');
      }
      if (!reviewable.includes(named)) {
        throw new ConflictException(
          `V${named.versionNumber} is ${OBJECTIVE_STATUS_LABELS[named.status as ObjectiveStatus]} ` +
            'and is not under review.',
        );
      }
      return named;
    }

    if (reviewable.length === 0) {
      throw new ConflictException('This objective has no version under review.');
    }
    if (reviewable.length > 1) {
      throw new ConflictException(
        'This objective has more than one version under review. Name the version you mean.',
      );
    }
    return reviewable[0] as VersionWithSteps;
  }

  /** A version in one expected status, for approve and publish. */
  private namedVersion(
    versions: readonly VersionWithSteps[],
    versionId: string | undefined,
    expected: ObjectiveStatus,
  ): VersionWithSteps {
    const candidates = versions.filter((version) => version.status === expected);

    if (versionId !== undefined) {
      const named = versions.find((version) => version.id === versionId);
      if (!named) {
        throw new NotFoundException('There is no such version of this objective.');
      }
      if (named.status !== expected) {
        throw new ConflictException(
          `V${named.versionNumber} is ${OBJECTIVE_STATUS_LABELS[named.status as ObjectiveStatus]}, ` +
            `not ${OBJECTIVE_STATUS_LABELS[expected]}.`,
        );
      }
      return named;
    }

    if (candidates.length === 0) {
      throw new ConflictException(
        `This objective has no version that is ${OBJECTIVE_STATUS_LABELS[expected]}.`,
      );
    }
    if (candidates.length > 1) {
      throw new ConflictException('More than one version qualifies. Name the version you mean.');
    }
    return candidates[0] as VersionWithSteps;
  }

  /**
   * Only the responsible owner the form named may act as the reviewer.
   *
   * `objective:Approve` says who may approve things in general; the form's Responsible Owner /
   * Send To says who this one was sent to. Both are required, the same shape as a reward's named
   * approver — a permission is not the same as being the person accountable for this objective.
   */
  private assertIsResponsibleOwner(
    version: ObjectiveVersion,
    actorUserId: string,
    act: string,
  ): void {
    if (version.responsibleOwnerUserId === null) {
      throw new ConflictException(
        'This objective has no Responsible Owner / Send To, so nobody is its reviewer.',
      );
    }
    if (version.responsibleOwnerUserId !== actorUserId) {
      throw new ForbiddenException(
        `Only the Responsible Owner this objective was sent to may ${act} it. Holding the ` +
          'permission is not the same as being the person it was routed to.',
      );
    }
  }

  /**
   * Copy a version into a new `Draft`, content and grid together.
   *
   * The one place a new version is made, used by `startNewDraft`, `rollbackTo` and the automatic
   * V2 that an edit of a live objective triggers. Three callers, one implementation: three copies
   * of "clone the content and the steps" is three places for the grid to be forgotten.
   *
   * Must be called inside a tenant transaction.
   */
  private async copyIntoNewDraftWithinCurrentScope(input: {
    scope: TenantScope;
    actorUserId: string;
    objective: Objective;
    versions: readonly VersionWithSteps[];
    fromVersionId?: string | undefined;
    origin: 'Edit' | 'Rollback';
    reason?: string | undefined;
  }): Promise<VersionWithSteps> {
    const open = input.versions.filter((version) =>
      isObjectiveDraftEditable(version.status as ObjectiveStatus),
    );
    if (open.length > 0) {
      throw new ConflictException(
        `This objective already has an open draft (V${open[0]?.versionNumber}). Edit that one, ` +
          'or finish it, before starting another.',
      );
    }

    const source =
      input.fromVersionId === undefined
        ? (input.versions.find((version) => version.status === 'Active') ?? input.versions[0])
        : input.versions.find((version) => version.id === input.fromVersionId);

    if (!source) {
      throw new NotFoundException('There is no version of this objective to copy.');
    }

    const highest = input.versions.reduce(
      (best, version) => Math.max(best, version.versionNumber),
      0,
    );

    const created = await this.prisma.client.objectiveVersion.create({
      data: {
        tenantId: input.scope.tenantId,
        objectiveId: input.objective.id,
        versionNumber: highest + 1,
        status: 'Draft',
        origin: input.origin,
        copiedFromVersionId: source.id,
        ...this.contentColumns(this.contentOf(source)),
        createdByUserId: input.actorUserId,
      },
    });

    await this.writeSteps(
      input.scope,
      created.id,
      source.steps.map((step) => this.stepOf(step)),
    );

    await this.auditEvents.appendWithinCurrentScope(input.scope.tenantId, {
      action: input.origin === 'Rollback' ? 'objective.rolled_back' : 'objective.new_draft_opened',
      resourceType: 'objective',
      resourceId: input.objective.id,
      actorUserId: input.actorUserId,
      resourceRef: `${input.objective.code} V${created.versionNumber}`,
      ...(input.reason === undefined ? {} : { reason: input.reason }),
      summary:
        input.origin === 'Rollback'
          ? `Rolled back to V${source.versionNumber} by opening V${created.versionNumber} as a ` +
            'draft copied from it. The live version keeps running until this one is approved and ' +
            'published.'
          : `Opened V${created.versionNumber} as a draft copied from V${source.versionNumber}. ` +
            'The live version keeps running until this one is approved and published.',
      metadata: {
        // Exact version ids on both ends: the client requires historical records to keep them.
        versionId: created.id,
        versionNumber: created.versionNumber,
        copiedFromVersionId: source.id,
        copiedFromVersionNumber: source.versionNumber,
        origin: input.origin,
        stepCount: source.steps.length,
      },
    });

    return { ...created, steps: [] } as VersionWithSteps;
  }

  /**
   * Validate the Responsible Owner / Send To against the reporting hierarchy.
   *
   * ## What "hierarchy-aware" is taken to mean, and what it is not
   *
   * Two checks, and the difference between them matters:
   *
   *   * **Hard:** the person must be an active member of this company. Always checkable.
   *   * **Hierarchy:** when *both* the objective's owner and the responsible owner have an
   *     employment record, they must be in the same reporting line — one at or beneath the other.
   *
   * The **direction is deliberately not constrained.** The prompt's language ("Responsible
   * manager") suggests sending upward, while the approved reference shows a Head owning an
   * objective and sending it down to a specialist. Constraining the direction would break one of
   * the two, so the rule is "same reporting line" and the direction is left to the company.
   *
   * When either person has no employment record the hierarchy cannot be evaluated, and this
   * **permits it and says so** rather than refusing. That is a considered exception to the usual
   * fail-closed rule: routing is a data-quality concern, not a security boundary — the recipient
   * still needs `objective:Approve` and the row-level scope check before they can do anything —
   * and refusing would make the Objective Builder unusable for a company that has not finished
   * filling in its hierarchy. The audit event records `hierarchyEvaluated: false` so the gap is
   * visible rather than silent.
   */
  private async checkResponsibleOwnerWithinCurrentScope(input: {
    scope: TenantScope;
    objectiveOwnerUserId: string;
    responsibleOwnerUserId: string;
  }): Promise<{ hierarchyEvaluated: boolean; note: string }> {
    const membership = await this.prisma.client.tenantMembership.findFirst({
      where: { userId: input.responsibleOwnerUserId, accountState: 'Active' },
    });
    if (!membership) {
      throw new BadRequestException(
        'That person is not an active member of this company, so an objective cannot be sent ' +
          'to them.',
      );
    }

    if (input.responsibleOwnerUserId === input.objectiveOwnerUserId) {
      return {
        hierarchyEvaluated: true,
        note: 'The objective owner is also its Responsible Owner.',
      };
    }

    // Sequential, **not** `Promise.all`. These run inside an already-open tenant transaction, and
    // concurrent queries on one interactive transaction lose the AsyncLocalStorage scope — which
    // makes them run unscoped, which under Row-Level Security returns nothing. The first version
    // of this used `Promise.all` and the effect was precisely the wrong answer in the dangerous
    // direction: both lookups came back empty, the code concluded "hierarchy unevaluable", and it
    // permitted a routing it should have refused. A test caught it.
    const ownerEmployment = await this.prisma.client.employmentRecord.findFirst({
      // `(tenant_id, user_id)` is the only index on this column, so the tenant has to be named for
      // it to be reachable. RLS still does the confining (ADR-271).
      where: { tenantId: input.scope.tenantId, userId: input.objectiveOwnerUserId },
    });
    const reviewerEmployment = await this.prisma.client.employmentRecord.findFirst({
      where: { tenantId: input.scope.tenantId, userId: input.responsibleOwnerUserId },
    });

    if (!ownerEmployment || !reviewerEmployment) {
      return {
        hierarchyEvaluated: false,
        note:
          'The reporting hierarchy could not be checked because one of these people has no ' +
          'employment record yet. The routing was allowed; the recipient still needs the ' +
          'permission and scope to act on it.',
      };
    }

    // Sequential for the same reason as the lookups above.
    const reviewerAbove = await this.organization.isInReportingSubtree({
      tenantId: input.scope.tenantId,
      managerUserId: input.responsibleOwnerUserId,
      subjectUserId: input.objectiveOwnerUserId,
    });
    const reviewerBelow = await this.organization.isInReportingSubtree({
      tenantId: input.scope.tenantId,
      managerUserId: input.objectiveOwnerUserId,
      subjectUserId: input.responsibleOwnerUserId,
    });

    if (!reviewerAbove && !reviewerBelow) {
      throw new BadRequestException(
        'That person is not in the same reporting line as this objective’s owner. Send it to ' +
          'somebody in the owner’s management chain or their team.',
      );
    }

    return {
      hierarchyEvaluated: true,
      note: reviewerAbove
        ? 'The Responsible Owner is above the objective owner in the reporting tree.'
        : 'The Responsible Owner is in the objective owner’s team.',
    };
  }

  /**
   * The review stage a person reads, derived rather than stored.
   *
   * Exists because approval is a fact on the version and not a status: `ReadyForApproval` with an
   * `approvedAt` means "approved, awaiting publish", and a screen showing only the status would
   * make an approved version look like one still waiting for a decision.
   */
  private reviewStageOf(version: ObjectiveVersion): string {
    const status = version.status as ObjectiveStatus;

    if (status === 'ReadyForApproval') {
      return version.approvedAt === null ? 'Awaiting approval' : 'Approved — awaiting publish';
    }
    if (status === 'Draft' && version.sentBackAt !== null) {
      return 'Sent back for changes';
    }
    if (status === 'UnderReview') {
      return version.executionTeamConfirmedAt === null
        ? 'Under review'
        : 'Under review — execution team confirmed';
    }
    return OBJECTIVE_STATUS_LABELS[status];
  }

  private viewOf(
    objective: Objective,
    versions: readonly VersionWithSteps[],
    reward: ObjectiveReward | null,
  ): ObjectiveView {
    const views = versions.map((version) => this.versionViewOf(version));

    return {
      id: objective.id,
      code: objective.code,
      departmentId: objective.departmentId,
      objectiveOwnerUserId: objective.objectiveOwnerUserId,
      activeVersion: views.find((view) => view.status === 'Active') ?? null,
      openDraft: views.find((view) => isObjectiveDraftEditable(view.status)) ?? null,
      versions: views,
      reward: reward === null ? null : this.rewardViewOf(reward),
      createdByUserId: objective.createdByUserId,
      createdAt: objective.createdAt.toISOString(),
      updatedAt: objective.updatedAt.toISOString(),
    };
  }
}
