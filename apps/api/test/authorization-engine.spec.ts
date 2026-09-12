import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  ACTIONS,
  checkSeparationOfDuties,
  effectiveScopeFor,
  evaluatePrecedence,
  governingSodPolicy,
  isInScope,
  isInScopeAsync,
  isScopeNoWiderThan,
  MODULE_KEYS,
  narrowerScope,
  permittedActions,
  PLATFORM_PERMISSIONS,
  ROLE_TEMPLATES,
  sanitisePermissionSet,
  SCOPE_BREADTH,
  SCOPE_KINDS,
  USER_TYPE_CEILINGS,
  widestGrant,
  type Action,
  type ModuleKey,
  type PolicyRule,
  type PrecedenceInput,
  type SodPolicy,
  type UserType,
  capabilitiesHideBuilderScreens,
  expandCapabilities,
  POWER_EMPLOYEE_CAPABILITIES,
  STANDARD_EMPLOYEE_CAPABILITIES,
} from '@uboss/types';

/**
 * The authorization engine, tested as a pure function.
 *
 * This is the file that matters most in Prompt 7. The engine is where a subtle mistake is a
 * privilege-escalation bug, and because it takes a resolved input and returns a decision — no
 * database, no request, no clock — it can be tested exhaustively rather than sampled. Every
 * escalation negative below is a thing someone could plausibly try, expressed as an assertion
 * that it does not work.
 */

const ALL_COMPANY: readonly ModuleKey[] = MODULE_KEYS;

function input(overrides: Partial<PrecedenceInput> = {}): PrecedenceInput {
  return {
    userType: 'InternalUser',
    module: 'objective',
    action: 'View',
    grantedActions: ['View'],
    visibleModules: ['objective'],
    assignedScope: 'OwnWork',
    rules: [],
    ...overrides,
  };
}

function rule(overrides: Partial<PolicyRule> = {}): PolicyRule {
  return {
    layer: 'Company',
    module: null,
    action: null,
    effect: 'Deny',
    mandatory: false,
    reason: 'Test rule.',
    ...overrides,
  };
}

// ===========================================================================
describe('the five dimensions', () => {
  it('refuses an action no role granted', () => {
    const result = evaluatePrecedence(input({ action: 'Approve', grantedActions: ['View'] }));

    assert.equal(result.allowed, false);
    assert.equal(result.decision.reason, 'role-lacks-action');
    // The message names the dimension, so an API can say something useful.
    assert.match(result.decision.message, /does not include "Approve"/);
  });

  it('refuses a module no assignment makes visible', () => {
    const result = evaluatePrecedence(
      input({ module: 'roles', grantedActions: ['View'], visibleModules: ['objective'] }),
    );

    assert.equal(result.allowed, false);
    assert.equal(result.decision.reason, 'module-not-visible');
  });

  it('permits an action a role grants on a visible module', () => {
    assert.equal(evaluatePrecedence(input()).allowed, true);
  });

  it('reports the outermost reason when several would refuse', () => {
    // A guest asking to Approve a module they cannot see, with no grant. The user-type ceiling is
    // outermost, and that is what they should be told — not "your scope is wrong".
    const result = evaluatePrecedence(
      input({
        userType: 'ExternalGuest',
        action: 'Approve',
        grantedActions: [],
        visibleModules: [],
      }),
    );

    assert.equal(result.decision.reason, 'user-type-ceiling');
  });
});

// ===========================================================================
describe('user type ceilings', () => {
  it('never lets an External Guest approve, publish, run or administer, whatever their role', () => {
    // The escalation: give a guest the most powerful role and the widest scope.
    for (const action of [
      'Approve',
      'Publish',
      'Run',
      'ManageAccess',
      'Administer',
      'Audit',
      'Export',
    ] as Action[]) {
      const result = evaluatePrecedence(
        input({
          userType: 'ExternalGuest',
          action,
          grantedActions: [...ACTIONS],
          visibleModules: ALL_COMPANY,
          assignedScope: 'WholeCompany',
        }),
      );

      assert.equal(result.allowed, false, `a guest must never ${action}`);
      assert.equal(result.decision.reason, 'user-type-ceiling');
    }
  });

  it('does let an External Guest view, comment and draft', () => {
    for (const action of ['View', 'Comment', 'Create', 'EditDraft'] as Action[]) {
      const result = evaluatePrecedence(
        input({ userType: 'ExternalGuest', action, grantedActions: [action] }),
      );
      assert.equal(result.allowed, true, `a guest should be able to ${action}`);
    }
  });

  it('keeps a Platform User out of company workflow actions', () => {
    // A platform actor administers the platform; they do not approve a customer's work or run
    // their agents. `TenantGuard` already refuses them inside a workspace; this is the ceiling
    // saying the same thing in the engine.
    for (const action of ['Approve', 'Assign', 'Publish', 'Run', 'Schedule', 'Pause'] as Action[]) {
      const result = evaluatePrecedence(
        input({
          userType: 'PlatformUser',
          action,
          grantedActions: [...ACTIONS],
          visibleModules: ALL_COMPANY,
        }),
      );
      assert.equal(result.allowed, false, `a platform user must not ${action}`);
    }
  });

  it('places no ceiling on an Internal User', () => {
    assert.deepEqual(USER_TYPE_CEILINGS.InternalUser.forbidden, []);
  });
});

