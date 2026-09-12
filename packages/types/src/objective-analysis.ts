import type { StepApprovalKind } from './objectives.js';

/**
 * Objective AI analysis — the workflow draft, as a versioned schema.
 *
 * ## Why the schema carries its own version
 *
 * The prompt requires a **versioned JSON schema** for the analysis draft, and the reason is not
 * bookkeeping: a stored draft outlives the code that produced it. An objective analysed today and
 * opened in six months must either be readable or be refused *knowingly* — never
 * mis-interpreted by a reader that assumes a shape the writer never used. `ANALYSIS_SCHEMA_VERSION`
 * is stamped into every draft and checked on every read.
 *
 * ## The output is always a Draft
 *
 * Nothing in this file can produce a published anything. The analysis proposes a plan; a person
 * reviews it, approves it and publishes it through the Prompt 20 path. That is the client's rule
 * and it is why there is no `status` on a draft at all — the draft is not a lifecycle participant,
 * the *objective version* is.
 */

// ---------------------------------------------------------------------------
// Progress stages
// ---------------------------------------------------------------------------

/**
 * The client's seven stages, in order.
 *
 * Named exactly as the prompt names them. The approved UI shows this list with a marker per stage,
 * and the reference is explicit that the progress is **real** — "no fake completion". So a stage
 * is marked done when the work it names has actually finished, and the list is stored on the run
 * rather than animated on the client.
 */
export const ANALYSIS_STAGES = [
  'UnderstandingObjective',
  'ReadingTeamStructure',
  'DetectingHumanWork',
  'IdentifyingAiWork',
  'MatchingSkills',
  'AssigningOwners',
  'BuildingWorkflow',
] as const;
export type AnalysisStage = (typeof ANALYSIS_STAGES)[number];

export const ANALYSIS_STAGE_LABELS: Record<AnalysisStage, string> = {
  UnderstandingObjective: 'Understanding objective',
  ReadingTeamStructure: 'Reading team structure',
  DetectingHumanWork: 'Detecting human work',
  IdentifyingAiWork: 'Identifying AI work',
  MatchingSkills: 'Matching skills',
  AssigningOwners: 'Assigning owners',
  BuildingWorkflow: 'Building workflow',
};

export function analysisStageIndex(stage: AnalysisStage): number {
  return ANALYSIS_STAGES.indexOf(stage);
}

/**
 * A run's state.
 *
 * `Cancelled` is separate from `Failed` because they mean opposite things about the product: a
 * cancellation is somebody choosing to stop, a failure is the product not working. Collapsing them
 * would make "how often does analysis fail" unanswerable.
 */
export const ANALYSIS_RUN_STATUSES = [
  'Queued',
  'Running',
  'Completed',
  'Cancelled',
  'Failed',
] as const;
export type AnalysisRunStatus = (typeof ANALYSIS_RUN_STATUSES)[number];

export const ANALYSIS_RUN_STATUS_LABELS: Record<AnalysisRunStatus, string> = {
  Queued: 'Queued',
  Running: 'Running',
  Completed: 'Workflow draft ready',
  Cancelled: 'Cancelled',
  Failed: 'Failed',
};

export const ANALYSIS_RUN_STATUS_TONES: Record<AnalysisRunStatus, string> = {
  Queued: 'grey',
  Running: 'cyan',
  Completed: 'success',
  Cancelled: 'grey',
  Failed: 'danger',
};

export const TERMINAL_ANALYSIS_STATUSES = ['Completed', 'Cancelled', 'Failed'] as const;

export function isAnalysisRunFinished(status: AnalysisRunStatus): boolean {
  return (TERMINAL_ANALYSIS_STATUSES as readonly AnalysisRunStatus[]).includes(status);
}

/** A run may only be cancelled while it is still going. */
export function mayCancelAnalysis(status: AnalysisRunStatus): boolean {
  return status === 'Queued' || status === 'Running';
}

// ---------------------------------------------------------------------------
// Node kinds and their shapes
// ---------------------------------------------------------------------------

/**
 * What a node in the workflow draft is.
 *
 * `Condition` is separate from `Approval`: an approval is a person deciding, a condition is a rule
 * being evaluated. The prompt lists both, and treating a condition as an approval would put a
 * human gate where the plan intended a branch.
 */
