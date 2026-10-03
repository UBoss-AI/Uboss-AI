import { render, screen } from '@testing-library/react';
import { RUN_STATES, RUN_STATE_LABELS } from '@uboss/types';
import { describe, expect, it } from 'vitest';

import { RunState } from './RunState';

/*
 * Every real run state, and which of them is allowed to move.
 *
 * There is no execution data in this environment — no AI provider is configured and no run has
 * ever been created — so the mapping cannot be shown on a live screen without inventing a run,
 * which is the one thing that must not happen. It can be shown here, exhaustively, against the
 * state list the backend actually defines: the list is imported rather than restated, so adding a
 * state to the engine and forgetting it here fails this file.
 */
describe('RunState — motion means work', () => {
  const dot = (container: HTMLElement) => container.querySelector('.uboss-run-dot');

  it('covers every state the engine defines', () => {
    // Guards the guard: if RUN_STATES shrank to nothing the table below would assert nothing.
    expect(RUN_STATES.length).toBe(13);
  });

  it.each([...RUN_STATES])('renders %s with the label the engine gives it', (state) => {
    render(<RunState state={state} />);
    expect(screen.getByText(RUN_STATE_LABELS[state])).toBeInTheDocument();
  });

  it.each(['Running', 'Retrying'])('%s animates, because a machine is working', (state) => {
    const { container } = render(<RunState state={state} />);
    expect(dot(container)?.classList.contains('uboss-run-dot--working')).toBe(true);
  });

  /*
   * The important half. A run waiting for an approval, blocked on a budget, or sitting in a queue
   * is not working, and an animation on any of them would say it was — which is exactly the
   * reading an operator would act on.
   */
  it.each([...RUN_STATES].filter((s) => s !== 'Running' && s !== 'Retrying'))(
    '%s does not animate, because nothing is happening to it',
    (state) => {
      const { container } = render(<RunState state={state} />);
      expect(dot(container)?.classList.contains('uboss-run-dot--working')).toBe(false);
    },
  );

  it('names what is blocking rather than reporting a generic failure', () => {
    // Four different Blocked states exist because four different people have to fix them.
    for (const state of [
      'BlockedByBudget',
      'BlockedByConnection',
      'BlockedByPermission',
      'BlockedByProvider',
    ] as const) {
      const { container, unmount } = render(<RunState state={state} />);
      expect(container.querySelector('.uboss-run-state')?.getAttribute('data-state')).toBe(state);
      expect(screen.getByText(RUN_STATE_LABELS[state])).toBeInTheDocument();
      unmount();
    }
  });

  it('shows an unrecognised state as itself rather than as something familiar', () => {
    // A run in an unexpected state is exactly when a made-up label does the most damage.
    render(<RunState state="SomethingNew" />);
    expect(screen.getByText('SomethingNew')).toBeInTheDocument();
  });

  it('prefers the label the server sent over its own', () => {
    render(<RunState state="Running" label="Running step 3 of 7" />);
    expect(screen.getByText('Running step 3 of 7')).toBeInTheDocument();
  });

  it('distinguishes waiting from working in words, not only by the dot', () => {
    const { container: working } = render(<RunState state="Running" />);
    expect(working.textContent).toContain('in progress');

    const { container: waiting } = render(<RunState state="WaitingForApproval" />);
    // Said out loud, because the two look similar and the difference is whether a person is needed.
    expect(waiting.textContent).toContain('no machine work in progress');
  });
});
