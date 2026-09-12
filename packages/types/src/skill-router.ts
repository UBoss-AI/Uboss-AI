import { isSkillContentFrozen, type SkillAutonomy, type SkillCategory } from './skills.js';

/**
 * The Skill Router: choosing which approved Skills apply to a piece of AI work.
 *
 * ## What it is not allowed to do
 *
 * Two rules from the client, and both are absolute:
 *
 *   1. **It never returns an unapproved Skill for production work.** Only a `Published` version
 *      can be selected. A draft is a proposal, not a capability.
 *   2. **When the capability is missing it never invents one.** It records a **Skill Candidate**
 *      and routes it to governance. It does not publish, and it does not quietly use a draft
 *      "just this once" — that path is how an unreviewed capability ends up in production, and
 *      once it works nobody goes back.
 *
 * ## Why the scoring is deterministic and explainable
 *
 * There is no model here. The router is a rules engine over what a Skill **declares about
 * itself** — category, when-to-use, when-not-to-use, declared inputs, allowed tool categories,
 * autonomy — because those fields exist precisely so a capability can be selected without
 * guessing.
 *
 * That choice is not a placeholder for a model. A selection that cannot be explained cannot be
 * governed: somebody has to be able to ask "why did an agent use *that* Skill on our tender" and
 * get an answer that is not "the embedding was close". So every result carries its reasons, and
 * every rejection carries its disqualifier.
 */

/**
 * Everything the router is given. The client's list, verbatim.
 *
 * `aiTask` is free text — a description of the work — and it is the only unstructured input. The
 * rest are facts about the context that either match or do not.
 */
export interface SkillRouterContext {
  /** Which Objective this work belongs to. Opaque: the Objective model arrives at Prompt 19. */
  objectiveId?: string | undefined;
  departmentId?: string | undefined;
  /** The company's industry, for matching an Industry Pack. */
  industry?: string | undefined;
  /** What the work actually is, in words. */
  aiTask: string;
  /** Named inputs the caller can supply. A Skill needing more than these cannot run. */
  availableInputs: string[];
  /** What the caller needs back. Matched loosely against the Skill's declared output. */
  requiredOutput?: string | undefined;
  /** Tool categories the caller may permit. A Skill needing more is disqualified. */
  allowedToolCategories: string[];
  /** True when this work must pass an approval before taking effect. */
  requiresApproval: boolean;
  /**
   * The company's ceiling on how much a Skill may do unattended.
   *
   * A policy statement, not a preference: a Skill above it is disqualified rather than ranked
   * lower, because "we do not allow fully autonomous AI in this department" is not a hint.
   */
  maxAutonomy?: SkillAutonomy | undefined;
  /** Narrow to one category when the caller already knows the kind of work. */
  category?: SkillCategory | undefined;
}

/** What the router needs to know about a candidate Skill version. */
export interface RoutableSkillVersion {
  skillId: string;
  skillVersionId: string;
  skillKey: string;
  skillName: string;
  layer: string;
  /** The pack's industry, or null. */
  industry: string | null;
  status: string;
  category: string;
  purpose: string;
  whenToUse: string;
  whenNotToUse: string;
  declaredInputs: { name: string; required: boolean }[];
  allowedToolCategories: string[];
  requiresApproval: boolean;
  autonomy: SkillAutonomy;
  outputSchema: string;
}

export interface SkillMatch {
  skillId: string;
  skillVersionId: string;
  skillKey: string;
  skillName: string;
  /** 0–100. Explainable, and never the only thing shown. */
  confidence: number;
  /** Why it matched, in the order the signals were considered. */
  reasons: string[];
}

export interface SkillRejection {
  skillId: string;
  skillVersionId: string;
  skillName: string;
  /** The single rule that ruled it out. */
  disqualifier: string;
}

export interface SkillRoutingResult {
  matches: SkillMatch[];
  /** Every candidate that was considered and rejected, with the reason. */
  rejected: SkillRejection[];
  /** True when nothing qualified — the caller must then raise a Candidate, not improvise. */
  capabilityMissing: boolean;
  note: string;
}

/** The client's "small set". Five, and the reason is in `routeSkills`. */
export const ROUTER_MAX_RESULTS = 5;

/** Below this, a match is noise rather than a suggestion. */
export const ROUTER_MIN_CONFIDENCE = 25;

const AUTONOMY_ORDER: SkillAutonomy[] = [
  'SuggestOnly',
  'ProposeForApproval',
  'ActThenReport',
  'FullyAutonomous',
];