export const ANALYSIS_NODE_KINDS = [
  'Goal',
  'Human',
  'Ai',
  'Approval',
  'Condition',
  // Prompt 22: 'event trigger where supported'. An event is not work and not a decision, so it
  // is its own kind rather than a flag on another.
  'Trigger',
] as const;
export type AnalysisNodeKind = (typeof ANALYSIS_NODE_KINDS)[number];

/** The shapes the approved UI draws. */
export const NODE_SHAPES = ['goal', 'rectangle', 'diamond', 'gate'] as const;
export type NodeShape = (typeof NODE_SHAPES)[number];

/**
 * The locked UI rule, as data.
 *
 * The client's instruction is absolute: **Human node type is rectangle/square, AI node type is
 * diamond, and the Goal is visually distinct.** Keeping it as a mapping rather than as CSS in one
 * component means every renderer — the analysis panel, the workflow view, any later diagram —
 * reads the same answer, and an invariant test asserts it. Somebody restyling a component cannot
 * quietly make an AI node a rectangle.
 */
export const NODE_SHAPE_BY_KIND: Record<AnalysisNodeKind, NodeShape> = {
  Goal: 'goal',
  Human: 'rectangle',
  Ai: 'diamond',
  Approval: 'gate',
  Condition: 'gate',
  Trigger: 'gate',
};

export function nodeShapeFor(kind: AnalysisNodeKind): NodeShape {
  return NODE_SHAPE_BY_KIND[kind];
}

// ---------------------------------------------------------------------------
// The versioned draft schema
// ---------------------------------------------------------------------------

/**
 * The current schema version.
 *
 * Bump this when the draft's shape changes in a way a reader of the old shape would get wrong.
 * Adding an optional field does not need a bump; renaming, removing or re-meaning one does.
 */
export const ANALYSIS_SCHEMA_VERSION = 2;

/**
 * Versions this build can read.
 *
 * Version 1 (Prompt 21) carried a flat `definitionOfDone` and `evidenceRequired` string per
 * node; version 2 (Prompt 22) replaces them with the client's seven-part `dod` structure,
 * because the Pre-Publish Summary has to count nodes with **incomplete fields** and that is only
 * possible if the fields exist separately.
 *
 * A version 1 draft is therefore still readable — `upgradeWorkflowDraft` lifts it forward on
 * read — but only the current version may be **written**. That split is the whole value of
 * having stamped a version: old records stay legible without the writer having to support two
 * shapes.
 */
export const READABLE_SCHEMA_VERSIONS = [1, 2] as const;

/** One node of the proposed workflow. */
export interface AnalysisNode {
  /** Stable within the draft, so dependencies and approvals can name it. */
  id: string;
  kind: AnalysisNodeKind;
  /** What this step is, in the words a person will read on the diagram. */
  label: string;
  /** The shape the UI must draw. Stored so a renderer cannot disagree with the locked rule. */
  shape: NodeShape;
  /** Which Form 2 step this came from, when it came from one. 1-based. */
  fromStepPosition: number | null;
  /** The person accountable, for a `Human` node. Null when the analysis could not assign one. */
  ownerUserId: string | null;
  /** Their designation, for the diagram's second line. */
  ownerDesignation: string | null;
  /**
   * The approved, published Skill version an `Ai` node would use.
   *
   * Null when nothing suitable exists — and that is a legitimate outcome, not a failure. The
   * Skill Router raises a Skill Candidate for governance instead of inventing a capability.
   */
  skillVersionId: string | null;
  skillName: string | null;
  /**
   * The client's Definition of Done, in all seven parts.
   *
   * Structured since schema version 2. Version 1 carried a flat `definitionOfDone` and
   * `evidenceRequired` string; `upgradeWorkflowDraft` lifts those into this shape on read. The
   * change was needed because the Pre-Publish Summary counts nodes with **incomplete fields**,
   * and a paragraph cannot be partially missing.
   */
  dod: DefinitionOfDone;
  /** For an `Approval` node: what kind of approval. Mirrors `dod.approval` for the diagram. */
  approvalKind: string | null;
  /** For a `Trigger` node: what event starts it. Null for every other kind. */
  triggerEvent: string | null;
}

export interface AnalysisEdge {
  fromNodeId: string;
  toNodeId: string;
  /**
   * How this edge leads. Since schema version 2.
   *
   * Version 1 edges had no kind and were all sequential; the upgrade reads them as `Sequential`.
   */
  kind: WorkflowEdgeKind;
  /** For a `Condition` branch: which outcome this edge represents. */
  condition: string | null;
}

