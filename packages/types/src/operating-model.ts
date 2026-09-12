/**
 * Build / Manage / Operate — the CR-03 operating model. Prompt 40A.
 *
 * ## This is a vocabulary, not a permission engine
 *
 * The prompt is explicit: *"do not create a second RBAC system"*. So nothing here decides anything.
 * Every capability below **expands into grants in the existing model** — User Type + Role + Scope +
 * Module Visibility + Allowed Actions + Policy Constraints — and the authorization engine remains
 * the only thing that answers "may this person do this".
 *
 * What this adds is the layer the client actually asked for: an administrator adding a colleague
 * should be choosing *"can build agents"*, not ticking `agent-builder:EditDraft`. The mapping is
 * held as data so the friendly words and the real grants cannot drift apart, and so a test can
 * assert that every capability expands to something the engine recognises.
 *
 * ## What CR-03 changed, and what it did not
 *
 * **Changed:** a standard Employee no longer defaults to Agent Builder access. Before this
 * amendment the Employee role template granted `agent-builder: ['View','Comment','EditDraft','Run']`
 * — every employee could open the builder and edit drafts. CR-03 supersedes that: *"Standard
 * Employee defaults to Operations-only capabilities"*.
 *
 * **Not changed:** the engine, the action set, the module list, the scope model, or the principle
 * that hidden navigation is presentation only. `visibleModules` is derived from whatever grants a
 * person holds, so removing the grant is what hides the screen — and the backend refuses the route
 * for the same reason, not as a second mechanism.
 */

import type { Action, ModuleKey, PermissionSet } from './authorization.js';

// ---------------------------------------------------------------------------
// The three words an administrator chooses between
// ---------------------------------------------------------------------------

/**
 * The capability tiers, from least to most.
 *
 * Ordered, and the order is load-bearing: `capabilityRank` uses it to decide whether one person
 * may grant a capability to another. `Operate` is the default for a standard Employee.
 */
export const CAPABILITY_TIERS = ['Operate', 'Manage', 'Build'] as const;
export type CapabilityTier = (typeof CAPABILITY_TIERS)[number];

export const CAPABILITY_TIER_LABELS: Record<CapabilityTier, string> = {
  Operate: 'Run work assigned to them',
  Manage: 'Manage people and assigned work',
  Build: 'Design objectives and build agents',
};

export const CAPABILITY_TIER_DESCRIPTIONS: Record<CapabilityTier, string> = {
  Operate:
    'Sees their own tasks and the agents assigned to them, and can run those. Cannot open ' +
    'Objective Optimization or Agent Builder. This is the default for a new employee.',
  Manage:
    'Everything an operator can do, plus assigning work, reviewing their team’s output and ' +
    'seeing their team’s reports. Still cannot build agents unless that is granted separately.',
  Build:
    'Can define Objectives and design, configure and test Engine Agents — including building one ' +
    'on behalf of somebody who will only ever run it.',
};

export function capabilityRank(tier: CapabilityTier): number {
  return CAPABILITY_TIERS.indexOf(tier);
}

// ---------------------------------------------------------------------------
// The separately grantable capabilities
// ---------------------------------------------------------------------------

/**
 * The individually grantable capabilities, each expanding to real grants.
 *
 * The prompt requires two of these to be **separate** by name: *"Agent Builder/Create-Configure and
 * Run Assigned Engine Agents are separate grantable capabilities."* They already were, in a way
 * worth recording: `agent-builder` is the design module and `agents` is the operations module, so
 * building and running were never one permission. What was wrong was the **default** — every
 * Employee held both.
 */
