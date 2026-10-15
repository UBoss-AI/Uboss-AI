import {
  AGENT_RUN_TYPES,
  MISSING_DATA_BEHAVIOURS,
  type AgentRunType,
  type MissingDataBehaviour,
} from './agents.js';

/**
 * Bringing in an agent that was built somewhere else — CR-05.
 *
 * ## The problem this solves
 *
 * A company arrives with agents already running: a Custom GPT, an n8n workflow, a CrewAI crew, a
 * Claude subagent. They want them here, and what they can hand over is a file. The client's words:
 * *"kahin cloud me unke agent chal rahe hain… jo file milega agent ke liye, bas yahan drag and
 * drop kare, uske baad agent ban ke taiyar ho jaye."*
 *
 * ## Why there is no format to support
 *
 * Every platform exports its own shape and none of them agree: Claude writes Markdown with YAML
 * front-matter, GPTs and Assistants write JSON, n8n writes a node graph, Dify and CrewAI write
 * YAML, LangChain writes source code. Waiting for "their format" is waiting for a thing that does
 * not exist.
 *
 * What *is* common is the content. Every one of those files carries a name, a sentence about what
 * the agent is for, a block of instructions, a list of tools, and usually a trigger and some
 * steps. So this is the shape all of them are read into, and everything downstream speaks only
 * this.
 *
 * ## What a file is never allowed to bring
 *
 * **Skills**, because a Skill is an approved capability and a file that could author one would be
 * a way to put unreviewed capability into a company. The router matches a Skill from the work
 * itself, exactly as it does for an agent created by hand.
 *
 * **Credentials**, because every platform above stores them by reference rather than by value,
 * and because a connection is an administrator's decision with its own approval. A file may say
 * *that* an agent touches SAP; it may not say how to sign in to it.
 *
 * A file brings content. It does not bring authority.
 */
export interface AgentSyncEnvelope {
  /** What the agent is called. Checked against the company's agents before anything is created. */
  name: string;
  /** One sentence: what this agent is for. Becomes the work the Skill router is matched against. */
  purpose: string;
  /** Once, on demand, on a schedule, or on an event. Null when the file did not say. */
  runType: AgentRunType | null;
  /** The schedule or the event, in the file's own words. Only meaningful for the last two kinds. */
  triggerOrFrequency: string | null;
  /** The approved system or workspace the work happens in. */
  whereWorkHappens: string | null;
  /** Where the result has to be delivered. */
  outputDestination: string | null;
  /** What to do when something it needs is missing. */
  missingDataBehaviour: MissingDataBehaviour | null;
  /** The procedure, one row per step. Becomes the Job Method grid. */
  steps: AgentSyncStep[];
  /**
   * The outside systems the file says this agent touches, in its own words.
   *
   * Carried so a person can see what it will need, and deliberately **not** turned into a
   * connection: naming a system is not being granted access to it.
   */
  tools: string[];
  /**
   * The fields the file did not contain, by name.
   *
   * The reason this exists rather than leaving them null and silent: a person confirming an
   * import has to be able to tell "the file said nothing about this" from "the file said this and
   * it was read wrong". Those are different mistakes and they are fixed differently.
   */
  notFound: AgentSyncField[];
}

/**
 * One step of the procedure.
 *
 * `how` and `rule` are where an imported system prompt actually lands. UBoss's Job Method grid
 * carries *HOW — Exact Method* and *Rule / Formula / Check* columns, which is the structured form
 * of what a prompt says in prose — so the translation keeps the instruction rather than dropping
 * it, and puts it where somebody can review it line by line.
 */
export interface AgentSyncStep {
  /** What is done. The one field a step cannot be without. */
  what: string;
  /** How it is done — the instruction, in the file's own words. */
  how: string | null;
  /** A rule, formula or check that governs the step. */
  rule: string | null;
  /** What the step produces. */
  output: string | null;
}

export const AGENT_SYNC_FIELDS = [
  'name',
  'purpose',
  'runType',
  'triggerOrFrequency',
  'whereWorkHappens',
  'outputDestination',
  'missingDataBehaviour',
  'steps',
  'tools',
] as const;
export type AgentSyncField = (typeof AGENT_SYNC_FIELDS)[number];

