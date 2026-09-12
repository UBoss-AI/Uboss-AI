import {
  classificationAllowed,
  DEFAULT_DATA_CLASSIFICATION,
  type DataClassification,
} from './classification.js';
import { AGENT_MEMORY_MODES, type AgentMemoryMode } from './agents.js';

/**
 * Engine Agent memory — Prompt 33.
 *
 * ## What the approved documents actually say
 *
 * §19 gives four modes and one technical rule each, and those rules are already transcribed in
 * `AGENT_MEMORY_MODE_RULES` (Prompt 25). This module is the *enforcement*: §27.1 requires that for
 * each mode UBoss "define retention, visibility, deletion, cross-user/objective sharing limits,
 * sensitive-data restrictions and offboarding behavior", plus two absolutes:
 *
 * > Never use unrestricted cross-tenant or cross-user memory.
 * > Sensitive data classification controls whether a memory record can be persisted.
 *
 * ## Every number here is configuration, because the documents state none
 *
 * The same situation as Prompt 31's commercial terms: the client requires retention to be
 * *defined*, and defines no period. So each mode carries a policy row with a documented,
 * conservative default, and the engine reads the policy rather than deciding. Nothing here
 * hard-codes a rule a company's contract would override.
 *
 * The one thing that is **not** configurable is the cross-tenant rule. There is no policy field
 * for it, no flag to set and no code path that could express it — a memory record is written
 * inside a tenant transaction against an RLS-protected table, so "cross-tenant memory" is not a
 * setting a company could get wrong. That is deliberate: §19 calls it "never", and a `never` that
 * appears in a settings screen is not a never.
 */

// ---------------------------------------------------------------------------
// Visibility
// ---------------------------------------------------------------------------

/**
 * Who a memory record may be read back by.
 *
 * Derived from §19's per-mode rules rather than invented:
 *
 *   * `SameRun` — Current Run Only: "ephemeral context deleted/expired after run retention".
 *   * `SameObjective` — Objective Memory: "visible only to same Objective scope and authorized
 *     Agent versions".
 *   * `SameAgent` — Agent Memory: "reusable by same Engine Agent".
 *   * `CompanyWide` — only reachable by Approved Long-Term Memory, and only with an approval.
 */
export const MEMORY_VISIBILITIES = [
  'SameRun',
  'SameObjective',
  'SameAgent',
  'CompanyWide',
] as const;
export type MemoryVisibility = (typeof MEMORY_VISIBILITIES)[number];

export const MEMORY_VISIBILITY_LABELS: Record<MemoryVisibility, string> = {
  SameRun: 'This run only',
  SameObjective: 'The same Objective',
  SameAgent: 'The same Engine Agent',
  CompanyWide: 'Anywhere in the company',
};

/**
 * The **widest** visibility each mode may ever be configured to.
 *
 * A ceiling, not a setting. A company may narrow Agent Memory to `SameObjective`; it may not widen
 * Objective Memory to `SameAgent`, because §19's rule for that mode is "visible only to same
 * Objective scope" and a policy field that could contradict the approved document would make the
 * document advisory.
 */
export const MEMORY_MODE_MAX_VISIBILITY: Record<AgentMemoryMode, MemoryVisibility> = {
  CurrentRunOnly: 'SameRun',
  ObjectiveMemory: 'SameObjective',
  AgentMemory: 'SameAgent',
  ApprovedLongTermMemory: 'CompanyWide',
};

export function visibilityRank(visibility: MemoryVisibility): number {
  return MEMORY_VISIBILITIES.indexOf(visibility);
}

/** Whether a configured visibility is within the mode's ceiling. */
export function visibilityWithinMode(mode: AgentMemoryMode, visibility: MemoryVisibility): boolean {
  return visibilityRank(visibility) <= visibilityRank(MEMORY_MODE_MAX_VISIBILITY[mode]);
}

// ---------------------------------------------------------------------------
// Offboarding
// ---------------------------------------------------------------------------

