import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { ACTIONS, COMPANY_MODULES } from './authorization.js';
import { ROLE_TEMPLATES } from './role-templates.js';
import {
  csvCell,
  DASHBOARD_ALLOWED_KEYS,
  DASHBOARD_LANE_LABELS,
  DASHBOARD_LANE_MEASURE,
  DASHBOARD_LANES,
  DASHBOARD_TILE_DESTINATIONS,
  DASHBOARD_TILE_LANE,
  DASHBOARD_TILE_LABELS,
  DASHBOARD_TILE_MEASURE,
  DASHBOARD_TILE_MODULE,
  DASHBOARD_TILES,
  MAX_REPORT_RANGE_DAYS,
  permissionsForReport,
  REPORT_EXPORT_PERMISSION,
  REPORT_KEYS,
  reportDefinition,
  REPORTS,
  resolveWindow,
  scopeIsEmpty,
  toCsv,
  type ReportScope,
} from './reports.js';

/**
 * Reporting and the orchestration dashboard — Prompt 37, as revised.
 *
 * The weight is on the three things a wrong answer makes dangerous: **every tile being gated on a
 * module that really exists**, **a report requiring its source module's permission as well as
 * `reports:View`**, and **an empty scope meaning nobody rather than everybody**.
 *
 * The dashboard used to be two slices and nothing else, and these tests used to hold that line.
 * The client replaced that rule with an orchestration view, so what they hold now is the discipline
 * that replaced it: a tile is gated, a tile goes somewhere, a number means something stated, and
 * money never appears here.
 */
describe('the Company Workspace Dashboard', () => {
  it('offers the seven work areas, and no eighth', () => {
    assert.deepEqual(
      [...DASHBOARD_TILES],
      ['objectives', 'tasks', 'agents', 'approvals', 'exceptions', 'performance', 'reports'],
    );
  });

  it('gates every tile on a module that actually exists', () => {
    for (const tile of DASHBOARD_TILES) {
      const module = DASHBOARD_TILE_MODULE[tile];
      assert.ok(
        (COMPANY_MODULES as readonly string[]).includes(module),
        `${tile} is gated on "${module}", which is not a company module`,
      );
    }
  });

  it('sends every tile somewhere, and labels every one', () => {
    for (const tile of DASHBOARD_TILES) {
      assert.ok(
        DASHBOARD_TILE_DESTINATIONS[tile].startsWith('/'),
        `${tile} has no destination`,
      );
      assert.ok(DASHBOARD_TILE_LABELS[tile].length > 0, `${tile} has no label`);
    }
  });

  /*
   * A number with no stated meaning is the thing two people read two different ways — and on this
   * screen two people with different scopes legitimately see different numbers. So a tile either
   * says what its count measures, or it carries no count at all.
   */
  it('states what every count measures, or carries no count', () => {
    for (const tile of DASHBOARD_TILES) {
      const measure = DASHBOARD_TILE_MEASURE[tile];
      assert.ok(
        measure === null || measure.length > 0,
        `${tile} has a count with nothing said about what it counts`,
      );
    }
    // The two the client named that have no single honest number.
    assert.equal(DASHBOARD_TILE_MEASURE.performance, null);
    assert.equal(DASHBOARD_TILE_MEASURE.reports, null);
  });

  /*
   * The map is drawn from this, so a tile with no side has nowhere to be drawn — and the failure
   * is not an exception, it is a work area that silently stops appearing on the dashboard for
   * everybody. That is the kind of thing nobody notices until somebody asks where Approvals went.
   */
  it('puts every work area on one of the two sides', () => {
    for (const tile of DASHBOARD_TILES) {
      const lane = DASHBOARD_TILE_LANE[tile];
      assert.ok(
        (DASHBOARD_LANES as readonly string[]).includes(lane),
        `${tile} is on "${lane}", which is not a side of the dashboard`,
      );
    }
  });

  it('uses both sides, and says what each is for', () => {
    // A split with everything on one side is not a split; it is a heading over the whole screen.
    for (const lane of DASHBOARD_LANES) {
      const on = DASHBOARD_TILES.filter((tile) => DASHBOARD_TILE_LANE[tile] === lane);
      assert.ok(on.length > 0, `nothing is on the "${lane}" side`);
      assert.ok(DASHBOARD_LANE_LABELS[lane].length > 0, `"${lane}" has no label`);
      assert.ok(DASHBOARD_LANE_MEASURE[lane].length > 0, `"${lane}" does not say what it is for`);
    }
  });

  /*
   * Which side a work area is on is a statement about the product, so it is checked rather than
   * left to whoever edits the map next. Approvals drifting to "Execution" would put the thing that
   * checks work in the column for doing it.
   */
  it('keeps deciding and reviewing on the oversight side', () => {
    assert.equal(DASHBOARD_TILE_LANE.objectives, 'execution');
    assert.equal(DASHBOARD_TILE_LANE.tasks, 'execution');
    assert.equal(DASHBOARD_TILE_LANE.agents, 'execution');
    assert.equal(DASHBOARD_TILE_LANE.approvals, 'oversight');
    assert.equal(DASHBOARD_TILE_LANE.exceptions, 'oversight');
    assert.equal(DASHBOARD_TILE_LANE.performance, 'oversight');
    assert.equal(DASHBOARD_TILE_LANE.reports, 'oversight');
  });

  it('permits no third key on the dashboard payload', () => {
    // Still asserted, and still for the original reason: adding to this screen has to be a
    // decision somebody takes on purpose rather than something that accumulates.
    assert.deepEqual([...DASHBOARD_ALLOWED_KEYS], ['tiles', 'scope']);
    for (const forbidden of ['cost', 'tokens', 'spend', 'budget', 'kpis', 'badges']) {
      assert.equal(
        DASHBOARD_ALLOWED_KEYS.includes(forbidden),
        false,
        `"${forbidden}" must never appear on the Company Workspace Dashboard`,
      );
    }
  });
});

