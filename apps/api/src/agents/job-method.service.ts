import { createHash } from 'node:crypto';

import { ForbiddenException, Injectable, Logger, NotFoundException } from '@nestjs/common';

import {
  AUTOMATION_STANCE,
  exportLeaks,
  FORM2_PREFILL,
  JOB_METHOD_COLUMN_KEYS,
  JOB_METHOD_COLUMNS,
  JOB_METHOD_FORM_VERSION,
  JOB_METHOD_KEY_BY_HEADING,
  JOB_METHOD_MAX_ROWS,
  mayMerge,
  normaliseHeading,
  provenanceKey,
  readRow,
  suggestAgentGroups,
  validateFormEnvelope,
  type ImportProblem,
  type JobMethodColumnKey,
  type JobMethodForm,
  type JobMethodRow,
  type ValueSource,
} from '@uboss/types';

import { AuditEventService } from '../audit/audit-event.service.js';
import { AuthorizationService } from '../authorization/authorization.service.js';
import { PrismaService } from '../persistence/prisma.service.js';
import type { TenantScope } from '../persistence/tenant-context.js';

/** One row as it arrives from a spreadsheet: headings as typed, values as strings. */
export interface IncomingRow {
  [heading: string]: unknown;
}

/**
 * The Job Method: download a form, fill it in offline, upload it — Prompt 40A (CR-03) §4.
 *
 * ## Why the download needs no builder permission and the upload does
 *
 * The whole point of the feature. The person who knows how work is actually done is rarely the
 * person who should configure agents, so:
 *
 * * **Download** needs `todo:View` — you may take away the form for work you can see. An employee
 *   with no Agent Builder access at all can receive it, fill it in on a train, and send it back.
 * * **Upload** needs `agent-builder:EditDraft`. Bringing somebody's answers into a draft *is*
 *   building, and it is the moment a business description becomes agent configuration.
 *
 * ## Nothing is invented and nothing is activated
 *
 * A blank cell is reported `Missing` and stays blank. An over-long cell is reported `Invalid` and
 * is **not** truncated — a sentence silently cut mid-word would be stored as though the company had
 * written it that way. And an upload saves into a draft and stops: it never tests and never
 * activates, because a spreadsheet must not be able to put an agent into production
 * (`AUTOMATION_STANCE`).
 */
@Injectable()
export class JobMethodService {
  private readonly logger = new Logger(JobMethodService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly authorization: AuthorizationService,
    private readonly audit: AuditEventService,
  ) {}

  // -------------------------------------------------------------------------
  // Download
  // -------------------------------------------------------------------------