function autonomyRank(autonomy: SkillAutonomy): number {
  return AUTONOMY_ORDER.indexOf(autonomy);
}

/** Words worth matching on. Drops the filler that would make every Skill look relevant. */
const STOP_WORDS = new Set([
  'a',
  'an',
  'and',
  'are',
  'as',
  'at',
  'be',
  'by',
  'for',
  'from',
  'has',
  'have',
  'in',
  'into',
  'is',
  'it',
  'its',
  'of',
  'on',
  'or',
  'that',
  'the',
  'their',
  'this',
  'to',
  'was',
  'were',
  'when',
  'which',
  'with',
  'we',
  'our',
  'us',
  'do',
  'does',
  'not',
  'any',
  'all',
  'each',
]);

/**
 * A crude stem: drop a trailing plural `s` (but not `ss`).
 *
 * Not linguistics — enough that "pricing floors" in a Skill's exclusion text matches "pricing
 * floor" in a task description. Without it the two never overlap and the exclusion rule, which is
 * the safety-relevant one, almost never fires. That was a real gap this prompt's own test found.
 */
function stem(word: string): string {
  return word.length > 3 && word.endsWith('s') && !word.endsWith('ss') ? word.slice(0, -1) : word;
}

export function meaningfulWords(text: string): string[] {
  return [
    ...new Set(
      text
        .toLowerCase()
        .split(/[^a-z0-9]+/)
        .filter((word) => word.length > 2 && !STOP_WORDS.has(word))
        .map(stem),
    ),
  ];
}

/**
 * Score one candidate against one context.
 *
 * Returns `null` for a **disqualification** — a hard rule, not a low score — with the reason.
 * The distinction matters: a low score means "probably not this one", and a disqualification
 * means "this must not be used here". Ranking a policy violation slightly lower is how it
 * eventually gets used.
 */