/**
 * What happens to a person's memory records when they leave.
 *
 * §27.1 asks for "offboarding behavior" per mode and names no behaviour, so all three defensible
 * options exist and the company chooses. The distinction that matters:
 *
 *   * `DeleteOnOffboarding` — the record goes. Correct for anything personal to that individual.
 *   * `TransferToSuccessor` — the record survives, owned by the successor the offboarding names.
 *     Correct for work knowledge that belongs to the role rather than the person.
 *   * `RetainAnonymised` — the content survives with the owner detached. Correct where the company
 *     needs the knowledge and nobody needs to know whose it was.
 *
 * Prompt 13's offboarding already "preserves historical accountability while removing future
 * access", and none of these three contradict it: a memory record is working context, not an audit
 * record, and deleting one removes no accountability — the audit trail of who wrote it is
 * append-only and untouched.
 */
export const MEMORY_OFFBOARDING_BEHAVIOURS = [
  'DeleteOnOffboarding',
  'TransferToSuccessor',
  'RetainAnonymised',
] as const;
export type MemoryOffboardingBehaviour = (typeof MEMORY_OFFBOARDING_BEHAVIOURS)[number];

export const MEMORY_OFFBOARDING_LABELS: Record<MemoryOffboardingBehaviour, string> = {
  DeleteOnOffboarding: 'Delete it',
  TransferToSuccessor: 'Transfer it to their successor',
  RetainAnonymised: 'Keep it, without the owner',
};

// ---------------------------------------------------------------------------
// The policy
// ---------------------------------------------------------------------------

/** One mode's governed behaviour, for one company. */
export interface MemoryPolicy {
  mode: AgentMemoryMode;
  /**
   * How long a record survives, in days. `null` means it does not expire on its own — which is
   * only permitted for `ApprovedLongTermMemory`, because a record that never expires is exactly
   * what "approved long-term" means and exactly what the other three modes are not.
   */
  retentionDays: number | null;
  visibility: MemoryVisibility;
  /** The most sensitive class this mode may persist at all. */
  maxClassification: DataClassification;
  /** Whether one person's memory may be read back on behalf of another. */
  allowCrossUser: boolean;
  /** Whether a record written under one Objective may be read under another. */
  allowCrossObjective: boolean;
  offboardingBehaviour: MemoryOffboardingBehaviour;
  /**
   * Whether writing a record in this mode needs an approval first.
   *
   * True only for `ApprovedLongTermMemory` by default, and that is where the mode's name comes
   * from — §19's rule for it is "explicit governance", and a long-term memory nobody approved is
   * not governed.
   */
  requiresApproval: boolean;
}

/**
 * The defaults, and the reasoning for each number.
 *
 * Conservative throughout, because the cost of too short a retention is that an agent re-reads
 * something, and the cost of too long is that a company is holding data it did not intend to.
 *
 *   * **Current run only — 1 day.** §19 says "deleted/expired after run retention window" and
 *     names no window. A day outlives any run, including a retried one, and outlives the
 *     dead-letter inspection a failed run gets.
 *   * **Objective memory — 90 days.** An Objective's working life. Long enough that a monthly
 *     recurrence still has last month's context.
 *   * **Agent memory — 180 days.** Half a year of reusable working knowledge for one agent.
 *   * **Approved long-term — no expiry.** The point of the mode.
 *
 * The classification ceilings are the substantive decision: **only `ApprovedLongTermMemory` may
 * persist `Confidential` data, and nothing may persist `Restricted` by default.** §19 makes
 * classification the control over persistence, and the strictest class is the one where a company
 * should have to make the decision deliberately rather than inherit it.
 */
