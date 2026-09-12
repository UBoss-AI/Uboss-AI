import {
  isScopeNoWiderThan,
  narrowerScope,
  POLICY_LAYER_ORDER,
  USER_TYPE_CEILINGS,
  type Action,
  type AuthorizationDecision,
  type AuthorizationTraceStep,
  type ModuleKey,
  type PolicyEffect,
  type PolicyLayer,
  type ScopeKind,
  type UserType,
} from './authorization.js';

/**
 * The policy precedence engine.
 *
 * ## The rule being implemented
 *
 * `Platform → Company → Department → Objective → Engine Agent`, and **lower levels may be
 * stricter, never weaker than a mandatory higher-level control.**
 *
 * Taken literally, "never weaker" would mean no lower layer could relax anything a higher layer
 * said — which would make a company unable to grant an exception to its own advisory default, and
 * would make the word "mandatory" in the rule redundant. So the rule is implemented with the
 * distinction the word implies:
 *
 *   * **Any** restriction tightens. Effects intersect down the chain, so a lower layer can always
 *     narrow a scope, hide a module, or remove an action.
 *   * A restriction marked **mandatory** is sealed. No lower layer can lift it, and an attempt to
 *     is recorded in the trace as a refused override rather than silently ignored.
 *   * A restriction **not** marked mandatory is a default. A lower layer may explicitly `Allow`
 *     past it — that is how a Department grants an exception to a Company-wide default.
 *
 * ## Why this is a pure function
 *
 * It takes a resolved input and returns a decision. No database, no request context, no clock.
 * That is deliberate: this is the one piece of the system where a subtle mistake is a
 * privilege-escalation bug, and a pure function can be exhaustively tested — including the
 * escalation negatives — without a fixture in sight. Everything stateful lives in the service
 * that assembles the input.
 */

/** One policy statement at one layer. */
export interface PolicyRule {
  layer: PolicyLayer;
  /**
   * Which module the rule applies to. `null` means every module — the form a broad platform or
   * company control takes.
   */
  module: ModuleKey | null;
  /** Which action. `null` means every action. */
  action: Action | null;
  effect: PolicyEffect;
  /**
   * Sealed against lower layers. Only meaningful on a `Deny`: a mandatory `Allow` would be a
   * grant that lower layers cannot tighten, which is the one thing the precedence rule forbids.
   */
  mandatory: boolean;
  /** A scope ceiling this layer imposes, if any. Only ever narrows. */
  maxScope?: ScopeKind | undefined;
  /** Shown in the trace, and in the denial message when this rule is the one that refused. */
  reason: string;
}

/** Everything the engine needs, already resolved by the caller. */
export interface PrecedenceInput {
  userType: UserType;
  module: ModuleKey;
  action: Action;
  /**
   * What the person's role assignments grant on this module. Already the union across their
   * assignments, and already intersected with each role template's own ceiling.
   */
  grantedActions: readonly Action[];
  /** Modules the person's assignments make visible. */
  visibleModules: readonly ModuleKey[];
  /** The widest scope their assignments give. Layers may narrow it, never widen it. */
  assignedScope: ScopeKind;
  /** Every rule that could apply, in any order — the engine sorts by layer itself. */
  rules: readonly PolicyRule[];
}

export interface PrecedenceResult {
  allowed: boolean;
  effectiveScope: ScopeKind;
  decision: AuthorizationDecision;
}

/**
 * Does a rule apply to this (module, action)?
 *
 * A `null` module or action is a wildcard, which is how a broad control ("no Export anywhere in
 * this company") is expressed without enumerating the matrix.
 */
function applies(rule: PolicyRule, module: ModuleKey, action: Action): boolean {
  return (
    (rule.module === null || rule.module === module) &&
    (rule.action === null || rule.action === action)
  );
}

/**
 * Evaluate one (module, action) against everything.
 *
 * Order of checks is not arbitrary — it runs from the least conditional to the most, so that a
 * denial always names the outermost reason. Someone refused because they are a guest should be
 * told that, not told their scope was wrong.
 */