/** What each field is called on the confirmation screen, so one wording serves both sides. */
export const AGENT_SYNC_FIELD_LABELS: Record<AgentSyncField, string> = {
  name: 'Agent name',
  purpose: 'What it is for',
  runType: 'How it runs',
  triggerOrFrequency: 'When it runs',
  whereWorkHappens: 'Where the work happens',
  outputDestination: 'Where the result goes',
  missingDataBehaviour: 'If something it needs is missing',
  steps: 'Steps',
  tools: 'Outside systems it touches',
};

/** An envelope with nothing in it, so no caller has to remember the keys. */
export function emptyAgentSyncEnvelope(): AgentSyncEnvelope {
  return {
    name: '',
    purpose: '',
    runType: null,
    triggerOrFrequency: null,
    whereWorkHappens: null,
    outputDestination: null,
    missingDataBehaviour: null,
    steps: [],
    tools: [],
    notFound: [],
  };
}

/**
 * Which fields of this envelope are empty.
 *
 * Computed rather than trusted from the parser, so a hand-built envelope and a parsed one are
 * described by the same rule — and so editing a field on the confirmation screen takes it off the
 * list without anybody having to remember to.
 */
export function missingAgentSyncFields(envelope: AgentSyncEnvelope): AgentSyncField[] {
  const blank = (value: string | null) => value === null || value.trim() === '';

  const missing: AgentSyncField[] = [];
  if (blank(envelope.name)) missing.push('name');
  if (blank(envelope.purpose)) missing.push('purpose');
  if (envelope.runType === null) missing.push('runType');
  if (blank(envelope.triggerOrFrequency)) missing.push('triggerOrFrequency');
  if (blank(envelope.whereWorkHappens)) missing.push('whereWorkHappens');
  if (blank(envelope.outputDestination)) missing.push('outputDestination');
  if (envelope.missingDataBehaviour === null) missing.push('missingDataBehaviour');
  if (envelope.steps.length === 0) missing.push('steps');
  if (envelope.tools.length === 0) missing.push('tools');

  return missing;
}

/**
 * Can this be created as it stands?
 *
 * Only a name and a purpose. Everything else is a question the builder already knows how to ask,
 * and refusing the import because a file did not mention a schedule would send somebody back to
 * edit a file when the screen in front of them has the field on it.
 */
export function agentSyncIsCreatable(envelope: AgentSyncEnvelope): boolean {
  return envelope.name.trim() !== '' && envelope.purpose.trim() !== '';
}

// ---------------------------------------------------------------------------
// Reading UBoss's own format
// ---------------------------------------------------------------------------

/**
 * The Markdown an agent exported *from* UBoss is written in, and the one shape read without a
 * model call.
 *
 * Front-matter for the facts, `## Steps` for the procedure. It is deliberately the Claude
 * subagent shape — front-matter plus a body — because that is the one export format in the field
 * that is already Markdown, so a file from there often parses here with no translation at all.
 *
 * Read with a hand-written parser rather than a YAML library on purpose: the front-matter this
 * accepts is flat `key: value` pairs and nothing else, so there is no document model to attack,
 * no anchors, no tags, and no dependency. A file richer than that falls through to the model
 * reader, which is where arbitrary files are supposed to go anyway.
 */