  /**
   * The form, prefilled with what the Objective and the assignment already answer.
   *
   * **Five columns are deliberately left blank** — the tool, the method, the rule, the
   * prohibitions and the failure handling — because Form 2 has no field that means any of them. A
   * prefill that guessed would be UBoss inventing a business fact and presenting it to the person
   * least likely to challenge it. Collecting those five is the reason the form exists.
   */
  async downloadForm(input: {
    scope: TenantScope;
    actorUserId: string;
    aiWorkAssignmentId: string;
  }): Promise<JobMethodForm> {
    const context = await this.authorization.contextFor(input.scope, input.actorUserId);
    // `todo:View` — the grant a standard Employee holds. Taking the form away is not building.
    await this.authorization.assertCan(context, { module: 'todo', action: 'View' });

    const assignment = await this.requireAssignment(input.scope, input.aiWorkAssignmentId);

    const existing = await this.prisma.runInTenantTransaction(input.scope, () =>
      this.prisma.client.jobMethod.findFirst({
        where: { tenantId: input.scope.tenantId, aiWorkAssignmentId: input.aiWorkAssignmentId },
        select: { rows: { orderBy: { step: 'asc' } } },
      }),
    );

    const rows: JobMethodRow[] =
      existing !== null && existing.rows.length > 0
        ? existing.rows.map((row) => toRow(row))
        : prefillFromForm2(assignment.steps);

    const form: JobMethodForm = {
      context: {
        formVersion: JOB_METHOD_FORM_VERSION,
        objectiveId: assignment.objectiveId,
        objectiveVersionId: assignment.objectiveVersionId,
        objectiveName: assignment.objectiveName,
        aiWorkAssignmentId: assignment.id,
        assignmentTitle: assignment.title,
        assignedToEmployeeRef: assignment.assignedToEmployeeRef,
        downloadedAt: new Date().toISOString(),
      },
      columns: JOB_METHOD_COLUMNS,
      rows,
    };

    /**
     * The leak check runs on the produced form, every time.
     *
     * *"Never export secrets, credentials, system prompts or API keys."* A rule like that is kept
     * by checking the bytes that leave, not by the care of whoever writes the exporter next — and
     * this file leaves UBoss and comes back, so it is the one artifact where that matters most.
     *
     * A refusal rather than a redaction: if something forbidden is in a company's own Form 2 text,
     * quietly stripping it would hide a real problem in their data.
     */
    const leaks = exportLeaks(form);
    if (leaks.length > 0) {
      this.logger.error(`Refused a Job Method download containing: ${leaks.join(', ')}`);
      throw new ForbiddenException(
        'This form cannot be produced because the objective or assignment text contains ' +
          'something that must not leave UBoss. Ask an administrator to review it.',
      );
    }

    await this.audit.recordForTenant(input.scope, {
      action: 'agents.job_method_downloaded',
      actorUserId: input.actorUserId,
      resourceType: 'ai-work-assignment',
      resourceId: assignment.id,
      summary: `Downloaded the Job Method form for "${assignment.title}".`,
      metadata: { formVersion: JOB_METHOD_FORM_VERSION, rows: rows.length },
    });

    return form;
  }

  // -------------------------------------------------------------------------
  // Upload
  // -------------------------------------------------------------------------

