/**
 * The UBoss authorization vocabulary.
 *
 * Shared between the API and the web application on purpose: a permission the server enforces and
 * a permission the UI renders have to be the *same* value, or the two drift and the UI starts
 * showing controls the server will refuse. This module is the single source of truth for the five
 * dimensions, and nothing outside it may invent a module key or an action name.
 *
 * **None of this is the authorization itself.** Working rule E stands: hiding a module is
 * presentation, and every route is checked server-side regardless. These are the names the check
 * is written in.
 */

// ---------------------------------------------------------------------------
// Dimension 1 — user type
// ---------------------------------------------------------------------------

/**
 * What kind of person is acting.
 *
 * Distinct from role, and deliberately coarser: a role says *what* someone may do inside a
 * company, a user type says *what kind of relationship they have with UBoss at all*. An External
 * Guest with a Manager role is still a guest, and there are things no guest may ever do however
 * their role is configured.
 */
export const USER_TYPES = ['InternalUser', 'ExternalGuest', 'PlatformUser'] as const;
export type UserType = (typeof USER_TYPES)[number];

export const USER_TYPE_LABELS: Record<UserType, string> = {
  InternalUser: 'Internal User',
  ExternalGuest: 'External Guest',
  PlatformUser: 'Platform User',
};

/**
 * Ceilings that a role cannot lift.
 *
 * A guest's role might name `Administer`; the user type refuses it anyway. This is the outermost
 * limit in the precedence chain — see `POLICY_LAYERS` — and it exists because "we gave a
 * contractor the wrong role" should not be able to become "a contractor administered the company".
 */
export const USER_TYPE_CEILINGS: Record<UserType, { readonly forbidden: readonly Action[] }> = {
  // No ceiling: an internal person's limits come from their role and the policy layers.
  InternalUser: { forbidden: [] },
  /**
   * A guest may read, comment and produce draft work on things they are explicitly given. They
   * may never approve, publish, run, schedule, pause, manage access, administer or audit —
   * because each of those either commits the company to something or reveals its internals, and
   * a guest is by definition outside the company's accountability chain.
   */
  ExternalGuest: {
    forbidden: [
      'Approve',
      'Publish',
      'Run',
      'Schedule',
      'Pause',
      'ManageAccess',
      'Administer',
      'Audit',
      'Export',
    ],
  },
  /**
   * A platform user operates the Master Console. They may **not** act inside a company
   * workspace's business data — that is what `TenantGuard` already enforces (a platform actor
   * without a membership is refused), and it is repeated here so the ceiling is visible in one
   * place. Platform capability comes from the platform plane, not from a company role.
   */
  PlatformUser: { forbidden: ['Approve', 'Assign', 'Publish', 'Run', 'Schedule', 'Pause'] },
};

// ---------------------------------------------------------------------------
// Dimension 2 — role
// ---------------------------------------------------------------------------

export const ROLE_KINDS = [
  'Employee',
  'Manager',
  'Head',
  'CompanyAdmin',
  'Approver',
  'Auditor',
  'Custom',
] as const;
export type RoleKind = (typeof ROLE_KINDS)[number];

export const ROLE_KIND_LABELS: Record<RoleKind, string> = {
  Employee: 'Employee',
  Manager: 'Manager',
  Head: 'Head',
  CompanyAdmin: 'Company Admin',
  Approver: 'Approver',
  Auditor: 'Auditor',
  Custom: 'Custom Role',
};

// ---------------------------------------------------------------------------
// Dimension 3 — scope
// ---------------------------------------------------------------------------

/**
 * How much a role reaches.
 *
 * Ordered from narrowest to widest, and the order is load-bearing: `SCOPE_BREADTH` is what makes
 * "a lower policy layer may narrow a scope but never widen it" a comparison rather than a
 * special case per pair.
 */
export const SCOPE_KINDS = [
  'OwnWork',
  'SelectedResource',
  'TeamSubtree',
  'Department',
  'MultipleDepartments',
  'WholeCompany',
] as const;
export type ScopeKind = (typeof SCOPE_KINDS)[number];

