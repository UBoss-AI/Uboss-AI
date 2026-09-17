import { act, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { Toast, ToastRegion } from './Toast';

/*
 * The constraints on this primitive are all about restraint, so these tests are mostly about what
 * it must not do: take focus, outlive its usefulness, replace inline validation, or cover the
 * controls a person was about to press.
 */
describe('Toast', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('puts the message in the DOM as text, not only in the animation', () => {
    render(<Toast message="Draft saved." tone="ok" />);
    expect(screen.getByText('Draft saved.')).toBeInTheDocument();
  });

  it('waits for a pause for ordinary messages', () => {
    const { container } = render(<Toast message="Draft saved." tone="ok" />);
    // status, not alert: a save that worked is not worth interrupting a screen reader for.
    expect(container.querySelector('[role="status"]')).not.toBeNull();
    expect(container.querySelector('[role="alert"]')).toBeNull();
  });

  it('interrupts for an error', () => {
    const { container } = render(<Toast message="Could not reach the server." tone="error" />);
    expect(container.querySelector('[role="alert"]')).not.toBeNull();
  });

  it('never takes focus', () => {
    render(<Toast message="Draft saved." tone="ok" onDismiss={() => {}} />);
    // Stealing focus would make the page unusable by keyboard for as long as this is up. The
    // dismiss is reachable in the normal tab order instead.
    expect(document.activeElement).toBe(document.body);
  });

  it('leaves on its own after the stated time', () => {
    const onDismiss = vi.fn();
    render(<Toast message="Draft saved." tone="ok" durationMs={5000} onDismiss={onDismiss} />);

    act(() => void vi.advanceTimersByTime(4999));
    expect(onDismiss).not.toHaveBeenCalled();

    act(() => void vi.advanceTimersByTime(2));
    expect(onDismiss).toHaveBeenCalledTimes(1);
  });

  it('stays for as long as the thing it reports is still happening', () => {
    const onDismiss = vi.fn();
    render(<Toast message="Analysing…" tone="working" durationMs={null} onDismiss={onDismiss} />);

    // Removing a "still working" message would be claiming the work had finished.
    act(() => void vi.advanceTimersByTime(60_000));
    expect(onDismiss).not.toHaveBeenCalled();
    expect(screen.getByText('Analysing…')).toBeInTheDocument();
  });

  it('can be dismissed by hand', () => {
    const onDismiss = vi.fn();
    render(<Toast message="Draft saved." tone="ok" onDismiss={onDismiss} />);

    act(() => void screen.getByLabelText('Dismiss this message').click());
    expect(onDismiss).toHaveBeenCalledTimes(1);
  });

  it('offers no dismiss control when there is nothing to dismiss to', () => {
    render(<Toast message="Draft saved." tone="ok" />);
    expect(screen.queryByLabelText('Dismiss this message')).toBeNull();
  });

  it('labels the region so the label is not the first message', () => {
    const { container } = render(
      <ToastRegion>
        <Toast message="Draft saved." tone="ok" />
      </ToastRegion>,
    );
    const region = container.querySelector('[role="region"]');
    expect(region?.getAttribute('aria-label')).toBe('Notifications');
  });
});
