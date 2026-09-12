import {
  ACTIONS,
  COMPANY_MODULES,
  PLATFORM_MODULES,
  type Action,
  type ModuleKey,
  type PermissionSet,
  type RoleKind,
  type ScopeKind,
} from './authorization.js';

/**
 * The six built-in roles, defined as code rather than as rows.
 *
 * ## Why code and not seeded data
 *
 * A built-in role's meaning must be the same in every company. If `Manager` were six rows in six
 * tenants, they would diverge — someone edits one, a migration touches another — and "Manager"
 * would stop being a thing you could reason about across the platform. Custom roles are rows,
 * because their whole purpose is to differ per company.
 *
 * The cost is that changing a built-in role is a deploy rather than a configuration change. That
 * is the right way round: it is a change to what the product means, and it should be reviewed.
 *
 * ## These are ceilings, not grants
 *
 * A template says what the role may *ever* do. What a person actually gets is this, intersected
 * with their user type's ceiling, their scope, module visibility, and every policy layer. A
 * template alone authorises nothing.
 */

export interface RoleTemplate {
  kind: Exclude<RoleKind, 'Custom'>;
  label: string;
  /** One sentence a permissions screen can show. */
  summary: string;
  /** The widest scope this role may be assigned. A narrower assignment is always allowed. */
  maxScope: ScopeKind;
  /** The default scope when an assignment does not name one. */
  defaultScope: ScopeKind;
  permissions: PermissionSet;
}

const READ_ONLY: readonly Action[] = ['View'];
const COLLABORATE: readonly Action[] = ['View', 'Comment'];
/**
 * Kept as a comment rather than a constant: CR-03 removed its last use.
 *
 * `CONTRIBUTE` was `['View', 'Comment', 'Create', 'EditDraft']`, and the Employee template's
 * `objective` grant was the only thing that used it. Naming the shape here means the next role
 * that needs those four actions can reach for the same combination rather than inventing a fifth —
 * without leaving an unused binding that lint would flag on every build.
 */

/** Every company module, mapped to the same action list. */
function acrossCompany(actions: readonly Action[]): PermissionSet {
  return Object.fromEntries(COMPANY_MODULES.map((module) => [module, actions])) as PermissionSet;
}

function acrossPlatform(actions: readonly Action[]): PermissionSet {
  return Object.fromEntries(PLATFORM_MODULES.map((module) => [module, actions])) as PermissionSet;
}

