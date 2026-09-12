import {
  Body,
  Controller,
  Get,
  Param,
  Post,
  Put,
  Query,
  UnauthorizedException,
} from '@nestjs/common';
import { Transform, Type } from 'class-transformer';
import {
  IsArray,
  IsBoolean,
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  IsUUID,
  Matches,
  MaxLength,
  Min,
  MinLength,
  ValidateNested,
} from 'class-validator';

import {
  SKILL_AUTONOMY_LEVELS,
  SKILL_CATEGORIES,
  SKILL_CREATION_MODES,
  SKILL_IMPACT_DOMAINS,
  SKILL_LAYER_DESCRIPTIONS,
  SKILL_LAYER_LABELS,
  SKILL_LAYERS,
  SKILL_STATUSES,
  TOOL_ACTION_CATEGORIES,
  type SkillAutonomy,
  type SkillCategory,
  type SkillCreationMode,
  type SkillLayer,
  type SkillStatus,
} from '@uboss/types';

import { RequirePermission } from '../authorization/authorization.decorators.js';
import { actorUserId } from '../request-context/authenticated-actor.js';
import { getActor } from '../request-context/request-context.js';
import { PlatformOnly, TenantScoped } from '../tenancy/tenancy.decorators.js';
import { TenantContextService } from '../tenancy/tenant-context.service.js';
import { SkillService } from './skill.service.js';

export class SkillInputDto {
  @IsString() @MinLength(1) @MaxLength(80) name!: string;
  @IsString() @MaxLength(500) description!: string;
  @IsBoolean() required!: boolean;
}

export class SkillRuleDto {
  @IsString() @MinLength(1) @MaxLength(500) when!: string;
  @IsString() @MinLength(1) @MaxLength(500) then!: string;
}

export class SkillStepDto {
  @Type(() => Number) @IsInt() @Min(1) order!: number;
  @IsString() @MinLength(1) @MaxLength(1000) instruction!: string;
}

/**
 * Every content field the client lists, in their order.
 *
 * Validated here **and** in `@uboss/types` **and** by check constraints. Three layers because the
 * fields are the whole of what a governance reviewer reads: a Skill with an empty `whenNotToUse`
 * is the one that gets used for the wrong work, and a Skill whose autonomy contradicts its tool
 * categories is the one that does something irreversible unattended.
 */
export class SkillContentDto {
  @IsString() @MinLength(10) @MaxLength(2000) purpose!: string;
  @IsIn(SKILL_CATEGORIES) category!: SkillCategory;
  @IsString() @MinLength(5) @MaxLength(2000) whenToUse!: string;
  @IsString() @MinLength(5) @MaxLength(2000) whenNotToUse!: string;

  @IsArray() @ValidateNested({ each: true }) @Type(() => SkillInputDto) inputs!: SkillInputDto[];
  @IsArray() @ValidateNested({ each: true }) @Type(() => SkillRuleDto) rules!: SkillRuleDto[];
  @IsArray() @ValidateNested({ each: true }) @Type(() => SkillStepDto) steps!: SkillStepDto[];

  /** Declared, not granted. A `ConnectionToolGrant` is what an agent actually gets (Prompt 16). */
  @IsArray()
  @IsIn(TOOL_ACTION_CATEGORIES, { each: true })
  allowedToolCategories!: string[];

  @IsString() @MinLength(1) @MaxLength(8000) outputSchema!: string;
  @IsString() @MinLength(5) @MaxLength(2000) validation!: string;
  @IsString() @MinLength(5) @MaxLength(2000) failureHandling!: string;

  @IsBoolean() requiresApproval!: boolean;
  @IsIn(SKILL_AUTONOMY_LEVELS) autonomy!: SkillAutonomy;
  @IsString() @MinLength(5) @MaxLength(2000) evidenceRequirement!: string;
}

export class CreateSkillDto {
  @IsString()
  @Matches(/^[a-z][a-z0-9]*(-[a-z0-9]+)*$/, {
    message: 'A Skill handle is lower-kebab, so it can appear in a URL and be typed by a person.',
  })
  @MaxLength(80)
  key!: string;

