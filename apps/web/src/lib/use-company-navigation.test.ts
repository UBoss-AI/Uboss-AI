import { describe, expect, it } from 'vitest';

import { withSpaces } from './use-company-navigation';
import type { SpaceSummary } from './api-client';

const space = (id: string, name: string, departmentId: string | null = null): SpaceSummary => ({
  id,
  name,
  description: null,
  tone: 'blue',
  isDefault: false,
  departmentId,
  archivedAt: null,
});

const RIS = [{ key: 'tracker', label: 'RIS', icon: 'folder' as const, href: '/tracker' }];

describe('the spaces listed under RIS', () => {
  it('leaves every other group exactly as it was', () => {
    const operations = [
      { key: 'todo', label: 'To-do List', icon: 'list' as const, href: '/todo' },
      { key: 'agents', label: 'Engine Agents', icon: 'bot' as const, href: '/agents' },
    ];

    expect(withSpaces('Operations', operations, [space('s1', 'Sales')])).toEqual(operations);
  });

  it('adds nothing when this person has no spaces, so the heading stays away', () => {
    // A group of one is still a group of one: the sidebar draws the link with no chevron over it.
    expect(withSpaces('RIS', RIS, [])).toHaveLength(1);
  });

  it('lists each space under RIS, with RIS itself still first', () => {
    const items = withSpaces('RIS', RIS, [space('s1', 'Sales'), space('s2', 'Production', 'd1')]);

    expect(items.map((item) => item.label)).toEqual(['RIS', 'Sales', 'Production']);
    expect(items[0]?.key).toBe('tracker');
  });

  it('links each one to its own space, and to the module RIS is gated by', () => {
    const [, sales] = withSpaces('RIS', RIS, [space('s1', 'Sales')]);

    expect(sales?.href).toBe('/tracker?space=s1');
    expect(sales?.key).toBe('tracker-space-s1');
    expect(sales?.module).toBe('todo');
  });

  it('adds nothing when the RIS entry itself was filtered away', () => {
    /*
     * Somebody with no `todo` grant does not see RIS at all, and the spaces must not reappear
     * underneath an entry that is not there — that would be the sidebar restoring, by a different
     * route, exactly what the filter removed.
     */
    expect(withSpaces('RIS', [], [space('s1', 'Sales')])).toEqual([]);
  });
});
