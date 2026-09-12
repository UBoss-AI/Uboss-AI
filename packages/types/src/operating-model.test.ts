import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  AGENT_ROLES,
  BUILDER_ONLY_MODULES,
  CAPABILITIES,
  CAPABILITY_KEYS,
  CAPABILITY_TIER_DESCRIPTIONS,
  CAPABILITY_TIER_LABELS,
  CAPABILITY_TIERS,
  capabilitiesHideBuilderScreens,
  capabilityRank,
  DELEGATION_STANCE,
  delegationProblems,
  expandCapabilities,
  firstUnmetPrecondition,
  NEVER_IN_AN_OPERATOR_VIEW,
  OPERATOR_GRANTS_NOTHING,
  OPERATOR_VIEW_FIELDS,
  POWER_EMPLOYEE_CAPABILITIES,
  RUN_PRECONDITIONS,
  STANDARD_EMPLOYEE_CAPABILITIES,
  visibleModulesFor,
  type CapabilityKey,
  type RunPreconditionKey,
} from './operating-model.js';
import { ACTIONS, MODULE_KEYS } from './authorization.js';
import { ROLE_TEMPLATES } from './role-templates.js';

describe('the capability vocabulary maps onto the real engine', () => {
  it('labels and describes every tier', () => {
    for (const tier of CAPABILITY_TIERS) {
      assert.ok(CAPABILITY_TIER_LABELS[tier].length > 0, tier);
      assert.ok(CAPABILITY_TIER_DESCRIPTIONS[tier].length > 40, tier);
    }
  });

  it('names only modules and actions the engine recognises', () => {
    // The whole reason this is a vocabulary rather than a second RBAC: every capability has to
    // expand into something the existing engine can evaluate. A typo here would be a capability
    // that silently grants nothing.
    const modules = new Set<string>(MODULE_KEYS);
    const actions = new Set<string>(ACTIONS);

    for (const capability of CAPABILITIES) {
      for (const [module, granted] of Object.entries(capability.grants)) {
        assert.ok(modules.has(module), `${capability.key} names unknown module ${module}`);
        for (const action of granted as readonly string[]) {
          assert.ok(actions.has(action), `${capability.key} names unknown action ${action}`);
        }
      }
    }
  });

  it('gives every capability a tier and help text somebody could act on', () => {
    for (const capability of CAPABILITIES) {
      assert.ok(CAPABILITY_TIERS.includes(capability.tier), capability.key);
      assert.ok(capability.label.length > 0, capability.key);
      assert.ok(capability.help.length > 40, `${capability.key} help is too thin to be useful`);
    }
    assert.equal(new Set(CAPABILITY_KEYS).size, CAPABILITY_KEYS.length, 'duplicate capability key');
  });

  it('unions actions when two capabilities touch the same module', () => {
    // `BuildAgents` grants four actions on `agent-builder`; `ActivateAgents` adds `Publish`.
    // Replacing rather than unioning would remove access as somebody was given more of it —
    // a bug that gets reported as "the screen went blank".
    const built = expandCapabilities(['BuildAgents']);
    const both = expandCapabilities(['BuildAgents', 'ActivateAgents']);

    const builderActions = both['agent-builder'] ?? [];
    for (const action of built['agent-builder'] ?? []) {
      assert.ok(builderActions.includes(action), `${action} was lost`);
    }
    assert.ok(builderActions.includes('Publish'), 'Publish was not added');
  });

  it('expands nothing for an empty set, and ignores a key it does not know', () => {
    assert.deepEqual(expandCapabilities([]), {});
    assert.deepEqual(expandCapabilities(['NotAThing' as CapabilityKey]), {});
  });
});