  @IsString() @MinLength(2) @MaxLength(160) name!: string;

  @IsIn(SKILL_CREATION_MODES) creationMode!: SkillCreationMode;

  /** Required for `FromDocument`. */
  @IsOptional() @IsString() @MinLength(3) @MaxLength(500) sourceReference?: string;

  @ValidateNested() @Type(() => SkillContentDto) content!: SkillContentDto;
}

export class CloneSkillDto {
  @IsUUID() sourceSkillId!: string;
  @IsOptional() @IsUUID() sourceVersionId?: string;

  @IsString() @Matches(/^[a-z][a-z0-9]*(-[a-z0-9]+)*$/) @MaxLength(80) key!: string;
  @IsString() @MinLength(2) @MaxLength(160) name!: string;
}

/** A partial content change. Omitted fields carry from the version being superseded. */
export class SkillChangesDto {
  @IsOptional() @IsString() @MinLength(10) @MaxLength(2000) purpose?: string;
  @IsOptional() @IsIn(SKILL_CATEGORIES) category?: SkillCategory;
  @IsOptional() @IsString() @MinLength(5) @MaxLength(2000) whenToUse?: string;
  @IsOptional() @IsString() @MinLength(5) @MaxLength(2000) whenNotToUse?: string;

  @IsOptional()
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => SkillInputDto)
  inputs?: SkillInputDto[];
  @IsOptional()
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => SkillRuleDto)
  rules?: SkillRuleDto[];
  @IsOptional()
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => SkillStepDto)
  steps?: SkillStepDto[];

  @IsOptional()
  @IsArray()
  @IsIn(TOOL_ACTION_CATEGORIES, { each: true })
  allowedToolCategories?: string[];

  @IsOptional() @IsString() @MinLength(1) @MaxLength(8000) outputSchema?: string;
  @IsOptional() @IsString() @MinLength(5) @MaxLength(2000) validation?: string;
  @IsOptional() @IsString() @MinLength(5) @MaxLength(2000) failureHandling?: string;
  @IsOptional() @IsBoolean() requiresApproval?: boolean;
  @IsOptional() @IsIn(SKILL_AUTONOMY_LEVELS) autonomy?: SkillAutonomy;
  @IsOptional() @IsString() @MinLength(5) @MaxLength(2000) evidenceRequirement?: string;
}

export class StartDraftDto {
  @ValidateNested() @Type(() => SkillChangesDto) changes!: SkillChangesDto;
}

export class TransitionDto {
  @IsIn(SKILL_STATUSES) to!: SkillStatus;
  /** Required for anything that sends back, deprecates or archives. */
  @IsOptional() @IsString() @MinLength(5) @MaxLength(1000) reason?: string;
}

export class CatalogueQueryDto {
  @IsOptional() @IsIn(SKILL_LAYERS) layer?: SkillLayer;
  @IsOptional() @IsIn(SKILL_CATEGORIES) category?: SkillCategory;

  @IsOptional()
  @Transform(({ value }: { value: unknown }) =>
    value === undefined ? undefined : value === true || value === 'true',
  )
  @IsBoolean()
  publishedOnly?: boolean;
}

export class CreatePlatformSkillDto extends CreateSkillDto {
  @IsIn(SKILL_LAYERS) layer!: SkillLayer;
  /** Required for an Industry Pack. */
  @IsOptional() @IsString() @MinLength(2) @MaxLength(80) industry?: string;
}

/**
 * Settings → Skills & AI.
 *
 * ## What is deliberately absent
 *
 * There is **no template route**, no "instantiate", no "copy to my objective". The locked rule is
 * that there is no Objective, Workflow or Agent Template and no Templates Library, and the shape
 * of this controller is what keeps that true: the only way to get a Skill of your own is `clone`,
 * which produces a **draft under this company's own approval** with a recorded provenance link.
 *
 * ## Reading is not privileged; authoring is
 *
 * `settings:View` reads the catalogue — an employee needs to know what capabilities exist to
 * understand what an agent is doing. `settings:Administer` authors. `settings:Approve` approves,
 * because approving a capability is a governance decision and the Prompt 7 vocabulary already
 * separates the two.
 */