/**
 * The estimated AI usage, as a **range**.
 *
 * A range and not a number, deliberately. The prompt asks for an "estimated AI usage range", and
 * the honest reason is that nobody knows what a run will cost until it has run: input size varies,
 * retries happen, and a single figure presented next to real money reads as a quote. `basis` says
 * what the range was computed from so a reader can judge it.
 */
export interface AiUsageEstimate {
  minTokens: number;
  maxTokens: number;
  /** How many AI nodes the estimate covers. */
  aiNodeCount: number;
  /** Plain words: what this was derived from, and that it is an estimate. */
  basis: string;
}

/** What the analysis judged risky, and why. */
export interface AnalysisRisk {
  nodeId: string | null;
  severity: 'Low' | 'Medium' | 'High';
  summary: string;
}

/**
 * The workflow draft. **Always a draft** — see the module comment.
 */
export interface WorkflowDraft {
  /** Stamped on write, checked on read. See the module comment. */
  schemaVersion: number;
  /** The Goal node's id, so a renderer never has to guess which node is the goal. */
  goalNodeId: string;
  nodes: AnalysisNode[];
  edges: AnalysisEdge[];
  usage: AiUsageEstimate;
  risks: AnalysisRisk[];
  /**
   * What the analysis could not do, in plain words.
   *
   * Present and often non-empty on purpose. An analysis that silently omitted what it could not
   * work out would look complete and be wrong; the reference's own instruction is "no fake
   * completion".
   */
  gaps: string[];
}

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

/**
 * Validate a workflow draft against this schema version.
 *
 * Returns problems rather than throwing, so the same function can guard a write and explain a
 * refusal on read. A draft that fails this is never stored: a malformed draft in the database is
 * worse than no draft, because a screen will try to render it.
 */
