import type { Action, DenialReason, ScopeKind, SodRule } from './authorization.js';

/**
 * Scope evaluation and separation of duties.
 *
 * Both answer questions about a **specific resource**, which is why they are separate from the
 * precedence engine: a guard cannot know the resource before the handler has loaded it. The
 * two-phase shape is deliberate — the guard answers "could this role ever do this", the handler
 * answers "may they do it to *this row*".
 */

/**
 * What the authorization engine needs to know about the thing being acted on.
 *
 * Assembled by the handler from whatever it already loaded, so no extra query is needed in the
 * common case. Every field is optional except the id, because a resource that has no department
 * (a personal to-do) must still be checkable.
 */
export interface ResourceDescriptor {
  id: string;
  /** Who the resource belongs to. Drives `OwnWork`. */
  ownerUserId?: string | undefined;
  /**
   * Who created it. Drives separation of duties — distinct from the owner, because work is
   * routinely reassigned and the person who *wrote* something is the one who must not approve it.
   */
  createdByUserId?: string | undefined;
  /** Which department it sits in. Drives `Department` and `MultipleDepartments`. */
  departmentId?: string | undefined;
  /**
   * People who have already acted on this resource in the way now being attempted. Drives
   * `FourEyes`. Empty when the caller has no approval history to supply.
   */
  priorActorUserIds?: readonly string[] | undefined;
}

/** A person's scope, as granted by one role assignment. */
export interface ScopeGrant {
  kind: ScopeKind;
  /** For `SelectedResource`. */
  selectedResourceIds?: readonly string[] | undefined;
  /** For `Department` and `MultipleDepartments`. */
  departmentIds?: readonly string[] | undefined;
}

/**
 * Resolves the reporting tree, for `TeamSubtree`.
 *
 * A seam, not an implementation: the hierarchy and reporting-manager model arrives at Prompt 12.
 * Until a resolver is registered, `TeamSubtree` **cannot be evaluated** and fails closed — which
 * is the honest behaviour. Defaulting it to "allow" would silently make a manager's scope the
 * whole company; defaulting to `OwnWork` would look like it worked and quietly withhold access.
 * A distinct `scope-unevaluable` denial says which it is.
 */
export interface HierarchyResolver {
  /** Is `subjectUserId` at or beneath `managerUserId` in the reporting tree? */
  isInSubtree(input: {
    tenantId: string;
    managerUserId: string;
    subjectUserId: string;
  }): Promise<boolean>;
}

export type ScopeOutcome =
  | { inScope: true; detail: string }
  | {
      inScope: false;
      reason: Extract<DenialReason, 'out-of-scope' | 'scope-unevaluable'>;
      detail: string;
    };

/**
 * Is a resource inside a scope grant?
 *
 * Synchronous for every scope that can be decided from the descriptor and the grant alone, which
 * is all of them except `TeamSubtree`. That one needs the reporting tree and is handled by
 * `isInScopeAsync`; calling this with it returns `scope-unevaluable` rather than guessing.
 */
export function isInScope(input: {
  grant: ScopeGrant;
  resource: ResourceDescriptor;
  actorUserId: string;
}): ScopeOutcome {
  const { grant, resource, actorUserId } = input;

  switch (grant.kind) {
    case 'WholeCompany':
      // The tenant boundary is already enforced by `TenantGuard` and by Row-Level Security, so
      // "whole company" needs no further check — every resource that reached here is in it.
      return { inScope: true, detail: 'Whole-company scope.' };

    case 'OwnWork':
      return resource.ownerUserId === actorUserId
        ? { inScope: true, detail: 'The resource belongs to the actor.' }
        : {
            inScope: false,
            reason: 'out-of-scope',
            detail: 'Own-work scope, and this resource belongs to someone else.',
          };

    case 'SelectedResource': {
      const selected = grant.selectedResourceIds ?? [];
      return selected.includes(resource.id)
        ? { inScope: true, detail: 'The resource is explicitly selected.' }
        : {
            inScope: false,
            reason: 'out-of-scope',
            detail:
              selected.length === 0
                ? 'Selected-resource scope with nothing selected.'
                : 'The resource is not among those selected.',
          };
    }

    case 'Department':
    case 'MultipleDepartments': {
      const departments = grant.departmentIds ?? [];
      if (departments.length === 0) {
        return {
          inScope: false,
          reason: 'out-of-scope',
          detail: 'Department scope with no department assigned.',
        };
      }
      if (resource.departmentId === undefined) {
        // Fails closed rather than treating "no department" as a wildcard: the resource may well
        // belong to a department nobody has recorded yet.
        return {
          inScope: false,
          reason: 'out-of-scope',
          detail: 'The resource has no department, so a department scope cannot include it.',
        };
      }
      return departments.includes(resource.departmentId)
        ? { inScope: true, detail: `The resource is in an assigned department.` }
        : {
            inScope: false,
            reason: 'out-of-scope',
            detail: 'The resource is in a department outside this assignment.',
          };
    }

    case 'TeamSubtree':
      return {
        inScope: false,
        reason: 'scope-unevaluable',
        detail:
          'Team/subtree scope needs the reporting hierarchy, which arrives at Prompt 12. ' +
          'Refused rather than guessed — see HierarchyResolver.',
      };

    default: {
      // Exhaustiveness: a new scope kind must be handled explicitly, not fall through to allow.
      const unreachable: never = grant.kind;
      return {
        inScope: false,
        reason: 'out-of-scope',
        detail: `Unhandled scope kind: ${String(unreachable)}`,
      };
    }
  }
}