export const CAPABILITIES = [
  {
    key: 'RunAssignedAgents',
    label: 'Run assigned Engine Agents',
    tier: 'Operate',
    help:
      'Run the agents assigned or shared with them, see the result and the history, and report a ' +
      'problem. No prompts, no configuration, no model internals.',
    grants: { agents: ['View', 'Comment', 'Run'] },
  },
  {
    key: 'OwnTasks',
    label: 'Work on their own tasks',
    tier: 'Operate',
    help: 'The To-do list: their own assigned human work, with notes and evidence.',
    grants: { todo: ['View', 'Comment', 'EditDraft'] },
  },
  {
    key: 'AssignWork',
    label: 'Assign work to their team',
    tier: 'Manage',
    help: 'Give tasks and assigned AI work to people who report to them.',
    grants: { todo: ['View', 'Comment', 'Create', 'EditDraft', 'Assign'] },
  },
  {
    key: 'SeeTeamReports',
    label: 'See their team’s reports',
    tier: 'Manage',
    help: 'Reports, scoped to the people who report to them.',
    grants: { reports: ['View', 'Export'] },
  },
  {
    key: 'ManagePeople',
    label: 'Add and manage people',
    tier: 'Manage',
    help: 'Add employees, edit their records and manage who reports to whom.',
    grants: { users: ['View', 'Comment', 'Create', 'EditDraft'], hierarchy: ['View', 'EditDraft'] },
  },
  {
    key: 'DefineObjectives',
    label: 'Define and optimise Objectives',
    tier: 'Build',
    help:
      'Objective Optimization: write and revise the Objective and its workflow. Hidden entirely ' +
      'without this.',
    grants: { objective: ['View', 'Comment', 'Create', 'EditDraft'] },
  },
  {
    key: 'BuildAgents',
    label: 'Build and configure Engine Agents',
    tier: 'Build',
    help:
      'Agent Builder: design the agent, capture the Job Method, import a completed form, save a ' +
      'draft and test it. Hidden entirely without this. Activating may still need an approval.',
    grants: { 'agent-builder': ['View', 'Comment', 'Create', 'EditDraft', 'Run'] },
  },
  {
    key: 'ActivateAgents',
    label: 'Put agents live',
    tier: 'Build',
    help:
      'Publish a tested agent into production. Separate from building it on purpose: designing and ' +
      'deciding it may run are two decisions, and often two people.',
    grants: { 'agent-builder': ['Publish'], agents: ['View', 'Schedule'] },
  },
] as const;

export type CapabilityKey = (typeof CAPABILITIES)[number]['key'];

export const CAPABILITY_KEYS: readonly CapabilityKey[] = CAPABILITIES.map(
  (capability) => capability.key,
);

/**
 * The capabilities a standard Employee gets, and nothing else.
 *
 * **This is the CR-03 change in one line.** Operations only: run what is assigned to you, work on
 * your own tasks. No `objective`, no `agent-builder` — so neither screen appears in the sidebar
 * (because `visibleModules` is derived from the grants a person holds) and neither route is
 * reachable (because the backend refuses the same absent grant). One mechanism, not two.
 */
export const STANDARD_EMPLOYEE_CAPABILITIES: readonly CapabilityKey[] = [
  'RunAssignedAgents',
  'OwnTasks',
];

/**
 * A "Power Employee" — an employee explicitly given builder access.
 *
 * The prompt names this case: *"Power Employee may receive Builder access explicitly."* It is not a
 * new user type and not a new role template. It is a standard Employee with `BuildAgents` added,
 * which is exactly what "explicitly" should mean — a decision somebody made and an audit row
 * showing it, rather than a category people get filed into.
 */
export const POWER_EMPLOYEE_CAPABILITIES: readonly CapabilityKey[] = [
  ...STANDARD_EMPLOYEE_CAPABILITIES,
  'DefineObjectives',
  'BuildAgents',
];

export function capabilityDefinition(
  key: CapabilityKey,
): (typeof CAPABILITIES)[number] | undefined {
  return CAPABILITIES.find((capability) => capability.key === key);
}

/**
 * Expand a set of capabilities into a permission set the engine understands.
 *
 * Actions **union** where two capabilities touch the same module — `BuildAgents` and
 * `ActivateAgents` both grant on `agent-builder`, and the second must add `Publish` rather than
 * replace the first's four actions. Getting this wrong would silently remove access as somebody
 * was given more of it, which is the sort of bug that gets reported as "the screen went blank".
 */
export function expandCapabilities(keys: readonly CapabilityKey[]): PermissionSet {
  const granted: Record<string, Set<Action>> = {};

  for (const key of keys) {
    const definition = capabilityDefinition(key);
    if (definition === undefined) continue;

    for (const [module, actions] of Object.entries(definition.grants)) {
      const bucket = (granted[module] ??= new Set<Action>());
      for (const action of actions as readonly Action[]) bucket.add(action);
    }
  }

  const permissionSet: Record<string, Action[]> = {};
  for (const [module, actions] of Object.entries(granted)) {
    permissionSet[module] = [...actions];
  }
  return permissionSet as PermissionSet;
}

