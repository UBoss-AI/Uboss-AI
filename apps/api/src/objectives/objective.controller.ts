import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  ParseUUIDPipe,
  Post,
  Put,
  Query,
  UnauthorizedException,
} from '@nestjs/common';
import { Type } from 'class-transformer';
import {
  Allow,
  ArrayMaxSize,
  Matches,
  IsArray,
  IsBoolean,
  IsIn,
  IsInt,
  IsISO8601,
  IsOptional,
  IsString,
  IsUUID,
  MaxLength,
  Min,
  MinLength,
  ValidateNested,
} from 'class-validator';

import {
  ANALYSIS_NODE_KINDS,
  ANALYSIS_SCHEMA_VERSION,
  ANALYSIS_STAGE_LABELS,
  ANALYSIS_STAGES,
  FORM2_OBJECTIVE_FIELDS,
  FORM2_SECTION_LABELS,
  FORM2_SECTIONS,
  FORM2_WORKFLOW_COLUMN_COUNT,
  FORM2_WORKFLOW_COLUMNS,
  OBJECTIVE_STATUS_LABELS,
  OBJECTIVE_STATUS_TONES,
  NODE_SHAPE_BY_KIND,
  TOOL_ACTION_CATEGORIES,
  WORKFLOW_EDGE_KIND_LABELS,
  WORKFLOW_EDGE_KINDS,
  OBJECTIVE_STATUSES,
  REWARD_TYPE_LABELS,
  REWARD_TYPES,
  STEP_APPROVAL_KINDS,
  STEP_APPROVAL_LABELS,
  STEP_ENGINE_KINDS,
  STEP_ENGINE_LABELS,
  TIME_UNIT_LABELS,
  TIME_UNITS,
  WORKFLOW_COLUMN_GROUPS,
  type AnalysisNodeKind,
  type ObjectiveStatus,
  type RewardType,
  type StepApprovalKind,
  type StepEngineKind,
  type TimeUnit,
  type WorkflowEdgeKind,
} from '@uboss/types';

import { RequirePermission } from '../authorization/authorization.decorators.js';
import { actorUserId } from '../request-context/authenticated-actor.js';
import { getActor } from '../request-context/request-context.js';
import { TenantScoped } from '../tenancy/tenancy.decorators.js';
import { TenantContextService } from '../tenancy/tenant-context.service.js';
import { ModelGateway } from '../model-gateway/model-gateway.js';
import { ObjectiveAnalysisService } from './objective-analysis.service.js';
import { AssignmentService } from './assignment.service.js';
import { ObjectiveService } from './objective.service.js';
import { WorkflowEditorService } from './workflow-editor.service.js';

// ---------------------------------------------------------------------------
// DTOs
// ---------------------------------------------------------------------------

/**
 * Form 2's objective-level fields.
 *
 * Every optional field is `| null` rather than merely absent, because the form distinguishes
 * "cleared" from "not sent": a `PUT` that omitted `unit` would otherwise be unable to remove a
 * unit somebody entered by mistake. The ceilings match `FORM2_OBJECTIVE_FIELDS` and, through it,
 * the database columns.
 */
export class Form2ObjectiveDto {
  @IsString() @MinLength(1) @MaxLength(200) objectiveName!: string;
  @IsUUID() departmentId!: string;
  @IsUUID() objectiveOwnerUserId!: string;
  @IsString() @MinLength(1) @MaxLength(4000) expectedFinalResult!: string;

  @IsOptional() @IsInt() @Min(0) currentWorkload!: number | null;
  @IsOptional() @IsString() @MaxLength(60) unit!: string | null;

  @IsOptional() @IsInt() @Min(0) targetCompletionTime!: number | null;
  /** Separate from `unit`, and never collapsed into it. The client's locked instruction. */
  @IsOptional() @IsIn(TIME_UNITS) timeUnit!: TimeUnit | null;

  @IsOptional() @IsString() @MaxLength(160) preparedBy!: string | null;
  /** The form's own Date field. A business date — `YYYY-MM-DD`, not an instant. */
  @IsOptional() @IsISO8601({ strict: true }) formDate!: string | null;

  // ---- UBoss routing controls. Separate card in the UI, never inside the source section. ----
  @IsOptional() @IsUUID() responsibleOwnerUserId!: string | null;
  @IsOptional() @IsString() @MaxLength(200) executionTeam!: string | null;
}

/** One row of the workflow grid. Fourteen stored columns; `Step` is the position. */
export class Form2WorkflowStepDto {
  @IsInt() @Min(1) position!: number;

  @IsOptional() @IsString() @MaxLength(160) whoPersonName!: string | null;
  @IsOptional() @IsString() @MaxLength(160) whoDesignation!: string | null;
  @IsIn(STEP_ENGINE_KINDS) whoEngine!: StepEngineKind;

  @IsOptional() @IsString() @MaxLength(200) whenTrigger!: string | null;
  @IsOptional() @IsString() @MaxLength(120) whenFrequency!: string | null;

  @IsString() @MinLength(1) @MaxLength(2000) whatExactWork!: string;

  @IsOptional() @IsString() @MaxLength(400) inputWhatIsUsed!: string | null;
  @IsOptional() @IsString() @MaxLength(200) inputReceivedFrom!: string | null;

