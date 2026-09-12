/**
 * Skills: governed reusable capabilities.
 *
 * ## What a Skill is not
 *
 * **A Skill is not a Template.** The client's rule is explicit and locked: there is no Objective
 * Template, no Workflow Template and no Agent Template, and no Templates Library. The distinction
 * is not naming — it is what the thing does:
 *
 *   * A **Template** would be a copy-me starting point: you take it, it becomes yours, and the
 *     original stops mattering. Nothing governs the copy.
 *   * A **Skill** is a *governed capability* that stays under its own lifecycle. Work **references
 *     an approved version**; the version is immutable; a change creates a new draft that must be
 *     approved before anything uses it; and the catalogue always knows what is using what.
 *
 * So this file has versions, statuses, approvals, owners, autonomy limits and impact analysis. A
 * template library would need none of those, which is exactly why one would be the wrong answer.
 */

/**
 * The three layers, from most to least governed by UBoss itself.
 *
 * A layer decides **who owns the lifecycle**, not what the Skill can do. A company cannot edit a
 * UBoss Verified Skill; it can clone one into its own layer, which is a different Skill with its
 * own approval trail — and that difference is the whole reason cloning is not "copying a
 * template".
 */
export const SKILL_LAYERS = ['UbossVerified', 'IndustryPack', 'CompanyCustom'] as const;
export type SkillLayer = (typeof SKILL_LAYERS)[number];

export const SKILL_LAYER_LABELS: Record<SkillLayer, string> = {
  UbossVerified: 'UBoss Verified Universal Skill',
  IndustryPack: 'Industry Pack',
  CompanyCustom: 'Company Custom Skill',
};

export const SKILL_LAYER_DESCRIPTIONS: Record<SkillLayer, string> = {
  UbossVerified:
    'Published and maintained by UBoss, available to every company. A company can use it or ' +
    'clone it, but cannot change it.',
  IndustryPack:
    'Published by UBoss for one industry. Same governance as a Verified Skill, narrower audience.',
  CompanyCustom: "This company's own, under its own approval. The only layer a company can author.",
};

/** Platform-owned layers. A company can never author or edit one. */
export const PLATFORM_SKILL_LAYERS: readonly SkillLayer[] = ['UbossVerified', 'IndustryPack'];

export function isPlatformLayer(layer: SkillLayer): boolean {
  return PLATFORM_SKILL_LAYERS.includes(layer);
}

/**
 * The client's lifecycle, in order.
 *
 * `Approved` and `Published` are **one client step** written as two states, and the split earns
 * its keep: approving is a governance decision about the content, publishing is the moment work
 * may start referencing it. A Skill can be approved on Friday and published on Monday when the
 * department is ready, and an approval that has not been published yet is not a capability
 * anything can use.
 */
export const SKILL_STATUSES = [
  'Draft',
  'Test',
  'Review',
  'Approved',
  'Published',
  'Deprecated',
  'Archived',
] as const;
export type SkillStatus = (typeof SKILL_STATUSES)[number];

export const SKILL_STATUS_LABELS: Record<SkillStatus, string> = {
  Draft: 'Draft',
  Test: 'In test',
  Review: 'In review',
  Approved: 'Approved',
  Published: 'Published',
  Deprecated: 'Deprecated',
  Archived: 'Archived',
};

export const SKILL_STATUS_TONES: Record<
  SkillStatus,
  'grey' | 'blue' | 'cyan' | 'purple' | 'success' | 'warn' | 'danger'
> = {
  Draft: 'grey',
  Test: 'cyan',
  Review: 'purple',
  Approved: 'blue',
  Published: 'success',
  Deprecated: 'warn',
  Archived: 'grey',
};