export function parseAgentMarkdown(source: string): AgentSyncEnvelope {
  const envelope = emptyAgentSyncEnvelope();
  const text = source.replace(/\r\n/g, '\n');

  const frontMatter = text.match(/^---\n([\s\S]*?)\n---\n?/);
  const fields = new Map<string, string>();

  if (frontMatter) {
    for (const line of frontMatter[1]!.split('\n')) {
      const at = line.indexOf(':');
      if (at <= 0) continue;
      const key = line.slice(0, at).trim().toLowerCase();
      const value = line
        .slice(at + 1)
        .trim()
        .replace(/^["']|["']$/g, '');
      if (key !== '' && value !== '') fields.set(key, value);
    }
  }

  envelope.name = fields.get('name') ?? '';
  envelope.purpose = fields.get('purpose') ?? fields.get('description') ?? '';
  envelope.triggerOrFrequency = fields.get('trigger') ?? fields.get('schedule') ?? null;
  envelope.whereWorkHappens = fields.get('runs_in') ?? fields.get('where') ?? null;
  envelope.outputDestination = fields.get('output_to') ?? fields.get('output') ?? null;
  envelope.runType = readRunType(fields.get('run_type') ?? fields.get('runs') ?? null);
  envelope.missingDataBehaviour = readMissingDataBehaviour(
    fields.get('if_data_missing') ?? fields.get('on_missing_data') ?? null,
  );

  const tools = fields.get('tools') ?? fields.get('uses') ?? '';
  envelope.tools = tools
    .replace(/^\[|\]$/g, '')
    .split(',')
    .map((entry) => entry.trim())
    .filter((entry) => entry !== '');

  /*
   * A run type the file did not state, inferred from the trigger it did.
   *
   * Not a guess about the agent: "trigger: daily at 9am" *is* a schedule, and asking somebody to
   * restate it in a dropdown after they wrote it in the file is the sort of question the
   * zero-question rule exists to remove. Nothing is inferred when the file is silent.
   */
  if (envelope.runType === null && envelope.triggerOrFrequency !== null) {
    envelope.runType = /every|daily|weekly|monthly|hourly|cron|at \d|am\b|pm\b/i.test(
      envelope.triggerOrFrequency,
    )
      ? 'Scheduled'
      : 'EventBased';
  }

  envelope.steps = readMarkdownSteps(text.slice(frontMatter?.[0]?.length ?? 0));
  envelope.notFound = missingAgentSyncFields(envelope);
  return envelope;
}

/**
 * The steps under a `## Steps` heading, or the numbered list anywhere in the body.
 *
 * Both, because a file written for UBoss has the heading and a file from somewhere else usually
 * does not — and a numbered list in an agent's instructions is its procedure whether or not
 * anybody labelled it one.
 */
function readMarkdownSteps(body: string): AgentSyncStep[] {
  /*
   * Ends at the next heading or at the end of the file — and `(?![\s\S])` is how "end of file"
   * is written here rather than `$`.
   *
   * `m` is needed so `^##+` finds a heading on its own line, and under `m` a `$` matches at the
   * end of *every* line. A lazy body therefore stopped at the first newline it reached, and the
   * section came back holding one step out of three.
   */
  const section = body.match(
    /^##+[ \t]*(?:steps|procedure|tasks)[ \t]*\n([\s\S]*?)(?=\n##+[ \t]|(?![\s\S]))/im,
  );
  const searched = section?.[1] ?? body;

  const steps: AgentSyncStep[] = [];
  for (const line of searched.split('\n')) {
    const bullet = line.match(/^\s*(?:\d+[.)]|[-*])\s+(.*\S)\s*$/);
    if (!bullet) continue;

    /*
     * "Do the thing — because of the rule" is one step with a reason, not two steps.
     *
     * An em dash, a colon or a bracket is how people write the *how* beside the *what*, and
     * keeping them together in one cell would put an instruction where a reviewer is reading a
     * list of actions.
     */
    const whole = bullet[1]!;
    const split = whole.match(/^(.*?)\s+[—–:]\s+(.*)$/);
    steps.push({
      what: (split?.[1] ?? whole).trim(),
      how: split?.[2]?.trim() ?? null,
      rule: null,
      output: null,
    });
  }

  return steps;
}

/** A run type the file named, in whatever words, or null. */
function readRunType(value: string | null): AgentRunType | null {
  if (value === null) return null;
  const said = value
    .trim()
    .toLowerCase()
    .replace(/[\s_-]/g, '');

  for (const kind of AGENT_RUN_TYPES) {
    if (kind.toLowerCase() === said) return kind;
  }
  if (said === 'once') return 'RunOnce';
  if (said === 'ondemand' || said === 'manually') return 'Manual';
  if (said === 'schedule' || said === 'cron' || said === 'recurring') return 'Scheduled';
  if (said === 'event' || said === 'webhook' || said === 'trigger') return 'EventBased';
  return null;
}

/** A missing-data rule the file named, or null. Never defaulted: the company owns this choice. */
function readMissingDataBehaviour(value: string | null): MissingDataBehaviour | null {
  if (value === null) return null;
  const said = value
    .trim()
    .toLowerCase()
    .replace(/[\s_-]/g, '');

  for (const kind of MISSING_DATA_BEHAVIOURS) {
    if (kind.toLowerCase() === said) return kind;
  }
  if (said === 'halt' || said === 'abort') return 'Stop';
  if (said === 'ignore' || said === 'continue') return 'Skip';
  if (said === 'ask' || said === 'askhuman' || said === 'prompt') return 'AskUser';
  if (said === 'tryagain') return 'Retry';
  if (said === 'notify' || said === 'warn') return 'Alert';
  if (said === 'approval' || said === 'escalate') return 'RouteForApproval';
  return null;
}