export const SCOPE_KIND_LABELS: Record<ScopeKind, string> = {
  OwnWork: 'Own Work',
  SelectedResource: 'Selected Resource',
  TeamSubtree: 'Team / Subtree',
  Department: 'Department',
  MultipleDepartments: 'Multiple Departments',
  WholeCompany: 'Whole Company',
};

/**
 * Relative breadth, for comparison only.
 *
 * `SelectedResource` sits above `OwnWork` because an explicit grant can reach further than your
 * own work; it sits below `TeamSubtree` because it is an enumerated list rather than a rule. The
 * numbers are ordinals, not sizes — they answer "is this narrower than that", nothing else.
 */
export const SCOPE_BREADTH: Record<ScopeKind, number> = {
  OwnWork: 0,
  SelectedResource: 1,
  TeamSubtree: 2,
  Department: 3,
  MultipleDepartments: 4,
  WholeCompany: 5,
};

/** Is `candidate` no wider than `ceiling`? The test a lower policy layer has to pass. */
export function isScopeNoWiderThan(candidate: ScopeKind, ceiling: ScopeKind): boolean {
  return SCOPE_BREADTH[candidate] <= SCOPE_BREADTH[ceiling];
}

/** The narrower of two scopes. Used when layers each impose one. */
export function narrowerScope(a: ScopeKind, b: ScopeKind): ScopeKind {
  return SCOPE_BREADTH[a] <= SCOPE_BREADTH[b] ? a : b;
}

// ---------------------------------------------------------------------------
// Dimension 4 — module visibility
// ---------------------------------------------------------------------------

/**
 * Every module a permission can name.
 *
 * Taken from the client's approved navigation (`COMPANY_NAV` and `MASTER_NAV`), because a module
 * that exists in the UI and not here would be unprotectable, and one that exists here and not in
 * the UI would be unreachable. Kept as a flat list rather than nested by nav group: the nav
 * grouping is presentation and has already changed once.
 */
export const COMPANY_MODULES = [
  'dashboard',
  'hierarchy',
  'objective',
  'agent-builder',
  'todo',
  'agents',
  'executor',
  'approvals',
  'performance',
  'reports',
  'users',
  'roles',
  'profile-search',
  'settings',
] as const;

/**
 * There is deliberately **no `audit` module.**
 *
 * The reference UI puts "Audit & Activity" inside Settings, as a section rather than a top-level
 * module, and the module list above is the client's approved set. So the company-side audit trail
 * is reached as `{ module: 'settings', action: 'Audit' }` — reading the trail — and
 * `{ module: 'settings', action: 'Export' }` for an export. Adding a fifteenth module would have
 * been inventing vocabulary the client did not give us, and the `Audit` action already exists
 * precisely so that reading a trail is separately grantable from administering the thing it
 * describes. `settings: ['View']` does not imply `settings: ['Audit']`.
 *
 * The platform plane keeps its own `security` module, which is where cross-tenant security
 * events and break-glass live.
 */

export const PLATFORM_MODULES = [
  'platform-dashboard',
  'companies',
  'create-company',
  'plans',
  'billing',
  'credits',
  'providers',
  'skills',
  'testing',
  'release',
  'dev-ops',
  'support',
  'security',
  'system-health',
  'platform-settings',
] as const;

export const MODULE_KEYS = [...COMPANY_MODULES, ...PLATFORM_MODULES] as const;
export type ModuleKey = (typeof MODULE_KEYS)[number];
export type CompanyModuleKey = (typeof COMPANY_MODULES)[number];
export type PlatformModuleKey = (typeof PLATFORM_MODULES)[number];

export function isCompanyModule(module: ModuleKey): module is CompanyModuleKey {
  return (COMPANY_MODULES as readonly string[]).includes(module);
}

export function isPlatformModule(module: ModuleKey): module is PlatformModuleKey {
  return (PLATFORM_MODULES as readonly string[]).includes(module);
}

// ---------------------------------------------------------------------------
// Dimension 5 — allowed actions
// ---------------------------------------------------------------------------

