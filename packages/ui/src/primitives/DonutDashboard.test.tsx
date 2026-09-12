import { render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import { DonutDashboard } from './DonutDashboard';

describe('DonutDashboard — locked two-slice contract', () => {
  it('renders exactly two slices and no others', () => {
    const { container } = render(<DonutDashboard agents={8} pendingJobs={12} />);

    // One track circle plus exactly two data arcs. A third arc would mean the locked
    // "Agents + Pending Jobs only" rule had been broken.
    const circles = container.querySelectorAll('circle');
    expect(circles).toHaveLength(3);
  });

  it('labels exactly the two permitted categories', () => {
    render(<DonutDashboard agents={8} pendingJobs={12} />);

    expect(screen.getByText('Agents')).toBeInTheDocument();
    expect(screen.getByText('Pending Jobs')).toBeInTheDocument();
    expect(screen.getAllByText(/Agents|Pending Jobs/)).toHaveLength(2);
  });

  it('shows the total in the centre', () => {
    render(<DonutDashboard agents={8} pendingJobs={12} />);

    expect(screen.getByText('20')).toBeInTheDocument();
    expect(screen.getByText('items in scope')).toBeInTheDocument();
  });

  it('renders each count', () => {
    render(<DonutDashboard agents={8} pendingJobs={12} />);

    expect(screen.getByText('8')).toBeInTheDocument();
    expect(screen.getByText('12')).toBeInTheDocument();
  });

  it('drills down from both legend entries', async () => {
    const onSelectAgents = vi.fn();
    const onSelectPendingJobs = vi.fn();
    render(
      <DonutDashboard
        agents={8}
        pendingJobs={12}
        onSelectAgents={onSelectAgents}
        onSelectPendingJobs={onSelectPendingJobs}
      />,
    );

    // Keyboard users must be able to reach both drill-downs; SVG arcs alone would not suffice.
    const buttons = screen.getAllByRole('button');
    expect(buttons).toHaveLength(2);

    buttons[0]?.click();
    expect(onSelectAgents).toHaveBeenCalledOnce();

    buttons[1]?.click();
    expect(onSelectPendingJobs).toHaveBeenCalledOnce();
  });

  it('describes the chart for assistive technology', () => {
    render(<DonutDashboard agents={3} pendingJobs={4} />);

    expect(screen.getByRole('img')).toHaveAccessibleName(
      '3 Agents and 4 Pending Jobs, 7 items in your scope',
    );
  });

  it('renders an empty state rather than an empty chart when nothing is in scope', () => {
    render(<DonutDashboard agents={0} pendingJobs={0} />);

    expect(screen.getByText('Nothing in your scope yet')).toBeInTheDocument();
    expect(screen.queryByRole('img')).not.toBeInTheDocument();
  });

  it('still renders a visible arc for a single-item category', () => {
    const { container } = render(<DonutDashboard agents={1} pendingJobs={19} />);

    // A 1-of-20 slice must not collapse to nothing.
    const arcs = Array.from(container.querySelectorAll('circle')).slice(1);
    expect(arcs).toHaveLength(2);
    for (const arc of arcs) {
      const [length] = (arc.getAttribute('stroke-dasharray') ?? '0').split(' ');
      expect(Number(length)).toBeGreaterThan(0);
    }
  });

  it('omits an arc for a zero category but keeps its legend entry', () => {
    const { container } = render(<DonutDashboard agents={0} pendingJobs={5} />);

    expect(container.querySelectorAll('circle')).toHaveLength(2);
    expect(screen.getByText('Agents')).toBeInTheDocument();
    expect(screen.getByText('0')).toBeInTheDocument();
  });
});