describe('the report catalogue', () => {
  it('is the prompt’s ten plus the one the sequence made possible', () => {
    /*
     * Ten came from the prompt. `DependencyWaiting` is the eleventh and was added when a step
     * whose predecessors are unfinished became a real state: from outside, an objective with four
     * waiting steps looks exactly like one nobody has got round to, and that difference is worth a
     * report. The count stays pinned so a twelfth is a decision somebody wrote down here.
     */
    assert.equal(REPORT_KEYS.length, 11);
    assert.equal(REPORTS.length, 11);
    assert.ok((REPORT_KEYS as readonly string[]).includes('DependencyWaiting'));
  });

  it('gives every report a question rather than only a title', () => {
    for (const report of REPORTS) {
      assert.equal(report.question.endsWith('?'), true, `${report.key} has no question`);
      assert.equal(report.label.length > 0, true);
    }
  });

  it('names a real company module and a real action on every source permission', () => {
    for (const report of REPORTS) {
      if (report.sourcePermission === null) continue;
      assert.equal(
        COMPANY_MODULES.includes(report.sourcePermission.module),
        true,
        `${report.key} names "${report.sourcePermission.module}", which is not a company module`,
      );
      assert.equal(
        ACTIONS.includes(report.sourcePermission.action),
        true,
        `${report.key} names "${report.sourcePermission.action}", which is not an action`,
      );
    }
  });

  /**
   * The leak that named the action rather than assuming `View`.
   *
   * An Employee holds `settings:View` — it is what lets anybody open Settings and see their own
   * profile. Assuming `View` on the source module handed them the company's AI spend and its
   * audit trail.
   */
  it('does not let an Employee reach AI cost or the audit trail through Reports', () => {
    const employee = ROLE_TEMPLATES.Employee;
    assert.equal(
      (employee.permissions.settings ?? []).includes('View'),
      true,
      'an Employee does hold settings:View, which is why assuming it was the bug',
    );

    for (const key of ['AiUsageAndCost', 'AuditActivity'] as const) {
      const report = reportDefinition(key);
      const needed = report!.sourcePermission;
      assert.notEqual(needed, null, `${key} must need something beyond reports:View`);
      assert.equal(
        (employee.permissions[needed!.module] ?? []).includes(needed!.action),
        false,
        `an Employee can reach ${key}, which is a leak`,
      );
    }
  });

  it('requires the source module’s View as well as reports:View', () => {
    const approvals = reportDefinition('ApprovalAging');
    assert.notEqual(approvals, undefined);

    const required = permissionsForReport(approvals!);
    assert.deepEqual(required, [
      { module: 'reports', action: 'View' },
      { module: 'approvals', action: 'View' },
    ]);

    // And the two that need more than View.
    assert.deepEqual(permissionsForReport(reportDefinition('AiUsageAndCost')!), [
      { module: 'reports', action: 'View' },
      { module: 'settings', action: 'Administer' },
    ]);
    assert.deepEqual(permissionsForReport(reportDefinition('AuditActivity')!), [
      { module: 'reports', action: 'View' },
      { module: 'settings', action: 'Audit' },
    ]);
  });

  it('asks for only reports:View where the report has no other source', () => {
    const mix = reportDefinition('HumanVsAiWorkMix');
    assert.deepEqual(permissionsForReport(mix!), [{ module: 'reports', action: 'View' }]);
  });

  /**
   * The leak this two-grant rule prevents, asserted rather than described.
   *
   * If a report were gated on `reports:View` alone, every role template that holds it — which is
   * all of them — could read every other module's data through Reports.
   */
  it('closes both doors on the templates as they stand', () => {
    /*
     * This used to assert that an Employee holds `reports:View`, and demonstrate the leak from
     * there. CR-03 §9 took that grant away — a standard Employee is operations-first and gets
     * company Reports only when somebody grants them — so the example now shows the first door
     * shut rather than the second.
     *
     * Both doors are worth asserting, because they fail differently: the first is "you cannot
     * open Reports at all", the second is "you can open Reports, and this particular report is
     * still not yours".
     */
    const employee = ROLE_TEMPLATES.Employee;
    assert.equal(
      (employee.permissions.reports ?? []).length,
      0,
      'a default Employee holds no reports grant — CR-03 §9',
    );

    // The second door, on a role that is through the first. A Manager may open Reports, and holds
    // `settings:View`; the two reports sourced from settings need Administer and Audit, so the
    // source grant is what withholds them rather than the Reports grant.
    const manager = ROLE_TEMPLATES.Manager;
    assert.equal((manager.permissions.reports ?? []).includes('View'), true);
    const settings = manager.permissions.settings ?? [];
    assert.equal(settings.includes('Administer'), false);
    assert.equal(settings.includes('Audit'), false);
  });

  it('keeps export as its own grant, held by Manager and above and not by Employee', () => {
    assert.deepEqual(REPORT_EXPORT_PERMISSION, { module: 'reports', action: 'Export' });

    assert.equal((ROLE_TEMPLATES.Employee.permissions.reports ?? []).includes('Export'), false);
    assert.equal((ROLE_TEMPLATES.Approver.permissions.reports ?? []).includes('Export'), false);
    for (const role of ['Manager', 'Head', 'CompanyAdmin'] as const) {
      assert.equal(
        (ROLE_TEMPLATES[role].permissions.reports ?? []).includes('Export'),
        true,
        `${role} should be able to export`,
      );
    }
  });
});