@Controller('tenants/:tenantId/skills')
@TenantScoped()
export class SkillController {
  constructor(
    private readonly skills: SkillService,
    private readonly tenantContext: TenantContextService,
  ) {}

  /** The vocabulary: layers, categories, autonomy levels, creation modes, impact domains. */
  @Get('catalogue-meta')
  @RequirePermission({ module: 'settings', action: 'View' })
  meta(): unknown {
    return {
      layers: SKILL_LAYERS.map((layer) => ({
        layer,
        label: SKILL_LAYER_LABELS[layer],
        description: SKILL_LAYER_DESCRIPTIONS[layer],
      })),
      categories: SKILL_CATEGORIES,
      autonomyLevels: SKILL_AUTONOMY_LEVELS,
      creationModes: SKILL_CREATION_MODES,
      statuses: SKILL_STATUSES,
      toolCategories: TOOL_ACTION_CATEGORIES,
      impactDomains: SKILL_IMPACT_DOMAINS,
      note:
        'A Skill is a governed capability, not a template. There is no Templates Library and no ' +
        'Objective, Workflow or Agent Template: work references a published version, that ' +
        'version is immutable, and a change creates a new draft that must be approved.',
    };
  }

  @Get()
  @RequirePermission({ module: 'settings', action: 'View' })
  async catalogue(@Query() query: CatalogueQueryDto): Promise<unknown> {
    return this.skills.catalogueFor({
      scope: this.tenantContext.requireScope(),
      actorUserId: this.currentUserId(),
      ...(query.layer === undefined ? {} : { layer: query.layer }),
      ...(query.category === undefined ? {} : { category: query.category }),
      ...(query.publishedOnly === undefined ? {} : { publishedOnly: query.publishedOnly }),
    });
  }

  @Get(':id')
  @RequirePermission({ module: 'settings', action: 'View' })
  async view(@Param('id') id: string): Promise<unknown> {
    return this.skills.view({
      scope: this.tenantContext.requireScope(),
      actorUserId: this.currentUserId(),
      skillId: id,
    });
  }

  /** Create a company custom Skill. Manual, From-document or Create-with-UBoss-AI. */
  @Post()
  @RequirePermission({ module: 'settings', action: 'Administer' })
  async create(@Body() body: CreateSkillDto): Promise<unknown> {
    return this.skills.createCompanySkill({
      scope: this.tenantContext.requireScope(),
      actorUserId: this.currentUserId(),
      key: body.key,
      name: body.name,
      content: body.content,
      creationMode: body.creationMode,
      ...(body.sourceReference === undefined ? {} : { sourceReference: body.sourceReference }),
    });
  }

  /**
   * Clone a Skill into this company.
   *
   * **The only way to get your own version of a platform Skill**, and the reason cloning is not
   * copying a template: the result is a draft under this company's approval, with its provenance
   * recorded so the impact analysis can still find it.
   */
  @Post('clone')
  @RequirePermission({ module: 'settings', action: 'Administer' })
  async clone(@Body() body: CloneSkillDto): Promise<unknown> {
    return this.skills.cloneSkill({
      scope: this.tenantContext.requireScope(),
      actorUserId: this.currentUserId(),
      sourceSkillId: body.sourceSkillId,
      ...(body.sourceVersionId === undefined ? {} : { sourceVersionId: body.sourceVersionId }),
      key: body.key,
      name: body.name,
    });
  }

  /** Start a new draft version. The published one is untouched — that is what editing means. */
  @Post(':id/versions')
  @RequirePermission({ module: 'settings', action: 'Administer' })
  async startDraft(@Param('id') id: string, @Body() body: StartDraftDto): Promise<unknown> {
    return this.skills.startNewDraft({
      scope: this.tenantContext.requireScope(),
      actorUserId: this.currentUserId(),
      skillId: id,
      changes: body.changes,
    });
  }