  @IsOptional() @IsString() @MaxLength(200) whereWorkIsDone!: string | null;

  @IsOptional() @IsString() @MaxLength(400) outputWhatIsProduced!: string | null;
  @IsOptional() @IsString() @MaxLength(200) outputSentTo!: string | null;

  @IsOptional() @IsString() @MaxLength(60) timeTaken!: string | null;
  @IsOptional() @IsString() @MaxLength(2000) currentProblem!: string | null;

  @IsIn(STEP_APPROVAL_KINDS) approval!: StepApprovalKind;
}

export class CreateObjectiveDto {
  /** Optional: derived from the department and the year when absent. */
  @IsOptional() @IsString() @MaxLength(40) code?: string;

  @ValidateNested() @Type(() => Form2ObjectiveDto) content!: Form2ObjectiveDto;

  /**
   * The grid. `ArrayMaxSize` is a request-size guard, not a business cap — the client's rule is
   * that the row count is not fixed, and 500 steps is far past any real process while still
   * stopping a single request from carrying a million rows.
   */
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(500)
  @ValidateNested({ each: true })
  @Type(() => Form2WorkflowStepDto)
  steps?: Form2WorkflowStepDto[];
}

export class UpdateObjectiveDraftDto {
  @IsOptional() @IsUUID() versionId?: string;

  @ValidateNested() @Type(() => Form2ObjectiveDto) content!: Form2ObjectiveDto;

  @IsArray()
  @ArrayMaxSize(500)
  @ValidateNested({ each: true })
  @Type(() => Form2WorkflowStepDto)
  steps!: Form2WorkflowStepDto[];
}

export class SubmitObjectiveDto {
  @IsOptional() @IsUUID() versionId?: string;
}

/**
 * The Performance & Reward panel.
 *
 * Note what this DTO has no field for: approved, settled, paid. The client's rule is that nothing
 * auto-pays on completion, so there is no way to ask for it.
 */
export class ObjectiveRewardDto {
  @IsBoolean() applicable!: boolean;
  @IsOptional() @IsIn(REWARD_TYPES) rewardType!: RewardType | null;
  /** Integer minor units for `Cash`, whole points for `Points`. */
  @IsOptional() @IsInt() @Min(0) amountMinorUnits!: number | null;
  @IsOptional() @IsString() @MaxLength(2000) eligibilityCondition!: string | null;
  @IsOptional() @IsISO8601({ strict: true }) completionDeadline!: string | null;
  @IsOptional() @IsString() @MaxLength(2000) evidence!: string | null;
  @IsOptional() @IsUUID() approverUserId!: string | null;
}

/** Every review route can name a version; all default to the one under review. */
export class VersionOnlyDto {
  @IsOptional() @IsUUID() versionId?: string;
}

export class ConfirmExecutionTeamDto {
  @IsOptional() @IsUUID() versionId?: string;
  /** The manager may adjust the team as they accept it. */
  @IsOptional() @IsString() @MaxLength(200) executionTeam?: string;
}

export class SendBackDto {
  @IsOptional() @IsUUID() versionId?: string;
  /** Required. The author cannot act on a send-back with no reason. */
  @IsString() @MinLength(1) @MaxLength(2000) reason!: string;
}

export class ApproveObjectiveDto {
  @IsOptional() @IsUUID() versionId?: string;
  @IsOptional() @IsString() @MinLength(1) @MaxLength(2000) reason?: string;
}

export class NewDraftDto {
  /** Defaults to the live version, then the newest. */
  @IsOptional() @IsUUID() fromVersionId?: string;
}

export class RollbackDto {
  /** The older version to base the new draft on. */
  @IsUUID() versionId!: string;
  /** Required: replacing the plan people are working to needs accounting for. */
  @IsString() @MinLength(1) @MaxLength(2000) reason!: string;
}

export class CompareVersionsDto {
  @IsUUID() from!: string;
  @IsUUID() to!: string;
}

export class StartAnalysisDto {
  /** Defaults to the objective’s open draft. */
  @IsOptional() @IsUUID() versionId?: string;
}

/** The seven parts of a Definition of Done. Every part optional on a patch. */
export class DefinitionOfDoneDto {
  @IsOptional() @IsString() @MaxLength(2000) expectedOutput?: string;
  @IsOptional() @IsString() @MaxLength(2000) criteria?: string;
  @IsOptional() @IsString() @MaxLength(2000) evidence?: string;
  @IsOptional() @IsArray() @IsString({ each: true }) @ArrayMaxSize(50) dependencies?: string[];
  @IsOptional() @IsArray() @IsIn(TOOL_ACTION_CATEGORIES, { each: true }) tools?: string[];
  @IsOptional() @IsIn(STEP_APPROVAL_KINDS) approval?: StepApprovalKind | null;
  @IsOptional() @IsString() @MaxLength(2000) failureCondition?: string;
}

/**
 * Every edit carries the revision it was made against.
 *
 * Not optional: two managers on one plan is a real situation, and last-write-wins is the wrong
 * answer for a document this consequential. The server refuses a stale revision and says so.
 */
export class EditNodeDto {
  @IsOptional() @IsUUID() versionId?: string;
  @IsInt() @Min(1) revision!: number;

