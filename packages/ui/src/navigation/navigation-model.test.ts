import { describe, expect, it } from 'vitest';

import { COMPANY_NAV, filterNavigation } from './navigation-model';

/**
 * Permission-driven navigation — Prompt 40A (CR-03) §8.
 *
 * The rule these tests exist to hold: **the sidebar is derived from grants, never from a role
 * label.** `filterNavigation` takes a list of module keys and knows nothing about who holds them,
 * which is what makes a second rule impossible to add here by accident — there is nowhere to put an
 * `if (role === 'Employee')`.
 */

/** What `/my-access` returns for a standard Employee after CR-03. Grants, not a role name. */
const STANDARD_EMPLOYEE = [
  'dashboard',
  'hierarchy',
  'todo',
  'agents',
  'executor',
  'approvals',
  'performance',
  'reports',
  'profile-search',
  'settings',
  'chat',
];

describe('filterNavigation', () => {
  it('renders everything when the answer is not known yet', () => {
    // A menu leans open: every route is independently guarded, so the worst case is an item that
    // refuses when clicked — against a sidebar that flickers to empty on each page load.
    expect(filterNavigation(COMPANY_NAV, null)).toHaveLength(COMPANY_NAV.length);
    expect(filterNavigation(COMPANY_NAV, undefined)).toHaveLength(COMPANY_NAV.length);
  });

  it('hides Objective Optimization and Agent Builder from a standard Employee', () => {
    // The central CR-03 change: the Employee template has no `objective` and no `agent-builder`
    // key at all, and the absence is the feature.
    const keys = filterNavigation(COMPANY_NAV, STANDARD_EMPLOYEE)
      .flatMap((group) => group.items)
      .map((item) => item.key);

    expect(keys).not.toContain('objective');
    expect(keys).not.toContain('agent-builder');
  });

  it('shows them again the moment the grant is there — with no change to any role label', () => {
    const keys = filterNavigation(COMPANY_NAV, [...STANDARD_EMPLOYEE, 'agent-builder'])
      .flatMap((group) => group.items)
      .map((item) => item.key);

    expect(keys).toContain('agent-builder');
  });

  it('puts Workspace Chat under Operations when the grant is there', () => {
    const operations = filterNavigation(COMPANY_NAV, STANDARD_EMPLOYEE).find(
      (group) => group.group === 'Operations',
    );

    expect(operations?.items.map((item) => item.key)).toContain('chat');
  });

  it('hides Workspace Chat when it is not granted', () => {
    const keys = filterNavigation(
      COMPANY_NAV,
      STANDARD_EMPLOYEE.filter((key) => key !== 'chat'),
    )
      .flatMap((group) => group.items)
      .map((item) => item.key);

    expect(keys).not.toContain('chat');
  });

  it('drops a group once nothing in it is permitted', () => {
    // An empty "Builders" heading with no items under it reads as a broken menu.
    const groups = filterNavigation(COMPANY_NAV, ['dashboard']);

    expect(groups.map((group) => group.group)).toEqual(['Home']);
  });

  it('keeps the source order rather than the order of the grants', () => {
    const operations = filterNavigation(COMPANY_NAV, ['agents', 'todo', 'chat']).find(
      (group) => group.group === 'Operations',
    );

    expect(operations?.items.map((item) => item.key)).toEqual(['todo', 'agents', 'chat']);
  });

  it('returns nothing at all when nothing is granted', () => {
    expect(filterNavigation(COMPANY_NAV, [])).toEqual([]);
  });

  it('never mutates the source navigation', () => {
    const before = JSON.stringify(COMPANY_NAV);
    filterNavigation(COMPANY_NAV, ['dashboard']);
    expect(JSON.stringify(COMPANY_NAV)).toBe(before);
  });

  it('ignores a granted module that has no navigation item', () => {
    // `skills` is a platform module: a grant on it must not conjure a sidebar entry.
    const groups = filterNavigation(COMPANY_NAV, ['dashboard', 'skills']);
    expect(groups.flatMap((group) => group.items).map((item) => item.key)).toEqual(['dashboard']);
  });
});