export function validateWorkflowDraft(draft: Partial<WorkflowDraft>): string[] {
  const problems: string[] = [];

  if (draft.schemaVersion !== ANALYSIS_SCHEMA_VERSION) {
    problems.push(
      `This draft is schema version ${String(draft.schemaVersion)}, and this build reads ` +
        `version ${ANALYSIS_SCHEMA_VERSION}. It is refused rather than guessed at.`,
    );
    // No point checking a shape we do not claim to understand.
    return problems;
  }

  if (!Array.isArray(draft.nodes) || draft.nodes.length === 0) {
    problems.push('A workflow draft needs at least one node.');
    return problems;
  }

  const ids = new Set<string>();
  for (const node of draft.nodes) {
    if (ids.has(node.id)) {
      problems.push(`Two nodes share the id ${node.id}.`);
    }
    ids.add(node.id);

    if (!ANALYSIS_NODE_KINDS.includes(node.kind)) {
      problems.push(`Node ${node.id} has an unknown kind.`);
      continue;
    }

    // The locked UI rule, checked on the data rather than trusted to the renderer.
    if (node.shape !== nodeShapeFor(node.kind)) {
      problems.push(
        `Node ${node.id} is a ${node.kind} node but carries the shape "${node.shape}". ` +
          `A ${node.kind} node is always drawn as "${nodeShapeFor(node.kind)}".`,
      );
    }

    if (node.label.trim() === '') {
      problems.push(`Node ${node.id} has no label.`);
    }

    // The Definition of Done must be **present and structured**, but its parts may be blank: the
    // manager fills them in during editing, and the Pre-Publish Summary is what counts the gaps.
    // Refusing an incomplete one here would make an analysis unable to store its own first draft.
    if (node.dod === undefined || node.dod === null) {
      problems.push(`Node ${node.id} has no Definition of Done.`);
      continue;
    }
    if (!Array.isArray(node.dod.dependencies)) {
      problems.push(`Node ${node.id} needs a dependency list, even an empty one.`);
    } else {
      for (const dependency of node.dod.dependencies) {
        if (!draft.nodes.some((candidate) => candidate.id === dependency)) {
          problems.push(
            `Node ${node.id} depends on ${dependency}, which is not a node in this draft. A ` +
              'dependency nothing can resolve is a dependency nothing can enforce.',
          );
        }
        if (dependency === node.id) {
          problems.push(`Node ${node.id} depends on itself.`);
        }
      }
    }
    if (!Array.isArray(node.dod.tools)) {
      problems.push(`Node ${node.id} needs a tool list, even an empty one.`);
    }

    if (node.kind === 'Trigger' && (node.triggerEvent ?? '').trim() === '') {
      problems.push(`Node ${node.id} is a trigger but names no event.`);
    }
  }

  const goals = draft.nodes.filter((node) => node.kind === 'Goal');
  if (goals.length !== 1) {
    problems.push(
      `A workflow draft has exactly one Goal node; this one has ${goals.length}. The Goal is what ` +
        'the whole plan is for.',
    );
  } else if (draft.goalNodeId !== goals[0]?.id) {
    problems.push('`goalNodeId` does not name the Goal node.');
  }

  if (!Array.isArray(draft.edges)) {
    problems.push('A workflow draft needs an edge list, even an empty one.');
  } else {
    for (const edge of draft.edges) {
      if (!ids.has(edge.fromNodeId)) {
        problems.push(`An edge starts at ${edge.fromNodeId}, which is not a node in this draft.`);
      }
      if (!ids.has(edge.toNodeId)) {
        problems.push(`An edge ends at ${edge.toNodeId}, which is not a node in this draft.`);
      }
      if (edge.fromNodeId === edge.toNodeId) {
        problems.push(`An edge on ${edge.fromNodeId} points at itself.`);
      }
      if (!WORKFLOW_EDGE_KINDS.includes(edge.kind)) {
        // Names the offending value and the permitted set, like the Form 2 messages do. "Has an
        // unknown kind" leaves whoever reads it to guess both what was wrong and what is allowed.
        problems.push(
          `The edge from ${edge.fromNodeId} to ${edge.toNodeId} has an unknown kind ` +
            `"${String(edge.kind)}". One of: ${WORKFLOW_EDGE_KINDS.join(', ')}.`,
        );
      }
      // A condition branch that does not say which branch it is cannot be followed.
      if (edge.kind === 'Condition' && (edge.condition ?? '').trim() === '') {
        problems.push(
          `The condition edge from ${edge.fromNodeId} does not say which outcome it represents.`,
        );
      }
    }
  }

  if (draft.usage === undefined) {
    problems.push('A workflow draft needs an AI usage estimate.');
  } else {
    if (draft.usage.minTokens < 0 || draft.usage.maxTokens < 0) {
      problems.push('An AI usage estimate cannot be negative.');
    }
    if (draft.usage.maxTokens < draft.usage.minTokens) {
      problems.push('An AI usage range cannot end below where it starts.');
    }
    if (draft.usage.basis.trim() === '') {
      problems.push('An AI usage estimate has to say what it was derived from.');
    }
  }

  if (!Array.isArray(draft.risks)) {
    problems.push('A workflow draft needs a risk list, even an empty one.');
  }
  if (!Array.isArray(draft.gaps)) {
    problems.push('A workflow draft needs a gap list, even an empty one.');
  }

  return problems;
}

/**
 * Whether a draft produced by an older build can be read by this one.
 *
 * Separate from `validateWorkflowDraft` because the answer to "can I read this" and the answer to
 * "is this well-formed" are different, and a screen needs the first before it attempts the second.
 */
export function isReadableSchemaVersion(schemaVersion: number): boolean {
  return (READABLE_SCHEMA_VERSIONS as readonly number[]).includes(schemaVersion);
}

// ---------------------------------------------------------------------------
// Prompt 22 — the manager-editable workflow
// ---------------------------------------------------------------------------

/**
 * How one node leads to another.
 *
 * The client's list, and the distinctions are load-bearing:
 *
 *   * **`Sequential`** — the ordinary case: this, then that.
 *   * **`Parallel`** — several nodes proceed from one, at the same time. Distinct from sequential
 *     because a parallel fan-out is a scheduling instruction, not a preference: rendering it as a
 *     chain would tell the team to do in series what the plan says to do at once.
 *   * **`Condition`** — an IF/ELSE branch. Carries the branch label in `condition`.
 *   * **`Failure`** — the path taken when the source node fails. Kept apart from `Condition`
 *     because a failure branch is not a business decision; conflating them would make "what
 *     happens when this breaks" indistinguishable from "what happens when the answer is no".
 */