  @IsOptional() @IsString() @MinLength(1) @MaxLength(300) label?: string;
  @IsOptional() @IsUUID() ownerUserId?: string | null;
  @IsOptional() @IsString() @MaxLength(160) ownerDesignation?: string | null;
  @IsOptional() @IsString() @MaxLength(300) triggerEvent?: string | null;
  @IsOptional() @ValidateNested() @Type(() => DefinitionOfDoneDto) dod?: DefinitionOfDoneDto;
}

export class ConvertNodeDto {
  @IsOptional() @IsUUID() versionId?: string;
  @IsInt() @Min(1) revision!: number;
  @IsIn(ANALYSIS_NODE_KINDS) to!: AnalysisNodeKind;
}

export class AddNodeDto {
  @IsOptional() @IsUUID() versionId?: string;
  @IsInt() @Min(1) revision!: number;
  @IsIn(ANALYSIS_NODE_KINDS) kind!: AnalysisNodeKind;
  @IsString() @MinLength(1) @MaxLength(300) label!: string;
  /** Wire a sequential edge from this node to the new one. */
  @IsOptional() @IsString() @MaxLength(80) afterNodeId?: string;
}

export class WorkflowEdgeDto {
  @IsString() @MaxLength(80) fromNodeId!: string;
  @IsString() @MaxLength(80) toNodeId!: string;
  @IsIn(WORKFLOW_EDGE_KINDS) kind!: WorkflowEdgeKind;
  /** Required for a `Condition` edge: which outcome it represents. */
  @IsOptional() @IsString() @MaxLength(300) condition?: string | null;
}

export class SetEdgesDto {
  @IsOptional() @IsUUID() versionId?: string;
  @IsInt() @Min(1) revision!: number;

  @IsArray()
  @ArrayMaxSize(500)
  @ValidateNested({ each: true })
  @Type(() => WorkflowEdgeDto)
  edges!: WorkflowEdgeDto[];
}

export class SetDependenciesDto {
  @IsOptional() @IsUUID() versionId?: string;
  @IsInt() @Min(1) revision!: number;
  @IsArray() @ArrayMaxSize(50) @IsString({ each: true }) dependsOn!: string[];
}

export class VersionQueryDto {
  @IsOptional() @IsUUID() versionId?: string;
  /** Present so `whitelist: true` does not silently strip an unknown query parameter. */
  @Allow() _?: unknown;
}

export class RevisionQueryDto {
  @IsOptional() @IsUUID() versionId?: string;
  /** A query parameter arrives as a string; the handler converts it. */
  @Matches(/^[0-9]+$/) revision!: string;
  @Allow() _?: unknown;
}

export class AssignWorkflowDto {
  @IsOptional() @IsUUID() versionId?: string;
  /** Accept the readiness warnings. Blockers are never acceptable this way. */
  @IsOptional() @IsBoolean() acceptWarnings?: boolean;
}

export class ListObjectivesDto {
  @IsOptional() @IsIn(OBJECTIVE_STATUSES) status?: ObjectiveStatus;
  @IsOptional() @IsUUID() departmentId?: string;
  @IsOptional() @IsString() @MaxLength(200) search?: string;
  /** Present so `whitelist: true` does not silently strip an unknown query parameter. */
  @Allow() _?: unknown;
}

// ---------------------------------------------------------------------------
// Controller
// ---------------------------------------------------------------------------

/**
 * Objective Optimization / Objective Builder.
 *
 * `objective:Create` to create, `objective:EditDraft` to save or submit a draft, `objective:View`
 * to read, and `objective:Assign` for the reward panel — because promising a bonus is part of
 * assigning work rather than part of drafting it, and an Employee's role carries `EditDraft`
 * without `Assign`.
 *
 * Every route's `@RequirePermission` is only phase one. The row-level half runs in the service
 * with the objective's department and owner, so a manager cannot reach another department's
 * objective by knowing its id.
 */
@Controller('tenants/:tenantId/objectives')
@TenantScoped()
export class ObjectiveController {
  constructor(
    private readonly objectives: ObjectiveService,
    private readonly tenantContext: TenantContextService,
    /// Prompt 21: analysis, and the gateway so `analysis/meta` can say whether a real model
    /// is reachable rather than letting a screen assume one is.
    private readonly analysis: ObjectiveAnalysisService,
    private readonly modelGateway: ModelGateway,
    /// Prompt 22: the manager-editable workflow and the Pre-Publish Summary.
    private readonly workflow: WorkflowEditorService,
    /// Prompt 23: Approve & Assign, the transactional boundary between a plan and real work.
    private readonly assignment: AssignmentService,
  ) {}