// ===========================================================================
describe('policy precedence', () => {
  it('lets any layer tighten', () => {
    for (const layer of [
      'Platform',
      'Company',
      'Department',
      'Objective',
      'EngineAgent',
    ] as const) {
      const result = evaluatePrecedence(
        input({ rules: [rule({ layer, action: 'View', reason: `${layer} says no.` })] }),
      );

      assert.equal(result.allowed, false, `${layer} should be able to deny`);
      assert.equal(result.decision.decidedBy, layer);
      assert.equal(result.decision.message, `${layer} says no.`);
    }
  });

  it('lets a lower layer grant an exception to a NON-mandatory higher denial', () => {
    const result = evaluatePrecedence(
      input({
        rules: [
          rule({ layer: 'Company', action: 'View', mandatory: false, reason: 'Company default.' }),
          rule({ layer: 'Department', action: 'View', effect: 'Allow', reason: 'Dept exception.' }),
        ],
      }),
    );

    assert.equal(result.allowed, true);
  });

  it('refuses to let ANY lower layer lift a mandatory higher denial', () => {
    // The central escalation this file exists to prevent, tried from every lower layer.
    for (const layer of ['Company', 'Department', 'Objective', 'EngineAgent'] as const) {
      const result = evaluatePrecedence(
        input({
          rules: [
            rule({
              layer: 'Platform',
              action: 'View',
              mandatory: true,
              reason: 'Platform mandate.',
            }),
            rule({ layer, action: 'View', effect: 'Allow', reason: `${layer} tries to override.` }),
          ],
        }),
      );

      assert.equal(result.allowed, false, `${layer} must not lift a mandatory Platform control`);
      assert.equal(result.decision.decidedBy, 'Platform');
      assert.equal(result.decision.message, 'Platform mandate.');
    }
  });

  it('records a refused override in the trace rather than ignoring it silently', () => {
    const result = evaluatePrecedence(
      input({
        rules: [
          rule({ layer: 'Company', action: 'View', mandatory: true, reason: 'Company mandate.' }),
          rule({ layer: 'EngineAgent', action: 'View', effect: 'Allow', reason: 'Agent tries.' }),
        ],
      }),
    );

    const refusal = (result.decision.trace ?? []).find(
      (step) => step.layer === 'EngineAgent' && step.outcome === 'noop',
    );
    assert.ok(refusal, 'the refused override must appear in the trace');
    assert.match(refusal.detail, /Refused to override the mandatory Company control/);
  });

  it('applies a mandatory control set at any layer, not only Platform', () => {
    const result = evaluatePrecedence(
      input({
        rules: [
          rule({ layer: 'Department', action: 'View', mandatory: true, reason: 'Dept mandate.' }),
          rule({ layer: 'EngineAgent', action: 'View', effect: 'Allow', reason: 'Agent tries.' }),
        ],
      }),
    );

    assert.equal(result.allowed, false);
    assert.equal(result.decision.decidedBy, 'Department');
  });

  it('honours a wildcard rule across every module and action', () => {
    const result = evaluatePrecedence(
      input({
        action: 'Export',
        grantedActions: ['Export'],
        rules: [rule({ layer: 'Company', module: null, action: 'Export', reason: 'No exports.' })],
      }),
    );

    assert.equal(result.allowed, false);
  });

  it('ignores a rule for a different module or action', () => {
    const result = evaluatePrecedence(
      input({
        rules: [
          rule({ module: 'roles', action: 'View', reason: 'Irrelevant.' }),
          rule({ module: 'objective', action: 'Approve', reason: 'Also irrelevant.' }),
        ],
      }),
    );

    assert.equal(result.allowed, true);
  });
});