/**
 * The same check, able to resolve `TeamSubtree` when a hierarchy resolver is available.
 *
 * Separate from the synchronous form so the common path stays synchronous and the one scope that
 * needs a lookup is visibly the exception.
 */
export async function isInScopeAsync(input: {
  grant: ScopeGrant;
  resource: ResourceDescriptor;
  actorUserId: string;
  tenantId: string;
  hierarchy?: HierarchyResolver | undefined;
}): Promise<ScopeOutcome> {
  if (input.grant.kind !== 'TeamSubtree') {
    return isInScope(input);
  }

  if (!input.hierarchy) {
    return isInScope(input);
  }

  if (input.resource.ownerUserId === undefined) {
    return {
      inScope: false,
      reason: 'out-of-scope',
      detail: 'Team scope needs an owner to place the resource in the tree.',
    };
  }

  // The actor's own work is in their own subtree; asking the resolver would be a query to
  // establish something already known.
  if (input.resource.ownerUserId === input.actorUserId) {
    return { inScope: true, detail: 'The resource belongs to the actor.' };
  }

  const inSubtree = await input.hierarchy.isInSubtree({
    tenantId: input.tenantId,
    managerUserId: input.actorUserId,
    subjectUserId: input.resource.ownerUserId,
  });

  return inSubtree
    ? { inScope: true, detail: "The owner reports into the actor's subtree." }
    : {
        inScope: false,
        reason: 'out-of-scope',
        detail: "The owner is outside the actor's subtree.",
      };
}

/**
 * The widest of several grants.
 *
 * A person may hold more than one role assignment, and scope is a union across them — being both
 * an Employee (own work) and an Approver on three named objectives means both, not the narrower.
 * The *policy layers* then narrow the union; that is where tightening happens.
 */
export function widestGrant(grants: readonly ScopeGrant[]): ScopeGrant | undefined {
  if (grants.length === 0) {
    return undefined;
  }

  return grants.reduce((widest, candidate) => {
    const merged = mergeSameKind(widest, candidate);
    if (merged) {
      return merged;
    }
    return scopeRank(candidate.kind) > scopeRank(widest.kind) ? candidate : widest;
  });
}

/** Two grants of the same kind combine their id lists rather than one shadowing the other. */
function mergeSameKind(a: ScopeGrant, b: ScopeGrant): ScopeGrant | undefined {
  if (a.kind !== b.kind) {
    return undefined;
  }
  if (a.kind === 'SelectedResource') {
    return {
      kind: a.kind,
      selectedResourceIds: [
        ...new Set([...(a.selectedResourceIds ?? []), ...(b.selectedResourceIds ?? [])]),
      ],
    };
  }
  if (a.kind === 'Department' || a.kind === 'MultipleDepartments') {
    const departmentIds = [...new Set([...(a.departmentIds ?? []), ...(b.departmentIds ?? [])])];
    return {
      // Two single-department grants are, together, a multiple-department grant. Saying so keeps
      // the kind honest rather than leaving a `Department` grant holding two departments.
      kind: departmentIds.length > 1 ? 'MultipleDepartments' : a.kind,
      departmentIds,
    };
  }
  return a;
}

const SCOPE_RANK: Record<ScopeKind, number> = {
  OwnWork: 0,
  SelectedResource: 1,
  TeamSubtree: 2,
  Department: 3,
  MultipleDepartments: 4,
  WholeCompany: 5,
};