  /**
   * The form's own definition: every field, every grid column, every closed vocabulary.
   *
   * Served rather than hardcoded in the screen so that "Form 2 is preserved exactly" has a single
   * answer both planes read. A field removed from the shared list disappears from this response
   * and from the form together, which is what makes the invariant test meaningful.
   */
  @Get('form2')
  @RequirePermission({ module: 'objective', action: 'View' })
  form2(): unknown {
    return {
      sections: FORM2_SECTIONS_RESPONSE,
      fields: FORM2_OBJECTIVE_FIELDS,
      workflow: {
        groups: WORKFLOW_COLUMN_GROUPS,
        columns: FORM2_WORKFLOW_COLUMNS,
        columnCount: FORM2_WORKFLOW_COLUMN_COUNT,
        rowCountFixed: false,
      },
      vocabularies: {
        timeUnits: TIME_UNITS.map((unit) => ({ value: unit, label: TIME_UNIT_LABELS[unit] })),
        engineKinds: STEP_ENGINE_KINDS.map((kind) => ({
          value: kind,
          label: STEP_ENGINE_LABELS[kind],
        })),
        approvalKinds: STEP_APPROVAL_KINDS.map((kind) => ({
          value: kind,
          label: STEP_APPROVAL_LABELS[kind],
        })),
        rewardTypes: REWARD_TYPES.map((type) => ({
          value: type,
          label: REWARD_TYPE_LABELS[type],
        })),
        statuses: OBJECTIVE_STATUSES.map((status) => ({
          value: status,
          label: OBJECTIVE_STATUS_LABELS[status],
          tone: OBJECTIVE_STATUS_TONES[status],
        })),
      },
      note:
        'This is the approved Form 2, field for field. Unit and Time Unit are separate source ' +
        'inputs and are never collapsed; the workflow grid keeps all ' +
        `${FORM2_WORKFLOW_COLUMN_COUNT} columns and its row count is not fixed. The ` +
        'Performance & Reward panel is separate from these fields and never edits them.',
    };
  }

  @Get()
  @RequirePermission({ module: 'objective', action: 'View' })
  async list(@Query() query: ListObjectivesDto): Promise<unknown> {
    return this.objectives.list({
      scope: this.tenantContext.requireScope(),
      actorUserId: this.currentUserId(),
      ...(query.status === undefined ? {} : { status: query.status }),
      ...(query.departmentId === undefined ? {} : { departmentId: query.departmentId }),
      ...(query.search === undefined ? {} : { search: query.search }),
    });
  }

  @Post()
  @RequirePermission({ module: 'objective', action: 'Create' })
  async create(@Body() body: CreateObjectiveDto): Promise<unknown> {
    return this.objectives.create({
      scope: this.tenantContext.requireScope(),
      actorUserId: this.currentUserId(),
      ...(body.code === undefined ? {} : { code: body.code }),
      content: this.contentOf(body.content),
      ...(body.steps === undefined ? {} : { steps: body.steps.map((step) => this.stepOf(step)) }),
    });
  }

  @Get(':objectiveId')
  @RequirePermission({ module: 'objective', action: 'View' })
  async view(@Param('objectiveId', ParseUUIDPipe) objectiveId: string): Promise<unknown> {
    return this.objectives.view({
      scope: this.tenantContext.requireScope(),
      actorUserId: this.currentUserId(),
      objectiveId,
    });
  }

  @Put(':objectiveId/draft')
  @RequirePermission({ module: 'objective', action: 'EditDraft' })
  async updateDraft(
    @Param('objectiveId', ParseUUIDPipe) objectiveId: string,
    @Body() body: UpdateObjectiveDraftDto,
  ): Promise<unknown> {
    return this.objectives.updateDraft({
      scope: this.tenantContext.requireScope(),
      actorUserId: this.currentUserId(),
      objectiveId,
      ...(body.versionId === undefined ? {} : { versionId: body.versionId }),
      content: this.contentOf(body.content),
      steps: body.steps.map((step) => this.stepOf(step)),
    });
  }

  @Post(':objectiveId/submit')
  @RequirePermission({ module: 'objective', action: 'EditDraft' })
  async submit(
    @Param('objectiveId', ParseUUIDPipe) objectiveId: string,
    @Body() body: SubmitObjectiveDto,
  ): Promise<unknown> {
    return this.objectives.submitForReview({
      scope: this.tenantContext.requireScope(),
      actorUserId: this.currentUserId(),
      objectiveId,
      ...(body.versionId === undefined ? {} : { versionId: body.versionId }),
    });
  }

  @Get(':objectiveId/reward')
  @RequirePermission({ module: 'objective', action: 'View' })
  async readReward(@Param('objectiveId', ParseUUIDPipe) objectiveId: string): Promise<unknown> {
    const reward = await this.objectives.readReward({
      scope: this.tenantContext.requireScope(),
      actorUserId: this.currentUserId(),
      objectiveId,
    });
    // Absent is not "not applicable", so the two are distinguishable on the wire.
    return { reward };
  }

  @Put(':objectiveId/reward')
  @RequirePermission({ module: 'objective', action: 'Assign' })
  async saveReward(
    @Param('objectiveId', ParseUUIDPipe) objectiveId: string,
    @Body() body: ObjectiveRewardDto,
  ): Promise<unknown> {
    return this.objectives.saveReward({
      scope: this.tenantContext.requireScope(),
      actorUserId: this.currentUserId(),
      objectiveId,
      panel: {
        applicable: body.applicable,
        rewardType: body.rewardType ?? null,
        amountMinorUnits: body.amountMinorUnits ?? null,
        eligibilityCondition: body.eligibilityCondition ?? null,
        completionDeadline: this.dateOnly(body.completionDeadline ?? null),
        evidence: body.evidence ?? null,
        approverUserId: body.approverUserId ?? null,
      },
    });
  }