/** Which modules a set of capabilities makes visible. Presentation follows the grants. */
export function visibleModulesFor(keys: readonly CapabilityKey[]): ModuleKey[] {
  return Object.keys(expandCapabilities(keys)) as ModuleKey[];
}

/** The two screens CR-03 hides from a standard Employee, named so a test can assert it. */
export const BUILDER_ONLY_MODULES: readonly string[] = ['objective', 'agent-builder'];

export function capabilitiesHideBuilderScreens(keys: readonly CapabilityKey[]): boolean {
  const visible = new Set(visibleModulesFor(keys) as string[]);
  return BUILDER_ONLY_MODULES.every((module) => !visible.has(module));
}

// ---------------------------------------------------------------------------
// The delegation boundary
// ---------------------------------------------------------------------------

/**
 * May this administrator grant these capabilities?
 *
 * *"Admin cannot delegate permissions outside their own authority."* Two rules, and the second is
 * the one people forget:
 *
 * 1. **You cannot grant what you do not hold.** A manager without `BuildAgents` cannot give it to
 *    anybody — otherwise the capability set is decorative, since anybody could route around their
 *    own limits by granting themselves a deputy.
 * 2. **You cannot grant above your own tier.** Holding one Build capability does not make you able
 *    to hand out every Build capability; the tier is the ceiling, not a licence.
 *
 * Returns the refused keys with a reason rather than a boolean, so a screen can grey out the exact
 * checkbox and say why. A flat "not allowed" on a form with eight checkboxes is a support ticket.
 */
export function delegationProblems(input: {
  granterCapabilities: readonly CapabilityKey[];
  requested: readonly CapabilityKey[];
  /** True for a company administrator, who may grant anything within the company. */
  granterIsCompanyAdmin: boolean;
}): { key: CapabilityKey; reason: string }[] {
  if (input.granterIsCompanyAdmin) return [];

  const held = new Set(input.granterCapabilities);
  const ceiling = Math.max(
    -1,
    ...input.granterCapabilities.map((key) => {
      const definition = capabilityDefinition(key);
      return definition === undefined ? -1 : capabilityRank(definition.tier);
    }),
  );

  const refused: { key: CapabilityKey; reason: string }[] = [];

  for (const key of input.requested) {
    const definition = capabilityDefinition(key);
    if (definition === undefined) {
      refused.push({ key, reason: 'That is not a capability UBoss recognises.' });
      continue;
    }

    if (!held.has(key)) {
      refused.push({
        key,
        reason:
          `You do not have "${definition.label}" yourself, so you cannot give it to somebody ` +
          'else. Ask a company administrator.',
      });
      continue;
    }

    if (capabilityRank(definition.tier) > ceiling) {
      refused.push({
        key,
        reason: `"${definition.label}" is above the level of access you hold.`,
      });
    }
  }

  return refused;
}

export const DELEGATION_STANCE =
  'An administrator can only grant access they hold themselves, and never above their own level. ' +
  'So the person who set up your account cannot have given you more than they had — and the way ' +
  'to get more is to ask somebody who has it, not somebody who can pass it on.';

// ---------------------------------------------------------------------------
// Who did what to an agent
// ---------------------------------------------------------------------------

/**
 * The five distinct people around one Engine Agent.
 *
 * CR-03: *"Track creator/configurator, assigned employee/operator, owner, approver and activator
 * distinctly where required."*
 *
 * They are genuinely five and not one, and the case that proves it is the one this amendment is
 * about: a **manager builds an agent for an employee who will only ever run it**. The manager is
 * creator and configurator, the employee is operator, a department head may be owner, a second
 * person approves, and somebody else activates. Collapsing any pair would make an audit trail
 * unable to answer "who decided this should run" — which is the first question asked when an agent
 * does something wrong.
 */
