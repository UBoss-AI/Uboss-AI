import {
  BadRequestException,
  Body,
  Controller,
  Get,
  Param,
  Post,
  Query,
  UnauthorizedException,
} from '@nestjs/common';
import {
  IsBoolean,
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  Max,
  MaxLength,
  Min,
  MinLength,
} from 'class-validator';

import {
  DATA_CLASSIFICATIONS,
  FILE_SCAN_STATE_DESCRIPTIONS,
  FILE_SCAN_STATE_LABELS,
  FILE_SCAN_STATES,
  MAX_CONFIGURABLE_UPLOAD_BYTES,
  MAX_RETENTION_DAYS,
  REDACTION_STANCE,
  RETENTION_ACTION_DESCRIPTIONS,
  RETENTION_ACTION_LABELS,
  RETENTION_ACTIONS,
  type DataClassification,
  type RetentionAction,
} from '@uboss/types';

import { RequirePermission } from '../authorization/authorization.decorators.js';
import { actorUserId } from '../request-context/authenticated-actor.js';
import { getActor } from '../request-context/request-context.js';
import { TenantContextService } from '../tenancy/tenant-context.service.js';
import { TenantScoped } from '../tenancy/tenancy.decorators.js';
import { FileService } from './file.service.js';

class UploadDto {
  @IsString() @MinLength(1) @MaxLength(400) filename!: string;
  @IsString() @MinLength(1) @MaxLength(160) contentType!: string;

  /**
   * The file, base64-encoded.
   *
   * **Not multipart.** The whole API is JSON, every client is the same Next.js app, and a single
   * multipart route would mean a second body parser, a second validation path and a second place
   * for a size limit to be enforced. Base64 costs a third more bytes on the wire and keeps one
   * request pipeline — which is the trade this codebase has made everywhere else.
   *
   * The declared size is checked against the *decoded* length, so a client cannot understate it.
   */
  @IsString() @MinLength(1) contentBase64!: string;

  @IsOptional()
  @IsIn(DATA_CLASSIFICATIONS as readonly string[], {
    message: `classification must be one of: ${DATA_CLASSIFICATIONS.join(', ')}.`,
  })
  classification?: DataClassification;
}

class ClassifyDto {
  @IsIn(DATA_CLASSIFICATIONS as readonly string[], {
    message: `classification must be one of: ${DATA_CLASSIFICATIONS.join(', ')}.`,
  })
  classification!: DataClassification;

  @IsString() @MinLength(4) @MaxLength(500) reason!: string;
}

class LegalHoldDto {
  @IsBoolean() onHold!: boolean;
  @IsString() @MinLength(4) @MaxLength(500) reason!: string;
}

class DeleteFileDto {
  @IsString() @MinLength(4) @MaxLength(500) reason!: string;
}

class PolicyDto {
  @IsInt() @Min(1) @Max(MAX_CONFIGURABLE_UPLOAD_BYTES) maxUploadBytes!: number;

  @IsString({ each: true }) @MaxLength(160, { each: true }) allowedContentTypes!: string[];

  @IsOptional() @IsInt() @Min(1) @Max(MAX_RETENTION_DAYS) defaultRetentionDays?: number | null;

  @IsIn(RETENTION_ACTIONS as readonly string[], {
    message: `defaultRetentionAction must be one of: ${RETENTION_ACTIONS.join(', ')}.`,
  })
  defaultRetentionAction!: RetentionAction;

  @IsIn(DATA_CLASSIFICATIONS as readonly string[]) exportCeiling!: DataClassification;
  @IsIn(DATA_CLASSIFICATIONS as readonly string[]) externalEgressCeiling!: DataClassification;

  @IsString() @MinLength(4) @MaxLength(500) reason!: string;
}

/**
 * Files — Prompt 35.
 *
 * ## The grants, and why they are these
 *
 * Knowledge & Data lives under **Settings** in the approved navigation, so every route here is a
 * `settings` grant rather than a fourteenth module:
 *
 * * **Upload** — `settings:EditDraft`. CompanyAdmin. Adding company knowledge is an administrative
 *   act, not something an Employee does unasked.
 * * **List, read** — `settings:View`.
 * * **Download** — `settings:Export`. The content leaving UBoss is an export, and `Export` is the
 *   grant that means exactly that. CompanyAdmin holds it; Approver does not, which is correct —
 *   approving a knowledge source is not the same authority as taking its contents away.
 * * **Reclassify, legal hold, delete, policy** — `settings:Administer`. Each changes who may read
 *   what, or removes it permanently.
 *
 * There is no `Approve` route here: approving is a *knowledge source* act and lives on the other
 * controller. A file is not approved; it is scanned.
 */
@Controller('tenants/:tenantId/files')
@TenantScoped()
export class FileController {
  constructor(
    private readonly files: FileService,
    private readonly tenantContext: TenantContextService,
  ) {}

  /** The vocabulary a screen renders from, plus what the adapters actually are. */
  @Get('meta')
  @RequirePermission({ module: 'settings', action: 'View' })
  async meta(): Promise<unknown> {
    return {
      scanStates: FILE_SCAN_STATES.map((state) => ({
        key: state,
        label: FILE_SCAN_STATE_LABELS[state],
        description: FILE_SCAN_STATE_DESCRIPTIONS[state],
      })),
      classifications: DATA_CLASSIFICATIONS,
      retentionActions: RETENTION_ACTIONS.map((action) => ({
        key: action,
        label: RETENTION_ACTION_LABELS[action],
        description: RETENTION_ACTION_DESCRIPTIONS[action],
      })),
      // Both stated to the screen, because a company is entitled to know that the "scan" behind a
      // green tick was a mock and that nothing redacts.
      redactionStance: REDACTION_STANCE,
      adapters: this.files.adapters(),
    };
  }