  /**
   * Read a completed form and merge it into a draft.
   *
   * The pipeline, in the order `IMPORT_STAGES` declares and for the reason it declares it:
   * **linkage is verified before anything is parsed**. A file for a different assignment, or from a
   * form version whose columns have moved, is refused before its cells reach any field — because
   * once they are read, a wrong mapping looks exactly like a filled-in form.
   *
   * Every attempt is recorded, accepted or not. A **refused** import is the more valuable row: "I
   * sent that in three weeks ago" is answered by a record saying it arrived and why it was not
   * applied.
   */
  async importForm(input: {
    scope: TenantScope;
    actorUserId: string;
    aiWorkAssignmentId: string;
    filename: string;
    envelope: { formVersion: unknown; objectiveVersionId: unknown; aiWorkAssignmentId: unknown };
    rows: readonly IncomingRow[];
    /**
     * Set when the upload could not be opened as a workbook at all.
     *
     * Passed in rather than detected here, because reading the file is the controller's job — but
     * **recorded** here, so a file that was not a spreadsheet still leaves a row saying it arrived
     * and why it was refused. Failing in the controller would lose that, and "I sent that form in
     * three weeks ago" would have no answer.
     */
    unreadable?: string | undefined;
  }): Promise<{
    accepted: boolean;
    stage: string;
    problems: ImportProblem[];
    rows: JobMethodRow[];
    refusedBecause: string | null;
    agentSuggestion: ReturnType<typeof suggestAgentGroups> | null;
  }> {
    const context = await this.authorization.contextFor(input.scope, input.actorUserId);
    // Building, not viewing. This is where a business description becomes configuration.
    await this.authorization.assertCan(context, { module: 'agent-builder', action: 'EditDraft' });

    const assignment = await this.requireAssignment(input.scope, input.aiWorkAssignmentId);
    const jobMethod = await this.ensureJobMethod(input.scope, input.actorUserId, assignment);

    const contentHash = createHash('sha256')
      .update(JSON.stringify({ envelope: input.envelope, rows: input.rows }))
      .digest('hex');

    // ---- stage 1a: a file that is not a workbook at all ----
    if (input.unreadable !== undefined) {
      await this.recordImport(input.scope, {
        jobMethodId: jobMethod.id,
        actorUserId: input.actorUserId,
        filename: input.filename,
        contentHash,
        claimedFormVersion: null,
        stage: 'ValidateFile',
        accepted: false,
        refusedBecause: input.unreadable,
        problems: [],
        rowsRead: 0,
        rowsAccepted: 0,
      });
      return {
        accepted: false,
        stage: 'ValidateFile',
        problems: [],
        rows: [],
        refusedBecause: input.unreadable,
        agentSuggestion: null,
      };
    }

    // ---- stages 1 and 2: the file, then the linkage ----
    const envelope = validateFormEnvelope({
      formVersion: input.envelope.formVersion,
      objectiveVersionId: input.envelope.objectiveVersionId,
      aiWorkAssignmentId: input.envelope.aiWorkAssignmentId,
      expected: {
        objectiveVersionId: assignment.objectiveVersionId,
        aiWorkAssignmentId: assignment.id,
      },
    });

    if (!envelope.ok) {
      await this.recordImport(input.scope, {
        jobMethodId: jobMethod.id,
        actorUserId: input.actorUserId,
        filename: input.filename,
        contentHash,
        claimedFormVersion:
          typeof input.envelope.formVersion === 'number' ? input.envelope.formVersion : null,
        stage: envelope.stage,
        accepted: false,
        refusedBecause: envelope.reason,
        problems: [],
        rowsRead: 0,
        rowsAccepted: 0,
      });
      return {
        accepted: false,
        stage: envelope.stage,
        problems: [],
        rows: [],
        refusedBecause: envelope.reason,
        agentSuggestion: null,
      };
    }

    if (input.rows.length > JOB_METHOD_MAX_ROWS) {
      const reason =
        `This form has ${input.rows.length} rows and the limit is ${JOB_METHOD_MAX_ROWS}. A job ` +
        'with more steps than that is more than one job — split it across assignments.';
      await this.recordImport(input.scope, {
        jobMethodId: jobMethod.id,
        actorUserId: input.actorUserId,
        filename: input.filename,
        contentHash,
        claimedFormVersion: JOB_METHOD_FORM_VERSION,
        stage: 'ParseRows',
        accepted: false,
        refusedBecause: reason,
        problems: [],
        rowsRead: input.rows.length,
        rowsAccepted: 0,
      });
      return {
        accepted: false,
        stage: 'ParseRows',
        problems: [],
        rows: [],
        refusedBecause: reason,
        agentSuggestion: null,
      };
    }

    // ---- stages 3, 4 and 5: parse, map, flag ----
    const problems: ImportProblem[] = [];
    const parsed: JobMethodRow[] = [];

    input.rows.forEach((incoming, index) => {
      const step = index + 1;
      const cells: Partial<Record<JobMethodColumnKey, unknown>> = {};

      for (const [heading, value] of Object.entries(incoming)) {
        const key = JOB_METHOD_KEY_BY_HEADING[normaliseHeading(heading)];
        if (key === undefined) {
          /**
           * An unmapped column is flagged, not dropped silently.
           *
           * It is usually somebody adding a column because the form did not ask what they needed
           * to say — which is feedback about the form rather than a mistake in the data, and the
           * only way anybody finds that out is if it surfaces here.
           */
          problems.push({
            kind: 'Unmapped',
            row: step,
            column: heading.slice(0, 120),
            detail:
              `Row ${step} has a column "${heading.slice(0, 60)}" that UBoss has no field for. ` +
              'Nothing from it was saved.',
          });
          continue;
        }
        cells[key] = value;
      }

      const read = readRow({ step, cells });
      parsed.push(read.row);
      problems.push(...read.problems);
    });

    // ---- stage 6 and 7: review, then merge into a draft only ----
    const accepted = mayMerge(problems);

    if (accepted) {
      await this.mergeRows(input.scope, jobMethod.id, parsed);
    }

    await this.recordImport(input.scope, {
      jobMethodId: jobMethod.id,
      actorUserId: input.actorUserId,
      filename: input.filename,
      contentHash,
      claimedFormVersion: JOB_METHOD_FORM_VERSION,
      stage: accepted ? 'MergeIntoDraft' : 'FlagProblems',
      accepted,
      refusedBecause: accepted
        ? null
        : 'Some rows could not be used as written. Nothing was saved — see the flagged problems.',
      problems,
      rowsRead: parsed.length,
      rowsAccepted: accepted ? parsed.length : 0,
    });

    return {
      accepted,
      stage: accepted ? 'MergeIntoDraft' : 'FlagProblems',
      problems,
      rows: accepted ? parsed : [],
      refusedBecause: accepted
        ? null
        : 'Some rows could not be used as written. Nothing was saved — see the flagged problems.',
      // The suggestion, so a builder sees how many agents this looks like before designing one.
      // A suggestion only: `suggestAgentGroups` never decides.
      agentSuggestion: accepted ? suggestAgentGroups(parsed) : null,
    };
  }

