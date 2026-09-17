import { describe, expect, it } from 'vitest';

import { COMPANY_NAV, filterNavigation, type NavGroup } from './navigation-model';

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

describe('an offered item is an item that opens', () => {
  /*
   * The rule this enforces: no visible sidebar entry may route to a screen the same person is
   * forbidden to open.
   *
   * Module presence used to be the whole filter, and for almost every screen it is right. But a
   * screen whose landing request names a specific row is subject to the scope layer too, and the
   * scope layer can refuse what the module grant allowed. Performance is the case that found it:
   * every role holds `performance:View`, so the sidebar offered it to a Head whose own record
   * `GET performance/me` then refused, because a department-scoped role cannot place a resource
   * carrying no department. The server now reports those keys, having run the route's own
   * authorize call, and they are filtered here.
   */
  const keysOf = (groups: readonly NavGroup[]) => groups.flatMap((group) => group.items.map((item) => item.key));

  it('offers Performance when nothing is known to refuse it', () => {
    const offered = keysOf(filterNavigation(COMPANY_NAV, ['dashboard', 'performance'], []));
    expect(offered).toContain('performance');
  });

  it('withholds an entry the engine has already refused', () => {
    const offered = keysOf(filterNavigation(COMPANY_NAV, ['dashboard', 'performance'], ['performance']));

    expect(offered).not.toContain('performance');
    // And only that entry: a refusal is about one screen, not about the group it sits in.
    expect(offered).toContain('dashboard');
  });

  /*
   * The one place this deliberately does not fail open. A missing module list means the answer has
   * not arrived, so the full menu is the right guess — but an unavailable key is not a pending
   * answer, it is the server having been refused already. Showing it because the module list is
   * still loading would put the broken item back on screen for exactly as long as the page takes
   * to settle, which is when people click things.
   */
  it('honours a refusal even while the module list is still loading', () => {
    const offered = keysOf(filterNavigation(COMPANY_NAV, null, ['performance']));

    expect(offered).not.toContain('performance');
    expect(offered).toContain('dashboard');
    expect(offered.length).toBeGreaterThan(5);
  });

  it('still renders the whole menu when nothing is known either way', () => {
    const offered = keysOf(filterNavigation(COMPANY_NAV, null, null));
    expect(offered).toContain('performance');
  });

  it('drops a group that a refusal empties', () => {
    const oneItemGroup: NavGroup[] = [{ group: 'SOLO', items: [{ key: 'performance', label: 'Performance', icon: 'medal', href: '/performance' }] }];

    // A heading with nothing under it reads as a loading failure, which is why the group goes too.
    expect(filterNavigation(oneItemGroup, ['performance'], ['performance'])).toEqual([]);
  });
});