/**
 * The only permitted transitions.
 *
 * A closed table rather than scattered `if` statements, so the whole lifecycle is auditable by
 * reading twelve lines — the same shape as `ALLOWED_LIFECYCLE_TRANSITIONS` (Prompt 11).
 *
 * Three deliberate shapes:
 *
 *   * **`Review` can go back to `Draft`.** A reviewer who rejects something must be able to send
 *     it back; a lifecycle where rejection is a dead end gets worked around by cloning.
 *   * **`Published` cannot return to `Draft`.** That is the immutability rule: an authorised edit
 *     after publication creates a **new version**, it does not reopen the live one.
 *   * **`Archived` is terminal.** Nothing leaves it. Un-archiving would mean a capability
 *     silently becoming available again, which is what a new version is for.
 */
export const ALLOWED_SKILL_TRANSITIONS: Record<SkillStatus, readonly SkillStatus[]> = {
  Draft: ['Test', 'Review', 'Archived'],
  // Testing can send it back for authoring, or forward for review.
  Test: ['Draft', 'Review', 'Archived'],
  Review: ['Draft', 'Approved', 'Archived'],
  Approved: ['Published', 'Draft', 'Archived'],
  Published: ['Deprecated', 'Archived'],
  Deprecated: ['Archived'],
  Archived: [],
};

export function mayTransitionSkill(from: SkillStatus, to: SkillStatus): boolean {
  return ALLOWED_SKILL_TRANSITIONS[from].includes(to);
}

/** Statuses in which a version's content is frozen. */
export const IMMUTABLE_SKILL_STATUSES: readonly SkillStatus[] = [
  'Approved',
  'Published',
  'Deprecated',
  'Archived',
];

/**
 * Is this version's content frozen?
 *
 * **`Approved` counts, not just `Published`.** The client's rule names publication, and this is
 * deliberately stricter: an approval is a governance decision about specific content, so content
 * that could change after approval would make the approval meaningless. Somebody could get
 * "delete records" approved by having "read records" reviewed.
 */
export function isSkillContentFrozen(status: SkillStatus): boolean {
  return IMMUTABLE_SKILL_STATUSES.includes(status);
}

/** Statuses in which work may reference the version. */
export const USABLE_SKILL_STATUSES: readonly SkillStatus[] = ['Published'];

/**
 * How much a Skill may do without a person.
 *
 * The client's `autonomy` field. Ordered, so a policy can say "nothing above
 * `ProposeForApproval` in this department" and mean something.
 */
export const SKILL_AUTONOMY_LEVELS = [
  /** Produces a suggestion. A person does the work. */
  'SuggestOnly',
  /** Produces the output; a person approves before it takes effect. */
  'ProposeForApproval',
  /** Acts, then reports. Reversible work only. */
  'ActThenReport',
  /** Acts without review. Never permitted with a high-risk tool category. */
  'FullyAutonomous',
] as const;
export type SkillAutonomy = (typeof SKILL_AUTONOMY_LEVELS)[number];

export const SKILL_AUTONOMY_LABELS: Record<SkillAutonomy, string> = {
  SuggestOnly: 'Suggest only',
  ProposeForApproval: 'Propose for approval',
  ActThenReport: 'Act, then report',
  FullyAutonomous: 'Fully autonomous',
};

/**
 * Autonomy levels that must not be combined with a high-risk tool category.
 *
 * The connection between this file and Prompt 16: a Skill that may `Delete` or make a
 * `FinancialChange` cannot also be `FullyAutonomous`, because that combination is an irreversible
 * action in somebody else's system with no person involved at any point. The Executor Agent's
 * escalation layer is not a substitute — the locked rule is that it never silently approves
 * high-risk work.
 */
export const AUTONOMY_REQUIRING_APPROVAL: readonly SkillAutonomy[] = [
  'SuggestOnly',
  'ProposeForApproval',
  'ActThenReport',
];

export function autonomyPermittedWithHighRiskTools(autonomy: SkillAutonomy): boolean {
  return autonomy !== 'FullyAutonomous';
}

