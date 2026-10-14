import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import { JourneyRail, type JourneyStop } from './JourneyRail';

const stops: JourneyStop[] = [
  { key: 'draft', label: 'Draft', state: 'done' },
  { key: 'review', label: 'Under Review', state: 'done' },
  { key: 'ai', label: 'AI Analysis', state: 'optional', detour: true },
  { key: 'wf', label: 'Workflow Draft', state: 'optional', detour: true },
  { key: 'approve', label: 'Ready for Approval', state: 'current' },
  { key: 'active', label: 'Active', state: 'upcoming' },
];

describe('JourneyRail', () => {
  it('is an ordered list, because the order is the meaning', () => {
    const { container } = render(<JourneyRail stops={stops} label="Objective journey" />);

    const list = container.querySelector('ol');
    expect(list).not.toBeNull();
    expect(list?.getAttribute('aria-label')).toBe('Objective journey');
    expect(container.querySelectorAll('li')).toHaveLength(stops.length);
  });

  it('numbers the main line only, so a detour does not renumber the rest', () => {
    const { container } = render(<JourneyRail stops={stops} label="Objective journey" />);
    const markers = [...container.querySelectorAll('.uboss-journey-marker')].map((node) =>
      node.textContent?.trim(),
    );

    // Draft and Under Review are done, so they show a tick rather than their number. The two
    // detour stops show a dash. "Ready for Approval" is the third stop on the line and must say
    // 3 — not 5, which is where it sits in the array.
    expect(markers[4]).toBe('3');
    expect(markers[5]).toBe('4');
  });

  it('marks where the person is, for assistive technology as well as the eye', () => {
    const { container } = render(<JourneyRail stops={stops} label="Objective journey" />);

    const current = container.querySelectorAll('[aria-current="step"]');
    expect(current).toHaveLength(1);
    expect(current[0]?.textContent).toContain('Ready for Approval');
  });

  it('says every state in words, never in colour alone', () => {
    render(<JourneyRail stops={stops} label="Objective journey" />);

    expect(screen.getByText(/current stage/)).toBeInTheDocument();
    expect(screen.getAllByText(/— done/).length).toBe(2);
    expect(screen.getAllByText(/optional, not on this path/).length).toBe(2);
  });

  it('shows a halted stage as still current, and says it has stopped', () => {
    const halted: JourneyStop[] = [
      { key: 'active', label: 'Active', state: 'halted' },
      { key: 'done', label: 'Completed', state: 'upcoming' },
    ];
    const { container } = render(<JourneyRail stops={halted} label="Objective journey" />);

    // Where the person is — a paused record has not left the stage it stopped on.
    expect(container.querySelectorAll('[aria-current="step"]')).toHaveLength(1);
    expect(screen.getByText(/current stage, stopped/)).toBeInTheDocument();
    expect(container.querySelector('.uboss-journey-stop--halted')).not.toBeNull();
  });

  it('gives detour stops their own class, so they can be drawn off the line', () => {
    const { container } = render(<JourneyRail stops={stops} label="Objective journey" />);
    expect(container.querySelectorAll('.uboss-journey-stop--detour')).toHaveLength(2);
  });
});

describe('JourneyRail — the name is never said twice', () => {
  /*
   * Reported from a copy-paste. Half the stages are one word, so the full name and the short name
   * were identical and the markup carried both: invisible on screen, correct to a screen reader,
   * and "DraftDraft — done" to anyone who selected the text.
   */
  it('writes a one-word stage name once', () => {
    const { container } = render(
      <JourneyRail
        stops={[{ key: 'draft', label: 'Draft', fullLabel: 'Draft', state: 'done' }]}
        label="Objective journey"
      />,
    );

    const stop = container.querySelector('.uboss-journey-stop') as HTMLElement;
    expect(stop.textContent).toBe('Draft — done');
  });

  it('still carries the full name when it says more than the label', () => {
    const { container } = render(
      <JourneyRail
        stops={[
          { key: 'r', label: 'Review', fullLabel: 'Submitted / Under Review', state: 'current' },
        ]}
        label="Objective journey"
      />,
    );

    const stop = container.querySelector('.uboss-journey-stop') as HTMLElement;
    // Drawn short.
    expect(container.querySelector('[aria-hidden="true"].uboss-journey-marker')).not.toBeNull();
    expect(stop.textContent).toContain('Review');
    // Spoken long — the product's own wording, not the abbreviation.
    expect(stop.querySelector('.uboss-sr-only')?.textContent).toContain('Submitted / Under Review');
  });
});