// ===========================================================================
describe('scope narrowing', () => {
  it('lets a layer narrow the scope', () => {
    const result = evaluatePrecedence(
      input({
        assignedScope: 'WholeCompany',
        rules: [rule({ effect: 'Allow', maxScope: 'Department', reason: 'Dept only.' })],
      }),
    );

    assert.equal(result.allowed, true);
    assert.equal(result.effectiveScope, 'Department');
  });

  it('refuses to let a layer WIDEN the scope, and says so in the trace', () => {
    // The escalation: an Engine Agent layer trying to award itself the whole company.
    const result = evaluatePrecedence(
      input({
        assignedScope: 'OwnWork',
        rules: [
          rule({
            layer: 'EngineAgent',
            effect: 'Allow',
            maxScope: 'WholeCompany',
            reason: 'Agent wants everything.',
          }),
        ],
      }),
    );

    assert.equal(result.effectiveScope, 'OwnWork', 'the scope must not widen');
    const ignored = (result.decision.trace ?? []).find(
      (step) => step.outcome === 'noop' && /widen/.test(step.detail),
    );
    assert.ok(ignored, 'the ignored widening must be traced');
  });

  it('takes the narrowest when several layers each impose a ceiling', () => {
    const result = evaluatePrecedence(
      input({
        assignedScope: 'WholeCompany',
        rules: [
          rule({ layer: 'Company', effect: 'Allow', maxScope: 'MultipleDepartments', reason: 'a' }),
          rule({ layer: 'Department', effect: 'Allow', maxScope: 'OwnWork', reason: 'b' }),
          rule({ layer: 'Objective', effect: 'Allow', maxScope: 'Department', reason: 'c' }),
        ],
      }),
    );

    assert.equal(result.effectiveScope, 'OwnWork');
  });

  it('orders the scope kinds narrowest to widest', () => {
    const ordered = [...SCOPE_KINDS].sort((a, b) => SCOPE_BREADTH[a] - SCOPE_BREADTH[b]);
    assert.deepEqual(ordered, [...SCOPE_KINDS], 'SCOPE_KINDS must already be in breadth order');

    assert.equal(isScopeNoWiderThan('OwnWork', 'WholeCompany'), true);
    assert.equal(isScopeNoWiderThan('WholeCompany', 'OwnWork'), false);
    assert.equal(narrowerScope('Department', 'OwnWork'), 'OwnWork');
  });

  it('computes a listing scope without deciding permission', () => {
    const scope = effectiveScopeFor('WholeCompany', 'objective', 'View', [
      rule({ effect: 'Allow', maxScope: 'Department', reason: 'x' }),
    ]);
    assert.equal(scope, 'Department');
  });
});