  /** What is captured so far, and how many agents it looks like. */
  async view(input: {
    scope: TenantScope;
    actorUserId: string;
    aiWorkAssignmentId: string;
  }): Promise<unknown> {
    const context = await this.authorization.contextFor(input.scope, input.actorUserId);
    await this.authorization.assertCan(context, { module: 'todo', action: 'View' });

    const jobMethod = await this.prisma.runInTenantTransaction(input.scope, () =>
      this.prisma.client.jobMethod.findFirst({
        where: { tenantId: input.scope.tenantId, aiWorkAssignmentId: input.aiWorkAssignmentId },
        select: {
          id: true,
          formVersion: true,
          rows: { orderBy: { step: 'asc' } },
          imports: { orderBy: { importedAt: 'desc' }, take: 10 },
        },
      }),
    );

    if (jobMethod === null) {
      return { captured: false, rows: [], imports: [], automationStance: AUTOMATION_STANCE };
    }

    const rows = jobMethod.rows.map((row) => toRow(row));

    return {
      captured: rows.length > 0,
      formVersion: jobMethod.formVersion,
      rows,
      provenance: Object.fromEntries(
        jobMethod.rows.map((row) => [row.step, row.provenance as Record<string, ValueSource>]),
      ),
      imports: jobMethod.imports.map((entry) => ({
        filename: entry.filename,
        stage: entry.stage,
        accepted: entry.accepted,
        refusedBecause: entry.refusedBecause,
        rowsRead: entry.rowsRead,
        rowsAccepted: entry.rowsAccepted,
        importedAt: entry.importedAt.toISOString(),
      })),
      agentSuggestion: rows.length > 0 ? suggestAgentGroups(rows) : null,
      automationStance: AUTOMATION_STANCE,
    };
  }

  // -------------------------------------------------------------------------
  // Internals
  // -------------------------------------------------------------------------