  // -------------------------------------------------------------------------
  // Review routing (Prompt 20)
  // -------------------------------------------------------------------------

  /**
   * Confirm the execution team. `objective:Assign`, responsible owner only.
   *
   * A precondition of `review/complete`, so the step is load-bearing rather than decorative.
   */
  @Post(':objectiveId/review/confirm-team')
  @RequirePermission({ module: 'objective', action: 'Assign' })
  async confirmTeam(
    @Param('objectiveId', ParseUUIDPipe) objectiveId: string,
    @Body() body: ConfirmExecutionTeamDto,
  ): Promise<unknown> {
    return this.objectives.confirmExecutionTeam({
      scope: this.tenantContext.requireScope(),
      actorUserId: this.currentUserId(),
      objectiveId,
      ...(body.versionId === undefined ? {} : { versionId: body.versionId }),
      ...(body.executionTeam === undefined ? {} : { executionTeam: body.executionTeam }),
    });
  }

  /** Send back / request changes. `objective:Approve`, responsible owner only, reason required. */
  @Post(':objectiveId/review/send-back')
  @RequirePermission({ module: 'objective', action: 'Approve' })
  async sendBack(
    @Param('objectiveId', ParseUUIDPipe) objectiveId: string,
    @Body() body: SendBackDto,
  ): Promise<unknown> {
    return this.objectives.sendBack({
      scope: this.tenantContext.requireScope(),
      actorUserId: this.currentUserId(),
      objectiveId,
      ...(body.versionId === undefined ? {} : { versionId: body.versionId }),
      reason: body.reason,
    });
  }

  /** Finish the review: the version becomes Ready for Approval. */
  @Post(':objectiveId/review/complete')
  @RequirePermission({ module: 'objective', action: 'Assign' })
  async completeReview(
    @Param('objectiveId', ParseUUIDPipe) objectiveId: string,
    @Body() body: VersionOnlyDto,
  ): Promise<unknown> {
    return this.objectives.completeReview({
      scope: this.tenantContext.requireScope(),
      actorUserId: this.currentUserId(),
      objectiveId,
      ...(body.versionId === undefined ? {} : { versionId: body.versionId }),
    });
  }

  /**
   * Approve. **Does not publish and does not change the status** — see ADR-104.
   *
   * The response's `reviewStage` becomes "Approved — awaiting publish", which is what a screen
   * should show rather than the raw status.
   */
  @Post(':objectiveId/approve')
  @RequirePermission({ module: 'objective', action: 'Approve' })
  async approve(
    @Param('objectiveId', ParseUUIDPipe) objectiveId: string,
    @Body() body: ApproveObjectiveDto,
  ): Promise<unknown> {
    return this.objectives.approve({
      scope: this.tenantContext.requireScope(),
      actorUserId: this.currentUserId(),
      objectiveId,
      ...(body.versionId === undefined ? {} : { versionId: body.versionId }),
      ...(body.reason === undefined ? {} : { reason: body.reason }),
    });
  }

  /** Publish an approved version. `objective:Publish`. Archives the version it supersedes. */
  @Post(':objectiveId/publish')
  @RequirePermission({ module: 'objective', action: 'Publish' })
  async publish(
    @Param('objectiveId', ParseUUIDPipe) objectiveId: string,
    @Body() body: VersionOnlyDto,
  ): Promise<unknown> {
    return this.objectives.publish({
      scope: this.tenantContext.requireScope(),
      actorUserId: this.currentUserId(),
      objectiveId,
      ...(body.versionId === undefined ? {} : { versionId: body.versionId }),
    });
  }

  // -------------------------------------------------------------------------
  // Strict versioning (Prompt 20)
  // -------------------------------------------------------------------------

  /**
   * Open the next draft, copied from the live version.
   *
   * `PUT /draft` does this automatically when there is no open draft, which is the client's rule.
   * This route exists for the case where somebody wants the draft *before* they start typing —
   * the approved UI's "edit a live objective" entry point.
   */
  @Post(':objectiveId/versions/new-draft')
  @RequirePermission({ module: 'objective', action: 'EditDraft' })
  async newDraft(
    @Param('objectiveId', ParseUUIDPipe) objectiveId: string,
    @Body() body: NewDraftDto,
  ): Promise<unknown> {
    return this.objectives.startNewDraft({
      scope: this.tenantContext.requireScope(),
      actorUserId: this.currentUserId(),
      objectiveId,
      ...(body.fromVersionId === undefined ? {} : { fromVersionId: body.fromVersionId }),
    });
  }

  /** Roll back: a **new** draft copied from an older version. Never a resurrection. */
  @Post(':objectiveId/versions/rollback')
  @RequirePermission({ module: 'objective', action: 'EditDraft' })
  async rollback(
    @Param('objectiveId', ParseUUIDPipe) objectiveId: string,
    @Body() body: RollbackDto,
  ): Promise<unknown> {
    return this.objectives.rollbackTo({
      scope: this.tenantContext.requireScope(),
      actorUserId: this.currentUserId(),
      objectiveId,
      versionId: body.versionId,
      reason: body.reason,
    });
  }