export const ROLE_TEMPLATES: Record<Exclude<RoleKind, 'Custom'>, RoleTemplate> = {
  /**
   * Employee — does the work.
   *
   * Operations only, since **CR-03 (Prompt 40A)**.
   *
   * Sees their own tasks, runs the Engine Agents assigned or shared with them, and reads what
   * concerns them. Cannot approve, publish, assign, manage access or administer. Scope is capped
   * at `OwnWork`: an employee's reach is their own work, and anything wider is a manager's role.
   *
   * ## What CR-03 changed here, and why the previous reading is not simply wrong
   *
   * This template used to grant `objective: CONTRIBUTE` and
   * `agent-builder: ['View','Comment','EditDraft','Run']`. That was a **correct** reading of the
   * source document in force at the time, which said "Employee completes Human work and only
   * missing Agent setup → Test → Activate" and listed "assigned Agent Builder work" in the
   * employee's own scope. A test pinned it, with the citation attached, precisely so nobody would
   * narrow it by accident.
   *
   * CR-03 narrows it **on purpose** and says so in terms: it "supersedes any earlier assumption
   * that every assigned employee must use Agent Builder", and requires that a standard Employee
   * default to operations-only capabilities with Objective Optimization and Agent Builder hidden
   * and backend-blocked unless explicitly granted. A latest explicit client amendment outranks the
   * earlier functional document, so the grant goes.
   *
   * ## The mechanism is one thing, not two
   *
   * `visibleModules` is derived from whichever modules a person holds any grant on. So **removing
   * the keys is what hides the screens** — and the same absent grant is what makes the backend
   * refuse the route. Hiding without blocking would be the failure the locked rule warns about;
   * here there is nothing to keep in step, because presentation reads the same fact the guard does.
   *
   * ## How an employee's knowledge still reaches a build
   *
   * The Job Method form (Prompt 40A §4): an authorized builder downloads it, the employee fills it
   * in offline with no builder access at all, and the builder imports it into a draft. The person
   * who knows how the work is done is rarely the person who should be configuring agents, and a
   * spreadsheet is a better answer to that than a role grant.
   *
   * An employee who genuinely should build is a "Power Employee" — the same template plus an
   * explicit grant, which is a decision with an audit row behind it rather than a category.
   */
  Employee: {
    kind: 'Employee',
    label: 'Employee',
    summary: 'Does the work: their own tasks, and the agents assigned to them.',
    maxScope: 'OwnWork',
    defaultScope: 'OwnWork',
    permissions: {
      dashboard: READ_ONLY,
      hierarchy: READ_ONLY,
      // ---- CR-03: `objective` and `agent-builder` are absent, and the absence is the feature ----
      //
      // Objective Optimization and Agent Builder are the two BUILDERS screens. No grant means no
      // entry in `visibleModules`, so neither appears in the sidebar; and no grant is also what
      // the route guard refuses on. See the note on this template for the citation.
      //
      // Granting either one back is a deliberate act — the `DefineObjectives` and `BuildAgents`
      // capabilities in `operating-model.ts` are how an administrator does it, and the audit trail
      // records that they did.
      todo: ['View', 'Comment', 'EditDraft'],
      // The operator grant, and after CR-03 the *only* agent-side grant a standard Employee has.
      //
      // `Run` but not `Publish` or `Schedule`: running a released version is doing the work;
      // deciding what is released, or that it runs unattended, is not. Whether a particular run is
      // permitted is a further question — `RUN_PRECONDITIONS` lists all seven conditions, of which
      // this grant is one.
      agents: ['View', 'Comment', 'Run'],
      executor: READ_ONLY,
      approvals: READ_ONLY,
      performance: READ_ONLY,
      reports: READ_ONLY,
      'profile-search': READ_ONLY,
      settings: READ_ONLY,
    },
  },

  /**
   * Manager — runs a team.
   *
   * Adds `Assign`, `Schedule` and `Pause` over a team subtree. Deliberately **not** `Approve`:
   * the client's locked Approve & Assign boundary is that handing work to a person and approving
   * the plan are separate decisions. A manager who should also approve is given the Approver role
   * as well, which makes the second decision visible in the assignment record instead of implied
   * by a job title.
   */
  Manager: {
    kind: 'Manager',
    label: 'Manager',
    summary: 'Runs a team: assigns work, schedules and pauses runs, sees their subtree.',
    maxScope: 'TeamSubtree',
    defaultScope: 'TeamSubtree',
    permissions: {
      dashboard: READ_ONLY,
      hierarchy: COLLABORATE,
      objective: ['View', 'Comment', 'Create', 'EditDraft', 'Assign'],
      // CONTRIBUTE plus `Run`: a manager may activate the agent for work in their team.
      'agent-builder': ['View', 'Comment', 'Create', 'EditDraft', 'Run'],
      todo: ['View', 'Comment', 'Create', 'EditDraft', 'Assign'],
      agents: ['View', 'Comment', 'Run', 'Schedule', 'Pause'],
      executor: COLLABORATE,
      approvals: COLLABORATE,
      performance: READ_ONLY,
      reports: ['View', 'Export'],
      users: READ_ONLY,
      'profile-search': READ_ONLY,
      settings: READ_ONLY,
    },
  },

  /**
   * Head — owns a department.
   *
   * Adds `Approve` and `Publish` within a department. This is where a decision starts committing
   * the company, which is why `HIGH_RISK_ACTIONS` and the separation-of-duties hooks first bite
   * on this role in practice.
   */
  Head: {
    kind: 'Head',
    label: 'Head',
    summary: 'Owns a department: approves and publishes within it, sees its whole tree.',
    maxScope: 'MultipleDepartments',
    defaultScope: 'Department',
    permissions: {
      dashboard: READ_ONLY,
      hierarchy: ['View', 'Comment', 'Create', 'EditDraft'],
      objective: ['View', 'Comment', 'Create', 'EditDraft', 'Assign', 'Approve', 'Publish'],
      // `Run` activates an agent; `Publish` is the authority over the canonical job method
      // (Form 3) and over releasing a reusable agent's configuration to the company.
      'agent-builder': ['View', 'Comment', 'Create', 'EditDraft', 'Run', 'Publish'],
      todo: ['View', 'Comment', 'Create', 'EditDraft', 'Assign'],
      agents: ['View', 'Comment', 'Run', 'Schedule', 'Pause', 'Publish'],
      executor: ['View', 'Comment', 'Pause'],
      approvals: ['View', 'Comment', 'Approve'],
      performance: ['View', 'Export'],
      reports: ['View', 'Export'],
      users: COLLABORATE,
      'profile-search': READ_ONLY,
      // Not `Audit`, and the reason is a limit rather than a policy: `audit_events` carries no
      // department, so a `Department`-scoped audit grant cannot be narrowed to a department —
      // it would quietly read the whole company. Rather than grant a scope we cannot enforce,
      // `Audit` goes only to roles whose scope is `WholeCompany` anyway, and the service
      // refuses an audit read from a narrower scope instead of over-returning (ADR-047).
      settings: READ_ONLY,
    },
  },

  /**
   * Company Admin — administers the company.
   *
   * The only company role with `ManageAccess` and `Administer`, and the only one whose default
   * scope is the whole company.
   *
   * It deliberately does **not** carry `Approve` on `objective` or `approvals`. Administering a
   * company is not the same as being an approver in its workflow, and giving an administrator
   * blanket approval rights is how "the admin approved their own change" happens. An admin who
   * must also approve is additionally assigned the Approver role — a separate, visible decision.
   */
  CompanyAdmin: {
    kind: 'CompanyAdmin',
    label: 'Company Admin',
    summary:
      'Administers the company: users, roles, settings and integrations across the whole company.',
    maxScope: 'WholeCompany',
    defaultScope: 'WholeCompany',
    permissions: {
      dashboard: READ_ONLY,
      hierarchy: ['View', 'Comment', 'Create', 'EditDraft', 'Administer'],
      objective: ['View', 'Comment', 'Export'],
      'agent-builder': ['View', 'Comment'],
      todo: READ_ONLY,
      agents: ['View', 'Comment', 'Pause'],
      executor: ['View', 'Comment', 'Pause', 'Administer'],
      approvals: READ_ONLY,
      // `Administer` is new at Prompt 12B: the performance policy — the points per outcome and
      // the badge thresholds — is company configuration, and this is the role that holds every
      // other `Administer`. It also gates the two performance events a *person* may record (a
      // manual adjustment and an approved blocker's neutralisation); the four derived outcomes
      // are written by the modules that own the work, so no role can type in points for work
      // that never happened.
      //
      // Deliberately **not** granted to `Head` or `Manager`: a department head setting
      // company-wide thresholds, or adjusting their own reports' scores unilaterally, is the
      // conflict this separation exists to prevent. An exception a manager raises reaches the
      // ledger through the approvals path, which decides it on its own authority.
      performance: ['View', 'Export', 'Administer'],
      reports: ['View', 'Export'],
      users: ['View', 'Comment', 'Create', 'EditDraft', 'ManageAccess', 'Administer'],
      roles: ['View', 'Create', 'EditDraft', 'ManageAccess', 'Administer'],
      'profile-search': ['View'],
      // `Audit` and `Export` are new at Prompt 8: a Company Admin answering a compliance
      // request needs to read and export their own company's trail. This is safe to grant in a
      // way it would not have been before, because the trail is now append-only in the database
      // — the admin can read every row and alter none of them (ADR-046). It is still not
      // `Approve`: reading history and approving work remain different decisions.
      // **No `Approve`, including on `settings`.** Prompt 17 needed a permission for a Skill's
      // approval step and this role was the obvious place to put it — which the Prompt 7
      // invariant test correctly refused. The invariant is the stronger position and it is the
      // client's own model: an administrator who must also approve is *additionally* assigned the
      // Approver role, so the second decision is visible in the assignment record rather than
      // implied by a job title. `settings:Approve` therefore lives on `Approver` alone.
      settings: ['View', 'EditDraft', 'Administer', 'Audit', 'Export'],
    },
  },

  /**
   * Approver — approves, and does little else.
   *
   * Narrow on purpose. An approver needs to see enough to judge and then approve; giving them
   * authoring rights would let the same person write and approve the same thing, which is exactly
   * what the separation-of-duties hooks exist to prevent. Keeping the role narrow means the
   * common case never reaches those hooks.
   *
   * Default scope is `SelectedResource`: an approver is usually appointed for specific work
   * rather than granted standing authority over a department.
   */
  Approver: {
    kind: 'Approver',
    label: 'Approver',
    summary: 'Reviews and approves. Deliberately cannot author what it approves.',
    maxScope: 'MultipleDepartments',
    defaultScope: 'SelectedResource',
    permissions: {
      dashboard: READ_ONLY,
      objective: ['View', 'Comment', 'Approve'],
      'agent-builder': ['View', 'Comment', 'Approve'],
      todo: COLLABORATE,
      agents: ['View', 'Comment', 'Approve'],
      executor: COLLABORATE,
      approvals: ['View', 'Comment', 'Approve'],
      performance: READ_ONLY,
      reports: READ_ONLY,
      hierarchy: READ_ONLY,
      'profile-search': READ_ONLY,
      // New at Prompt 17. A Skill's approval is exactly this role's purpose — "reviews and
      // approves, deliberately cannot author what it approves" — so it reads Settings and may
      // approve a Skill version without `Administer`, which is what makes the separation real
      // rather than nominal.
      settings: ['View', 'Approve'],
    },
  },

  /**
   * Auditor — reads everything, changes nothing.
   *
   * `View`, `Export` and `Audit` across the whole company, and **no write action anywhere**. The
   * point of an auditor is that their access cannot alter what they are auditing, so this
   * template has no `Comment` either: a comment is a mark on the record, and an auditor's
   * findings belong in an audit report rather than in the workflow they are reviewing.
   */
  Auditor: {
    kind: 'Auditor',
    label: 'Auditor',
    summary: 'Reads and exports everything across the company. Cannot change anything.',
    maxScope: 'WholeCompany',
    defaultScope: 'WholeCompany',
    permissions: acrossCompany(['View', 'Export', 'Audit']),
  },
};