describe('a standard Employee is operations-only — the CR-03 change', () => {
  it('gives a standard Employee neither builder screen', () => {
    assert.equal(capabilitiesHideBuilderScreens(STANDARD_EMPLOYEE_CAPABILITIES), true);
    const visible = visibleModulesFor(STANDARD_EMPLOYEE_CAPABILITIES) as string[];
    for (const module of BUILDER_ONLY_MODULES) {
      assert.equal(visible.includes(module), false, `${module} is still visible`);
    }
  });

  it('still lets them run what is assigned to them and work on their own tasks', () => {
    // Operations-only must not mean useless. This is the other half of the requirement.
    const granted = expandCapabilities(STANDARD_EMPLOYEE_CAPABILITIES);
    assert.ok((granted.agents ?? []).includes('Run'));
    assert.ok((granted.todo ?? []).includes('EditDraft'));
  });

  it('hides the builder screens in the role template too, not just in the vocabulary', () => {
    // The vocabulary is what an administrator picks from; the template is what a new Employee
    // actually gets. If these two disagreed, the default would not be what this prompt changed.
    const employee = ROLE_TEMPLATES.Employee.permissions;
    assert.equal(employee['agent-builder'], undefined, 'Employee still holds agent-builder');
    assert.equal(employee.objective, undefined, 'Employee still holds objective');
  });

  it('keeps the Employee guardrails that CR-03 did not touch', () => {
    // Narrowing one thing must not have widened another. An Employee still holds none of the
    // five escalating actions anywhere, and is still capped at their own work.
    for (const [module, actions] of Object.entries(ROLE_TEMPLATES.Employee.permissions)) {
      for (const forbidden of ['Approve', 'Publish', 'Assign', 'ManageAccess', 'Administer']) {
        assert.ok(
          !(actions ?? []).includes(forbidden as never),
          `Employee must not have ${forbidden} on ${module}`,
        );
      }
    }
    assert.equal(ROLE_TEMPLATES.Employee.maxScope, 'OwnWork');
  });

  it('gives a Power Employee the builder screens, explicitly', () => {
    assert.equal(capabilitiesHideBuilderScreens(POWER_EMPLOYEE_CAPABILITIES), false);
    const granted = expandCapabilities(POWER_EMPLOYEE_CAPABILITIES);
    assert.ok((granted['agent-builder'] ?? []).includes('EditDraft'));
    assert.ok((granted.objective ?? []).includes('EditDraft'));
    // And still not activation: designing an agent and deciding it may run stay separate.
    assert.equal((granted['agent-builder'] ?? []).includes('Publish'), false);
  });

  it('keeps a Power Employee a superset of a standard one', () => {
    for (const key of STANDARD_EMPLOYEE_CAPABILITIES) {
      assert.ok(POWER_EMPLOYEE_CAPABILITIES.includes(key), `${key} was lost`);
    }
  });

  it('separates building an agent from running one', () => {
    // Named as a requirement in the prompt. They were already separate modules; what was wrong
    // was the default. This asserts the separation itself so it cannot be collapsed later.
    const build = expandCapabilities(['BuildAgents']);
    const run = expandCapabilities(['RunAssignedAgents']);
    assert.equal(build.agents, undefined, 'building must not grant the operations module');
    assert.equal(run['agent-builder'], undefined, 'running must not grant the builder');
  });
});

describe('delegation cannot exceed the granter', () => {
  it('lets a company administrator grant anything', () => {
    assert.deepEqual(
      delegationProblems({
        granterCapabilities: [],
        requested: [...CAPABILITY_KEYS],
        granterIsCompanyAdmin: true,
      }),
      [],
    );
  });

  it('refuses a capability the granter does not hold', () => {
    const refused = delegationProblems({
      granterCapabilities: ['RunAssignedAgents', 'OwnTasks'],
      requested: ['BuildAgents'],
      granterIsCompanyAdmin: false,
    });
    assert.equal(refused.length, 1);
    assert.equal(refused[0]?.key, 'BuildAgents');
    // Names the capability, so a screen can grey out the right checkbox and say why.
    assert.match(refused[0]?.reason ?? '', /do not have/i);
  });

  it('refuses a capability above the granter’s own tier even when they hold one at it', () => {
    // The rule people forget: holding one Build capability is not a licence to hand out every
    // Build capability. Here the granter holds none at Build, so a Build request is refused even
    // though they hold two Operate ones.
    const refused = delegationProblems({
      granterCapabilities: ['RunAssignedAgents'],
      requested: ['DefineObjectives'],
      granterIsCompanyAdmin: false,
    });
    assert.equal(refused.length, 1);
  });

  it('allows what the granter holds', () => {
    assert.deepEqual(
      delegationProblems({
        granterCapabilities: ['RunAssignedAgents', 'OwnTasks', 'AssignWork'],
        requested: ['RunAssignedAgents', 'OwnTasks'],
        granterIsCompanyAdmin: false,
      }),
      [],
    );
  });

  it('refuses a capability nobody has heard of', () => {
    const refused = delegationProblems({
      granterCapabilities: ['RunAssignedAgents'],
      requested: ['Administer everything' as CapabilityKey],
      granterIsCompanyAdmin: false,
    });
    assert.equal(refused.length, 1);
    assert.match(refused[0]?.reason ?? '', /not a capability/i);
  });

  it('ranks the tiers in the order the ceiling depends on', () => {
    assert.ok(capabilityRank('Operate') < capabilityRank('Manage'));
    assert.ok(capabilityRank('Manage') < capabilityRank('Build'));
  });

  it('states the delegation rule in words a person could be shown', () => {
    assert.match(DELEGATION_STANCE, /only grant access they hold/i);
  });
});