  /** The client's Version History. Exact version ids on the wire. */
  @Get(':objectiveId/versions')
  @RequirePermission({ module: 'objective', action: 'View' })
  async history(@Param('objectiveId', ParseUUIDPipe) objectiveId: string): Promise<unknown> {
    return this.objectives.history({
      scope: this.tenantContext.requireScope(),
      actorUserId: this.currentUserId(),
      objectiveId,
    });
  }

  /** The client's Compare view. */
  @Get(':objectiveId/versions/compare')
  @RequirePermission({ module: 'objective', action: 'View' })
  async compare(
    @Param('objectiveId', ParseUUIDPipe) objectiveId: string,
    @Query() query: CompareVersionsDto,
  ): Promise<unknown> {
    return this.objectives.compareVersions({
      scope: this.tenantContext.requireScope(),
      actorUserId: this.currentUserId(),
      objectiveId,
      fromVersionId: query.from,
      toVersionId: query.to,
    });
  }

  // -------------------------------------------------------------------------
  // AI analysis (Prompt 21)
  // -------------------------------------------------------------------------

  /**
   * The analysis stages and whether this deployment has a real model.
   *
   * `usesRealModel` is served rather than assumed so a screen can say plainly that the analysis
   * ran against a mock. **`capability` is an opaque label and never a provider or model name** —
   * the client's locked rule is that provider names stay behind the Model Gateway.
   */
  @Get('analysis/meta')
  @RequirePermission({ module: 'objective', action: 'View' })
  analysisMeta(): unknown {
    return {
      stages: ANALYSIS_STAGES.map((stage) => ({ stage, label: ANALYSIS_STAGE_LABELS[stage] })),
      nodeShapes: NODE_SHAPE_BY_KIND,
      schemaVersion: ANALYSIS_SCHEMA_VERSION,
      model: {
        capability: this.modelGateway.capability,
        usesRealModel: this.modelGateway.usesRealModel,
      },
      note:
        'Analysis output is always a **draft**. Nothing is live until a person approves and ' +
        'publishes it, and no work is assignable before that. Human nodes are drawn as ' +
        'rectangles, AI nodes as diamonds, and the Goal is visually distinct.',
    };
  }

  /** Start an analysis. `objective:EditDraft` — producing a draft is drafting. */
  @Post(':objectiveId/analysis')
  @RequirePermission({ module: 'objective', action: 'EditDraft' })
  async startAnalysis(
    @Param('objectiveId', ParseUUIDPipe) objectiveId: string,
    @Body() body: StartAnalysisDto,
  ): Promise<unknown> {
    return this.analysis.start({
      scope: this.tenantContext.requireScope(),
      actorUserId: this.currentUserId(),
      objectiveId,
      ...(body.versionId === undefined ? {} : { versionId: body.versionId }),
    });
  }

  /** The latest run, so a reopened screen shows where it got to. */
  @Get(':objectiveId/analysis')
  @RequirePermission({ module: 'objective', action: 'View' })
  async latestAnalysis(@Param('objectiveId', ParseUUIDPipe) objectiveId: string): Promise<unknown> {
    const run = await this.analysis.latestFor({
      scope: this.tenantContext.requireScope(),
      actorUserId: this.currentUserId(),
      objectiveId,
    });
    // Absent is not an error — an objective may simply never have been analysed.
    return { run };
  }

  @Get(':objectiveId/analysis/:runId')
  @RequirePermission({ module: 'objective', action: 'View' })
  async analysisRun(@Param('runId', ParseUUIDPipe) runId: string): Promise<unknown> {
    return this.analysis.view({
      scope: this.tenantContext.requireScope(),
      actorUserId: this.currentUserId(),
      runId,
    });
  }

  /** Cancel a run. Takes effect at the next stage boundary. */
  @Post(':objectiveId/analysis/:runId/cancel')
  @RequirePermission({ module: 'objective', action: 'EditDraft' })
  async cancelAnalysis(@Param('runId', ParseUUIDPipe) runId: string): Promise<unknown> {
    return this.analysis.cancel({
      scope: this.tenantContext.requireScope(),
      actorUserId: this.currentUserId(),
      runId,
    });
  }

  // -------------------------------------------------------------------------
  // The workflow editor (Prompt 22)
  // -------------------------------------------------------------------------

  /**
   * The editor's own vocabulary: node kinds with their shapes, edge kinds, and the parts of a
   * Definition of Done.
   *
   * Served so the editor's palette and the server's validation cannot disagree about what a node
   * or an edge may be.
   */
  @Get('workflow/meta')
  @RequirePermission({ module: 'objective', action: 'View' })
  workflowMeta(): unknown {
    return {
      nodeKinds: ANALYSIS_NODE_KINDS.map((kind) => ({ kind, shape: NODE_SHAPE_BY_KIND[kind] })),
      edgeKinds: WORKFLOW_EDGE_KINDS.map((kind) => ({
        kind,
        label: WORKFLOW_EDGE_KIND_LABELS[kind],
      })),
      /** The seven parts the client names. */
      dodFields: [
        'expectedOutput',
        'criteria',
        'evidence',
        'dependencies',
        'tools',
        'approval',
        'failureCondition',
      ],
      approvalKinds: STEP_APPROVAL_KINDS,
      schemaVersion: ANALYSIS_SCHEMA_VERSION,
      note:
        'Only Human and AI work nodes convert, and Human to AI needs an approved published ' +
        'Skill. Nothing here publishes: Approve & Assign is a separate transaction.',
    };
  }