/**
 * How a company custom Skill draft was started. The client's four modes.
 *
 * Recorded on the version because it is part of the provenance somebody reviewing a Skill wants:
 * "who wrote this, and did a person or a model draft it" is a different question from "who
 * approved it", and both matter.
 */
export const SKILL_CREATION_MODES = [
  'Manual',
  'CreateWithUbossAi',
  'FromDocument',
  'Clone',
] as const;
export type SkillCreationMode = (typeof SKILL_CREATION_MODES)[number];

export const SKILL_CREATION_MODE_LABELS: Record<SkillCreationMode, string> = {
  Manual: 'Manual',
  CreateWithUbossAi: 'Create with UBoss AI',
  FromDocument: 'From an SOP or document',
  Clone: 'Clone an existing Skill',
};

/**
 * The client's skill categories.
 *
 * A closed set so the catalogue can be browsed and a router (Prompt 18) can filter on something
 * stable, rather than on free text that drifts into thirty near-synonyms.
 */
export const SKILL_CATEGORIES = [
  'Research',
  'Analysis',
  'Drafting',
  'Review',
  'Compliance',
  'DataEntry',
  'Communication',
  'Reporting',
  'Operations',
] as const;
export type SkillCategory = (typeof SKILL_CATEGORIES)[number];

/**
 * One IF/THEN rule.
 *
 * The client's `IF/THEN rules` field, as structure rather than prose. Structured because Prompt
 * 18's router has to reason about applicability, and because "IF the tender value exceeds X THEN
 * escalate" is a governance statement somebody must be able to review line by line.
 */
export interface SkillRule {
  /** The condition, in the reviewer's words. */
  when: string;
  /** What the Skill does when it holds. */
  then: string;
}

/** One numbered step. Ordered prose, because a procedure is read by a person. */
export interface SkillStep {
  order: number;
  instruction: string;
}

/** One declared input the Skill needs before it can run. */
export interface SkillInput {
  name: string;
  description: string;
  required: boolean;
}

/**
 * Everything a version says about itself.
 *
 * Every field the client lists, in their order, and nothing invented. `outputSchema` is a JSON
 * Schema fragment as text: validating a Skill's output is Prompt 18's job, and storing a parsed
 * shape now would freeze a decision that belongs there.
 */
export interface SkillContent {
  purpose: string;
  category: SkillCategory;
  whenToUse: string;
  /** Kept as its own field, not folded into `whenToUse`: knowing when *not* to reach for a Skill
   * is what stops it being used for the wrong work, and it is the field people skip. */
  whenNotToUse: string;
  inputs: SkillInput[];
  rules: SkillRule[];
  steps: SkillStep[];
  /** Tool categories from Prompt 16. A Skill declares what it needs; a grant decides what it gets. */
  allowedToolCategories: string[];
  outputSchema: string;
  validation: string;
  failureHandling: string;
  /** Whether a run of this Skill needs an approval decision. */
  requiresApproval: boolean;
  autonomy: SkillAutonomy;
  /** What the Skill must record so its work can be checked afterwards. */
  evidenceRequirement: string;
}

/**
 * The impact-analysis domains the client requires before an upgrade.
 *
 * A **declared registry** rather than an implicit query, for the same reason as
 * `HANDOVER_DOMAINS`: most of what it must count does not exist yet, and the difference between
 * "no affected Objectives" and "we cannot count Objectives" is the whole value of the analysis.
 * A screen that reported four zeroes would be worse than one that says which three it cannot see.
 */
export const SKILL_IMPACT_DOMAINS = [
  {
    key: 'agents',
    label: 'Engine Agents referencing this Skill',
    status: 'not-implemented' as const,
    arrivesWith: 'the Agent Builder prompt',
  },
  {
    key: 'objectives',
    label: 'Objectives whose workflow uses it',
    status: 'not-implemented' as const,
    arrivesWith: 'the Objective Builder prompt',
  },
  {
    key: 'departments',
    label: 'Departments affected',
    status: 'derived' as const,
    note: 'Derived from the Objectives and Agents above, so it becomes real when they do.',
  },
  {
    key: 'activeRuns',
    label: 'Runs in flight',
    status: 'not-implemented' as const,
    arrivesWith: 'the Engine Agent run prompt',
  },
  {
    key: 'clones',
    label: 'Company Skills cloned from this one',
    status: 'implemented' as const,
  },
] as const;