describe('the five people around an agent', () => {
  it('names all five distinctly, each with a reason', () => {
    const keys = AGENT_ROLES.map((role) => role.key);
    for (const expected of [
      'Creator',
      'Configurator',
      'Operator',
      'Owner',
      'Approver',
      'Activator',
    ]) {
      assert.ok(keys.includes(expected as never), `${expected} is missing`);
    }
    assert.equal(new Set(keys).size, keys.length);
    for (const role of AGENT_ROLES) {
      assert.ok(role.why.length > 30, `${role.key} does not say why it is distinct`);
    }
  });

  it('says plainly that being the operator grants nothing', () => {
    // The sentence this whole amendment exists to make true.
    assert.match(OPERATOR_GRANTS_NOTHING, /does not let you/i);
    assert.match(OPERATOR_GRANTS_NOTHING, /granted separately/i);
  });
});

describe('the seven conditions on running an assigned agent', () => {
  const all = (): Record<RunPreconditionKey, boolean> =>
    Object.fromEntries(
      RUN_PRECONDITIONS.map((precondition) => [precondition.key, true]),
    ) as Record<RunPreconditionKey, boolean>;

  it('permits a run when every condition is met', () => {
    assert.equal(firstUnmetPrecondition(all()), null);
  });

  it('names the first unmet condition rather than a bare refusal', () => {
    const met = all();
    met.LiveVersion = false;
    const unmet = firstUnmetPrecondition(met);
    assert.equal(unmet?.key, 'LiveVersion');
    assert.match(unmet?.message ?? '', /no live version/i);
  });

  it('checks assignment first, so a refusal to a stranger reveals nothing', () => {
    // The ordering is a security property, not a convenience. Somebody with no assignment must
    // not learn from the message whether the agent is approved, what it connects to, or whether
    // the company has run out of budget.
    const met = all();
    met.Assignment = false;
    met.Approval = false;
    met.Budget = false;
    met.Connections = false;

    const unmet = firstUnmetPrecondition(met);
    assert.equal(unmet?.key, 'Assignment');
    assert.match(unmet?.message ?? '', /not been assigned/i);
    for (const leak of ['budget', 'approval', 'connection', 'expired']) {
      assert.equal(
        (unmet?.message ?? '').toLowerCase().includes(leak),
        false,
        `the assignment refusal leaks "${leak}"`,
      );
    }
  });

  it('treats a missing answer as unmet rather than met', () => {
    // Fail closed. An absent flag is not a permission, so an empty object must refuse at the
    // first condition rather than sail through all seven.
    const unmet = firstUnmetPrecondition({});
    assert.equal(unmet?.key, 'Assignment');
    assert.notEqual(unmet, null);
  });

  it('gives every condition a message that says what to do', () => {
    for (const precondition of RUN_PRECONDITIONS) {
      assert.ok(precondition.ifMissing.length > 20, `${precondition.key} has no usable message`);
      assert.ok(precondition.label.length > 0, precondition.key);
    }
  });
});

describe('what a normal operator is shown', () => {
  it('lists only fields a person needs to do the work', () => {
    for (const field of ['agentName', 'status', 'canRun', 'cannotRunBecause']) {
      assert.ok(OPERATOR_VIEW_FIELDS.includes(field as never), `${field} is missing`);
    }
  });

  it('names no internal field in the operator view', () => {
    // The prompt's rule: no prompts, JSON, API keys or model internals for normal operators.
    // Asserted against the field list itself, so a field named `promptTemplate` could not be
    // added without this failing.
    const serialised = OPERATOR_VIEW_FIELDS.join(' ').toLowerCase();
    for (const forbidden of NEVER_IN_AN_OPERATOR_VIEW) {
      assert.equal(
        serialised.includes(forbidden.replace(/[^a-z]/g, '')),
        false,
        `the operator view exposes "${forbidden}"`,
      );
    }
  });
});