  /** Open the editable draft, seeding it from the analysis on first open. */
  @Post(':objectiveId/workflow')
  @RequirePermission({ module: 'objective', action: 'EditDraft' })
  async openWorkflow(
    @Param('objectiveId', ParseUUIDPipe) objectiveId: string,
    @Body() body: VersionOnlyDto,
  ): Promise<unknown> {
    return this.workflow.open({
      scope: this.tenantContext.requireScope(),
      actorUserId: this.currentUserId(),
      objectiveId,
      ...(body.versionId === undefined ? {} : { versionId: body.versionId }),
    });
  }

  @Get(':objectiveId/workflow')
  @RequirePermission({ module: 'objective', action: 'View' })
  async viewWorkflow(
    @Param('objectiveId', ParseUUIDPipe) objectiveId: string,
    @Query() query: VersionQueryDto,
  ): Promise<unknown> {
    return this.workflow.view({
      scope: this.tenantContext.requireScope(),
      actorUserId: this.currentUserId(),
      objectiveId,
      ...(query.versionId === undefined ? {} : { versionId: query.versionId }),
    });
  }

  /** Edit a node's title, details, owner, trigger or Definition of Done. */
  @Put(':objectiveId/workflow/nodes/:nodeId')
  @RequirePermission({ module: 'objective', action: 'EditDraft' })
  async editWorkflowNode(
    @Param('objectiveId', ParseUUIDPipe) objectiveId: string,
    @Param('nodeId') nodeId: string,
    @Body() body: EditNodeDto,
  ): Promise<unknown> {
    return this.workflow.editNode({
      scope: this.tenantContext.requireScope(),
      actorUserId: this.currentUserId(),
      objectiveId,
      ...(body.versionId === undefined ? {} : { versionId: body.versionId }),
      revision: body.revision,
      nodeId,
      patch: {
        ...(body.label === undefined ? {} : { label: body.label }),
        ...(body.ownerUserId === undefined ? {} : { ownerUserId: body.ownerUserId }),
        ...(body.ownerDesignation === undefined ? {} : { ownerDesignation: body.ownerDesignation }),
        ...(body.triggerEvent === undefined ? {} : { triggerEvent: body.triggerEvent }),
        ...(body.dod === undefined ? {} : { dod: body.dod }),
      },
    });
  }

  /** Human ↔ AI conversion, where allowed. */
  @Post(':objectiveId/workflow/nodes/:nodeId/convert')
  @RequirePermission({ module: 'objective', action: 'EditDraft' })
  async convertWorkflowNode(
    @Param('objectiveId', ParseUUIDPipe) objectiveId: string,
    @Param('nodeId') nodeId: string,
    @Body() body: ConvertNodeDto,
  ): Promise<unknown> {
    return this.workflow.convertNode({
      scope: this.tenantContext.requireScope(),
      actorUserId: this.currentUserId(),
      objectiveId,
      ...(body.versionId === undefined ? {} : { versionId: body.versionId }),
      revision: body.revision,
      nodeId,
      to: body.to,
    });
  }

  @Post(':objectiveId/workflow/nodes')
  @RequirePermission({ module: 'objective', action: 'EditDraft' })
  async addWorkflowNode(
    @Param('objectiveId', ParseUUIDPipe) objectiveId: string,
    @Body() body: AddNodeDto,
  ): Promise<unknown> {
    return this.workflow.addNode({
      scope: this.tenantContext.requireScope(),
      actorUserId: this.currentUserId(),
      objectiveId,
      ...(body.versionId === undefined ? {} : { versionId: body.versionId }),
      revision: body.revision,
      kind: body.kind,
      label: body.label,
      ...(body.afterNodeId === undefined ? {} : { afterNodeId: body.afterNodeId }),
    });
  }

  @Delete(':objectiveId/workflow/nodes/:nodeId')
  @RequirePermission({ module: 'objective', action: 'EditDraft' })
  async deleteWorkflowNode(
    @Param('objectiveId', ParseUUIDPipe) objectiveId: string,
    @Param('nodeId') nodeId: string,
    @Query() query: RevisionQueryDto,
  ): Promise<unknown> {
    return this.workflow.deleteNode({
      scope: this.tenantContext.requireScope(),
      actorUserId: this.currentUserId(),
      objectiveId,
      ...(query.versionId === undefined ? {} : { versionId: query.versionId }),
      revision: Number(query.revision),
      nodeId,
    });
  }

  /** Reorder / reconnect: the edge list is replaced whole. */
  @Put(':objectiveId/workflow/edges')
  @RequirePermission({ module: 'objective', action: 'EditDraft' })
  async setWorkflowEdges(
    @Param('objectiveId', ParseUUIDPipe) objectiveId: string,
    @Body() body: SetEdgesDto,
  ): Promise<unknown> {
    return this.workflow.setEdges({
      scope: this.tenantContext.requireScope(),
      actorUserId: this.currentUserId(),
      objectiveId,
      ...(body.versionId === undefined ? {} : { versionId: body.versionId }),
      revision: body.revision,
      edges: body.edges.map((edge) => ({
        fromNodeId: edge.fromNodeId,
        toNodeId: edge.toNodeId,
        kind: edge.kind,
        condition: edge.condition ?? null,
      })),
    });
  }