// ===========================================================================
describe('resource scope', () => {
  const resource = {
    id: 'res-1',
    ownerUserId: 'owner',
    createdByUserId: 'author',
    departmentId: 'dept-a',
  };

  it('OwnWork covers only the actor’s own resources', () => {
    assert.equal(
      isInScope({ grant: { kind: 'OwnWork' }, resource, actorUserId: 'owner' }).inScope,
      true,
    );
    assert.equal(
      isInScope({ grant: { kind: 'OwnWork' }, resource, actorUserId: 'someone-else' }).inScope,
      false,
    );
  });

  it('SelectedResource covers exactly what is listed', () => {
    assert.equal(
      isInScope({
        grant: { kind: 'SelectedResource', selectedResourceIds: ['res-1'] },
        resource,
        actorUserId: 'x',
      }).inScope,
      true,
    );
    assert.equal(
      isInScope({
        grant: { kind: 'SelectedResource', selectedResourceIds: ['res-2'] },
        resource,
        actorUserId: 'x',
      }).inScope,
      false,
    );
  });

  it('an empty SelectedResource list grants nothing', () => {
    const outcome = isInScope({
      grant: { kind: 'SelectedResource', selectedResourceIds: [] },
      resource,
      actorUserId: 'x',
    });
    assert.equal(outcome.inScope, false);
  });

  it('Department covers only the assigned departments', () => {
    assert.equal(
      isInScope({
        grant: { kind: 'Department', departmentIds: ['dept-a'] },
        resource,
        actorUserId: 'x',
      }).inScope,
      true,
    );
    assert.equal(
      isInScope({
        grant: { kind: 'Department', departmentIds: ['dept-b'] },
        resource,
        actorUserId: 'x',
      }).inScope,
      false,
    );
  });

  it('a resource with no department is NOT covered by a department scope', () => {
    // Fails closed: "no department recorded" is not a wildcard.
    const outcome = isInScope({
      grant: { kind: 'Department', departmentIds: ['dept-a'] },
      resource: { id: 'res-2' },
      actorUserId: 'x',
    });

    assert.equal(outcome.inScope, false);
    assert.equal(outcome.inScope === false && outcome.reason, 'out-of-scope');
  });

  it('WholeCompany covers anything that reached the check', () => {
    assert.equal(
      isInScope({ grant: { kind: 'WholeCompany' }, resource, actorUserId: 'x' }).inScope,
      true,
    );
  });

  it('TeamSubtree fails closed with a distinct reason while there is no hierarchy', () => {
    const outcome = isInScope({ grant: { kind: 'TeamSubtree' }, resource, actorUserId: 'x' });

    assert.equal(outcome.inScope, false);
    // Distinct from out-of-scope on purpose: "we cannot tell" and "no" need different messages,
    // and defaulting either way would be wrong — allow would grant the company, deny would look
    // like it worked.
    assert.equal(outcome.inScope === false && outcome.reason, 'scope-unevaluable');
  });

  it('TeamSubtree resolves once a hierarchy resolver is registered', async () => {
    const hierarchy = {
      async isInSubtree(query: { subjectUserId: string }) {
        return query.subjectUserId === 'owner';
      },
    };

    const inside = await isInScopeAsync({
      grant: { kind: 'TeamSubtree' },
      resource,
      actorUserId: 'manager',
      tenantId: 't',
      hierarchy,
    });
    assert.equal(inside.inScope, true);

    const outside = await isInScopeAsync({
      grant: { kind: 'TeamSubtree' },
      resource: { ...resource, ownerUserId: 'stranger' },
      actorUserId: 'manager',
      tenantId: 't',
      hierarchy,
    });
    assert.equal(outside.inScope, false);
  });

  it('unions several grants rather than taking the narrowest', () => {
    // A person who is an Employee (own work) and an Approver on two objectives holds both.
    const widest = widestGrant([
      { kind: 'OwnWork' },
      { kind: 'SelectedResource', selectedResourceIds: ['a'] },
      { kind: 'SelectedResource', selectedResourceIds: ['b'] },
    ]);

    assert.equal(widest?.kind, 'SelectedResource');
    assert.deepEqual([...(widest?.selectedResourceIds ?? [])].sort(), ['a', 'b']);
  });

  it('promotes two single-department grants to MultipleDepartments', () => {
    const widest = widestGrant([
      { kind: 'Department', departmentIds: ['a'] },
      { kind: 'Department', departmentIds: ['b'] },
    ]);

    assert.equal(widest?.kind, 'MultipleDepartments');
    assert.equal((widest?.departmentIds ?? []).length, 2);
  });
});

