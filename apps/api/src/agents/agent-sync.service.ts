import { BadRequestException, Injectable, Logger } from '@nestjs/common';

import {
  agentSyncIsCreatable,
  emptyAgentSyncEnvelope,
  JOB_METHOD_CELL_MAX,
  JOB_METHOD_MAX_ROWS,
  missingAgentSyncFields,
  parseAgentMarkdown,
  type AgentExecutionSetup,
  type AgentSyncEnvelope,
  type AgentSyncStep,
  type JobMethodRow,
} from '@uboss/types';

import { ModelGateway } from '../model-gateway/model-gateway.js';
import type { TenantScope } from '../persistence/tenant-context.js';
import { AgentBuilderService } from './agent-builder.service.js';
import { JobMethodService } from './job-method.service.js';

/**
 * The most a dropped file may be.
 *
 * An agent definition is a page or two; this is roughly twenty. Past that it is somebody
 * dropping the wrong thing — a database export, a log, a bundle — and reading it would cost a
 * model call to discover that.
 *
 * Deliberately well under the 1 MB an ordinary route accepts, so the refusal is this sentence
 * rather than the body parser's bare 413. A person who dropped the wrong file should be told
 * which file was wrong and why, not handed a status code.
 */
export const AGENT_SYNC_MAX_BYTES = 64 * 1024;

/** What the model is allowed to spend reading one file. Two pages in, a small JSON object out. */
const EXTRACTION_TOKEN_CEILING = 4_000;

/**
 * Bringing in an agent that was built somewhere else — CR-05.
 *
 * ## Two readers, one answer
 *
 * A file written by UBoss is read by `parseAgentMarkdown`, which costs nothing and cannot be
 * wrong about a format it defines. Anything else — a Custom GPT's JSON, an n8n workflow, a
 * CrewAI crew's YAML, a plain prompt somebody pasted into a text file — is read by one model
 * call. Both produce the same envelope, and everything after this point knows only the envelope.
 *
 * The native reader runs first and the model only sees what it could not understand. A company
 * importing fifty of its own agents therefore spends nothing.
 *
 * ## Reading never writes
 *
 * `read` returns what the file says and creates nothing at all — not a draft, not an agent, not
 * a placeholder. That is the same decision the objective workbook made for the same reason: a
 * person has to see what was understood before any of it becomes a record, and an endpoint that
 * *cannot* write is a stronger promise than one that chooses not to.
 *
 * ## Creating goes the ordinary way
 *
 * `create` calls the same `createStandalone` the "Create Custom Agent" button calls, then the
 * same `saveSetup` and the same job-method save. No rule is reimplemented here: the name clash,
 * the Skill routing, the readiness findings and — since CR-04 — the Head's approval all behave
 * exactly as they do for an agent somebody typed in by hand. An import that could skip any of
 * those would be a way of getting an unreviewed agent into a company by uploading a file.
 */
@Injectable()
export class AgentSyncService {
  private readonly logger = new Logger(AgentSyncService.name);

  constructor(
    private readonly builder: AgentBuilderService,
    private readonly jobMethods: JobMethodService,
    private readonly modelGateway: ModelGateway,
  ) {}

  /**
   * Read a dropped file. Writes nothing.
   *
   * `usedModel` travels with the answer because it changes what the reader should trust: a native
   * parse is exact, and an extraction is a reading of prose that deserves a look before it is
   * confirmed.
   */
  async read(input: {
    scope: TenantScope;
    actorUserId: string;
    filename: string;
    content: string;
  }): Promise<{ envelope: AgentSyncEnvelope; usedModel: boolean; note: string }> {
    const text = input.content;
    if (text.trim() === '') {
      throw new BadRequestException('That file is empty, so there is no agent in it to read.');
    }
    if (Buffer.byteLength(text, 'utf8') > AGENT_SYNC_MAX_BYTES) {
      throw new BadRequestException(
        `That file is larger than ${Math.round(AGENT_SYNC_MAX_BYTES / 1024)} KB. An agent ` +
          'definition is a page or two — this looks like something else.',
      );
    }

    const native = parseAgentMarkdown(text);
    if (agentSyncIsCreatable(native)) {
      return {
        envelope: native,
        usedModel: false,
        note:
          'Read directly: this file is in the format UBoss writes. Nothing has been created — ' +
          'check what it says and create the agent when it is right.',
      };
    }

    const extracted = await this.extract({
      scope: input.scope,
      actorUserId: input.actorUserId,
      filename: input.filename,
      text,
    });

    return {
      envelope: extracted,
      usedModel: true,
      note:
        'This file was not in the format UBoss writes, so it was read for what it contains. ' +
        'Check every field — anything the file did not say has been left blank rather than ' +
        'guessed. Nothing has been created yet.',
    };
  }