function scopeRank(kind: ScopeKind): number {
  return SCOPE_RANK[kind];
}

// ---------------------------------------------------------------------------
// Separation of duties / four eyes
// ---------------------------------------------------------------------------

/** A configured separation-of-duties control. */
export interface SodPolicy {
  action: Action;
  /** `null` applies the rule on every module. */
  module: string | null;
  rule: SodRule;
  /**
   * Sealed against lower layers, exactly as a mandatory policy rule is. A mandatory four-eyes
   * control on `Approve` is the kind of thing a regulator asks about, and it must not be
   * removable by a department that finds it inconvenient.
   */
  mandatory: boolean;
  reason: string;
}

export type SodOutcome =
  { satisfied: true; detail: string } | { satisfied: false; detail: string; rule: SodRule };

/**
 * Would this action breach a separation-of-duties control?
 *
 * ## Why this is a separate check rather than part of the permission
 *
 * Because it is not about *authority*, it is about *this particular pairing*. The same person with
 * the same role may approve one thing and not another, purely because they wrote the second one.
 * Folding it into the permission set would make it invisible in every permission screen and
 * impossible to explain.
 *
 * ## The Executor Agent
 *
 * This is the hook that makes the locked rule enforceable: the **Executor Agent must never
 * silently bypass or replace a required Human approval.** An automated actor calls exactly this
 * function, gets refused for exactly this reason, and has to escalate. There is no bypass
 * parameter, and adding one would break the rule rather than implement an exception.
 */
export function checkSeparationOfDuties(input: {
  policies: readonly SodPolicy[];
  action: Action;
  module: string;
  actorUserId: string;
  resource: ResourceDescriptor;
  /** True when the actor is an automated agent rather than a person. */
  actingAsAgent?: boolean | undefined;
}): SodOutcome {
  const applicable = input.policies.filter(
    (policy) =>
      policy.action === input.action && (policy.module === null || policy.module === input.module),
  );

  if (applicable.length === 0) {
    return { satisfied: true, detail: 'No separation-of-duties control applies.' };
  }

  for (const policy of applicable) {
    if (policy.rule === 'NoSelfApproval') {
      // Keyed on the creator, not the owner: work is reassigned routinely, and the person who
      // wrote a thing is the one who must not wave it through.
      if (
        input.resource.createdByUserId !== undefined &&
        input.resource.createdByUserId === input.actorUserId
      ) {
        return {
          satisfied: false,
          rule: policy.rule,
          detail: policy.reason,
        };
      }
      continue;
    }

    // FourEyes: at least one *other* person must already have acted, and the actor must not be
    // among them. An automated actor can never satisfy it — two agents are not four eyes, and
    // treating them as such is precisely the silent bypass the locked rule forbids.
    if (input.actingAsAgent === true) {
      return {
        satisfied: false,
        rule: policy.rule,
        detail:
          `${policy.reason} An automated agent cannot satisfy a four-eyes control; this has to ` +
          'be escalated to a person.',
      };
    }

    const priorActors = (input.resource.priorActorUserIds ?? []).filter(
      (userId) => userId !== input.actorUserId,
    );

    if (
      input.resource.createdByUserId !== undefined &&
      input.resource.createdByUserId === input.actorUserId
    ) {
      return { satisfied: false, rule: policy.rule, detail: policy.reason };
    }

    if (priorActors.length === 0) {
      return {
        satisfied: false,
        rule: policy.rule,
        detail: `${policy.reason} This needs a second person: nobody else has acted on it yet.`,
      };
    }
  }

  return { satisfied: true, detail: 'Separation-of-duties controls satisfied.' };
}

/**
 * The strictest applicable control, for display.
 *
 * A screen showing "why can I not approve this" needs the rule that will bite, and a mandatory
 * control outranks an advisory one of the same kind.
 */
export function governingSodPolicy(
  policies: readonly SodPolicy[],
  action: Action,
  module: string,
): SodPolicy | undefined {
  const applicable = policies.filter(
    (policy) => policy.action === action && (policy.module === null || policy.module === module),
  );

  return (
    applicable.find((policy) => policy.mandatory && policy.rule === 'FourEyes') ??
    applicable.find((policy) => policy.rule === 'FourEyes') ??
    applicable.find((policy) => policy.mandatory) ??
    applicable[0]
  );
}
