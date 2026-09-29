import { act, render } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import { useJustBecameTrue } from './use-just-became-true';

/*
 * The whole value of this hook is what it does NOT report.
 *
 * It exists so a control can say "this just became available", and the failure that matters is
 * firing on arrival — announcing a change that did not happen, on every page load, for every
 * control that happens to start out ready. That is worse than no cue at all, because it teaches
 * people to ignore the cue.
 */
function Probe({ value }: { value: boolean }) {
  const [fired, clear] = useJustBecameTrue(value);
  return (
    <button type="button" data-fired={fired ? 'yes' : 'no'} onClick={clear}>
      probe
    </button>
  );
}

const firedOn = (container: HTMLElement) =>
  container.querySelector('button')?.getAttribute('data-fired');

describe('useJustBecameTrue', () => {
  it('says nothing when it starts out false', () => {
    const { container } = render(<Probe value={false} />);
    expect(firedOn(container)).toBe('no');
  });

  it('says nothing when it starts out already true', () => {
    // The case that matters: a control that was ready before this screen opened did not just
    // become ready, and must not claim to have.
    const { container } = render(<Probe value />);
    expect(firedOn(container)).toBe('no');
  });

  it('reports the transition from false to true', () => {
    const { container, rerender } = render(<Probe value={false} />);
    expect(firedOn(container)).toBe('no');

    rerender(<Probe value />);
    expect(firedOn(container)).toBe('yes');
  });

  it('says nothing when it goes the other way', () => {
    const { container, rerender } = render(<Probe value />);
    rerender(<Probe value={false} />);

    // A gate closing is not something to celebrate, and the cue means "now available".
    expect(firedOn(container)).toBe('no');
  });

  it('stays quiet while it remains true', () => {
    const { container, rerender } = render(<Probe value={false} />);
    rerender(<Probe value />);
    expect(firedOn(container)).toBe('yes');

    // Cleared by the caller when the cue finishes, and a re-render must not revive it: the flag
    // must not outlive the thing it marks.
    act(() => {
      container.querySelector('button')?.click();
    });
    expect(firedOn(container)).toBe('no');

    rerender(<Probe value />);
    expect(firedOn(container)).toBe('no');
  });
});
