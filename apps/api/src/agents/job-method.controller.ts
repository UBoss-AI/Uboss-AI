import {
  BadRequestException,
  Body,
  Controller,
  Get,
  Header,
  Param,
  Post,
  Res,
  UnauthorizedException,
} from '@nestjs/common';
import type { Response } from 'express';
import {
  ArrayMaxSize,
  IsArray,
  IsObject,
  IsOptional,
  IsString,
  MaxLength,
  MinLength,
} from 'class-validator';

import {
  AUTOMATION_STANCE,
  COLUMNS_THE_EMPLOYEE_MUST_ANSWER,
  AGENT_BOUNDARY_FACTORS,
  BUILD_FLOW_LABELS,
  BUILD_FLOW_STAGES,
  IMPORT_PROBLEM_KINDS,
  IMPORT_PROBLEM_LABELS,
  IMPORT_STAGE_LABELS,
  IMPORT_STAGES,
  JOB_METHOD_COLUMNS,
  JOB_METHOD_FORM_VERSION,
  JOB_METHOD_MAX_ROWS,
  stageIsRequired,
} from '@uboss/types';

import { actorUserId } from '../request-context/authenticated-actor.js';
import { getActor } from '../request-context/request-context.js';
import { TenantScoped } from '../tenancy/tenancy.decorators.js';
import { TenantContextService } from '../tenancy/tenant-context.service.js';
import { JobMethodWorkbook } from './job-method-workbook.js';
import { JobMethodService } from './job-method.service.js';

/**
 * A returned workbook, base64 encoded.
 *
 * Base64 in a JSON body rather than multipart, matching the Prompt 35 upload path this codebase
 * already has — one upload convention rather than two, and the per-route body limit in `main.ts`
 * already understands it.
 */
class ImportWorkbookDto {
  @IsString() @MinLength(1) @MaxLength(400) filename!: string;
  @IsString() @MinLength(1) @MaxLength(30_000_000) contentBase64!: string;
}

class ImportFormDto {
  @IsString() @MinLength(1) @MaxLength(400) filename!: string;
  /** The context block from the downloaded form, returned unchanged. */
  @IsObject() envelope!: { formVersion: unknown; objectiveVersionId: unknown; aiWorkAssignmentId: unknown };
  @IsArray() @ArrayMaxSize(JOB_METHOD_MAX_ROWS + 1) rows!: Record<string, unknown>[];
  @IsOptional() @IsString() note?: string;
}

/**
 * Download / offline fill / upload the Job Method — Prompt 40A (CR-03) §4.
 *
 * ## The permission split is the feature
 *
 * No `@RequirePermission` at the route level, because the two halves need different grants and the
 * service applies each: **download** needs `todo:View`, which a standard Employee holds, and
 * **upload** needs `agent-builder:EditDraft`, which they do not. Putting one decorator on the
 * controller would have forced both to the same grant and collapsed the distinction this whole
 * amendment rests on.
 */
@Controller('tenants/:tenantId/job-methods')
@TenantScoped()
export class JobMethodController {
  constructor(
    private readonly jobMethods: JobMethodService,
    private readonly tenantContext: TenantContextService,
  ) {}

  /** The columns, the pipeline, the flow and what an upload will never do. */
  @Get('meta')
  async meta(): Promise<unknown> {
    return {
      formVersion: JOB_METHOD_FORM_VERSION,
      maxRows: JOB_METHOD_MAX_ROWS,
      columns: JOB_METHOD_COLUMNS,
      // The five nothing prefills — the reason the form is sent out at all.
      columnsTheEmployeeMustAnswer: COLUMNS_THE_EMPLOYEE_MUST_ANSWER,
      importStages: IMPORT_STAGES.map((stage) => ({
        key: stage,
        label: IMPORT_STAGE_LABELS[stage],
      })),
      problemKinds: IMPORT_PROBLEM_KINDS.map((kind) => ({
        key: kind,
        label: IMPORT_PROBLEM_LABELS[kind],
      })),
      buildFlow: BUILD_FLOW_STAGES.map((stage) => ({
        key: stage,
        label: BUILD_FLOW_LABELS[stage],
        required: stageIsRequired(stage),
      })),
      agentBoundaryFactors: AGENT_BOUNDARY_FACTORS,
      // Served verbatim: an upload saves a draft and does nothing else.
      automationStance: AUTOMATION_STANCE,
    };
  }