  /** Edit an open draft in place. Refused once the content is frozen. */
  @Put('versions/:versionId')
  @RequirePermission({ module: 'settings', action: 'Administer' })
  async updateDraft(
    @Param('versionId') versionId: string,
    @Body() body: SkillChangesDto,
  ): Promise<unknown> {
    return this.skills.updateDraft({
      scope: this.tenantContext.requireScope(),
      actorUserId: this.currentUserId(),
      versionId,
      changes: body,
    });
  }

  /**
   * Move a version through the lifecycle.
   *
   * The floor is `View` and **the service decides**, because which permission a move needs
   * depends on the move and on the row's current status: approving and rejecting need
   * `settings:Approve`, everything else needs `Administer`. A guard cannot know either before
   * the row is loaded, so an `Administer` floor here would lock a dedicated Approver — who holds
   * `Approve` and deliberately not `Administer` — out of the one step that is theirs. This
   * prompt's own HTTP test caught exactly that. The Prompt 7 two-phase shape, not a relaxation.
   */
  @Post('versions/:versionId/transition')
  @RequirePermission({ module: 'settings', action: 'View' })
  async transition(
    @Param('versionId') versionId: string,
    @Body() body: TransitionDto,
  ): Promise<unknown> {
    return this.skills.transition({
      scope: this.tenantContext.requireScope(),
      actorUserId: this.currentUserId(),
      versionId,
      to: body.to,
      ...(body.reason === undefined ? {} : { reason: body.reason }),
    });
  }

  /** What an upgrade would affect. Reports unknown, not zero, for what it cannot count. */
  @Get('versions/:versionId/impact')
  @RequirePermission({ module: 'settings', action: 'View' })
  async impact(@Param('versionId') versionId: string): Promise<unknown> {
    return this.skills.impactOf({
      scope: this.tenantContext.requireScope(),
      actorUserId: this.currentUserId(),
      versionId,
    });
  }

  /** The governance trail: every lifecycle move, with who and why. */
  @Get('versions/:versionId/history')
  @RequirePermission({ module: 'settings', action: 'View' })
  async history(@Param('versionId') versionId: string): Promise<unknown> {
    return this.skills.historyOf({
      scope: this.tenantContext.requireScope(),
      actorUserId: this.currentUserId(),
      versionId,
    });
  }

  private currentUserId(): string {
    const userId = actorUserId(getActor());
    if (!userId) {
      throw new UnauthorizedException('This requires an identified user.');
    }
    return userId;
  }
}

/**
 * The platform Skill Catalog.
 *
 * The only place a `tenant_id IS NULL` Skill comes into existence. A company cannot reach these
 * routes (`@PlatformOnly`), and even if one somehow did, the Row-Level Security `WITH CHECK` half
 * refuses the write — belt and brace, because a company able to publish a "UBoss Verified" Skill
 * would be publishing something every other company reads as verified by UBoss.
 */
@Controller('platform/skills')
@PlatformOnly()
export class PlatformSkillController {
  constructor(private readonly skills: SkillService) {}

  @Post()
  @RequirePermission({ module: 'skills', action: 'Create' })
  async create(@Body() body: CreatePlatformSkillDto): Promise<unknown> {
    return this.skills.createPlatformSkill({
      actorUserId: this.currentUserId(),
      layer: body.layer,
      key: body.key,
      name: body.name,
      ...(body.industry === undefined ? {} : { industry: body.industry }),
      content: body.content,
    });
  }

  @Post('versions/:versionId/transition')
  @RequirePermission({ module: 'skills', action: 'Publish' })
  async transition(
    @Param('versionId') versionId: string,
    @Body() body: TransitionDto,
  ): Promise<unknown> {
    return this.skills.transitionPlatformVersion({
      actorUserId: this.currentUserId(),
      versionId,
      to: body.to,
      ...(body.reason === undefined ? {} : { reason: body.reason }),
    });
  }

  private currentUserId(): string {
    const userId = actorUserId(getActor());
    if (!userId) {
      throw new UnauthorizedException('This requires an identified platform actor.');
    }
    return userId;
  }
}
