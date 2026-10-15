import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { AccessLevelView } from '../lib/api-client';

/**
 * Access & Permissions — a section, then a level. CR-04.
 *
 * What these tests hold is the *shape of the authority*, not the widget:
 *
 *   * a level the administrator cannot grant is **shown, disabled and explained**, never hidden —
 *     a form that quietly omits an option looks complete and teaches nobody why;
 *   * every box is a request the **server** evaluates, and the screen renders the verdict;
 *   * a level includes the ones below it, so the boxes below a held level are held too, and
 *     unticking the lowest is how "no access" is said.
 */
const view = vi.fn();
const set = vi.fn();

vi.mock('../lib/api-client', () => ({
  ApiError: class ApiError extends Error {
    // The real one carries a status. Mirrored here so a test cannot construct a refusal the
    // client could never produce.
    constructor(
      message: string,
      readonly statusCode = 500,
    ) {
      super(message);
    }
  },
  accessLevelsApi: {
    view: (...args: unknown[]) => view(...args),
    set: (...args: unknown[]) => set(...args),
  },
}));

const { AccessPermissionsStep } = await import('./AccessPermissionsStep');
const { ApiError } = await import('../lib/api-client');

function response(overrides: Partial<AccessLevelView> = {}): AccessLevelView {
  return {
    sections: [
      {
        module: 'objective',
        label: 'Objective Optimization',
        levels: [
          {
            level: 'Viewer',
            label: 'Viewer',
            line: 'Can read objectives and their plans.',
            held: true,
            canGrant: true,
            whyNot: null,
          },
          {
            level: 'Creator',
            label: 'Creator',
            line: 'Can write and change objectives.',
            held: true,
            canGrant: true,
            whyNot: null,
          },
          {
            level: 'Approver',
            label: 'Approver',
            line: 'Can approve an objective or send it back.',
            held: false,
            canGrant: false,
            whyNot:
              'Approver on Objective Optimization is above the Creator access you hold there.',
          },
          {
            level: 'Admin',
            label: 'Admin',
            line: 'Can run the analysis, publish and assign the work.',
            held: false,
            canGrant: false,
            whyNot: 'Admin on Objective Optimization is above the Creator access you hold there.',
          },
        ],
      },
      {
        module: 'dashboard',
        label: 'Dashboard',
        levels: [
          {
            level: 'Viewer',
            label: 'Viewer',
            line: 'Can open the dashboard.',
            held: false,
            canGrant: true,
            whyNot: null,
          },
        ],
      },
    ],
    ...overrides,
  };
}

describe('Access & Permissions', () => {
  beforeEach(() => {
    view.mockReset();
    set.mockReset();
    view.mockResolvedValue(response());
    set.mockResolvedValue(response());
  });

  const open = async () => {
    render(<AccessPermissionsStep tenantId="t-1" userId="u-1" subjectLabel="Aman Singh" />);
    await screen.findByText('Objective Optimization');
  };

  it('names who is being edited', async () => {
    await open();
    expect(screen.getByText('For Aman Singh')).toBeTruthy();
  });

  /*
   * The sections are the sidebar's, and the four names never change.
   *
   * An administrator comparing two colleagues should be comparing one vocabulary; a section that
   * renamed its levels would make "Creator" mean something different two rows down.
   */
  it('lists sections, each with the levels that section offers', async () => {
    await open();

    expect(screen.getByTestId('section-objective')).toBeTruthy();
    expect(screen.getByTestId('section-dashboard')).toBeTruthy();

    // Objective Optimization governs a decision, so it offers all four.
    for (const level of ['Viewer', 'Creator', 'Approver', 'Admin']) {
      expect(screen.getByTestId(`level-objective-${level}`)).toBeTruthy();
    }

    // The Dashboard is a screen you can see or cannot. Offering it an Approver would be a control
    // that changes nothing, and somebody ticking it would believe they had granted something.
    expect(screen.getByTestId('level-dashboard-Viewer')).toBeTruthy();
    expect(screen.queryByTestId('level-dashboard-Approver')).toBeNull();
  });

  it('shows every level below the one held as held too', async () => {
    await open();

    // Creator, so Viewer as well — because a Creator who could not read would be nonsense.
    expect((screen.getByTestId('level-objective-Viewer') as HTMLInputElement).checked).toBe(true);
    expect((screen.getByTestId('level-objective-Creator') as HTMLInputElement).checked).toBe(true);
    expect((screen.getByTestId('level-objective-Approver') as HTMLInputElement).checked).toBe(
      false,
    );
  });

  it('shows a level it cannot grant, disabled, with the reason visible', async () => {
    await open();

    const approver = screen.getByTestId('level-objective-Approver') as HTMLInputElement;
    expect(approver.disabled).toBe(true);
    // Shown, not hidden: the administrator learns why rather than wondering where it went.
    expect(screen.getAllByText(/above the Creator access you hold there/).length).toBeGreaterThan(
      0,
    );
  });

  it('sets a section to the level that was ticked', async () => {
    await open();
    await userEvent.click(screen.getByTestId('level-dashboard-Viewer'));

    await waitFor(() => expect(set).toHaveBeenCalledTimes(1));
    expect(set).toHaveBeenCalledWith('t-1', 'u-1', 'dashboard', 'Viewer');
  });

  /*
   * Unticking the lowest held box is how "no access" is said.
   *
   * There is no other control for it, and a section somebody can only ever be added to is a
   * screen that cannot undo its own mistake.
   */
  it('clears the section when the lowest held level is unticked', async () => {
    await open();
    await userEvent.click(screen.getByTestId('level-objective-Viewer'));

    await waitFor(() => expect(set).toHaveBeenCalledTimes(1));
    expect(set).toHaveBeenCalledWith('t-1', 'u-1', 'objective', null);
  });

  /* Ticking a held level that is not the lowest steps them down to it, rather than clearing. */
  it('steps a level down rather than clearing when a higher box is unticked', async () => {
    await open();
    await userEvent.click(screen.getByTestId('level-objective-Creator'));

    await waitFor(() => expect(set).toHaveBeenCalledTimes(1));
    expect(set).toHaveBeenCalledWith('t-1', 'u-1', 'objective', 'Creator');
  });

  it("renders the server's refusal verbatim rather than paraphrasing it", async () => {
    set.mockRejectedValue(
      new ApiError('Admin on Settings is above the Viewer access you hold there.', 409),
    );
    await open();

    await userEvent.click(screen.getByTestId('level-dashboard-Viewer'));

    await waitFor(() =>
      expect(
        screen.getByText('Admin on Settings is above the Viewer access you hold there.'),
      ).toBeTruthy(),
    );
  });
});