  /**
   * Create the agent from the envelope a person confirmed.
   *
   * The envelope, not the file: whatever the reader understood, what is created is what the
   * person signed off on screen. A file that is read wrongly and corrected by hand produces the
   * right agent, and nothing is created from a reading nobody looked at.
   */
  async create(input: {
    scope: TenantScope;
    actorUserId: string;
    envelope: AgentSyncEnvelope;
  }): Promise<{ assignmentId: string; stepsSaved: number }> {
    const envelope = input.envelope;

    if (!agentSyncIsCreatable(envelope)) {
      throw new BadRequestException(
        'An agent needs a name and a sentence saying what it is for. Fill those in and create ' +
          'it — the rest can be answered on the builder screen.',
      );
    }
    if (envelope.steps.length > JOB_METHOD_MAX_ROWS) {
      throw new BadRequestException(
        `That file has ${envelope.steps.length} steps and the limit is ${JOB_METHOD_MAX_ROWS}. ` +
          'A job with more than that is more than one job.',
      );
    }

    // The same call the "Create Custom Agent" button makes. The name clash, the Skill routing and
    // the audit entry are that method's, not a second copy of them here.
    const created = await this.builder.createStandalone({
      scope: input.scope,
      actorUserId: input.actorUserId,
      name: envelope.name.trim(),
      purpose: envelope.purpose.trim(),
    });

    const assignmentId = created.assignmentId;

    /*
     * Only what the file actually said.
     *
     * `saveSetup` takes a patch and drops absent keys, so a field the file was silent about stays
     * unanswered and the builder goes on asking for it. Sending a null would answer it, badly:
     * "this file did not mention a schedule" and "this agent has no schedule" are different
     * facts, and only the second is the company's to state.
     */
    const patch: Partial<AgentExecutionSetup> = {};
    if (envelope.runType !== null) patch.runType = envelope.runType;
    if (notBlank(envelope.triggerOrFrequency)) {
      patch.triggerOrFrequency = envelope.triggerOrFrequency.trim();
    }
    if (notBlank(envelope.whereWorkHappens)) {
      patch.whereWorkHappens = envelope.whereWorkHappens.trim();
    }
    if (notBlank(envelope.outputDestination)) {
      patch.outputDestination = envelope.outputDestination.trim();
    }
    if (envelope.missingDataBehaviour !== null) {
      patch.missingDataBehaviour = envelope.missingDataBehaviour;
    }

    if (Object.keys(patch).length > 0) {
      await this.builder.saveSetup({
        scope: input.scope,
        actorUserId: input.actorUserId,
        assignmentId,
        patch,
      });
    }

    let stepsSaved = 0;
    if (envelope.steps.length > 0) {
      const rows = envelope.steps.map((step, index) => this.rowOf(step, index, envelope));
      const saved = await this.jobMethods.saveRows({
        scope: input.scope,
        actorUserId: input.actorUserId,
        aiWorkAssignmentId: assignmentId,
        rows,
      });
      stepsSaved = saved.saved;
    }

    return { assignmentId, stepsSaved };
  }

  /**
   * One step of the file as one row of the Job Method.
   *
   * This is where an imported system prompt actually lands. A prompt's "do this, in this way,
   * subject to this rule" maps onto *WHAT — Exact Work*, *HOW — Exact Method* and
   * *Rule / Formula / Check*, which is the same sentence written so that a reviewer can argue
   * with one line of it rather than with two pages of prose.
   *
   * The output destination falls back to the agent's own, because a file that states it once at
   * the top means it for every step — repeating it per row is a thing people do not write down.
   */
  private rowOf(step: AgentSyncStep, index: number, envelope: AgentSyncEnvelope): JobMethodRow {
    const cell = (value: string | null | undefined) => {
      if (value === null || value === undefined) return undefined;
      const trimmed = value.trim();
      if (trimmed === '') return undefined;
      return trimmed.length > JOB_METHOD_CELL_MAX ? trimmed.slice(0, JOB_METHOD_CELL_MAX) : trimmed;
    };

    return {
      step: index + 1,
      ...maybe('whatExactWork', cell(step.what)),
      ...maybe('howExactMethod', cell(step.how)),
      ...maybe('ruleFormulaCheck', cell(step.rule)),
      ...maybe('output', cell(step.output)),
      ...maybe('toolSystemWorkplace', cell(envelope.whereWorkHappens)),
      ...maybe('outputDestination', cell(step.output ? null : envelope.outputDestination)),
    };
  }