/**
 * The complete action vocabulary. Closed set, in the client's approved order.
 *
 * Two distinctions in here are easy to lose and matter a great deal:
 *
 *   * **`EditDraft` is not `Publish`.** Draft work is reversible and private; publishing commits
 *     a version other people and running agents depend on. The UBoss versioning rule (a V2 draft
 *     is taken from the live version) only means anything if these are separately grantable.
 *   * **`Assign` is not `Approve`.** The client's locked "Approve & Assign" boundary is that
 *     approving a plan and handing work to a named person are different decisions, made by
 *     potentially different people. Collapsing them would erase that boundary.
 */
export const ACTIONS = [
  'View',
  'Comment',
  'Create',
  'EditDraft',
  'Assign',
  'Approve',
  'Publish',
  'Run',
  'Schedule',
  'Pause',
  'Export',
  'ManageAccess',
  'Administer',
  'Audit',
] as const;
export type Action = (typeof ACTIONS)[number];

export const ACTION_LABELS: Record<Action, string> = {
  View: 'View',
  Comment: 'Comment',
  Create: 'Create',
  EditDraft: 'Edit Draft',
  Assign: 'Assign',
  Approve: 'Approve',
  Publish: 'Publish',
  Run: 'Run',
  Schedule: 'Schedule',
  Pause: 'Pause',
  Export: 'Export',
  ManageAccess: 'Manage Access',
  Administer: 'Administer',
  Audit: 'Audit',
};

/**
 * Actions that change state.
 *
 * `View`, `Comment` and `Audit` are reads — `Comment` is a write in the database sense but adds
 * no state anyone acts on, and treating it as a write would block commenting in a read-only
 * company, which is a worse answer than allowing it.
 */
export const WRITE_ACTIONS: readonly Action[] = [
  'Create',
  'EditDraft',
  'Assign',
  'Approve',
  'Publish',
  'Run',
  'Schedule',
  'Pause',
  'ManageAccess',
  'Administer',
];

export function isWriteAction(action: Action): boolean {
  return WRITE_ACTIONS.includes(action);
}

/**
 * Actions that are high-risk by default, and therefore candidates for a separation-of-duties
 * rule.
 *
 * This is **not** the policy — a company configures which actions actually require four eyes.
 * It is the default candidate set a configuration screen would offer, and the set the seeded
 * platform baseline applies `NoSelfApproval` to.
 */
export const HIGH_RISK_ACTIONS: readonly Action[] = [
  'Approve',
  'Publish',
  'ManageAccess',
  'Administer',
  'Export',
];

// ---------------------------------------------------------------------------
// Policy layers
// ---------------------------------------------------------------------------

/**
 * The precedence chain, outermost first.
 *
 * The client's rule: **lower levels may be stricter, never weaker than a mandatory higher-level
 * control.** Two consequences that the engine implements literally:
 *
 *   * a restriction at any layer applies (the effect is an intersection), so a lower layer can
 *     always tighten;
 *   * a restriction marked **mandatory** at a higher layer cannot be lifted by a lower one. A
 *     non-mandatory restriction is a *default* and a lower layer may explicitly allow past it.
 *
 * That distinction is what makes the rule implementable rather than a slogan: without it,
 * "never weaker" would mean no lower layer could ever relax anything, and a company could not
 * grant an exception to its own advisory default.
 */
export const POLICY_LAYERS = [
  'Platform',
  'Company',
  'Department',
  'Objective',
  'EngineAgent',
] as const;
export type PolicyLayer = (typeof POLICY_LAYERS)[number];

export const POLICY_LAYER_LABELS: Record<PolicyLayer, string> = {
  Platform: 'Platform',
  Company: 'Company',
  Department: 'Department',
  Objective: 'Objective',
  EngineAgent: 'Engine Agent',
};

/** Position in the chain. Lower number = higher (outer) layer. */
export const POLICY_LAYER_ORDER: Record<PolicyLayer, number> = {
  Platform: 0,
  Company: 1,
  Department: 2,
  Objective: 3,
  EngineAgent: 4,
};

export type PolicyEffect = 'Deny' | 'Allow';

/** Separation-of-duties rules. */
export const SOD_RULES = ['NoSelfApproval', 'FourEyes'] as const;
export type SodRule = (typeof SOD_RULES)[number];