  /**
   * Download the form as a **real spreadsheet**.
   *
   * `todo:View` — an employee with no builder access can receive this, which is the entire point:
   * the person who knows how the work is done fills it in offline and sends it back.
   *
   * Returns `.xlsx` bytes with a `Content-Disposition`, so a browser saves a file rather than
   * rendering JSON. The JSON shape is still available at `/form.json` for a client that wants to
   * render the form itself.
   */
  @Get(':aiWorkAssignmentId/form.xlsx')
  @Header(
    'Content-Type',
    'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  )
  async downloadWorkbook(
    @Param('aiWorkAssignmentId') aiWorkAssignmentId: string,
    @Res({ passthrough: true }) response: Response,
  ): Promise<Buffer> {
    const form = await this.jobMethods.downloadForm({
      scope: this.tenantContext.requireScope(),
      actorUserId: this.currentUserId(),
      aiWorkAssignmentId,
    });

    const filename = JobMethodWorkbook.filenameFor(form);
    response.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    return JobMethodWorkbook.toBuffer(form);
  }

  /** The same form as JSON, for a client that renders it rather than downloading it. */
  @Get(':aiWorkAssignmentId/form')
  async download(
    @Param('aiWorkAssignmentId') aiWorkAssignmentId: string,
  ): Promise<unknown> {
    return this.jobMethods.downloadForm({
      scope: this.tenantContext.requireScope(),
      actorUserId: this.currentUserId(),
      aiWorkAssignmentId,
    });
  }

  /** What has been captured, its provenance, and how many agents it looks like. */
  @Get(':aiWorkAssignmentId')
  async view(@Param('aiWorkAssignmentId') aiWorkAssignmentId: string): Promise<unknown> {
    return this.jobMethods.view({
      scope: this.tenantContext.requireScope(),
      actorUserId: this.currentUserId(),
      aiWorkAssignmentId,
    });
  }

  /**
   * Upload a completed form. `agent-builder:EditDraft`.
   *
   * Returns the import review — the flagged problems and what would be saved — and saves into the
   * draft only. It never tests and never activates.
   */
  @Post(':aiWorkAssignmentId/import')
  async import(
    @Param('aiWorkAssignmentId') aiWorkAssignmentId: string,
    @Body() body: ImportFormDto,
  ): Promise<unknown> {
    return this.jobMethods.importForm({
      scope: this.tenantContext.requireScope(),
      actorUserId: this.currentUserId(),
      aiWorkAssignmentId,
      filename: body.filename,
      envelope: body.envelope,
      rows: body.rows,
    });
  }

  /**
   * Upload a completed workbook. `agent-builder:EditDraft`.
   *
   * Reads the file, then hands the rows to the same import pipeline the JSON route uses — so the
   * validation, the linkage check, the flagging and the draft-only rule are identical whichever
   * way the answers arrived. A second import path for spreadsheets would be a second place for
   * those rules to drift.
   *
   * A file that cannot be opened at all is refused **before** the pipeline, with a reason a person
   * can act on: "that is not a spreadsheet" and "that spreadsheet has no Job Method headings" are
   * different problems and deserve different sentences.
   */
  @Post(':aiWorkAssignmentId/import-workbook')
  async importWorkbook(
    @Param('aiWorkAssignmentId') aiWorkAssignmentId: string,
    @Body() body: ImportWorkbookDto,
  ): Promise<unknown> {
    const bytes = Buffer.from(body.contentBase64, 'base64');
    if (bytes.byteLength === 0) {
      throw new BadRequestException('That file is empty.');
    }

    const read = await JobMethodWorkbook.fromBuffer(bytes);
    if (read.unreadable !== null) {
      // Recorded as a refused import by the service, so "I sent that in" still has an answer —
      // rather than failing here with nothing written down.
      return this.jobMethods.importForm({
        scope: this.tenantContext.requireScope(),
        actorUserId: this.currentUserId(),
        aiWorkAssignmentId,
        filename: body.filename,
        envelope: read.envelope,
        rows: [],
        unreadable: read.unreadable,
      });
    }

    return this.jobMethods.importForm({
      scope: this.tenantContext.requireScope(),
      actorUserId: this.currentUserId(),
      aiWorkAssignmentId,
      filename: body.filename,
      envelope: read.envelope,
      rows: read.rows,
    });
  }

  private currentUserId(): string {
    const id = actorUserId(getActor());
    if (id === undefined || id === null) {
      throw new UnauthorizedException('This requires a signed-in member of the company.');
    }
    return id;
  }
}