  /**
   * Read a file that is not ours, with one model call.
   *
   * The instruction is deliberately narrow: pull out six named things and say nothing else. The
   * failure to design against is not a bad extraction, it is a *confident* one — a model that
   * fills in a plausible schedule for an agent whose file never mentioned one produces an agent
   * that runs when nobody asked it to. So the instruction says to leave a field out rather than
   * infer it, and whatever comes back is still shown to a person before anything is created.
   *
   * A failed or unreadable answer is not an error. It returns an empty envelope with every field
   * listed as not found, and the person fills the form in themselves — which is exactly the
   * "Create Custom Agent" path they would have used anyway.
   */
  private async extract(input: {
    scope: TenantScope;
    actorUserId: string;
    filename: string;
    text: string;
  }): Promise<AgentSyncEnvelope> {
    const empty = emptyAgentSyncEnvelope();

    try {
      const response = await this.modelGateway.complete({
        profile: 'AGENT_STANDARD',
        purpose: 'AgentSyncImport',
        instruction:
          'This file defines an AI agent built on some other platform. Return a single JSON ' +
          'object describing it, with these keys and no others: name, purpose, runType, ' +
          'triggerOrFrequency, whereWorkHappens, outputDestination, missingDataBehaviour, ' +
          'steps, tools. "runType" is one of RunOnce, Manual, Scheduled, EventBased. ' +
          '"missingDataBehaviour" is one of Stop, Skip, AskUser, Retry, Alert, ' +
          'RouteForApproval. "steps" is an array of objects with the keys what, how, rule and ' +
          'output. "tools" is an array of the names of outside systems it touches. Omit any key ' +
          'the file does not state. Do not infer, do not complete, do not improve: a field the ' +
          'file is silent about must be absent from your answer. Never return credentials, API ' +
          'keys or tokens even if the file contains them.',
        context: `Filename: ${input.filename}\n\n${input.text}`,
        maxTokens: EXTRACTION_TOKEN_CEILING,
        tenantId: input.scope.tenantId,
        actorUserId: input.actorUserId,
      });

      const parsed = readJsonObject(response.output);
      if (parsed === null) {
        empty.notFound = missingAgentSyncFields(empty);
        return empty;
      }

      // Through the Markdown reader's own vocabulary helpers, by writing what the model said
      // back as front-matter: one place decides what "on demand" and "halt" mean, rather than
      // two that drift.
      const envelope = parseAgentMarkdown(frontMatterFrom(parsed));
      envelope.steps = readSteps(parsed['steps']);
      envelope.notFound = missingAgentSyncFields(envelope);
      return envelope;
    } catch (caught) {
      /*
       * A reading that failed is not an import that failed.
       *
       * The model being unavailable, over budget or slow must not stop somebody bringing their
       * agent in. They get the form with the fields blank, which is the screen they would have
       * used before this feature existed.
       */
      this.logger.warn(
        `Could not read ${input.filename} with a model: ${
          caught instanceof Error ? caught.message : String(caught)
        }`,
      );
      empty.notFound = missingAgentSyncFields(empty);
      return empty;
    }
  }
}

/** A key written only when there is something to write, for `exactOptionalPropertyTypes`. */
function maybe(key: keyof JobMethodRow, value: string | undefined): Partial<JobMethodRow> {
  return value === undefined ? {} : { [key]: value };
}

function notBlank(value: string | null): value is string {
  return value !== null && value.trim() !== '';
}

/**
 * The JSON object in a model's answer, or null.
 *
 * Tolerant of the two things models do to JSON — wrapping it in a fenced code block, and saying
 * a sentence before it — because refusing over a fence would throw away a correct reading.
 */
function readJsonObject(output: string): Record<string, unknown> | null {
  const fenced = output.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const candidate = fenced?.[1] ?? output;
  const start = candidate.indexOf('{');
  const end = candidate.lastIndexOf('}');
  if (start < 0 || end <= start) return null;

  try {
    const parsed: unknown = JSON.parse(candidate.slice(start, end + 1));
    return typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

/** The extracted fields as front-matter, so the Markdown reader's vocabulary handling is reused. */
function frontMatterFrom(parsed: Record<string, unknown>): string {
  const text = (key: string): string | null => {
    const value = parsed[key];
    return typeof value === 'string' && value.trim() !== '' ? value.trim() : null;
  };

  const tools = Array.isArray(parsed['tools'])
    ? parsed['tools'].filter((entry): entry is string => typeof entry === 'string').join(', ')
    : null;

  const lines = [
    ['name', text('name')],
    ['purpose', text('purpose')],
    ['run_type', text('runType')],
    ['trigger', text('triggerOrFrequency')],
    ['runs_in', text('whereWorkHappens')],
    ['output_to', text('outputDestination')],
    ['if_data_missing', text('missingDataBehaviour')],
    ['tools', tools],
  ]
    // A newline inside a value would end the front-matter line and swallow the rest, so values
    // are flattened to one line before they are written.
    .filter((entry): entry is [string, string] => entry[1] !== null)
    .map(([key, value]) => `${key}: ${value.replace(/\s*\n\s*/g, ' ')}`);

  return `---\n${lines.join('\n')}\n---\n`;
}

/** The steps a model returned, keeping only what each row actually says. */
function readSteps(value: unknown): AgentSyncStep[] {
  if (!Array.isArray(value)) return [];

  const steps: AgentSyncStep[] = [];
  for (const entry of value.slice(0, JOB_METHOD_MAX_ROWS)) {
    const text = (key: string): string | null => {
      if (typeof entry !== 'object' || entry === null) return null;
      const held = (entry as Record<string, unknown>)[key];
      return typeof held === 'string' && held.trim() !== '' ? held.trim() : null;
    };

    // A step with no "what" is not a step. Dropping it is better than a blank row somebody has
    // to notice and delete.
    const what = typeof entry === 'string' ? entry.trim() : text('what');
    if (what === null || what === '') continue;

    steps.push({ what, how: text('how'), rule: text('rule'), output: text('output') });
  }

  return steps;
}