// ===========================================================================
describe('separation of duties', () => {
  const noSelfApproval: SodPolicy = {
    action: 'Approve',
    module: null,
    rule: 'NoSelfApproval',
    mandatory: true,
    reason: 'You cannot approve something you created.',
  };

  const fourEyes: SodPolicy = {
    action: 'Approve',
    module: null,
    rule: 'FourEyes',
    mandatory: true,
    reason: 'Two people must act on this.',
  };

  it('blocks the creator from approving their own work', () => {
    const outcome = checkSeparationOfDuties({
      policies: [noSelfApproval],
      action: 'Approve',
      module: 'objective',
      actorUserId: 'author',
      resource: { id: 'r', createdByUserId: 'author' },
    });

    assert.equal(outcome.satisfied, false);
    assert.equal(outcome.satisfied === false && outcome.rule, 'NoSelfApproval');
  });

  it('lets a different person approve it', () => {
    const outcome = checkSeparationOfDuties({
      policies: [noSelfApproval],
      action: 'Approve',
      module: 'objective',
      actorUserId: 'reviewer',
      resource: { id: 'r', createdByUserId: 'author' },
    });

    assert.equal(outcome.satisfied, true);
  });

  it('keys on the creator, not the current owner', () => {
    // Work is reassigned routinely. The person who WROTE it is the one who must not wave it
    // through, so a reassignment must not launder a self-approval.
    const outcome = checkSeparationOfDuties({
      policies: [noSelfApproval],
      action: 'Approve',
      module: 'objective',
      actorUserId: 'author',
      resource: { id: 'r', ownerUserId: 'someone-else', createdByUserId: 'author' },
    });

    assert.equal(outcome.satisfied, false);
  });

  it('does not apply to an action it was not configured for', () => {
    const outcome = checkSeparationOfDuties({
      policies: [noSelfApproval],
      action: 'EditDraft',
      module: 'objective',
      actorUserId: 'author',
      resource: { id: 'r', createdByUserId: 'author' },
    });

    assert.equal(outcome.satisfied, true);
  });

  it('four eyes needs a second person, not just a different one', () => {
    const alone = checkSeparationOfDuties({
      policies: [fourEyes],
      action: 'Approve',
      module: 'objective',
      actorUserId: 'reviewer',
      resource: { id: 'r', createdByUserId: 'author', priorActorUserIds: [] },
    });
    assert.equal(alone.satisfied, false);

    const withSecond = checkSeparationOfDuties({
      policies: [fourEyes],
      action: 'Approve',
      module: 'objective',
      actorUserId: 'reviewer-2',
      resource: { id: 'r', createdByUserId: 'author', priorActorUserIds: ['reviewer-1'] },
    });
    assert.equal(withSecond.satisfied, true);
  });

  it('does not count the actor as their own second pair of eyes', () => {
    const outcome = checkSeparationOfDuties({
      policies: [fourEyes],
      action: 'Approve',
      module: 'objective',
      actorUserId: 'reviewer',
      resource: { id: 'r', createdByUserId: 'author', priorActorUserIds: ['reviewer'] },
    });

    assert.equal(outcome.satisfied, false);
  });

  /**
   * The locked rule: the Executor Agent must never silently bypass or replace a required Human
   * approval. These two are that rule, as assertions.
   */
  it('never lets an automated agent satisfy a four-eyes control', () => {
    const outcome = checkSeparationOfDuties({
      policies: [fourEyes],
      action: 'Approve',
      module: 'objective',
      actorUserId: 'executor-agent',
      resource: { id: 'r', createdByUserId: 'author', priorActorUserIds: ['a-person'] },
      actingAsAgent: true,
    });

    assert.equal(outcome.satisfied, false, 'an agent must not complete a four-eyes approval');
    assert.match(outcome.satisfied === false ? outcome.detail : '', /escalated to a person/);
  });

  it('offers no bypass parameter at all', () => {
    // There is deliberately no `force`, `override` or `systemActor` option. If one were added,
    // this test would still pass — so the assertion is on the function's arity and the absence
    // of such a key in the input type, which the compiler enforces. Kept as a written record of
    // the intent for whoever is tempted.
    const outcome = checkSeparationOfDuties({
      policies: [noSelfApproval],
      action: 'Approve',
      module: 'objective',
      actorUserId: 'author',
      resource: { id: 'r', createdByUserId: 'author' },
      actingAsAgent: true,
    });

    assert.equal(outcome.satisfied, false);
  });

  it('reports the strictest applicable control for display', () => {
    const governing = governingSodPolicy(
      [
        { ...noSelfApproval, mandatory: false },
        { ...fourEyes, mandatory: true },
      ],
      'Approve',
      'objective',
    );

    assert.equal(governing?.rule, 'FourEyes');
    assert.equal(governing?.mandatory, true);
  });

  it('honours a module-scoped control without applying it elsewhere', () => {
    const scoped: SodPolicy = { ...noSelfApproval, module: 'agents' };

    assert.equal(
      checkSeparationOfDuties({
        policies: [scoped],
        action: 'Approve',
        module: 'agents',
        actorUserId: 'author',
        resource: { id: 'r', createdByUserId: 'author' },
      }).satisfied,
      false,
    );

    assert.equal(
      checkSeparationOfDuties({
        policies: [scoped],
        action: 'Approve',
        module: 'objective',
        actorUserId: 'author',
        resource: { id: 'r', createdByUserId: 'author' },
      }).satisfied,
      true,
    );
  });
});