export const DEFAULT_MEMORY_POLICIES: Record<AgentMemoryMode, MemoryPolicy> = {
  CurrentRunOnly: {
    mode: 'CurrentRunOnly',
    retentionDays: 1,
    visibility: 'SameRun',
    // The ephemeral mode may hold sensitive context while the run is in flight — it is the only
    // way a run can work on a confidential document at all — and it is gone within the day.
    maxClassification: 'Confidential',
    allowCrossUser: false,
    allowCrossObjective: false,
    offboardingBehaviour: 'DeleteOnOffboarding',
    requiresApproval: false,
  },
  ObjectiveMemory: {
    mode: 'ObjectiveMemory',
    retentionDays: 90,
    visibility: 'SameObjective',
    maxClassification: 'Internal',
    allowCrossUser: false,
    allowCrossObjective: false,
    offboardingBehaviour: 'TransferToSuccessor',
    requiresApproval: false,
  },
  AgentMemory: {
    mode: 'AgentMemory',
    retentionDays: 180,
    visibility: 'SameAgent',
    maxClassification: 'Internal',
    allowCrossUser: false,
    allowCrossObjective: false,
    offboardingBehaviour: 'RetainAnonymised',
    requiresApproval: false,
  },
  ApprovedLongTermMemory: {
    mode: 'ApprovedLongTermMemory',
    retentionDays: null,
    visibility: 'CompanyWide',
    maxClassification: 'Confidential',
    // Company-wide by definition, so cross-user reading is the mode rather than an exception —
    // but it is the mode that needs an approval before anything is written at all.
    allowCrossUser: true,
    allowCrossObjective: true,
    offboardingBehaviour: 'RetainAnonymised',
    requiresApproval: true,
  },
};

/**
 * The longest retention a company may configure, in days.
 *
 * Ten years, and it applies to the three expiring modes. Not a policy the documents state — it is
 * a guard against a typo: `retentionDays: 36500` entered as `365000` would be a thousand-year
 * retention nobody meant, and the mode for keeping something indefinitely already exists and
 * requires an approval.
 */
export const MAX_MEMORY_RETENTION_DAYS = 3_650;

/**
 * Why a policy would be refused.
 *
 * Returned as a list rather than thrown one at a time, so a settings screen can show every
 * problem at once instead of making somebody fix them in sequence.
 */
export function memoryPolicyProblems(policy: MemoryPolicy): string[] {
  const problems: string[] = [];

  if (!visibilityWithinMode(policy.mode, policy.visibility)) {
    problems.push(
      `${policy.mode} cannot be visible to ${MEMORY_VISIBILITY_LABELS[
        policy.visibility
      ].toLowerCase()}. Its widest permitted visibility is ` +
        `"${MEMORY_VISIBILITY_LABELS[MEMORY_MODE_MAX_VISIBILITY[policy.mode]]}", which the ` +
        'approved architecture sets for this mode.',
    );
  }

  if (policy.retentionDays === null && policy.mode !== 'ApprovedLongTermMemory') {
    problems.push(
      `${policy.mode} must expire. Only Approved Long-Term Memory may be kept indefinitely, and ` +
        'it needs an approval before anything is written.',
    );
  }

  if (policy.retentionDays !== null) {
    if (!Number.isInteger(policy.retentionDays) || policy.retentionDays < 1) {
      problems.push('Retention must be a whole number of days, at least one.');
    } else if (policy.retentionDays > MAX_MEMORY_RETENTION_DAYS) {
      problems.push(
        `Retention cannot exceed ${MAX_MEMORY_RETENTION_DAYS} days. To keep something ` +
          'indefinitely, use Approved Long-Term Memory, which requires an approval.',
      );
    }
  }

  if (
    policy.mode === 'CurrentRunOnly' &&
    policy.retentionDays !== null &&
    policy.retentionDays > 7
  ) {
    problems.push(
      'Current Run Only is ephemeral context. Keeping it longer than a week makes it a different ' +
        'mode under the same name — use Agent Memory if the agent should remember.',
    );
  }

  if (policy.mode === 'ApprovedLongTermMemory' && !policy.requiresApproval) {
    problems.push(
      'Approved Long-Term Memory requires an approval. Without one it is not approved, and the ' +
        'architecture calls for "explicit governance" on this mode specifically.',
    );
  }

  if (policy.allowCrossUser && visibilityRank(policy.visibility) < visibilityRank('CompanyWide')) {
    problems.push(
      'Cross-user reading needs company-wide visibility. A record scoped to one Objective or one ' +
        'agent that any user may read is the "unrestricted cross-user memory" the architecture ' +
        'forbids.',
    );
  }

  if (policy.allowCrossObjective && policy.visibility === 'SameObjective') {
    problems.push(
      'A record visible only to the same Objective cannot also be readable across Objectives.',
    );
  }

  return problems;
}

