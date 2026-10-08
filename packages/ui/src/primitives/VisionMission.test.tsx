import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import { VisionMission } from './VisionMission';

/*
 * The strip draws the Vision above the Mission.
 *
 * It is the client's instruction, and it was the other way round until they said so — which is
 * exactly the kind of decision that gets quietly reversed by somebody tidying the props into
 * alphabetical order, or by the next person who reads the component's name as the drawing order.
 *
 * Asserted by position in the rendered document rather than by the order of the JSX, because the
 * JSX is the thing that would be changed and the position is what somebody sees.
 */

const strip = (vision: string | null, mission: string | null) =>
  render(<VisionMission vision={vision} mission={mission} />);

/** The panel labels, in the order they appear on screen. */
const labelsInOrder = () =>
  screen.getAllByText(/^Company (Vision|Mission)$/).map((node) => node.textContent?.trim() ?? '');

describe('VisionMission', () => {
  it('draws the Vision above the Mission', () => {
    strip('<p>Where we are going.</p>', '<p>What we do daily.</p>');
    expect(labelsInOrder()).toEqual(['Company Vision', 'Company Mission']);
  });

  it('keeps that order when only one of them is written', () => {
    // An empty panel still draws, with its prompt — so the order cannot depend on the content.
    strip(null, '<p>What we do daily.</p>');
    expect(labelsInOrder()).toEqual(['Company Vision', 'Company Mission']);
  });

  it('keeps the Mission on its own gradient wherever it sits', () => {
    // The modifier carries the darker gradient. Moving the panel must not move the colour with
    // the position, which is what a swap written in CSS rather than in markup would have done.
    const { container } = strip('<p>Vision.</p>', '<p>Mission.</p>');
    const panels = Array.from(container.querySelectorAll('.uboss-vm'));

    expect(panels).toHaveLength(2);
    expect(panels[0]?.className).not.toContain('uboss-vm--mission');
    expect(panels[1]?.className).toContain('uboss-vm--mission');
  });

  it('prompts rather than drawing a blank panel when nothing is recorded', () => {
    strip(null, null);
    expect(screen.getByText('No Vision recorded yet.')).toBeInTheDocument();
    expect(screen.getByText('No Mission recorded yet.')).toBeInTheDocument();
  });
});