/**
 * Validate a version's content.
 *
 * Returns every problem rather than the first, because this is a long form and being told one
 * mistake at a time is how a review cycle takes four days.
 */
export function validateSkillContent(content: Partial<SkillContent>): string[] {
  const problems: string[] = [];

  const required: [keyof SkillContent, string][] = [
    ['purpose', 'a purpose'],
    ['whenToUse', 'when to use it'],
    ['whenNotToUse', 'when **not** to use it'],
    ['outputSchema', 'an output schema'],
    ['validation', 'how its output is validated'],
    ['failureHandling', 'what happens when it fails'],
    ['evidenceRequirement', 'what evidence it must record'],
  ];

  for (const [field, description] of required) {
    if (typeof content[field] !== 'string' || (content[field] as string).trim() === '') {
      problems.push(`A Skill needs ${description}.`);
    }
  }

  if (content.category !== undefined && !SKILL_CATEGORIES.includes(content.category)) {
    problems.push(`Unknown category. One of: ${SKILL_CATEGORIES.join(', ')}.`);
  }

  if (!Array.isArray(content.steps) || content.steps.length === 0) {
    problems.push('A Skill needs at least one step. A capability with no procedure is a wish.');
  } else {
    const orders = content.steps.map((step) => step.order);
    if (new Set(orders).size !== orders.length) {
      problems.push('Two steps share the same position.');
    }
    if (content.steps.some((step) => step.instruction.trim() === '')) {
      problems.push('A step with no instruction cannot be followed.');
    }
  }

  if (Array.isArray(content.rules)) {
    for (const rule of content.rules) {
      if (rule.when.trim() === '' || rule.then.trim() === '') {
        problems.push('An IF/THEN rule needs both halves.');
        break;
      }
    }
  }

  if (Array.isArray(content.inputs)) {
    const names = content.inputs.map((input) => input.name.trim().toLowerCase());
    if (new Set(names).size !== names.length) {
      problems.push('Two inputs share the same name.');
    }
    if (names.some((name) => name === '')) {
      problems.push('An input needs a name.');
    }
  }

  return problems;
}

/**
 * Cross-field rules a per-field validator cannot see.
 *
 * Both of these are governance rather than data hygiene, which is why they are separate and
 * separately explained.
 */
export function validateSkillGovernance(content: Partial<SkillContent>): string[] {
  const problems: string[] = [];

  const highRisk = [
    'Delete',
    'ExternalBulkSend',
    'SensitiveExport',
    'FinancialChange',
    'ProductionChange',
  ];
  const declaredHighRisk = (content.allowedToolCategories ?? []).filter((category) =>
    highRisk.includes(category),
  );

  if (
    declaredHighRisk.length > 0 &&
    content.autonomy !== undefined &&
    !autonomyPermittedWithHighRiskTools(content.autonomy)
  ) {
    problems.push(
      `A Skill that may ${declaredHighRisk.join(' or ')} cannot be fully autonomous. That ` +
        'combination is an irreversible action in somebody else’s system with no person involved ' +
        'at any point, and the Executor Agent is not a substitute — it never silently approves ' +
        'high-risk work.',
    );
  }

  if (
    declaredHighRisk.length > 0 &&
    content.requiresApproval === false &&
    content.autonomy !== 'SuggestOnly'
  ) {
    problems.push(
      `A Skill that may ${declaredHighRisk.join(' or ')} must either require approval or only ` +
        'suggest. Anything else means the high-risk action happens on nobody’s decision.',
    );
  }

  return problems;
}