export function scoreSkillForContext(
  context: SkillRouterContext,
  candidate: RoutableSkillVersion,
): { confidence: number; reasons: string[] } | { disqualifier: string } {
  // ---- Hard rules first. Each one prevents a specific wrong outcome. ----

  if (candidate.status !== 'Published') {
    return {
      disqualifier:
        `Not published (${candidate.status}). Only an approved, published version may be ` +
        'selected for work — a draft is a proposal, not a capability.',
    };
  }

  const missingTools = candidate.allowedToolCategories.filter(
    (category) => !context.allowedToolCategories.includes(category),
  );
  if (missingTools.length > 0) {
    return {
      disqualifier:
        `Needs ${missingTools.join(', ')}, which this work does not permit. A Skill that cannot ` +
        'use its tools would fail part-way through, which is worse than not being selected.',
    };
  }

  if (
    context.maxAutonomy !== undefined &&
    autonomyRank(candidate.autonomy) > autonomyRank(context.maxAutonomy)
  ) {
    return {
      disqualifier:
        `Its autonomy (${candidate.autonomy}) exceeds the policy ceiling ` +
        `(${context.maxAutonomy}). A company policy about unattended AI is not a preference to ` +
        'rank lower.',
    };
  }

  if (context.requiresApproval && !candidate.requiresApproval) {
    return {
      disqualifier:
        'This work must pass an approval and the Skill does not require one, so using it would ' +
        'produce output that takes effect with nobody having decided.',
    };
  }

  const missingInputs = candidate.declaredInputs
    .filter((input) => input.required)
    .map((input) => input.name)
    .filter((name) => !context.availableInputs.includes(name));
  if (missingInputs.length > 0) {
    return {
      disqualifier:
        `Requires input${missingInputs.length === 1 ? '' : 's'} not available here: ` +
        `${missingInputs.join(', ')}.`,
    };
  }

  if (context.category !== undefined && candidate.category !== context.category) {
    return {
      disqualifier: `A ${candidate.category} Skill, and this work is ${context.category}.`,
    };
  }

  // ---- The "when not to use it" check, which is why that field exists. ----
  const taskWords = meaningfulWords(context.aiTask);
  const exclusionWords = meaningfulWords(candidate.whenNotToUse);
  const exclusionHits = exclusionWords.filter((word) => taskWords.includes(word));

  /*
   * The exclusion rule is a **ratio**, not an absolute count.
   *
   * "At least two of the exclusion's distinctive words, and at least half of them" reads the
   * field the way a person would: a Skill whose "never use this for…" is mostly *about* this task
   * is excluded, while one that happens to share a word or two with a long exclusion is not.
   *
   * An absolute threshold was tried first and was wrong in the dangerous direction — because
   * `meaningfulWords` de-duplicates, a three-word threshold almost never fired, so the
   * safety-relevant rule was effectively off. This prompt's own test caught it.
   *
   * Deliberately conservative in the *safe* direction: being wrongly excluded costs a
   * suggestion, being wrongly included costs a piece of work done by the wrong capability.
   */
  const exclusionRatio =
    exclusionWords.length === 0 ? 0 : exclusionHits.length / exclusionWords.length;

  if (exclusionHits.length >= 2 && exclusionRatio >= 0.5) {
    return {
      disqualifier:
        `Its "when not to use" says: "${candidate.whenNotToUse}". This task overlaps that on ` +
        `${exclusionHits.join(', ')}.`,
    };
  }

  // ---- Soft signals. Each contributes, and each is named in the result. ----
  const reasons: string[] = [];
  let confidence = 0;
  /** Set by a signal that says this Skill is *for* this work, rather than merely compatible. */
  let matchedOnRelevance = false;

  if (candidate.category === context.category) {
    confidence += 20;
    reasons.push(`Same category (${candidate.category}).`);
  }

  const whenToUseWords = meaningfulWords(candidate.whenToUse);
  const whenHits = whenToUseWords.filter((word) => taskWords.includes(word));
  if (whenHits.length > 0) {
    // Capped, so a very long `whenToUse` cannot win by volume.
    const points = Math.min(35, whenHits.length * 9);
    confidence += points;
    matchedOnRelevance = true;
    reasons.push(`Its "when to use" matches this task on ${whenHits.slice(0, 5).join(', ')}.`);
  }

  const purposeWords = meaningfulWords(candidate.purpose);
  const purposeHits = purposeWords.filter((word) => taskWords.includes(word));
  if (purposeHits.length > 0) {
    confidence += Math.min(20, purposeHits.length * 6);
    matchedOnRelevance = true;
    reasons.push(`Its purpose matches on ${purposeHits.slice(0, 5).join(', ')}.`);
  }

  if (context.requiredOutput !== undefined) {
    const outputWords = meaningfulWords(context.requiredOutput);
    const schemaWords = meaningfulWords(candidate.outputSchema);
    const outputHits = outputWords.filter((word) => schemaWords.includes(word));
    if (outputHits.length > 0) {
      confidence += Math.min(15, outputHits.length * 7);
      matchedOnRelevance = true;
      reasons.push(`Its output includes ${outputHits.slice(0, 3).join(', ')}.`);
    }
  }

  if (candidate.layer === 'IndustryPack' && candidate.industry !== null) {
    if (context.industry !== undefined && candidate.industry === context.industry) {
      confidence += 15;
      reasons.push(`Published for the ${candidate.industry} industry.`);
    } else {
      // Not a disqualification: a pack written for another industry may still be the best
      // available answer, and refusing it outright would leave the company with nothing.
      confidence -= 10;
      reasons.push(
        `Published for ${candidate.industry}, which is not this company's industry — usable, ` +
          'but ranked lower than something written for this one.',
      );
    }
  }

  /*
   * A company's own Skill outranks a platform one, all else equal.
   *
   * Somebody here wrote it, reviewed it and approved it for this company's way of working, and
   * that is more information than a universal Skill carries. Small, because a Verified Skill is
   * often better made — this breaks ties rather than deciding.
   */
  if (candidate.layer === 'CompanyCustom') {
    confidence += 8;
    reasons.push("This company's own approved Skill.");
  }

  // Needing fewer tools than permitted is a mild positive: least privilege, achieved by choice.
  if (candidate.allowedToolCategories.length < context.allowedToolCategories.length) {
    confidence += 5;
    reasons.push('Needs fewer tools than this work permits.');
  }

  /*
   * **At least one relevance signal is required.**
   *
   * Matching the category and needing few tools are a *filter* and a *tie-breaker*; neither is
   * evidence that this Skill is for this task. Without this rule a Skill about birthday messages
   * scored exactly the confidence floor on category-plus-fewer-tools alone and was offered for
   * tender screening — which this prompt's own test caught.
   *
   * So a Skill must match on what it says it is for: its "when to use", its purpose, or the
   * output the caller asked for. A rule is clearer here than a tuned threshold, and it cannot
   * drift the way a number does.
   */
  if (!matchedOnRelevance) {
    return {
      disqualifier:
        'Nothing about this task matches what it says it is for. Its category fits, but a ' +
        'category is a filter rather than a reason.',
    };
  }

  return { confidence: Math.max(0, Math.min(100, confidence)), reasons };
}

