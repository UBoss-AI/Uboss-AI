import { fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { RowMenu } from './RowMenu';

/**
 * Which way the menu opens.
 *
 * It only ever opened downward. On a table the rows near the bottom of the window are most of
 * them, and a four-item menu on one of those ran off the screen with its lower items — including
 * the destructive one under the separator — unreachable. Reported from a walkthrough where two of
 * four items could not be reached at all.
 *
 * jsdom measures nothing, so every rect here is stubbed. That is the right level anyway: the
 * decision under test is arithmetic on a trigger's position and a panel's height, and stubbing
 * those is how you ask about the arithmetic rather than about a layout engine.
 */
describe('RowMenu placement', () => {
  const items = [
    { key: 'a', label: 'Change role', onSelect: () => {} },
    { key: 'b', label: 'Suspend', onSelect: () => {} },
    { key: 'c', label: 'Reset password', onSelect: () => {} },
    { key: 'd', label: 'Offboard', onSelect: () => {}, destructive: true },
  ];

  /** Put the trigger at `triggerTop` in an 800px window, with a panel `panelHeight` tall. */
  const layout = (triggerTop: number, panelHeight: number) => {
    vi.spyOn(window, 'innerHeight', 'get').mockReturnValue(800);
    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (
      this: HTMLElement,
    ) {
      const isPanel = this.getAttribute('role') === 'menu';
      const top = isPanel ? 0 : triggerTop;
      const height = isPanel ? panelHeight : 28;
      return {
        top,
        bottom: top + height,
        height,
        left: 0,
        right: 0,
        width: 190,
        x: 0,
        y: top,
        toJSON: () => ({}),
      } as DOMRect;
    });
  };

  afterEach(() => {
    vi.restoreAllMocks();
  });

  const openMenu = () => {
    render(<RowMenu subject="Aman Singh" items={items} />);
    fireEvent.click(screen.getByRole('button', { name: /More actions for Aman Singh/ }));
    return screen.getByRole('menu');
  };

  it('opens downward when there is room below', () => {
    layout(100, 180);
    expect(openMenu().className).not.toContain('is-above');
  });

  it('opens upward when the window ends before the menu does', () => {
    // Trigger 60px from the bottom, menu 180px tall: downward would put two items off-screen.
    layout(740, 180);
    expect(openMenu().className).toContain('is-above');
  });

  it('stays downward when neither side has room, rather than flipping into a smaller gap', () => {
    /*
     * A menu taller than the window fits nowhere. Flipping it then trades one clipped end for
     * another and loses the first item as well — and the first item is the one focus lands on.
     * The default stands and the reader can scroll.
     */
    layout(400, 900);
    expect(openMenu().className).not.toContain('is-above');
  });
});