  private async mergeRows(
    scope: TenantScope,
    jobMethodId: string,
    rows: readonly JobMethodRow[],
  ): Promise<void> {
    await this.prisma.runInTenantTransaction(scope, async () => {
      /**
       * Replace rather than upsert row by row.
       *
       * A returned form is the company's complete statement of how the job is done, so a step they
       * deleted must disappear. Merging row by row would leave an orphaned step 7 from a previous
       * import sitting between the new 6 and 8, and nobody would notice until an agent was built
       * from it.
       */
      await this.prisma.client.jobMethodRow.deleteMany({ where: { jobMethodId } });

      for (const row of rows) {
        const provenance: Record<string, ValueSource> = {};
        for (const key of JOB_METHOD_COLUMN_KEYS) {
          if (key === 'step') continue;
          if (row[key] !== undefined) provenance[provenanceKey(row.step, key)] = 'UploadedForm';
        }

        await this.prisma.client.jobMethodRow.create({
          data: {
            tenantId: scope.tenantId,
            jobMethodId,
            step: row.step,
            whatExactWork: row.whatExactWork ?? null,
            inputExactInput: row.inputExactInput ?? null,
            whereInputSource: row.whereInputSource ?? null,
            toolSystemWorkplace: row.toolSystemWorkplace ?? null,
            howExactMethod: row.howExactMethod ?? null,
            ruleFormulaCheck: row.ruleFormulaCheck ?? null,
            output: row.output ?? null,
            outputDestination: row.outputDestination ?? null,
            approval: row.approval ?? null,
            agentMustNeverDo: row.agentMustNeverDo ?? null,
            ifMissingOrWrong: row.ifMissingOrWrong ?? null,
            time: row.time ?? null,
            provenance: provenance as never,
          },
        });
      }
    });
  }

  private async recordImport(
    scope: TenantScope,
    input: {
      jobMethodId: string;
      actorUserId: string;
      filename: string;
      contentHash: string;
      claimedFormVersion: number | null;
      stage: string;
      accepted: boolean;
      refusedBecause: string | null;
      problems: readonly ImportProblem[];
      rowsRead: number;
      rowsAccepted: number;
    },
  ): Promise<void> {
    await this.prisma.runInTenantTransaction(scope, async () => {
      await this.prisma.client.jobMethodImport.create({
        data: {
          tenantId: scope.tenantId,
          jobMethodId: input.jobMethodId,
          filename: input.filename.slice(0, 400),
          contentHash: input.contentHash,
          claimedFormVersion: input.claimedFormVersion,
          stage: input.stage,
          accepted: input.accepted,
          refusedBecause: input.refusedBecause,
          problems: input.problems as never,
          rowsRead: input.rowsRead,
          rowsAccepted: input.rowsAccepted,
          importedByUserId: input.actorUserId,
        },
      });

      await this.audit.appendWithinCurrentScope(scope.tenantId, {
        action: input.accepted ? 'agents.job_method_imported' : 'agents.job_method_import_refused',
        actorUserId: input.actorUserId,
        resourceType: 'job-method',
        resourceId: input.jobMethodId,
        summary: input.accepted
          ? `Imported ${input.rowsAccepted} rows from "${input.filename}" into the draft.`
          : `Refused "${input.filename}": ${input.refusedBecause ?? 'unusable'}`,
        metadata: {
          filename: input.filename.slice(0, 200),
          stage: input.stage,
          problems: input.problems.length,
        },
      });
    });
  }

  private async ensureJobMethod(
    scope: TenantScope,
    actorUserId: string,
    assignment: { id: string; objectiveVersionId: string },
  ): Promise<{ id: string }> {
    return this.prisma.runInTenantTransaction(scope, async () => {
      const existing = await this.prisma.client.jobMethod.findFirst({
        where: { tenantId: scope.tenantId, aiWorkAssignmentId: assignment.id },
        select: { id: true },
      });
      if (existing !== null) return existing;

      return this.prisma.client.jobMethod.create({
        data: {
          tenantId: scope.tenantId,
          aiWorkAssignmentId: assignment.id,
          objectiveVersionId: assignment.objectiveVersionId,
          formVersion: JOB_METHOD_FORM_VERSION,
          createdByUserId: actorUserId,
        },
        select: { id: true },
      });
    });
  }