describe('report windows', () => {
  const now = new Date('2026-09-12T12:00:00.000Z');

  it('resolves each fixed range from the caller’s clock', () => {
    const week = resolveWindow({ range: 'Last7Days', now });
    assert.equal(week.ok, true);
    assert.equal(week.ok && week.window.to.getTime() - week.window.from.getTime(), 7 * 86_400_000);
  });

  it('refuses a custom range that is missing an end, or is backwards', () => {
    assert.equal(resolveWindow({ range: 'Custom', now, from: now }).ok, false);
    assert.equal(
      resolveWindow({
        range: 'Custom',
        now,
        from: new Date('2026-09-12T00:00:00.000Z'),
        to: new Date('2026-09-11T00:00:00.000Z'),
      }).ok,
      false,
    );
  });

  it('refuses a range longer than a year', () => {
    const outcome = resolveWindow({
      range: 'Custom',
      now,
      from: new Date('2024-01-01T00:00:00.000Z'),
      to: new Date('2026-01-01T00:00:00.000Z'),
    });
    assert.equal(outcome.ok, false);
    assert.equal(
      outcome.ok === false && outcome.reason.includes(String(MAX_REPORT_RANGE_DAYS)),
      true,
    );
  });

  it('accepts a range exactly at the limit', () => {
    const from = new Date('2026-01-01T00:00:00.000Z');
    const to = new Date(from.getTime() + MAX_REPORT_RANGE_DAYS * 86_400_000);
    assert.equal(resolveWindow({ range: 'Custom', now, from, to }).ok, true);
  });
});

describe('report scope', () => {
  const scope = (userIds: readonly string[] | null): ReportScope => ({
    kind: 'TeamSubtree',
    userIds,
    departmentIds: null,
    description: 'test',
  });

  /**
   * The most dangerous default a reporting layer can have, pinned shut.
   *
   * A bug producing an empty list must narrow the report to nobody, not widen it to everybody.
   * `null` is the only value that means unrestricted, and it is only ever produced deliberately.
   */
  it('treats an empty user list as nobody, and null as everybody', () => {
    assert.equal(scopeIsEmpty(scope([])), true, 'an empty list is nobody');
    assert.equal(scopeIsEmpty(scope(null)), false, 'null is the whole company');
    assert.equal(scopeIsEmpty(scope(['a'])), false);
  });
});

describe('csv export', () => {
  /**
   * CSV injection: a cell beginning `=`, `+`, `-` or `@` executes as a formula when the file is
   * opened in Excel or Sheets, and report cells carry free text a company typed.
   */
  it('neutralises a formula in every cell', () => {
    assert.equal(csvCell('=cmd|"/c calc"!A1'), `"'=cmd|""/c calc""!A1"`);
    assert.equal(csvCell('+1234'), `"'+1234"`);
    assert.equal(csvCell('-1234'), `"'-1234"`);
    assert.equal(csvCell('@SUM(A1)'), `"'@SUM(A1)"`);
  });

  it('leaves ordinary text alone but still quotes it', () => {
    assert.equal(csvCell('Quarterly review'), '"Quarterly review"');
    assert.equal(csvCell('He said "hello"'), '"He said ""hello"""');
    assert.equal(csvCell(null), '""');
    assert.equal(csvCell(42), '"42"');
  });

  it('writes a header from the columns, in order', () => {
    const csv = toCsv([{ b: 2, a: 1 }], ['a', 'b']);
    assert.equal(csv, '"a","b"\r\n"1","2"');
  });

  it('emits only the named columns, so a query returning more cannot leak it', () => {
    const csv = toCsv([{ a: 1, secret: 'do not export me' }], ['a']);
    assert.equal(csv.includes('do not export me'), false);
  });
});