/** Every mode has a policy, and every policy is coherent. Asserted by a test, not assumed. */
export function everyModeHasACoherentDefault(): boolean {
  return AGENT_MEMORY_MODES.every(
    (mode) => memoryPolicyProblems(DEFAULT_MEMORY_POLICIES[mode]).length === 0,
  );
}

// ---------------------------------------------------------------------------
// Writing
// ---------------------------------------------------------------------------

/** What a caller wants to remember. */
export interface MemoryWriteRequest {
  mode: AgentMemoryMode;
  classification: DataClassification;
  /** The run that produced it. Always present: a memory record has a provenance or it has none. */
  runId: string;
  objectiveId: string | null;
  engineAgentId: string;
  ownerUserId: string | null;
  /** Whether an approval has been verified, for the mode that needs one. */
  approvalRequestId: string | null;
}

export type MemoryWriteDecision =
  | { persist: true; expiresAt: Date | null; visibility: MemoryVisibility }
  | { persist: false; reason: string };

/**
 * Whether a record may be persisted, and until when.
 *
 * The four refusals, in the order they are checked:
 *
 * 1. **Too sensitive for the mode.** §19's rule, and the only one the document states as a rule
 *    about persistence: classification controls whether a record can be persisted at all.
 * 2. **`ObjectiveMemory` with no Objective.** The mode's visibility is "the same Objective", so a
 *    record with no Objective would be visible to nothing — or, worse, to everything, depending on
 *    how the read query treated the null. Refused rather than resolved.
 * 3. **An approval the mode requires and the caller has not got.** Passed as a verified id rather
 *    than a boolean, for the reason Prompt 28 established: a boolean is a claim, an id is a
 *    record.
 * 4. **A run that did not happen.** Not checked here — the service checks the run exists in this
 *    tenant, because this function has no database.
 */
export function decideMemoryWrite(
  request: MemoryWriteRequest,
  policy: MemoryPolicy,
  now: Date,
): MemoryWriteDecision {
  if (policy.mode !== request.mode) {
    return {
      persist: false,
      reason: `The policy for ${policy.mode} cannot govern a ${request.mode} record.`,
    };
  }

  if (!classificationAllowed(request.classification, policy.maxClassification)) {
    return {
      persist: false,
      reason:
        `${request.classification} data cannot be kept as ${request.mode}. This company permits ` +
        `up to ${policy.maxClassification} in this mode. The run may still work with it — this ` +
        'refuses to *remember* it.',
    };
  }

  if (request.mode === 'ObjectiveMemory' && request.objectiveId === null) {
    return {
      persist: false,
      reason:
        'Objective Memory is visible only within its Objective, so a record with no Objective ' +
        'has no scope to be visible in.',
    };
  }

  if (policy.requiresApproval && request.approvalRequestId === null) {
    return {
      persist: false,
      reason:
        `${request.mode} needs an approval before anything is written. Raise one and pass the ` +
        'approved request.',
    };
  }

  return {
    persist: true,
    expiresAt:
      policy.retentionDays === null
        ? null
        : new Date(now.getTime() + policy.retentionDays * 86_400_000),
    visibility: policy.visibility,
  };
}

// ---------------------------------------------------------------------------
// Reading
// ---------------------------------------------------------------------------

/** A stored record, as much of it as a visibility decision needs. */
export interface MemoryRecordScope {
  mode: AgentMemoryMode;
  visibility: MemoryVisibility;
  runId: string;
  objectiveId: string | null;
  engineAgentId: string;
  ownerUserId: string | null;
  expiresAt: Date | null;
  deletedAt: Date | null;
}