export const WORKFLOW_EDGE_KINDS = ['Sequential', 'Parallel', 'Condition', 'Failure'] as const;
export type WorkflowEdgeKind = (typeof WORKFLOW_EDGE_KINDS)[number];

export const WORKFLOW_EDGE_KIND_LABELS: Record<WorkflowEdgeKind, string> = {
  Sequential: 'Then',
  Parallel: 'At the same time',
  Condition: 'If',
  Failure: 'On failure',
};

/**
 * The client's Definition of Done, with all seven parts it names.
 *
 * Structured rather than a paragraph, because each part is asked about separately: a reviewer wants
 * to know what evidence is required without reading a prose block, and the pre-publish summary has
 * to count nodes with **incomplete fields**, which is only possible if the fields exist.
 *
 * `dependencies` names node ids rather than free text: a dependency you cannot resolve to a node is
 * a dependency nothing can enforce.
 */
export interface DefinitionOfDone {
  /** What this node produces. */
  expectedOutput: string;
  /** How you know it is right. */
  criteria: string;
  /** What proves it happened. */
  evidence: string;
  /** Node ids this node waits on, beyond its incoming edges. */
  dependencies: string[];
  /** Tool categories the node needs. Drives the high-risk count. */
  tools: string[];
  /** The approval this node requires, if any. */
  approval: StepApprovalKind | null;
  /** What counts as failure, so a failure branch has something to trigger on. */
  failureCondition: string;
}

/** Which parts of a Definition of Done are missing. Drives the pre-publish "incomplete" count. */
export function incompleteDodFields(dod: Partial<DefinitionOfDone> | null): string[] {
  if (dod === null || dod === undefined) {
    return ['expected output', 'criteria', 'evidence', 'failure condition'];
  }

  const missing: string[] = [];
  const required: [keyof DefinitionOfDone, string][] = [
    ['expectedOutput', 'expected output'],
    ['criteria', 'criteria'],
    ['evidence', 'evidence'],
    ['failureCondition', 'failure condition'],
  ];

  for (const [field, label] of required) {
    const value = dod[field];
    if (typeof value !== 'string' || value.trim() === '') {
      missing.push(label);
    }
  }

  return missing;
}

/**
 * Whether a node may be converted between Human and AI.
 *
 * The client's phrasing is "Human ↔ AI conversion **where allowed**", and this is what the
 * allowance is:
 *
 *   * **Only work nodes convert.** A Goal is what the plan is for, an Approval is a person
 *     deciding, a Condition is a rule, a Trigger is an event. None of them is work somebody or
 *     something performs, so converting them is meaningless rather than merely restricted.
 *   * **AI → Human is always allowed.** A person can always do the work; taking a step away from
 *     an agent is never the risky direction.
 *   * **Human → AI needs an approved, published Skill.** Otherwise the conversion creates a node
 *     that cannot run, and the plan would go live containing a step nothing can perform. This is
 *     the same rule as S-147 seen from the other side.
 */
export function mayConvertNode(input: {
  from: AnalysisNodeKind;
  to: AnalysisNodeKind;
  /** True when an approved published Skill has been matched to this node's work. */
  hasApprovedSkill: boolean;
}): { allowed: boolean; reason: string } {
  if (input.from === input.to) {
    return { allowed: false, reason: 'That node is already of that kind.' };
  }

  const convertible: AnalysisNodeKind[] = ['Human', 'Ai'];
  if (!convertible.includes(input.from) || !convertible.includes(input.to)) {
    return {
      allowed: false,
      reason:
        'Only Human and AI work nodes convert. A Goal, an approval, a condition and a trigger are ' +
        'not work somebody performs, so converting them would mean nothing.',
    };
  }

  if (input.to === 'Ai' && !input.hasApprovedSkill) {
    return {
      allowed: false,
      reason:
        'This step has no approved, published Skill behind it, so making it AI work would create ' +
        'a step nothing can perform. Author and approve a Skill first.',
    };
  }

  return { allowed: true, reason: 'Permitted.' };
}

// ---------------------------------------------------------------------------
// The pre-publish readiness summary
// ---------------------------------------------------------------------------

/** One thing standing between the draft and publication. */
export interface ReadinessFinding {
  /** `Blocker` stops Approve & Assign; `Warning` is shown and may be accepted. */
  severity: 'Blocker' | 'Warning';
  /** Which node it concerns, when it concerns one. */
  nodeId: string | null;
  summary: string;
}