/**
 * Choose the Skills that apply.
 *
 * Returns **at most five**, above a confidence floor, plus every rejection with its reason.
 *
 * Five because the caller is choosing one: a list of twenty is a list nobody reads, and the
 * router's job is to narrow rather than to enumerate. The rejections are returned in full because
 * "why was our Skill not used" is the question this design exists to be able to answer.
 */
export function routeSkills(
  context: SkillRouterContext,
  candidates: readonly RoutableSkillVersion[],
): SkillRoutingResult {
  const matches: SkillMatch[] = [];
  const rejected: SkillRejection[] = [];

  for (const candidate of candidates) {
    const outcome = scoreSkillForContext(context, candidate);

    if ('disqualifier' in outcome) {
      rejected.push({
        skillId: candidate.skillId,
        skillVersionId: candidate.skillVersionId,
        skillName: candidate.skillName,
        disqualifier: outcome.disqualifier,
      });
      continue;
    }

    if (outcome.confidence < ROUTER_MIN_CONFIDENCE) {
      rejected.push({
        skillId: candidate.skillId,
        skillVersionId: candidate.skillVersionId,
        skillName: candidate.skillName,
        disqualifier:
          `Scored ${outcome.confidence}, below the ${ROUTER_MIN_CONFIDENCE} floor. Nothing about ` +
          'this task matches what it says it is for.',
      });
      continue;
    }

    matches.push({
      skillId: candidate.skillId,
      skillVersionId: candidate.skillVersionId,
      skillKey: candidate.skillKey,
      skillName: candidate.skillName,
      confidence: outcome.confidence,
      reasons: outcome.reasons,
    });
  }

  matches.sort((left, right) => right.confidence - left.confidence);
  const kept = matches.slice(0, ROUTER_MAX_RESULTS);

  return {
    matches: kept,
    rejected,
    capabilityMissing: kept.length === 0,
    note:
      kept.length === 0
        ? 'No approved Skill applies. Raise a Skill Candidate: the router never selects an ' +
          'unapproved version and never invents a capability, because an unreviewed capability ' +
          'that works once is one nobody goes back to review.'
        : `${kept.length} approved Skill${kept.length === 1 ? '' : 's'} apply. Each carries its ` +
          'reasons, and every rejection carries the rule that ruled it out — a selection nobody ' +
          'can explain cannot be governed.',
  };
}

// ---------------------------------------------------------------------------
// Evaluation
// ---------------------------------------------------------------------------

/**
 * How a saved case decides whether an output is right.
 *
 * Three kinds, because a Skill's output is checked three different ways in practice and folding
 * them into one would mean the strictest kind was unusable for anything textual.
 */
export const EVALUATION_ASSERTIONS = [
  /** The output must equal the expectation exactly. For a structured result. */
  'ExactMatch',
  /** The output must contain every expected fragment. For prose with required content. */
  'ContainsAll',
  /** A person judged it. Recorded, not computed. */
  'HumanJudged',
] as const;
export type EvaluationAssertion = (typeof EVALUATION_ASSERTIONS)[number];

export const EVALUATION_ASSERTION_LABELS: Record<EvaluationAssertion, string> = {
  ExactMatch: 'Exact match',
  ContainsAll: 'Contains all of',
  HumanJudged: 'Judged by a person',
};

/**
 * Evaluate one recorded output against one expectation.
 *
 * Pure, so the rule is testable without a database and identical wherever it runs. `HumanJudged`
 * cannot be computed and returns `null` — the caller must supply the verdict, and a case that
 * silently passed because nobody judged it would be worse than one that stayed open.
 */
export function evaluateOutput(input: {
  assertion: EvaluationAssertion;
  expected: string;
  actual: string;
}): boolean | null {
  if (input.assertion === 'HumanJudged') {
    return null;
  }

  const actual = input.actual.trim();

  if (input.assertion === 'ExactMatch') {
    return actual === input.expected.trim();
  }

  // `ContainsAll`: every non-empty line of the expectation must appear.
  const fragments = input.expected
    .split('\n')
    .map((fragment) => fragment.trim())
    .filter((fragment) => fragment !== '');

  return fragments.length > 0 && fragments.every((fragment) => actual.includes(fragment));
}