export const SOD_RULE_LABELS: Record<SodRule, string> = {
  NoSelfApproval: 'No self-approval',
  FourEyes: 'Four eyes (two distinct people)',
};

// ---------------------------------------------------------------------------
// The decision
// ---------------------------------------------------------------------------

/**
 * Why a decision came out the way it did.
 *
 * A permission check that answers only yes/no is close to undebuggable in a system with five
 * dimensions and five policy layers — and it produces useless error messages. Every denial names
 * the dimension that blocked it, so the API can say "your Employee role does not include Approve"
 * rather than "forbidden", and the internal permission test page can show the whole chain.
 */
export type DenialReason =
  | 'no-membership'
  | 'account-state'
  | 'company-lifecycle'
  | 'user-type-ceiling'
  | 'no-role-assignment'
  | 'role-lacks-action'
  | 'module-not-visible'
  | 'out-of-scope'
  | 'scope-unevaluable'
  | 'policy-denied'
  | 'separation-of-duties'
  | 'unknown-module'
  | 'unknown-action';

export interface AuthorizationDecision {
  allowed: boolean;
  /** Absent when allowed. */
  reason?: DenialReason;
  /** Human-readable, safe to show the person who was refused. */
  message: string;
  /** Which policy layer produced the decision, when a layer did. */
  decidedBy?: PolicyLayer;
  /** The effective scope the decision was evaluated against. */
  effectiveScope?: ScopeKind;
  /**
   * The full trace, for the internal permission test page and for audit. Never returned on a
   * normal API denial — it describes the company's policy configuration, which a refused caller
   * has no business reading.
   */
  trace?: readonly AuthorizationTraceStep[];
}

export interface AuthorizationTraceStep {
  layer: PolicyLayer | 'UserType' | 'Role' | 'Scope' | 'SeparationOfDuties';
  outcome: 'allow' | 'deny' | 'narrow' | 'noop';
  detail: string;
}

/** A permission a role grants: a module plus the actions permitted on it. */
export interface ModulePermission {
  module: ModuleKey;
  actions: readonly Action[];
}

/** A complete permission set, module-keyed. */
export type PermissionSet = Readonly<Partial<Record<ModuleKey, readonly Action[]>>>;

// ---------------------------------------------------------------------------
// Runtime validation
// ---------------------------------------------------------------------------

export function isUserType(value: unknown): value is UserType {
  return typeof value === 'string' && (USER_TYPES as readonly string[]).includes(value);
}

export function isRoleKind(value: unknown): value is RoleKind {
  return typeof value === 'string' && (ROLE_KINDS as readonly string[]).includes(value);
}

export function isScopeKind(value: unknown): value is ScopeKind {
  return typeof value === 'string' && (SCOPE_KINDS as readonly string[]).includes(value);
}

export function isModuleKey(value: unknown): value is ModuleKey {
  return typeof value === 'string' && (MODULE_KEYS as readonly string[]).includes(value);
}

export function isAction(value: unknown): value is Action {
  return typeof value === 'string' && (ACTIONS as readonly string[]).includes(value);
}

export function isPolicyLayer(value: unknown): value is PolicyLayer {
  return typeof value === 'string' && (POLICY_LAYERS as readonly string[]).includes(value);
}

export function isSodRule(value: unknown): value is SodRule {
  return typeof value === 'string' && (SOD_RULES as readonly string[]).includes(value);
}

/**
 * Narrow an untrusted permission set, dropping anything unrecognised.
 *
 * Used when reading a custom role's permissions out of a JSON column: a module or action that was
 * renamed or removed must not become an unenforceable grant, and dropping it fails **closed**.
 */
export function sanitisePermissionSet(value: unknown): PermissionSet {
  if (typeof value !== 'object' || value === null) {
    return {};
  }

  const out: Record<string, readonly Action[]> = {};

  for (const [module, actions] of Object.entries(value as Record<string, unknown>)) {
    if (!isModuleKey(module) || !Array.isArray(actions)) {
      continue;
    }
    const valid = actions.filter(isAction);
    if (valid.length > 0) {
      out[module] = valid;
    }
  }

  return out as PermissionSet;
}
