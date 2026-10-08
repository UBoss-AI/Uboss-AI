import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import { ProgressRing } from './ProgressRing';

/*
 * The number, and when the ring is allowed to look busy.
 *
 * Both halves matter. The percentage is the thing the screen was missing; the halo is the thing
 * that must not lie — a ring still turning over a cancelled run says work is happening when none
 * is, which is worse than the plain list it replaced.
 */
describe('ProgressRing', () => {
  it('shows the fraction of the work that is done', () => {
    render(<ProgressRing label="AI analysis progress" completed={3} total={7} />);
    // 3/7 is 42.857…, and a progress report rounds rather than reciting.
    expect(screen.getByText('43')).toBeInTheDocument();
    expect(screen.getByRole('progressbar')).toHaveAttribute('aria-valuenow', '43');
  });

  it('keeps the counts beside the percentage so nobody has to trust the rounding', () => {
    render(<ProgressRing label="AI analysis progress" completed={3} total={7} caption="3 of 7" />);
    expect(screen.getByText('3 of 7')).toBeInTheDocument();
    expect(screen.getByRole('progressbar')).toHaveAttribute('aria-valuetext', '43% — 3 of 7');
  });

  it('turns the halo only while work is really in flight', () => {
    const { container, rerender } = render(
      <ProgressRing label="AI analysis progress" completed={3} total={7} live />,
    );
    expect(container.querySelector('.uboss-progress-ring')?.className).toContain(
      'uboss-progress-ring--live',
    );

    // A run cancelled at stage three is also three of seven. The number stays; the motion stops.
    rerender(<ProgressRing label="AI analysis progress" completed={3} total={7} />);
    expect(container.querySelector('.uboss-progress-ring')?.className).not.toContain(
      'uboss-progress-ring--live',
    );
  });

  it('draws an empty ring rather than dividing by zero', () => {
    render(<ProgressRing label="Nothing to do" completed={0} total={0} />);
    expect(screen.getByText('0')).toBeInTheDocument();
    expect(screen.getByRole('progressbar')).toHaveAttribute('aria-valuenow', '0');
  });

  it('cannot be driven past its own total', () => {
    // A stage counter that overshoots is a server bug, and "140%" is not how a screen reports it.
    render(<ProgressRing label="AI analysis progress" completed={10} total={7} />);
    expect(screen.getByText('100')).toBeInTheDocument();
  });

  it('names what it measures, for anybody not looking at the screen', () => {
    render(<ProgressRing label="AI analysis progress" completed={1} total={7} />);
    expect(screen.getByRole('progressbar')).toHaveAccessibleName('AI analysis progress');
  });

  /*
   * The ring must not touch the edge of its own drawing.
   *
   * A stroke is centred on the path, so a radius of `(size - stroke) / 2` puts its outer half
   * exactly on the viewBox boundary. The browser clips that half at the four points where the
   * circle meets the edge, and a round ring renders as a flattened octagon — which is what
   * reached the screen and what the client reported as "chipped at the sides".
   *
   * Asserted at several sizes, because the stroke is derived from the size and a ratio that works
   * at 112 is not automatically safe at 64 or 200.
   */
  it.each([64, 112, 160, 200])('keeps the whole stroke inside its box at %ipx', (size) => {
    const { container } = render(
      <ProgressRing label="AI analysis progress" completed={3} total={7} size={size} />,
    );

    const svg = container.querySelector('svg');
    expect(svg).not.toBeNull();
    expect(svg!.getAttribute('viewBox')).toBe(`0 0 ${size} ${size}`);

    for (const circle of Array.from(container.querySelectorAll('circle'))) {
      const radius = Number(circle.getAttribute('r'));
      const stroke = Number(circle.getAttribute('stroke-width'));
      // The outer edge of the drawn line, measured from the centre.
      const outerEdge = radius + stroke / 2;
      expect(outerEdge).toBeLessThan(size / 2);
    }
  });
});
