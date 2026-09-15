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

/**
 * What `/my-access` returns for a standard Employee after CR-03. Grants, not a role name.
 *
 * There is deliberately no `chat` here, and there never can be: `visibleModules` is typed
 * `readonly ModuleKey[]`, and `chat` is not a module in either COMPANY_MODULES or
 * PLATFORM_MODULES. An earlier version of this fixture listed it, which made the chat assertions
 * below test an input the server cannot send.
 */
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

  it('puts Workspace Chat under Operations for a standard Employee', () => {
    const operations = filterNavigation(COMPANY_NAV, STANDARD_EMPLOYEE).find(
      (group) => group.group === 'Operations',
    );

    expect(operations?.items.map((item) => item.key)).toContain('chat');
  });

  it('shows Workspace Chat even though no grant mentions it', () => {
    // The regression this pins. Chat declares `module: null` because access to a conversation is
    // being a participant in it, not holding a company-wide grant — so filtering it against the
    // module list removed it for every user of every role. It must survive the emptiest grant
    // list there is.
    const keys = filterNavigation(COMPANY_NAV, [])
      .flatMap((group) => group.items)
      .map((item) => item.key);

    expect(keys).toContain('chat');
  });

  it('still hides a module-gated item that is not granted', () => {
    // The other half: making chat exempt must not make everything exempt.
    const keys = filterNavigation(COMPANY_NAV, [])
      .flatMap((group) => group.items)
      .map((item) => item.key);

    expect(keys).not.toContain('agent-builder');
    expect(keys).not.toContain('settings');
    expect(keys).not.toContain('dashboard');
  });

  it('drops a group once nothing in it is permitted', () => {
    // An empty "Builders" heading with no items under it reads as a broken menu. Operations still
    // appears because Workspace Chat is not module-gated and so is always offered.
    const groups = filterNavigation(COMPANY_NAV, ['dashboard']);

    expect(groups.map((group) => group.group)).toEqual(['Home', 'Operations']);
    expect(groups.find((group) => group.group === 'Operations')?.items.map((i) => i.key)).toEqual([
      'chat',
    ]);
  });

  it('keeps the source order rather than the order of the grants', () => {
    const operations = filterNavigation(COMPANY_NAV, ['agents', 'todo']).find(
      (group) => group.group === 'Operations',
    );

    // Source order, and chat sits where COMPANY_NAV puts it rather than being appended.
    expect(operations?.items.map((item) => item.key)).toEqual(['todo', 'agents', 'chat']);
  });

  it('returns nothing module-gated when nothing is granted', () => {
    const groups = filterNavigation(COMPANY_NAV, []);

    expect(groups.map((group) => group.group)).toEqual(['Operations']);
    expect(groups.flatMap((group) => group.items).map((item) => item.key)).toEqual(['chat']);
  });

  it('never mutates the source navigation', () => {
    const before = JSON.stringify(COMPANY_NAV);
    filterNavigation(COMPANY_NAV, ['dashboard']);
    expect(JSON.stringify(COMPANY_NAV)).toBe(before);
  });

  it('ignores a granted module that has no navigation item', () => {
    // `skills` is a platform module: a grant on it must not conjure a sidebar entry.
    const groups = filterNavigation(COMPANY_NAV, ['dashboard', 'skills']);
    expect(groups.flatMap((group) => group.items).map((item) => item.key)).toEqual([
      'dashboard',
      'chat',
    ]);
  });
});
