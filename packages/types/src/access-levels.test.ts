import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { COMPANY_MODULES, type CompanyModuleKey } from './authorization.js';
import {
  ACCESS_LEVELS,
  SECTION_LEVELS,
  accessLevelRank,
  accessSections,
  actionsForLevel,
  levelFromActions,
  levelGrantProblem,
  sectionLevelLine,
  type AccessLevel,
} from './access-levels.js';

describe('access as a section and a level', () => {
  /*
   * The property that makes it a level rather than a checkbox.
   *
   * An Approver who could not open the thing they are approving is not a permission anybody
   * means to grant, and it is exactly what independent ticks would allow.
   */
  it('gives every level everything the level below it has', () => {
    for (let i = 1; i < ACCESS_LEVELS.length; i += 1) {
      const lower = actionsForLevel(ACCESS_LEVELS[i - 1] as AccessLevel);
      const higher = actionsForLevel(ACCESS_LEVELS[i] as AccessLevel);
      for (const action of lower) {
        assert.ok(
          higher.includes(action),
          `${ACCESS_LEVELS[i]} does not include ${action}, which ${ACCESS_LEVELS[i - 1]} has`,
        );
      }
      assert.ok(higher.length > lower.length, `${ACCESS_LEVELS[i]} adds nothing`);
    }
  });

  it('puts the four actions where the approved list expects them', () => {
    const viewer = actionsForLevel('Viewer');
    const creator = actionsForLevel('Creator');
    const approver = actionsForLevel('Approver');
    const admin = actionsForLevel('Admin');

    // A download is not administration — "See their team's reports" is the bottom rung.
    assert.ok(viewer.includes('Export'));
    // Running an agent somebody assigned you is doing the work, not administering it.
    assert.ok(creator.includes('Run'));
    assert.ok(!viewer.includes('Run'));
    assert.ok(approver.includes('Approve'));
    assert.ok(!creator.includes('Approve'));
    // Handing work to other people, and handing out access, are the top.
    assert.ok(admin.includes('Assign'));
    assert.ok(admin.includes('ManageAccess'));
    assert.ok(!approver.includes('Assign'));
  });

  /*
   * The eight capabilities the previous screen offered, as section and level.
   *
   * This is the client's own mapping, asserted rather than described — if a level's actions ever
   * drift, the thing that breaks is the promise that was made about what they mean.
   */
  it('reproduces the capabilities it replaces', () => {
    const at = (module: CompanyModuleKey, level: AccessLevel) => actionsForLevel(level);

    // RunAssignedAgents → Engine Agents · Creator
    assert.ok(at('agents', 'Creator').includes('Run'));
    // OwnTasks → To-do List · Creator
    assert.ok(at('todo', 'Creator').includes('EditDraft'));
    // AssignWork → To-do List · Admin
    assert.ok(at('todo', 'Admin').includes('Assign'));
    assert.ok(!at('todo', 'Creator').includes('Assign'));
    // SeeTeamReports → Reports · Viewer
    assert.ok(at('reports', 'Viewer').includes('Export'));
    // ManagePeople → Hierarchy · Creator
    assert.ok(at('hierarchy', 'Creator').includes('EditDraft'));
    // DefineObjectives → Objective Optimization · Creator
    assert.ok(at('objective', 'Creator').includes('Create'));
    // BuildAgents → Agent Builder · Creator, ActivateAgents → Agent Builder · Admin
    assert.ok(at('agent-builder', 'Creator').includes('EditDraft'));
    assert.ok(at('agent-builder', 'Admin').includes('Publish'));
    assert.ok(!at('agent-builder', 'Creator').includes('Publish'));
  });

  /*
   * Only where it means something.
   *
   * `APPROVAL_TYPE_MODULE` routes every approval type to `objective`, `agents` or the generic
   * `approvals` queue. An "Approver" on the Dashboard is a control that changes nothing, and
   * somebody who ticked it would believe they had given a colleague something.
   */
  it('offers Approver only on the sections that govern a decision', () => {
    const withApprover = COMPANY_MODULES.filter((module) =>
      SECTION_LEVELS[module].includes('Approver'),
    );
    assert.deepEqual([...withApprover].sort(), ['agents', 'approvals', 'objective']);
  });

  it('offers every section at least a Viewer, and never an empty row', () => {
    for (const module of COMPANY_MODULES) {
      const levels = SECTION_LEVELS[module];
      assert.ok(levels.length > 0, `${module} offers no level at all`);
      assert.equal(levels[0], 'Viewer', `${module} does not start at Viewer`);
      // Ordered as the ladder is, so the screen can draw them left to right without sorting.
      const ranks = levels.map((level) => accessLevelRank(level));
      assert.deepEqual(
        ranks,
        [...ranks].sort((a, b) => a - b),
        `${module} lists levels out of order`,
      );
    }
  });

  it('says what each level means in that section, in one line', () => {
    for (const section of accessSections()) {
      for (const level of section.levels) {
        assert.ok(level.line.length > 0, `${section.module} · ${level.level} says nothing`);
        assert.ok(
          level.line.length < 90,
          `${section.module} · ${level.level} is a paragraph, not a line`,
        );
      }
    }
  });

  it('falls back to a generic line rather than drawing a blank', () => {
    // `dashboard` declares only Viewer; asking for a level it does not offer still answers.
    assert.ok(sectionLevelLine('dashboard', 'Admin').length > 0);
  });

  describe('what an administrator may hand out', () => {
    it('refuses a level above the one the granter holds', () => {
      const problem = levelGrantProblem({
        granterLevel: 'Creator',
        requested: 'Admin',
        module: 'objective',
        granterIsCompanyAdmin: false,
      });
      assert.match(String(problem), /above the Creator access you hold/i);
    });

    it('refuses a section the granter holds nothing on', () => {
      const problem = levelGrantProblem({
        granterLevel: null,
        requested: 'Viewer',
        module: 'agent-builder',
        granterIsCompanyAdmin: false,
      });
      assert.match(String(problem), /no access to Agent Builder yourself/i);
    });

    it('allows the level the granter holds, and everything below it', () => {
      for (const requested of ['Viewer', 'Creator'] as const) {
        assert.equal(
          levelGrantProblem({
            granterLevel: 'Creator',
            requested,
            module: 'objective',
            granterIsCompanyAdmin: false,
          }),
          null,
        );
      }
    });

    it('lets a company administrator grant anything inside their own company', () => {
      assert.equal(
        levelGrantProblem({
          granterLevel: null,
          requested: 'Admin',
          module: 'settings',
          granterIsCompanyAdmin: true,
        }),
        null,
      );
    });
  });

  describe('reading a level back off real grants', () => {
    it('answers with the highest level the actions amount to', () => {
      assert.equal(levelFromActions('objective', actionsForLevel('Approver')), 'Approver');
      assert.equal(levelFromActions('objective', actionsForLevel('Viewer')), 'Viewer');
    });

    it('answers nothing for somebody holding nothing', () => {
      assert.equal(levelFromActions('objective', []), null);
    });

    /*
     * A section that never offers Approve must not be judged against it.
     *
     * Agent Builder has no approvable thing of its own, so its Admin carries no `Approve` — and
     * reading its level back has to know that, or nobody could ever read as its Admin.
     */
    it('does not expect an action the section never offers', () => {
      assert.equal(levelFromActions('agent-builder', actionsForLevel('Admin')), 'Admin');
    });
  });
});