  @Put(':objectiveId/workflow/nodes/:nodeId/dependencies')
  @RequirePermission({ module: 'objective', action: 'EditDraft' })
  async setWorkflowDependencies(
    @Param('objectiveId', ParseUUIDPipe) objectiveId: string,
    @Param('nodeId') nodeId: string,
    @Body() body: SetDependenciesDto,
  ): Promise<unknown> {
    return this.workflow.setDependencies({
      scope: this.tenantContext.requireScope(),
      actorUserId: this.currentUserId(),
      objectiveId,
      ...(body.versionId === undefined ? {} : { versionId: body.versionId }),
      revision: body.revision,
      nodeId,
      dependsOn: body.dependsOn,
    });
  }

  /**
   * The client's Pre-Publish Summary.
   *
   * A readiness report, not permission. `readyToAssign` says whether anything would put
   * unperformable work in front of people; Approve & Assign is Prompt 23's transaction.
   */
  @Get(':objectiveId/workflow/pre-publish')
  @RequirePermission({ module: 'objective', action: 'View' })
  async prePublish(
    @Param('objectiveId', ParseUUIDPipe) objectiveId: string,
    @Query() query: VersionQueryDto,
  ): Promise<unknown> {
    return this.workflow.prePublishSummary({
      scope: this.tenantContext.requireScope(),
      actorUserId: this.currentUserId(),
      objectiveId,
      ...(query.versionId === undefined ? {} : { versionId: query.versionId }),
    });
  }

  /**
   * Approve & Assign — the client's actionable transaction boundary.
   *
   * `objective:Assign`, which is the action the role templates give a Manager. Everything the
   * client requires is validated first and **all** failures come back together; on success the
   * version goes live, the work is created and the plan is frozen, in one transaction.
   */
  @Post(':objectiveId/assign')
  @RequirePermission({ module: 'objective', action: 'Assign' })
  async approveAndAssign(
    @Param('objectiveId', ParseUUIDPipe) objectiveId: string,
    @Body() body: AssignWorkflowDto,
  ): Promise<unknown> {
    return this.assignment.approveAndAssign({
      scope: this.tenantContext.requireScope(),
      actorUserId: this.currentUserId(),
      objectiveId,
      ...(body.versionId === undefined ? {} : { versionId: body.versionId }),
      ...(body.acceptWarnings === undefined ? {} : { acceptWarnings: body.acceptWarnings }),
    });
  }

  // -------------------------------------------------------------------------
  // Internals
  // -------------------------------------------------------------------------

  private contentOf(dto: Form2ObjectiveDto) {
    return {
      objectiveName: dto.objectiveName,
      departmentId: dto.departmentId,
      objectiveOwnerUserId: dto.objectiveOwnerUserId,
      expectedFinalResult: dto.expectedFinalResult,
      currentWorkload: dto.currentWorkload ?? null,
      unit: dto.unit ?? null,
      targetCompletionTime: dto.targetCompletionTime ?? null,
      timeUnit: dto.timeUnit ?? null,
      preparedBy: dto.preparedBy ?? null,
      formDate: this.dateOnly(dto.formDate ?? null),
      responsibleOwnerUserId: dto.responsibleOwnerUserId ?? null,
      executionTeam: dto.executionTeam ?? null,
    };
  }

  private stepOf(dto: Form2WorkflowStepDto) {
    return {
      position: dto.position,
      whoPersonName: dto.whoPersonName ?? null,
      whoDesignation: dto.whoDesignation ?? null,
      whoEngine: dto.whoEngine,
      whenTrigger: dto.whenTrigger ?? null,
      whenFrequency: dto.whenFrequency ?? null,
      whatExactWork: dto.whatExactWork,
      inputWhatIsUsed: dto.inputWhatIsUsed ?? null,
      inputReceivedFrom: dto.inputReceivedFrom ?? null,
      whereWorkIsDone: dto.whereWorkIsDone ?? null,
      outputWhatIsProduced: dto.outputWhatIsProduced ?? null,
      outputSentTo: dto.outputSentTo ?? null,
      timeTaken: dto.timeTaken ?? null,
      currentProblem: dto.currentProblem ?? null,
      approval: dto.approval,
    };
  }

  /**
   * Keep only the date part.
   *
   * `@IsISO8601` accepts a full instant, and the form's Date and the reward deadline are business
   * dates. Trimming here rather than trusting the caller means a timestamp sent by mistake cannot
   * make one company's deadline land a day earlier than another's.
   */
  private dateOnly(value: string | null): string | null {
    return value === null ? null : value.slice(0, 10);
  }

  private currentUserId(): string {
    const userId = actorUserId(getActor());
    if (!userId) {
      throw new UnauthorizedException('This requires an identified user.');
    }
    return userId;
  }
}

/** The two cards, with the client’s exact captions. Derived, so a section cannot be missed. */
const FORM2_SECTIONS_RESPONSE = FORM2_SECTIONS.map((section) => ({
  section,
  label: FORM2_SECTION_LABELS[section],
}));
