import {
  Body,
  Controller,
  Get,
  Param,
  Post,
  Query,
  UnauthorizedException,
} from '@nestjs/common';
import {
  IsArray,
  IsIn,
  IsOptional,
  IsString,
  IsUUID,
  MaxLength,
  MinLength,
} from 'class-validator';

import {
  DATA_CLASSIFICATIONS,
  KNOWLEDGE_ACCESS_SCOPE_LABELS,
  KNOWLEDGE_ACCESS_SCOPES,
  KNOWLEDGE_SOURCE_KIND_LABELS,
  KNOWLEDGE_SOURCE_KINDS,
  KNOWLEDGE_SOURCE_STATES,
  type DataClassification,
  type KnowledgeAccessScope,
  type KnowledgeSourceKind,
} from '@uboss/types';

import { RequirePermission } from '../authorization/authorization.decorators.js';
import { actorUserId } from '../request-context/authenticated-actor.js';
import { getActor } from '../request-context/request-context.js';
import { TenantContextService } from '../tenancy/tenant-context.service.js';
import { TenantScoped } from '../tenancy/tenancy.decorators.js';
import { KnowledgeService } from './knowledge.service.js';

class CreateSourceDto {
  @IsString() @MinLength(2) @MaxLength(200) name!: string;
  @IsOptional() @IsString() @MaxLength(2000) description?: string;

  @IsIn(KNOWLEDGE_SOURCE_KINDS as readonly string[], {
    message: `kind must be one of: ${KNOWLEDGE_SOURCE_KINDS.join(', ')}.`,
  })
  kind!: KnowledgeSourceKind;

  @IsOptional()
  @IsIn(KNOWLEDGE_ACCESS_SCOPES as readonly string[], {
    message: `accessScope must be one of: ${KNOWLEDGE_ACCESS_SCOPES.join(', ')}.`,
  })
  accessScope?: KnowledgeAccessScope;

  @IsOptional() @IsUUID(7) departmentId?: string;
  @IsOptional() @IsArray() @IsUUID(7, { each: true }) namedAgentIds?: string[];

  @IsOptional() @IsIn(DATA_CLASSIFICATIONS as readonly string[]) classification?: DataClassification;
  @IsOptional() @IsUUID(7) connectionId?: string;
}

class UpdateSourceDto {
  @IsOptional() @IsString() @MinLength(2) @MaxLength(200) name?: string;
  @IsOptional() @IsString() @MaxLength(2000) description?: string;

  @IsOptional()
  @IsIn(KNOWLEDGE_ACCESS_SCOPES as readonly string[])
  accessScope?: KnowledgeAccessScope;

  @IsOptional() @IsUUID(7) departmentId?: string;
  @IsOptional() @IsArray() @IsUUID(7, { each: true }) namedAgentIds?: string[];
  @IsOptional() @IsIn(DATA_CLASSIFICATIONS as readonly string[]) classification?: DataClassification;
}

class ApproveSourceDto {
  @IsOptional() @IsString() @MaxLength(1000) note?: string;
}

class RetireSourceDto {
  @IsString() @MinLength(4) @MaxLength(500) reason!: string;
}

class SourceFileDto {
  @IsUUID(7) fileId!: string;
}

/**
 * Knowledge sources — Prompt 35.
 *
 * ## Authoring and approving are different grants on purpose
 *
 * `settings:EditDraft` assembles a source; `settings:Approve` approves it; `settings:Administer`
 * retires it. The first and third are the CompanyAdmin template and the second is the Approver
 * template, so **by default a source is approved by somebody other than the person who built it**.
 * That is the only structural separation of duties in this module, and it is the one that matters:
 * an approved source is what an Engine Agent is allowed to read.
 *
 * ## There is no "read this source's files" route for a person
 *
 * Reading a file is `GET /files/:fileId/content` on the other controller, under `settings:Export`.
 * A second download path scoped by knowledge source would be a second place the scan check has to
 * be remembered. `canRead` answers the question — *may this agent consult this source, and which
 * of its files are usable* — and the agent runtime takes the file ids from there.
 */
@Controller('tenants/:tenantId/knowledge-sources')
@TenantScoped()
export class KnowledgeController {
  constructor(
    private readonly knowledge: KnowledgeService,
    private readonly tenantContext: TenantContextService,
  ) {}

  @Get('meta')
  @RequirePermission({ module: 'settings', action: 'View' })
  async meta(): Promise<unknown> {
    return {
      kinds: KNOWLEDGE_SOURCE_KINDS.map((kind) => ({
        key: kind,
        label: KNOWLEDGE_SOURCE_KIND_LABELS[kind],
      })),
      states: KNOWLEDGE_SOURCE_STATES,
      accessScopes: KNOWLEDGE_ACCESS_SCOPES.map((scope) => ({
        key: scope,
        label: KNOWLEDGE_ACCESS_SCOPE_LABELS[scope],
      })),
      classifications: DATA_CLASSIFICATIONS,
    };
  }