export function evaluatePrecedence(input: PrecedenceInput): PrecedenceResult {
  const trace: AuthorizationTraceStep[] = [];

  // ---- 1. The user type ceiling. Outermost, and no role can lift it. ----
  const ceiling = USER_TYPE_CEILINGS[input.userType];
  if (ceiling.forbidden.includes(input.action)) {
    trace.push({
      layer: 'UserType',
      outcome: 'deny',
      detail: `${input.userType} may never ${input.action}.`,
    });
    return {
      allowed: false,
      effectiveScope: input.assignedScope,
      decision: {
        allowed: false,
        reason: 'user-type-ceiling',
        message: `This action is not available to a ${labelUserType(input.userType)}.`,
        effectiveScope: input.assignedScope,
        trace,
      },
    };
  }
  trace.push({
    layer: 'UserType',
    outcome: 'noop',
    detail: `${input.userType} does not forbid ${input.action}.`,
  });

  // ---- 2. Module visibility. ----
  if (!input.visibleModules.includes(input.module)) {
    trace.push({
      layer: 'Role',
      outcome: 'deny',
      detail: `No assignment makes "${input.module}" visible.`,
    });
    return {
      allowed: false,
      effectiveScope: input.assignedScope,
      decision: {
        allowed: false,
        reason: 'module-not-visible',
        message: 'You do not have access to that part of UBoss.',
        effectiveScope: input.assignedScope,
        trace,
      },
    };
  }

  // ---- 3. Does any role actually grant the action? ----
  if (!input.grantedActions.includes(input.action)) {
    trace.push({
      layer: 'Role',
      outcome: 'deny',
      detail: `Granted on "${input.module}": ${format(input.grantedActions)}. Missing ${input.action}.`,
    });
    return {
      allowed: false,
      effectiveScope: input.assignedScope,
      decision: {
        allowed: false,
        reason: 'role-lacks-action',
        message: `Your role does not include "${input.action}" on this.`,
        effectiveScope: input.assignedScope,
        trace,
      },
    };
  }
  trace.push({
    layer: 'Role',
    outcome: 'allow',
    detail: `Role grants ${input.action} on "${input.module}".`,
  });

  // ---- 4. The policy chain, outermost first. ----
  const ordered = [...input.rules]
    .filter((rule) => applies(rule, input.module, input.action))
    .sort((a, b) => POLICY_LAYER_ORDER[a.layer] - POLICY_LAYER_ORDER[b.layer]);

  let effectiveScope = input.assignedScope;
  /** The mandatory denial in force, if one has been set by an outer layer. */
  let sealedDenial: PolicyRule | undefined;
  /** The current non-mandatory denial, which a lower layer may still lift. */
  let standingDenial: PolicyRule | undefined;

  for (const rule of ordered) {
    // A scope ceiling only ever narrows, whichever layer sets it and whatever it says. A layer
    // asking for a *wider* scope is the escalation this whole file exists to prevent.
    if (rule.maxScope !== undefined) {
      if (isScopeNoWiderThan(rule.maxScope, effectiveScope)) {
        effectiveScope = rule.maxScope;
        trace.push({
          layer: rule.layer,
          outcome: 'narrow',
          detail: `Scope narrowed to ${rule.maxScope}: ${rule.reason}`,
        });
      } else {
        trace.push({
          layer: rule.layer,
          outcome: 'noop',
          detail:
            `Ignored an attempt to widen scope from ${effectiveScope} to ${rule.maxScope}. ` +
            'A policy layer may only narrow.',
        });
      }
    }

    if (rule.effect === 'Deny') {
      if (rule.mandatory) {
        sealedDenial = rule;
        trace.push({
          layer: rule.layer,
          outcome: 'deny',
          detail: `Mandatory denial, sealed against lower layers: ${rule.reason}`,
        });
      } else {
        standingDenial = rule;
        trace.push({
          layer: rule.layer,
          outcome: 'deny',
          detail: `Denied (a lower layer may grant an exception): ${rule.reason}`,
        });
      }
      continue;
    }

    // An explicit Allow. It can lift a standing default, and it can never lift a sealed one.
    if (sealedDenial) {
      trace.push({
        layer: rule.layer,
        outcome: 'noop',
        detail: `Refused to override the mandatory ${sealedDenial.layer} control: ${sealedDenial.reason}`,
      });
      continue;
    }

    if (standingDenial) {
      trace.push({
        layer: rule.layer,
        outcome: 'allow',
        detail: `Exception granted to the ${standingDenial.layer} default: ${rule.reason}`,
      });
      standingDenial = undefined;
      continue;
    }

    trace.push({
      layer: rule.layer,
      outcome: 'noop',
      detail: `Allow with nothing to override: ${rule.reason}`,
    });
  }

  const blocking = sealedDenial ?? standingDenial;
  if (blocking) {
    return {
      allowed: false,
      effectiveScope,
      decision: {
        allowed: false,
        reason: 'policy-denied',
        message: blocking.reason,
        decidedBy: blocking.layer,
        effectiveScope,
        trace,
      },
    };
  }

  return {
    allowed: true,
    effectiveScope,
    decision: {
      allowed: true,
      message: 'Permitted.',
      effectiveScope,
      trace,
    },
  };
}

/**
 * The effective scope for a (module, action), ignoring whether it is permitted.
 *
 * Used by list endpoints, which need to know how wide a query to run *before* they have a
 * resource to check. Deliberately separate from `evaluatePrecedence` so a caller cannot mistake
 * "how far can they see" for "may they do this".
 */
export function effectiveScopeFor(
  assignedScope: ScopeKind,
  module: ModuleKey,
  action: Action,
  rules: readonly PolicyRule[],
): ScopeKind {
  let scope = assignedScope;

  for (const rule of [...rules]
    .filter((candidate) => applies(candidate, module, action) && candidate.maxScope !== undefined)
    .sort((a, b) => POLICY_LAYER_ORDER[a.layer] - POLICY_LAYER_ORDER[b.layer])) {
    scope = narrowerScope(scope, rule.maxScope as ScopeKind);
  }

  return scope;
}

/**
 * The set of actions permitted on a module, for a whole permission matrix.
 *
 * The internal permission test page and any future permissions screen need the matrix, and
 * computing it by calling `evaluatePrecedence` per action is both correct and the only way to
 * guarantee the matrix and the enforcement agree. There is no second implementation to drift.
 */
export function permittedActions(
  input: Omit<PrecedenceInput, 'action'>,
  actions: readonly Action[],
): readonly Action[] {
  return actions.filter((action) => evaluatePrecedence({ ...input, action }).allowed);
}

function format(actions: readonly Action[]): string {
  return actions.length === 0 ? 'nothing' : actions.join(', ');
}

function labelUserType(userType: UserType): string {
  return userType === 'ExternalGuest'
    ? 'External Guest'
    : userType === 'PlatformUser'
      ? 'Platform User'
      : 'Internal User';
}
