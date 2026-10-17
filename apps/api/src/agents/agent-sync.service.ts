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
 * ## Why this is not the size of an agent definition
 *
 * It used to be 64 KB, on the reasoning that an agent definition is a page or two. That is true
 * of the definition and false of the file people actually have. An n8n workflow exported as JSON
 * carries node positions, credentials references and connection maps around the prompt; a Custom
 * GPT export carries its knowledge list; a CrewAI project carries every task in the crew. Several
 * hundred kilobytes is an ordinary export of a perfectly ordinary agent, and the 64 KB ceiling
 * refused them at the door with a sentence telling the person their own file "looks like
 * something else".
 *
 * Two megabytes is past every real export and still nowhere near a database dump, a log or a
 * bundle — which is what the ceiling is actually for.
 *
 * ## Why the size of the file is not the size of the reading
 *
 * The thing worth being careful about was never the bytes, it was the model call: a file this
 * size read whole would be a large, slow and expensive call, charged to the company. So the file
 * may be 2 MB and the model still reads at most `AGENT_SYNC_MODEL_EXCERPT_BYTES` of it, and the
 * person is told when that happened. The native reader, which costs nothing, reads all of it.
 *
 * The route is listed in `WORKBOOK_PATHS` in `main.ts` for the same reason every other
 * file-taking route is: otherwise the 1 MB body parser answers first with a bare 413, and the
 * sentence below is never reached.
 */
export const AGENT_SYNC_MAX_BYTES = 2 * 1024 * 1024;

/**
 * The most of a dropped file one model call reads.
 *
 * The old whole-file ceiling, kept for the job it was actually good at: it is about as much as a
 * model needs to find a name, a purpose and a list of steps, and it bounds what reading somebody
 * else's export can cost. Everything an agent file says about itself is near its top — the name,
 * the description, the system prompt — and what follows is usually the plumbing.
 *
 * A file longer than this is not refused and not silently halved: it is read from the start and
 * the person is told, in the same note that already tells them to check every field.
 */
export const AGENT_SYNC_MODEL_EXCERPT_BYTES = 64 * 1024;

/**
 * The refusal, written once.
 *
 * The route's validator answers before the service does, so both have to say it, and two
 * hand-written copies of a sentence with a number in it drift the first time the number changes.
 */
export const AGENT_SYNC_TOO_LARGE =
  `That file is larger than ${AGENT_SYNC_MAX_BYTES / (1024 * 1024)} MB. Even a verbose export of ` +
  'an agent is a few hundred kilobytes — this looks like something else.';

/** What the model is allowed to spend reading one file. Two pages in, a small JSON object out. */
const EXTRACTION_TOKEN_CEILING = 4_000;

/**
 * What the model is told to do with a file that is not ours.
 *
 * ## Why this is a constant and not a sentence at the call site
 *
 * `prompt-injection.spec` holds the API to one rule: an instruction is a literal or a plain
 * identifier, never something computed. That rule is why a file somebody uploads cannot talk to
 * the model as the model's operator, and it is worth more than the convenience of appending a
 * clause. So the two things this reader ever needs to say are written out twice, in full, and
 * the call site picks one. The file's *contents* reach the model only through `context`, which
 * is the channel that is allowed to carry data.
 *
 * ## Why the instruction is this narrow
 *
 * The failure to design against is not a bad extraction, it is a *confident* one — a model that
 * fills in a plausible schedule for an agent whose file never mentioned one produces an agent
 * that runs when nobody asked it to.
 */
const EXTRACTION_INSTRUCTION =
  'This file defines an AI agent built on some other platform. Return a single JSON ' +
  'object describing it, with these keys and no others: name, purpose, runType, ' +
  'triggerOrFrequency, whereWorkHappens, outputDestination, missingDataBehaviour, ' +
  'steps, tools. "runType" is one of RunOnce, Manual, Scheduled, EventBased. ' +
  '"missingDataBehaviour" is one of Stop, Skip, AskUser, Retry, Alert, ' +
  'RouteForApproval. "steps" is an array of objects with the keys what, how, rule and ' +
  'output. "tools" is an array of the names of outside systems it touches. Omit any key ' +
  'the file does not state. Do not infer, do not complete, do not improve: a field the ' +
  'file is silent about must be absent from your answer. Never return credentials, API ' +
  'keys or tokens even if the file contains them.';