  private async requireAssignment(
    scope: TenantScope,
    aiWorkAssignmentId: string,
  ): Promise<{
    id: string;
    title: string;
    objectiveId: string;
    objectiveVersionId: string;
    objectiveName: string;
    assignedToEmployeeRef: string | null;
    steps: { position: number; content: Record<string, unknown> }[];
  }> {
    const assignment = await this.prisma.runInTenantTransaction(scope, async () => {
      const row = await this.prisma.client.aiWorkAssignment.findFirst({
        where: { tenantId: scope.tenantId, id: aiWorkAssignmentId },
        select: {
          id: true,
          title: true,
          objectiveId: true,
          objectiveVersionId: true,
          engineAgentId: true,
        },
      });
      if (row === null) return null;

      const version = await this.prisma.client.objectiveVersion.findFirst({
        where: { tenantId: scope.tenantId, id: row.objectiveVersionId },
        select: {
          objectiveName: true,
          steps: { orderBy: { position: 'asc' } },
        },
      });

      /**
       * The employee reference, and what it deliberately is not.
       *
       * The company's own Employee ID, never a UBoss Unique ID and never an email. This file is
       * forwarded by email and filled in on somebody's laptop; a portable cross-company identifier
       * in it would travel with it, which is precisely what Prompt 37A was careful about.
       */
      const operator =
        row.engineAgentId === null
          ? null
          : await this.prisma.client.engineAgent.findFirst({
              where: { tenantId: scope.tenantId, id: row.engineAgentId },
              select: { builtForUserId: true },
            });

      const employeeRef =
        operator?.builtForUserId == null
          ? null
          : ((
              await this.prisma.client.employmentRecord.findFirst({
                where: { tenantId: scope.tenantId, userId: operator.builtForUserId },
                select: { employeeId: true },
              })
            )?.employeeId ?? null);

      return {
        id: row.id,
        title: row.title,
        objectiveId: row.objectiveId,
        objectiveVersionId: row.objectiveVersionId,
        objectiveName: version?.objectiveName ?? row.title,
        assignedToEmployeeRef: employeeRef,
        steps: (version?.steps ?? []).map((step) => ({
          position: step.position,
          content: step as unknown as Record<string, unknown>,
        })),
      };
    });

    if (assignment === null) {
      throw new NotFoundException('There is no such assigned AI work you can see.');
    }
    return assignment;
  }
}

/** A stored row back into the pure shape. */
function toRow(row: {
  step: number;
  whatExactWork: string | null;
  inputExactInput: string | null;
  whereInputSource: string | null;
  toolSystemWorkplace: string | null;
  howExactMethod: string | null;
  ruleFormulaCheck: string | null;
  output: string | null;
  outputDestination: string | null;
  approval: string | null;
  agentMustNeverDo: string | null;
  ifMissingOrWrong: string | null;
  time: string | null;
}): JobMethodRow {
  const out: JobMethodRow = { step: row.step };
  for (const key of JOB_METHOD_COLUMN_KEYS) {
    if (key === 'step') continue;
    const value = (row as unknown as Record<string, string | null>)[key];
    if (value !== null && value !== undefined) out[key] = value;
  }
  return out;
}

/**
 * Prefill from Form 2, and only where the two genuinely mean the same thing.
 *
 * `FORM2_PREFILL` is the map, and the five columns absent from it stay blank on purpose — they are
 * what the form is being sent out to collect.
 */
function prefillFromForm2(
  steps: readonly { position: number; content: Record<string, unknown> }[],
): JobMethodRow[] {
  if (steps.length === 0) {
    // One empty row rather than none, so somebody receiving a form for work with no recorded
    // workflow has something to write in.
    return [{ step: 1 }];
  }

  return steps.map((step, index) => {
    const row: JobMethodRow = { step: index + 1 };
    for (const [column, form2Field] of Object.entries(FORM2_PREFILL)) {
      const value = step.content[form2Field];
      if (typeof value === 'string' && value.trim() !== '') {
        row[column as Exclude<JobMethodColumnKey, 'step'>] = value;
      }
    }
    return row;
  });
}