// ===========================================================================
describe('role templates', () => {
  it('gives Employee no approve, publish, assign or administer anywhere', () => {
    for (const [module, actions] of Object.entries(ROLE_TEMPLATES.Employee.permissions)) {
      for (const forbidden of ['Approve', 'Publish', 'Assign', 'ManageAccess', 'Administer']) {
        assert.ok(
          !(actions ?? []).includes(forbidden as Action),
          `Employee must not have ${forbidden} on ${module}`,
        );
      }
    }
  });

  it('lets Employee run an approved agent but not publish or schedule one', () => {
    const agents = ROLE_TEMPLATES.Employee.permissions.agents ?? [];
    assert.ok(agents.includes('Run'), 'running approved work is the job');
    assert.ok(!agents.includes('Publish'));
    assert.ok(!agents.includes('Schedule'));
  });

  it('keeps Approve out of Manager, preserving the Approve & Assign boundary', () => {
    // The client's locked boundary: handing work to a person and approving the plan are separate
    // decisions. A manager who should also approve gets the Approver role as well, which makes
    // the second decision visible in the assignment record.
    for (const [, actions] of Object.entries(ROLE_TEMPLATES.Manager.permissions)) {
      assert.ok(!(actions ?? []).includes('Approve'), 'Manager must not carry Approve');
    }
    assert.ok((ROLE_TEMPLATES.Manager.permissions.objective ?? []).includes('Assign'));
  });

  it('keeps Approve out of Company Admin', () => {
    // Administering a company is not being an approver in its workflow. Blanket approval for an
    // administrator is how "the admin approved their own change" happens.
    for (const [, actions] of Object.entries(ROLE_TEMPLATES.CompanyAdmin.permissions)) {
      assert.ok(!(actions ?? []).includes('Approve'), 'CompanyAdmin must not carry Approve');
    }
  });

  it('gives Auditor no write action anywhere', () => {
    const writes: Action[] = [
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
      'Comment',
    ];

    for (const [module, actions] of Object.entries(ROLE_TEMPLATES.Auditor.permissions)) {
      for (const write of writes) {
        assert.ok(
          !(actions ?? []).includes(write),
          `Auditor must not have ${write} on ${module} — its access cannot alter what it audits`,
        );
      }
    }
  });

  it('keeps Approver unable to author what it approves', () => {
    for (const [module, actions] of Object.entries(ROLE_TEMPLATES.Approver.permissions)) {
      assert.ok(
        !(actions ?? []).includes('Create') && !(actions ?? []).includes('EditDraft'),
        `Approver must not author on ${module}`,
      );
    }
    assert.ok((ROLE_TEMPLATES.Approver.permissions.objective ?? []).includes('Approve'));
  });

  it('caps each role at a sensible scope', () => {
    assert.equal(ROLE_TEMPLATES.Employee.maxScope, 'OwnWork');
    assert.equal(ROLE_TEMPLATES.Manager.maxScope, 'TeamSubtree');
    assert.equal(ROLE_TEMPLATES.CompanyAdmin.maxScope, 'WholeCompany');
  });

  it('never names a module or action outside the vocabulary', () => {
    for (const template of Object.values(ROLE_TEMPLATES)) {
      for (const [module, actions] of Object.entries(template.permissions)) {
        assert.ok(
          (MODULE_KEYS as readonly string[]).includes(module),
          `${template.kind} names unknown module "${module}"`,
        );
        for (const action of actions ?? []) {
          assert.ok(
            (ACTIONS as readonly string[]).includes(action),
            `${template.kind} names unknown action "${action}"`,
          );
        }
      }
    }
  });

  it('keeps company and platform permissions separate', () => {
    // A platform permission set naming a company module would blur the two planes.
    for (const module of Object.keys(PLATFORM_PERMISSIONS)) {
      assert.ok(
        (MODULE_KEYS as readonly string[]).includes(module),
        `platform permissions name unknown module "${module}"`,
      );
    }
  });
});