/**
 * The platform-plane permission set.
 *
 * Not a company role: it is what a Platform User may do in the Master Console. Kept beside the
 * company templates so the two are visibly different things — a platform actor has no company
 * role at all, and `TenantGuard` already refuses one inside a company workspace.
 *
 * The platform role taxonomy the client's prototype shows (Owner / Admin / Finance / Support /
 * DevOps / Security) is **not** modelled here, and inventing a split would be guessing. Until the
 * client's reference arrives, a platform actor gets this one set, which is what
 * `User.isPlatformActor` has meant since Prompt 3.
 */
export const PLATFORM_PERMISSIONS: PermissionSet = {
  ...acrossPlatform(['View', 'Comment', 'Create', 'EditDraft', 'Export', 'Administer', 'Audit']),
  // Provisioning a company and issuing entitlements are the platform's whole job.
  'create-company': ['View', 'Create', 'Administer'],
  companies: ['View', 'Comment', 'EditDraft', 'Administer', 'Export', 'Audit'],
  security: ['View', 'Export', 'Audit', 'Administer'],
};

/** The actions a built-in role may ever perform on a module, or an empty list. */
export function templateActions(
  kind: Exclude<RoleKind, 'Custom'>,
  module: ModuleKey,
): readonly Action[] {
  return ROLE_TEMPLATES[kind].permissions[module] ?? [];
}

/** Every module a built-in role can see at all. Drives module visibility for built-ins. */
export function templateModules(kind: Exclude<RoleKind, 'Custom'>): readonly ModuleKey[] {
  return Object.keys(ROLE_TEMPLATES[kind].permissions) as ModuleKey[];
}

/**
 * A permission set naming every module and every action.
 *
 * Exists for tests and for the internal permission test page, so "what would an unrestricted role
 * look like" can be expressed without hand-writing the matrix. **Never** assigned to anyone: no
 * role template uses it, and nothing in the API can produce it.
 */
export function unrestrictedPermissionSet(): PermissionSet {
  return {
    ...acrossCompany(ACTIONS),
    ...acrossPlatform(ACTIONS),
  };
}