/** Who is asking, and on whose behalf. */
export interface MemoryReadContext {
  runId: string;
  objectiveId: string | null;
  engineAgentId: string;
  onBehalfOfUserId: string | null;
  now: Date;
}

/**
 * Whether one record is readable in one context.
 *
 * **The cross-tenant case is absent on purpose.** A record and a reader are both inside one
 * tenant transaction against an RLS-protected table, so a record from another company is not
 * something this function could be asked about — it would never have been read from the database.
 * Expressing it here as a check would imply the rows could arrive, which is the belief that leads
 * to a query somebody forgets to scope.
 */
export function memoryReadable(
  record: MemoryRecordScope,
  context: MemoryReadContext,
  policy: MemoryPolicy,
): boolean {
  if (record.deletedAt !== null) return false;
  if (record.expiresAt !== null && record.expiresAt.getTime() <= context.now.getTime()) {
    return false;
  }

  // Cross-user is checked before scope, because it is the absolute: §19's "never unrestricted
  // cross-user memory" holds however narrow the scope is.
  if (
    record.ownerUserId !== null &&
    context.onBehalfOfUserId !== null &&
    record.ownerUserId !== context.onBehalfOfUserId &&
    !policy.allowCrossUser
  ) {
    return false;
  }

  switch (record.visibility) {
    case 'SameRun':
      return record.runId === context.runId;
    case 'SameObjective':
      // A null Objective on either side never matches. Two records with no Objective are not
      // "the same Objective" — they are two records with no scope, and treating null as a
      // matching value is how a scoped read becomes a company-wide one.
      return (
        record.objectiveId !== null &&
        context.objectiveId !== null &&
        record.objectiveId === context.objectiveId
      );
    case 'SameAgent':
      if (record.engineAgentId !== context.engineAgentId) return false;
      return (
        policy.allowCrossObjective ||
        record.objectiveId === null ||
        record.objectiveId === context.objectiveId
      );
    case 'CompanyWide':
      return true;
  }
}

// ---------------------------------------------------------------------------
// Expiry and deletion
// ---------------------------------------------------------------------------

/** Records whose retention has run out, for the sweep. */
export function expiredMemoryIds(
  records: readonly { id: string; expiresAt: Date | null; deletedAt: Date | null }[],
  now: Date,
): string[] {
  return records
    .filter(
      (record) =>
        record.deletedAt === null &&
        record.expiresAt !== null &&
        record.expiresAt.getTime() <= now.getTime(),
    )
    .map((record) => record.id);
}

/** What offboarding does to one record, under the policy for its mode. */
export type OffboardingOutcome =
  | { action: 'Delete' }
  | { action: 'Transfer'; toUserId: string }
  | { action: 'Anonymise' }
  | { action: 'Leave'; reason: string };

/**
 * What happens to one of a leaver's records.
 *
 * `TransferToSuccessor` with no successor falls back to **deletion**, not to leaving the record
 * owned by somebody who has left. Prompt 13's offboarding makes a successor optional, and a
 * record owned by a departed person is access nobody reviews — so the fallback is the stricter of
 * the two, and it says which it took.
 */
export function offboardingOutcome(
  policy: MemoryPolicy,
  successorUserId: string | null,
): OffboardingOutcome {
  switch (policy.offboardingBehaviour) {
    case 'DeleteOnOffboarding':
      return { action: 'Delete' };
    case 'TransferToSuccessor':
      return successorUserId === null
        ? { action: 'Delete' }
        : { action: 'Transfer', toUserId: successorUserId };
    case 'RetainAnonymised':
      return { action: 'Anonymise' };
  }
}

/**
 * The classification a record takes when the caller supplies none.
 *
 * The product-wide default, so memory does not get its own. An unlabelled memory record is one
 * nobody classified, and `Internal` is the right way to be wrong (see `classification.ts`).
 */
export const DEFAULT_MEMORY_CLASSIFICATION: DataClassification = DEFAULT_DATA_CLASSIFICATION;