  @Get()
  @RequirePermission({ module: 'settings', action: 'View' })
  async list(@Query('includeRetired') includeRetired?: string): Promise<unknown> {
    return {
      sources: await this.knowledge.list({
        scope: this.tenantContext.requireScope(),
        actorUserId: this.currentUserId(),
        includeRetired: includeRetired === 'true',
      }),
    };
  }

  @Post()
  @RequirePermission({ module: 'settings', action: 'EditDraft' })
  async create(@Body() body: CreateSourceDto): Promise<unknown> {
    return this.knowledge.create({
      scope: this.tenantContext.requireScope(),
      actorUserId: this.currentUserId(),
      name: body.name,
      kind: body.kind,
      ...(body.description === undefined ? {} : { description: body.description }),
      ...(body.accessScope === undefined ? {} : { accessScope: body.accessScope }),
      ...(body.departmentId === undefined ? {} : { departmentId: body.departmentId }),
      ...(body.namedAgentIds === undefined ? {} : { namedAgentIds: body.namedAgentIds }),
      ...(body.classification === undefined ? {} : { classification: body.classification }),
      ...(body.connectionId === undefined ? {} : { connectionId: body.connectionId }),
    });
  }

  @Post(':sourceId')
  @RequirePermission({ module: 'settings', action: 'EditDraft' })
  async update(
    @Param('sourceId') sourceId: string,
    @Body() body: UpdateSourceDto,
  ): Promise<unknown> {
    return this.knowledge.update({
      scope: this.tenantContext.requireScope(),
      actorUserId: this.currentUserId(),
      sourceId,
      ...(body.name === undefined ? {} : { name: body.name }),
      ...(body.description === undefined ? {} : { description: body.description }),
      ...(body.accessScope === undefined ? {} : { accessScope: body.accessScope }),
      ...(body.departmentId === undefined ? {} : { departmentId: body.departmentId }),
      ...(body.namedAgentIds === undefined ? {} : { namedAgentIds: body.namedAgentIds }),
      ...(body.classification === undefined ? {} : { classification: body.classification }),
    });
  }

  @Post(':sourceId/approve')
  @RequirePermission({ module: 'settings', action: 'Approve' })
  async approve(
    @Param('sourceId') sourceId: string,
    @Body() body: ApproveSourceDto,
  ): Promise<unknown> {
    return this.knowledge.approve({
      scope: this.tenantContext.requireScope(),
      actorUserId: this.currentUserId(),
      sourceId,
      ...(body.note === undefined ? {} : { note: body.note }),
    });
  }

  @Post(':sourceId/retire')
  @RequirePermission({ module: 'settings', action: 'Administer' })
  async retire(
    @Param('sourceId') sourceId: string,
    @Body() body: RetireSourceDto,
  ): Promise<unknown> {
    return this.knowledge.retire({
      scope: this.tenantContext.requireScope(),
      actorUserId: this.currentUserId(),
      sourceId,
      reason: body.reason,
    });
  }

  @Post(':sourceId/files')
  @RequirePermission({ module: 'settings', action: 'EditDraft' })
  async addFile(
    @Param('sourceId') sourceId: string,
    @Body() body: SourceFileDto,
  ): Promise<unknown> {
    return this.knowledge.addFile({
      scope: this.tenantContext.requireScope(),
      actorUserId: this.currentUserId(),
      sourceId,
      fileId: body.fileId,
    });
  }

  @Post(':sourceId/files/remove')
  @RequirePermission({ module: 'settings', action: 'EditDraft' })
  async removeFile(
    @Param('sourceId') sourceId: string,
    @Body() body: SourceFileDto,
  ): Promise<unknown> {
    return this.knowledge.removeFile({
      scope: this.tenantContext.requireScope(),
      actorUserId: this.currentUserId(),
      sourceId,
      fileId: body.fileId,
    });
  }

  /**
   * Would this agent be allowed to consult this source?
   *
   * A read-only question, under `settings:View`, so somebody configuring a source can see what it
   * would do before an agent run finds out. The same function the runtime calls, so the answer on
   * the screen and the answer in production cannot diverge.
   */
  @Get(':sourceId/access')
  @RequirePermission({ module: 'settings', action: 'View' })
  async access(
    @Param('sourceId') sourceId: string,
    @Query('engineAgentId') engineAgentId?: string,
    @Query('departmentId') departmentId?: string,
  ): Promise<unknown> {
    return this.knowledge.accessPreview({
      scope: this.tenantContext.requireScope(),
      actorUserId: this.currentUserId(),
      sourceId,
      engineAgentId: engineAgentId ?? null,
      askingDepartmentId: departmentId ?? null,
    });
  }

  private currentUserId(): string {
    const id = actorUserId(getActor());
    if (id === undefined || id === null) {
      throw new UnauthorizedException('Knowledge sources are for signed-in company members.');
    }
    return id;
  }
}