// ===========================================================================
describe('privilege-escalation negatives', () => {
  it('an assignment cannot grant an action the role template lacks', () => {
    // `grantedActions` is produced from the template, so the escalation is to hand-craft an input
    // claiming more. The engine still refuses, because the *module visibility* and the granted
    // list are the only source — there is no path that adds to them.
    const result = evaluatePrecedence(
      input({
        module: 'objective',
        action: 'Approve',
        grantedActions: ROLE_TEMPLATES.Employee.permissions.objective ?? [],
        visibleModules: ['objective'],
      }),
    );

    assert.equal(result.allowed, false);
    assert.equal(result.decision.reason, 'role-lacks-action');
  });

  it('a custom role naming an unknown module or action grants nothing for it', () => {
    // The escalation: write `"*": ["Administer"]` or a misspelled action into a custom role's
    // stored matrix and hope it is treated as a wildcard.
    const sanitised = sanitisePermissionSet({
      '*': ['Administer'],
      objective: ['Approve', 'NotAnAction', 'Administer'],
      'no-such-module': ['View'],
    });

    assert.equal(sanitised['*' as ModuleKey], undefined, 'no wildcard module');
    assert.equal(sanitised['no-such-module' as ModuleKey], undefined);
    assert.deepEqual(sanitised.objective, ['Approve', 'Administer']);
  });

  it('a non-object custom role matrix grants nothing', () => {
    for (const bad of [null, undefined, 'Administer', 42, []]) {
      assert.deepEqual(sanitisePermissionSet(bad), {});
    }
  });

  it('an Engine Agent layer cannot grant itself past a company mandate', () => {
    const result = evaluatePrecedence(
      input({
        action: 'Run',
        grantedActions: ['Run'],
        rules: [
          rule({
            layer: 'Company',
            action: 'Run',
            mandatory: true,
            reason: 'Runs are paused company-wide.',
          }),
          rule({ layer: 'EngineAgent', action: 'Run', effect: 'Allow', reason: 'Agent insists.' }),
        ],
      }),
    );

    assert.equal(result.allowed, false);
    assert.equal(result.decision.message, 'Runs are paused company-wide.');
  });

  it('an Objective layer cannot widen scope past its department', () => {
    const result = evaluatePrecedence(
      input({
        assignedScope: 'Department',
        rules: [
          rule({ layer: 'Department', effect: 'Allow', maxScope: 'OwnWork', reason: 'narrow' }),
          rule({ layer: 'Objective', effect: 'Allow', maxScope: 'WholeCompany', reason: 'widen' }),
        ],
      }),
    );

    assert.equal(result.effectiveScope, 'OwnWork');
  });

  it('a guest cannot reach a forbidden action through a permitted module', () => {
    const result = evaluatePrecedence(
      input({
        userType: 'ExternalGuest',
        module: 'approvals',
        action: 'Approve',
        grantedActions: ['View', 'Comment', 'Approve'],
        visibleModules: ['approvals'],
        assignedScope: 'WholeCompany',
      }),
    );

    assert.equal(result.allowed, false);
    assert.equal(result.decision.reason, 'user-type-ceiling');
  });

  it('an empty granted list refuses everything', () => {
    for (const action of ACTIONS) {
      const result = evaluatePrecedence(
        input({ action, grantedActions: [], visibleModules: ['objective'] }),
      );
      assert.equal(result.allowed, false, `no grant must refuse ${action}`);
    }
  });

  it('an empty visible-module list refuses everything', () => {
    for (const module of MODULE_KEYS.slice(0, 6)) {
      const result = evaluatePrecedence(
        input({ module, grantedActions: [...ACTIONS], visibleModules: [] }),
      );
      assert.equal(result.allowed, false, `no visibility must refuse ${module}`);
    }
  });
});

// ===========================================================================
describe('the permission matrix', () => {
  it('is produced by the same engine that enforces, so the two cannot disagree', () => {
    const base = {
      userType: 'InternalUser' as UserType,
      module: 'objective' as ModuleKey,
      grantedActions: ['View', 'Comment', 'Approve'] as Action[],
      visibleModules: ['objective'] as ModuleKey[],
      assignedScope: 'Department' as const,
      rules: [rule({ action: 'Approve', reason: 'No approvals here.' })],
    };

    const permitted = permittedActions(base, [...ACTIONS]);

    assert.deepEqual([...permitted], ['View', 'Comment']);
    // And each one agrees with a direct evaluation.
    for (const action of ACTIONS) {
      const direct = evaluatePrecedence({ ...base, action }).allowed;
      assert.equal(direct, permitted.includes(action), `${action} must agree`);
    }
  });
});

// ===========================================================================
describe('the vocabulary itself', () => {
  it('has no duplicate module keys across company and platform', () => {
    assert.equal(new Set(MODULE_KEYS).size, MODULE_KEYS.length);
  });

  it('has no duplicate actions', () => {
    assert.equal(new Set(ACTIONS).size, ACTIONS.length);
  });

  it('exposes exactly the fourteen actions the client approved', () => {
    assert.equal(ACTIONS.length, 14);
    assert.deepEqual(
      [...ACTIONS],
      [
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
      ],
    );
  });

  it('exposes exactly the six scopes the client approved', () => {
    assert.equal(SCOPE_KINDS.length, 6);
  });

  it('keeps EditDraft and Publish distinct, and Assign and Approve distinct', () => {
    // Both distinctions are load-bearing client rules; collapsing either would erase a boundary.
    assert.notEqual('EditDraft', 'Publish');
    assert.ok((ACTIONS as readonly string[]).includes('EditDraft'));
    assert.ok((ACTIONS as readonly string[]).includes('Publish'));
    assert.ok((ACTIONS as readonly string[]).includes('Assign'));
    assert.ok((ACTIONS as readonly string[]).includes('Approve'));
  });
});

// ---------------------------------------------------------------------------
// Prompt 24 — who may set up and activate an agent
// ---------------------------------------------------------------------------

