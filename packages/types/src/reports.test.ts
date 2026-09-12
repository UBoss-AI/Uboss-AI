import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { ACTIONS, COMPANY_MODULES } from './authorization.js';
import { ROLE_TEMPLATES } from './role-templates.js';
import {
  csvCell,
  DASHBOARD_ALLOWED_KEYS,
  DASHBOARD_SLICE_DESTINATIONS,
  DASHBOARD_SLICE_LABELS,
  DASHBOARD_SLICES,
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
 * Reporting and the locked dashboard — Prompt 37.
 *
 * The weight is on the three things a wrong answer makes dangerous: **the dashboard staying two
 * slices**, **a report requiring its source module's permission as well as `reports:View`**, and
 * **an empty scope meaning nobody rather than everybody**.
 */
describe('the locked Company Workspace Dashboard', () => {
  it('has exactly two slices, and they are Agents and Pending Jobs', () => {
    assert.deepEqual([...DASHBOARD_SLICES], ['agents', 'pendingJobs']);
    assert.equal(DASHBOARD_SLICE_LABELS.agents, 'Agents');
    assert.equal(DASHBOARD_SLICE_LABELS.pendingJobs, 'Pending Jobs');
  });

  it('sends each slice somewhere', () => {
    assert.equal(DASHBOARD_SLICE_DESTINATIONS.agents, '/agents');
    assert.equal(DASHBOARD_SLICE_DESTINATIONS.pendingJobs, '/todo');
  });

  it('permits no third key on the dashboard payload', () => {
    // The failure mode is additive: nobody deletes the donut, somebody adds a card beside it.
    assert.deepEqual([...DASHBOARD_ALLOWED_KEYS], ['agents', 'pendingJobs', 'scope']);
    for (const forbidden of ['cost', 'tokens', 'notifications', 'kpis', 'objectives', 'badges']) {
      assert.equal(
        DASHBOARD_ALLOWED_KEYS.includes(forbidden),
        false,
        `"${forbidden}" must never appear on the Company Workspace Dashboard`,
      );
    }
  });
});

describe('the ten reports', () => {
  it('is exactly the ten the prompt names', () => {
    assert.equal(REPORT_KEYS.length, 10);
    assert.equal(REPORTS.length, 10);
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
  it('would otherwise let an Employee read modules they cannot open', () => {
    const employee = ROLE_TEMPLATES.Employee;
    assert.equal(
      (employee.permissions.reports ?? []).includes('View'),
      true,
      'an Employee can open Reports',
    );

    // And holds no `users` view at all, so a report sourced from it must be withheld.
    assert.equal((employee.permissions.users ?? []).length, 0);
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