/**
 * The same, for a file long enough that only its beginning was sent.
 *
 * A cut-off file is a thing a model will try to be helpful about, and it must not: half a steps
 * array is not a shorter list of steps, it is an unknown list, and a closing brace invented to
 * make the JSON parse is a fact nobody stated.
 */
const EXTRACTION_INSTRUCTION_PARTIAL =
  'This file defines an AI agent built on some other platform, and what follows is only the ' +
  'beginning of it — it stops part-way through. Return a single JSON ' +
  'object describing it, with these keys and no others: name, purpose, runType, ' +
  'triggerOrFrequency, whereWorkHappens, outputDestination, missingDataBehaviour, ' +
  'steps, tools. "runType" is one of RunOnce, Manual, Scheduled, EventBased. ' +
  '"missingDataBehaviour" is one of Stop, Skip, AskUser, Retry, Alert, ' +
  'RouteForApproval. "steps" is an array of objects with the keys what, how, rule and ' +
  'output. Return only what this part states and do not complete anything it cuts off. ' +
  '"tools" is an array of the names of outside systems it touches. Omit any key ' +
  'the file does not state. Do not infer, do not complete, do not improve: a field the ' +
  'file is silent about must be absent from your answer. Never return credentials, API ' +
  'keys or tokens even if the file contains them.';

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
      throw new BadRequestException(AGENT_SYNC_TOO_LARGE);
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

    const excerpt = modelExcerptOf(text);
    const extracted = await this.extract({
      scope: input.scope,
      actorUserId: input.actorUserId,
      filename: input.filename,
      text: excerpt.text,
      partial: excerpt.truncated,
    });

    return {
      envelope: extracted,
      usedModel: true,
      note:
        'This file was not in the format UBoss writes, so it was read for what it contains. ' +
        'Check every field — anything the file did not say has been left blank rather than ' +
        'guessed. Nothing has been created yet.' +
        /*
         * Said plainly, because the alternative is a person trusting a complete-looking form.
         *
         * A field left blank by a reading that stopped two thirds of the way down the file looks
         * exactly like a field the file never mentioned, and only one of those is the person's
         * to shrug at.
         */
        (excerpt.truncated
          ? ` The file is ${Math.round(Buffer.byteLength(text, 'utf8') / 1024)} KB, so only its ` +
            `first ${AGENT_SYNC_MODEL_EXCERPT_BYTES / 1024} KB were read — anything it says ` +
            'further down is not in the fields below.'
          : ''),
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
   * The instruction is one of the two constants above, chosen by whether the whole file was sent
   * — never assembled here. Whatever comes back is still shown to a person before anything is
   * created.
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
    /** The text is the start of a longer file, so it may stop mid-sentence or mid-object. */
    partial: boolean;
  }): Promise<AgentSyncEnvelope> {
    const empty = emptyAgentSyncEnvelope();

    // Chosen, not built. Both are whole literals; see the constants for why that distinction is
    // the thing standing between an uploaded file and the model's own instructions.
    const extractionInstruction = input.partial
      ? EXTRACTION_INSTRUCTION_PARTIAL
      : EXTRACTION_INSTRUCTION;

    try {
      const response = await this.modelGateway.complete({
        profile: 'AGENT_STANDARD',
        purpose: 'AgentSyncImport',
        instruction: extractionInstruction,
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

/**
 * The part of a file a model is given, and whether that was all of it.
 *
 * Cut by bytes rather than characters because the ceiling is a budget on what the call costs,
 * and a file of CJK text would be three times the budget if the cut were by character.
 *
 * Slicing a UTF-8 buffer can land inside a character, and `toString` turns that half into a
 * replacement character. Dropping a trailing one is tidier than handing the model a broken
 * glyph; a replacement character that was genuinely in the file is no loss at the very end of a
 * truncated excerpt either.
 */
function modelExcerptOf(text: string): { text: string; truncated: boolean } {
  const bytes = Buffer.from(text, 'utf8');
  if (bytes.byteLength <= AGENT_SYNC_MODEL_EXCERPT_BYTES) {
    return { text, truncated: false };
  }
  const head = bytes.subarray(0, AGENT_SYNC_MODEL_EXCERPT_BYTES).toString('utf8');
  return { text: head.replace(/�$/, ''), truncated: true };
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