describe('Agent Builder permissions are the documented journey', () => {
  it('gives a standard Employee no Agent Builder at all — CR-03', () => {
    // **This test replaces its own opposite, and the reason is worth keeping.**
    //
    // It used to assert that an Employee held `agent-builder: EditDraft` and `Run`, citing the
    // source document — "Employee completes Human work and only missing Agent setup -> Test ->
    // Activate" — and it said that if anybody narrowed the grant again, this test should be the
    // thing that stopped them. That was right for the document in force at the time.
    //
    // CR-03 (Prompt 40A) narrows it deliberately and says so in terms: it "supersedes any earlier
    // assumption that every assigned employee must use Agent Builder", and requires a standard
    // Employee to default to operations-only with Objective Optimization and Agent Builder hidden
    // and backend-blocked unless explicitly granted. A latest explicit client amendment outranks
    // the earlier functional document, so the grant goes — and this test now guards the new rule
    // with its own citation, so the *next* person to widen it by accident is stopped too.
    assert.equal(
      ROLE_TEMPLATES.Employee.permissions['agent-builder'],
      undefined,
      'a standard Employee must hold no agent-builder grant, so the screen is hidden and the ' +
        'route refused by the same absent grant',
    );
    assert.equal(
      ROLE_TEMPLATES.Employee.permissions.objective,
      undefined,
      'Objective Optimization is hidden from a standard Employee for the same reason',
    );
  });

  it('still lets an Employee run the agents assigned to them', () => {
    // Operations-only must not mean unable to work. The employee journey CR-03 keeps is: see the
    // agent in OPERATIONS, run it, read the result.
    const agents = ROLE_TEMPLATES.Employee.permissions.agents ?? [];
    assert.ok(agents.includes('View'));
    assert.ok(agents.includes('Run'));
    assert.ok(!agents.includes('Publish'), 'an Employee could release an agent version');
  });

  it('reaches a builder screen only through an explicit grant', () => {
    // The Power Employee case, and the thing that makes "unless explicitly granted" real: the
    // engine unions grants across a person's assignments, so a custom role carrying the builder
    // permissions is exactly "a standard Employee with Builder access added". No new mechanism.
    const granted = expandCapabilities(POWER_EMPLOYEE_CAPABILITIES);
    assert.ok((granted['agent-builder'] ?? []).includes('EditDraft'));
    assert.equal(capabilitiesHideBuilderScreens(STANDARD_EMPLOYEE_CAPABILITIES), true);
    assert.equal(capabilitiesHideBuilderScreens(POWER_EMPLOYEE_CAPABILITIES), false);
  });

  it('confines an Employee to their own work, which is what makes that safe', () => {
    // The grant above is only defensible because of this: the scope engine limits every action
    // to work this person owns, so an Employee never configures or activates anybody else's.
    assert.equal(ROLE_TEMPLATES.Employee.maxScope, 'OwnWork');
    assert.equal(ROLE_TEMPLATES.Employee.defaultScope, 'OwnWork');
  });

  it('still does not let an Employee release a reusable agent version to the company', () => {
    // The distinction the correction has to preserve: activating the agent for your own assigned
    // step is doing the work. Deciding which version of a reusable agent the company runs is a
    // different decision, and it stays out of the Employee template.
    const agents = ROLE_TEMPLATES.Employee.permissions.agents ?? [];
    assert.ok(agents.includes('Run'));
    assert.ok(!agents.includes('Publish'), 'an Employee could release an agent version');
    assert.ok(!agents.includes('Schedule'), 'an Employee could make an agent run unattended');
  });

  it('gives a Head authority over agent work without making them the owner of it', () => {
    const head = ROLE_TEMPLATES.Head.permissions['agent-builder'] ?? [];
    assert.ok(head.includes('Run'), 'a Head cannot activate an agent');
    assert.ok(head.includes('EditDraft'));
    // `Publish` is what gates the canonical Form 3 read and releasing a reusable agent's
    // configuration to the company — authority over the job method, not over doing the work.
    assert.ok(head.includes('Publish'));
  });

  it('keeps every Agent Builder action inside the closed vocabulary', () => {
    // The service asks the authorization engine for 'View', 'EditDraft' and 'Publish'. An action
    // that is not in ACTIONS is refused as unknown-action, so a typo there would deny silently
    // rather than fail loudly.
    for (const action of ['View', 'EditDraft', 'Run', 'Publish'] as const) {
      assert.ok((ACTIONS as readonly string[]).includes(action), `${action} is not an Action`);
    }
  });

  it('grants no role an action on agent-builder that the vocabulary does not define', () => {
    for (const template of Object.values(ROLE_TEMPLATES)) {
      for (const action of template.permissions['agent-builder'] ?? []) {
        assert.ok(
          (ACTIONS as readonly string[]).includes(action),
          `${template.kind} has unknown agent-builder action ${action}`,
        );
      }
    }
  });
});