/**
 * Everything the client's Pre-Publish Summary lists.
 *
 * Computed, never stored: a stored summary is a summary that goes stale the moment somebody edits
 * a node, and a reviewer reading a stale readiness check is worse off than one reading none.
 */
export interface PrePublishSummary {
  /** People who would receive work. The client asks for "affected employees". */
  affectedUserIds: string[];
  humanNodeCount: number;
  aiNodeCount: number;
  approvalGateCount: number;
  /** Skill versions the plan would use, and whether each is already in use elsewhere. */
  skillVersionIds: string[];
  /** AI nodes with no approved Skill — the client's "new" agents, which do not exist yet. */
  nodesNeedingNewSkill: string[];
  /** AI nodes reusing a Skill the company already has approved. */
  nodesReusingSkill: string[];
  /** Tool categories the plan needs that no live connection provides. */
  missingConnections: string[];
  /** Nodes whose tools include a high-risk category. */
  highRiskNodes: string[];
  /** A range, never a single figure. */
  estimatedUsage: AiUsageEstimate;
  /** People assigned more concurrent work than the plan can honour. */
  workloadConflicts: { userId: string; nodeIds: string[] }[];
  /** Nodes with an incomplete Definition of Done, and which parts are missing. */
  incompleteNodes: { nodeId: string; missing: string[] }[];
  findings: ReadinessFinding[];
  /** True when nothing blocks Approve & Assign. Warnings do not block. */
  readyToAssign: boolean;
  note: string;
}

/**
 * Lift a draft written by an earlier build into the current shape.
 *
 * The counterpart to `READABLE_SCHEMA_VERSIONS`: reading an old draft is only useful if something
 * turns it into the shape the rest of the code expects. Version 1's flat `definitionOfDone` and
 * `evidenceRequired` strings become the `expectedOutput` and `evidence` parts of the structure,
 * with the remaining parts left blank — which is honest, because version 1 genuinely did not
 * record them, and the Pre-Publish Summary will then report them as incomplete rather than
 * inventing content.
 *
 * Returns `null` for a version this build cannot read, so a caller has one thing to check.
 */
export function upgradeWorkflowDraft(stored: unknown): WorkflowDraft | null {
  if (typeof stored !== 'object' || stored === null) return null;

  const draft = stored as Record<string, unknown>;
  const version = typeof draft['schemaVersion'] === 'number' ? draft['schemaVersion'] : 0;

  if (!isReadableSchemaVersion(version)) return null;
  if (version === ANALYSIS_SCHEMA_VERSION) return stored as WorkflowDraft;

  // Version 1 to 2.
  const nodes = Array.isArray(draft['nodes']) ? (draft['nodes'] as Record<string, unknown>[]) : [];
  const edges = Array.isArray(draft['edges']) ? (draft['edges'] as Record<string, unknown>[]) : [];

  return {
    ...(stored as WorkflowDraft),
    schemaVersion: ANALYSIS_SCHEMA_VERSION,
    nodes: nodes.map((node) => {
      // The flat version 1 fields are dropped rather than carried alongside the structure they
      // were lifted into. Keeping both would leave two copies of the same fact in stored JSON,
      // free to disagree the moment someone edits one of them.
      const {
        definitionOfDone: _dod,
        evidenceRequired: _evidence,
        toolNeeds: _tools,
        ...rest
      } = node;

      return {
        ...(rest as unknown as AnalysisNode),
        dod: {
          expectedOutput: typeof _dod === 'string' ? _dod : '',
          criteria: '',
          evidence: typeof _evidence === 'string' ? _evidence : '',
          dependencies: [],
          tools: Array.isArray(_tools) ? (_tools as string[]) : [],
          approval: null,
          failureCondition: '',
        },
        // Normalised rather than spread through: the declared type is `string | null`, and a
        // version 1 node that never recorded this would otherwise hold `undefined` — a third
        // state nothing downstream is written to expect.
        approvalKind: typeof node['approvalKind'] === 'string' ? node['approvalKind'] : null,
        triggerEvent: null,
      };
    }),
    // Version 1 had no edge kinds, and every edge it wrote was a plain "then".
    edges: edges.map((edge) => ({
      ...(edge as unknown as AnalysisEdge),
      kind: 'Sequential' as WorkflowEdgeKind,
    })),
  };
}