/** What a regression comparison concluded. */
export const REGRESSION_VERDICTS = [
  /** The candidate passes everything the current version passes, and more. */
  'Improved',
  /** Identical results. */
  'NoChange',
  /** The candidate fails something the current version passes. **Blocks publication.** */
  'Regressed',
  /** Some better, some worse. A person decides. */
  'Mixed',
  /** Not enough cases ran to say anything. */
  'Inconclusive',
] as const;
export type RegressionVerdict = (typeof REGRESSION_VERDICTS)[number];

export interface CaseOutcome {
  caseId: string;
  currentPassed: boolean | null;
  candidatePassed: boolean | null;
}

/**
 * Compare a candidate version against the live one, case by case.
 *
 * ## Why `Regressed` is separate from `Mixed`
 *
 * Any case the current version passes and the candidate fails is a **regression**, whatever else
 * improved. That is the finding somebody publishing needs to see on its own, because "eight
 * better, one worse" is a decision and "one thing that used to work no longer does" is a
 * blocker until somebody accepts it deliberately.
 *
 * ## Why an unjudged case is inconclusive rather than passing
 *
 * A `HumanJudged` case with no verdict counts as neither. Treating it as a pass would let a
 * comparison report `Improved` on the strength of cases nobody looked at.
 */
export function compareVersions(outcomes: readonly CaseOutcome[]): {
  verdict: RegressionVerdict;
  casesCompared: number;
  regressions: string[];
  improvements: string[];
  unjudged: string[];
} {
  const regressions: string[] = [];
  const improvements: string[] = [];
  const unjudged: string[] = [];
  let compared = 0;

  for (const outcome of outcomes) {
    if (outcome.currentPassed === null || outcome.candidatePassed === null) {
      unjudged.push(outcome.caseId);
      continue;
    }

    compared += 1;
    if (outcome.currentPassed && !outcome.candidatePassed) {
      regressions.push(outcome.caseId);
    } else if (!outcome.currentPassed && outcome.candidatePassed) {
      improvements.push(outcome.caseId);
    }
  }

  if (compared === 0) {
    return { verdict: 'Inconclusive', casesCompared: 0, regressions, improvements, unjudged };
  }

  const verdict: RegressionVerdict =
    regressions.length > 0 && improvements.length > 0
      ? 'Mixed'
      : regressions.length > 0
        ? 'Regressed'
        : improvements.length > 0
          ? 'Improved'
          : 'NoChange';

  return { verdict, casesCompared: compared, regressions, improvements, unjudged };
}

// ---------------------------------------------------------------------------
// Skill Candidates
// ---------------------------------------------------------------------------

/**
 * A missing capability, recorded rather than improvised.
 *
 * The client's rule: when the router finds nothing, it creates or suggests a **Skill
 * Candidate/Draft** and routes it to authorized governance — and **never silently publishes or
 * auto-uses it**.
 *
 * So a Candidate is not a Skill. It is a request, with the context that produced it, and its only
 * outcomes are: somebody accepts it and a **Draft** Skill is created for the normal lifecycle, or
 * somebody rejects it with a reason. There is no path from Candidate to Published.
 */
export const CANDIDATE_STATUSES = ['Suggested', 'UnderReview', 'Accepted', 'Rejected'] as const;
export type CandidateStatus = (typeof CANDIDATE_STATUSES)[number];

export const CANDIDATE_STATUS_LABELS: Record<CandidateStatus, string> = {
  Suggested: 'Suggested',
  UnderReview: 'Under review',
  Accepted: 'Accepted — draft created',
  Rejected: 'Rejected',
};

export const ALLOWED_CANDIDATE_TRANSITIONS: Record<CandidateStatus, readonly CandidateStatus[]> = {
  Suggested: ['UnderReview', 'Accepted', 'Rejected'],
  UnderReview: ['Accepted', 'Rejected'],
  // Both terminal. Accepting creates a Draft Skill, which then has its own lifecycle; a
  // Candidate that could be re-opened would be a second, weaker lifecycle beside it.
  Accepted: [],
  Rejected: [],
};

export function mayTransitionCandidate(from: CandidateStatus, to: CandidateStatus): boolean {
  return ALLOWED_CANDIDATE_TRANSITIONS[from].includes(to);
}

/**
 * Re-exported so a caller checking "may this version still be edited" asks one function.
 *
 * The router and the evaluation harness both need it — a case may be attached to a frozen
 * version, and its **expectations** must then be frozen too, or the evidence could be edited to
 * match the result.
 */
export { isSkillContentFrozen };