  @Get('policy')
  @RequirePermission({ module: 'settings', action: 'View' })
  async policy(): Promise<unknown> {
    return this.files.policy(this.tenantContext.requireScope());
  }

  @Post('policy')
  @RequirePermission({ module: 'settings', action: 'Administer' })
  async setPolicy(@Body() body: PolicyDto): Promise<unknown> {
    return this.files.setPolicy({
      scope: this.tenantContext.requireScope(),
      actorUserId: this.currentUserId(),
      reason: body.reason,
      policy: {
        maxUploadBytes: body.maxUploadBytes,
        allowedContentTypes: body.allowedContentTypes,
        defaultRetentionDays: body.defaultRetentionDays ?? null,
        defaultRetentionAction: body.defaultRetentionAction,
        exportCeiling: body.exportCeiling,
        externalEgressCeiling: body.externalEgressCeiling,
      },
    });
  }

  @Get()
  @RequirePermission({ module: 'settings', action: 'View' })
  async list(@Query('includeDeleted') includeDeleted?: string): Promise<unknown> {
    return {
      files: await this.files.list({
        scope: this.tenantContext.requireScope(),
        actorUserId: this.currentUserId(),
        includeDeleted: includeDeleted === 'true',
      }),
    };
  }

  @Post()
  @RequirePermission({ module: 'settings', action: 'EditDraft' })
  async upload(@Body() body: UploadDto): Promise<unknown> {
    // Decoded before anything else, because every size and content check downstream has to run
    // against the real bytes rather than against a number the client supplied.
    const bytes = Buffer.from(body.contentBase64, 'base64');
    if (bytes.byteLength === 0) {
      throw new BadRequestException('That upload decoded to nothing. Check the base64 encoding.');
    }

    return this.files.upload({
      scope: this.tenantContext.requireScope(),
      actorUserId: this.currentUserId(),
      filename: body.filename,
      contentType: body.contentType,
      bytes,
      ...(body.classification === undefined ? {} : { classification: body.classification }),
    });
  }

  /** Scan a quarantined file again. Nothing else in the workflow is re-runnable. */
  @Post(':fileId/scan')
  @RequirePermission({ module: 'settings', action: 'EditDraft' })
  async scan(@Param('fileId') fileId: string): Promise<unknown> {
    return this.files.scan({ scope: this.tenantContext.requireScope(), fileId });
  }

  /**
   * Download the content, base64-encoded.
   *
   * The permission, the scan and the export ceiling all have to pass, in that order, and the
   * download is recorded in the security trail so the Data Exports view can show it.
   */
  @Get(':fileId/content')
  @RequirePermission({ module: 'settings', action: 'Export' })
  async download(@Param('fileId') fileId: string): Promise<unknown> {
    const result = await this.files.download({
      scope: this.tenantContext.requireScope(),
      actorUserId: this.currentUserId(),
      fileId,
    });
    return { file: result.view, contentBase64: result.bytes.toString('base64') };
  }

  @Post(':fileId/classification')
  @RequirePermission({ module: 'settings', action: 'Administer' })
  async classify(@Param('fileId') fileId: string, @Body() body: ClassifyDto): Promise<unknown> {
    return this.files.classify({
      scope: this.tenantContext.requireScope(),
      actorUserId: this.currentUserId(),
      fileId,
      classification: body.classification,
      reason: body.reason,
    });
  }

  @Post(':fileId/legal-hold')
  @RequirePermission({ module: 'settings', action: 'Administer' })
  async legalHold(@Param('fileId') fileId: string, @Body() body: LegalHoldDto): Promise<unknown> {
    return this.files.setLegalHold({
      scope: this.tenantContext.requireScope(),
      actorUserId: this.currentUserId(),
      fileId,
      onHold: body.onHold,
      reason: body.reason,
    });
  }

  /**
   * Delete a file's content.
   *
   * `POST`, not `DELETE`, for the reason every other destructive route in this codebase is: a
   * reason is mandatory, and a body on a `DELETE` is a thing half the HTTP stack drops.
   */
  @Post(':fileId/delete')
  @RequirePermission({ module: 'settings', action: 'Administer' })
  async deleteFile(@Param('fileId') fileId: string, @Body() body: DeleteFileDto): Promise<unknown> {
    return this.files.delete({
      scope: this.tenantContext.requireScope(),
      actorUserId: this.currentUserId(),
      fileId,
      reason: body.reason,
    });
  }

  /**
   * Run the retention sweep for this company.
   *
   * Exposed as a route because **nothing schedules it** — the fifth job waiting on the Prompt 26
   * business-cron scheduler, and the honest way to ship a reachable, tested sweep in the meantime.
   * It is not a way to delete a particular file: a held file is skipped, and so is one whose policy
   * asks for a person to decide.
   */
  @Post('retention/sweep')
  @RequirePermission({ module: 'settings', action: 'Administer' })
  async sweep(): Promise<unknown> {
    return this.files.sweepRetention({ scope: this.tenantContext.requireScope() });
  }

  private currentUserId(): string {
    const id = actorUserId(getActor());
    if (id === undefined || id === null) {
      throw new UnauthorizedException('Company files are for signed-in company members.');
    }
    return id;
  }
}