export const AGENT_ROLES = [
  {
    key: 'Creator',
    label: 'Created it',
    why: 'Who brought it into existence. Often a manager acting for somebody else.',
  },
  {
    key: 'Configurator',
    label: 'Configured it',
    why:
      'Who last changed what it does. Distinct from the creator because an agent is configured ' +
      'repeatedly and created once.',
  },
  {
    key: 'Operator',
    label: 'Runs it',
    why:
      'The assigned employee. **Being the operator grants no builder access** — that is the point ' +
      'of the distinction and the reason CR-03 exists.',
  },
  {
    key: 'Owner',
    label: 'Accountable for it',
    why: 'The business owner. Never null: an agent nobody owns is an agent nobody answers for.',
  },
  {
    key: 'Approver',
    label: 'Approved it',
    why: 'Who decided it was allowed to run. Never the same person as the activator by default.',
  },
  {
    key: 'Activator',
    label: 'Put it live',
    why: 'Who pressed the button, and when. The moment the agent became able to affect anything.',
  },
] as const;

export type AgentRoleKey = (typeof AGENT_ROLES)[number]['key'];

export const OPERATOR_GRANTS_NOTHING =
  'Being assigned an Engine Agent lets you run it. It does not let you see or change how it is ' +
  'built, and it does not give you Agent Builder — those are granted separately, by somebody who ' +
  'holds them.';

/**
 * Everything the check-list for running an assigned agent contains.
 *
 * CR-03 lists them: *"can Run only if assignment/share + scope + Run permission + live version +
 * approval + connection/tool/security/budget rules allow it."* Held as data so the refusal a
 * screen shows can name the **first** unmet condition — an operator told only "you cannot run
 * this" has no idea whether to wait, ask for access, or report a fault.
 */
export const RUN_PRECONDITIONS = [
  {
    key: 'Assignment',
    label: 'It is assigned or shared with you',
    ifMissing: 'This agent has not been assigned to you. Ask its owner to share it.',
  },
  {
    key: 'Scope',
    label: 'It is inside your scope',
    ifMissing: 'This agent belongs to a part of the company you do not cover.',
  },
  {
    key: 'RunPermission',
    label: 'You may run agents',
    ifMissing: 'You do not have permission to run agents. An administrator can grant it.',
  },
  {
    key: 'LiveVersion',
    label: 'It has a live configuration',
    ifMissing: 'This agent has no live version yet, so there is nothing to run.',
  },
  {
    key: 'Approval',
    label: 'Any required approval is in place',
    ifMissing: 'This agent is waiting for an approval before it can run.',
  },
  {
    key: 'Connections',
    label: 'The systems it needs are connected',
    ifMissing: 'A connection this agent needs is missing or expired.',
  },
  {
    key: 'Budget',
    label: 'There is budget for it',
    ifMissing: 'There is not enough budget set aside for this run.',
  },
] as const;

export type RunPreconditionKey = (typeof RUN_PRECONDITIONS)[number]['key'];

/**
 * The first unmet precondition, in the order above.
 *
 * **Order matters and it is not arbitrary.** Assignment is checked first because it is the only one
 * whose refusal must not reveal anything: somebody with no assignment should not learn from the
 * error message whether the agent is approved, what it connects to, or whether the company is out
 * of budget. Checking budget first would leak a company's commercial state to anybody who guessed
 * an id.
 */
export function firstUnmetPrecondition(
  met: Partial<Record<RunPreconditionKey, boolean>>,
): { key: RunPreconditionKey; message: string } | null {
  for (const precondition of RUN_PRECONDITIONS) {
    if (met[precondition.key] !== true) {
      return { key: precondition.key, message: precondition.ifMissing };
    }
  }
  return null;
}

/**
 * What a normal operator's screen shows — and, by omission, what it must never show.
 *
 * CR-03: *"No prompts/JSON/API keys/model internals for normal operators."* A closed list is the
 * only form of that rule a test can check, and the test is a grep of the serialised response for
 * the forbidden words.
 */
export const OPERATOR_VIEW_FIELDS = [
  'agentName',
  'linkedObjectiveName',
  'assignedWorkTitle',
  'status',
  'lastRunAt',
  'nextRunAt',
  'canRun',
  'cannotRunBecause',
] as const;

export const NEVER_IN_AN_OPERATOR_VIEW: readonly string[] = [
  'prompt',
  'systemprompt',
  'apikey',
  'api_key',
  'model',
  'temperature',
  'token',
  'credential',
  'secret',
  'config',
];
