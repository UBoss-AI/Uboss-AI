import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import { ANALYSIS_NODE_KINDS, nodeShapeFor, type AnalysisNode } from '@uboss/types';

import { WorkflowCanvasNode } from './WorkflowCanvasNode';

function node(overrides: Partial<AnalysisNode> = {}): AnalysisNode {
  const kind = overrides.kind ?? 'Human';
  return {
    id: 'step-1',
    kind,
    label: 'Collect evidence',
    shape: nodeShapeFor(kind),
    fromStepPosition: 1,
    ownerUserId: null,
    ownerDesignation: null,
    skillVersionId: null,
    skillName: null,
    dod: {
      expectedOutput: 'An evidence index.',
      criteria: 'Every applicable requirement has a named evidence document.',
      evidence: 'The evidence index, filed against this step.',
      dependencies: [],
      tools: [],
      approval: null,
      failureCondition: 'Evidence cannot be located.',
    },
    approvalKind: null,
    triggerEvent: null,
    ...overrides,
  };
}

const shapeOf = (container: HTMLElement) =>
  container.querySelector('[data-shape]')?.getAttribute('data-shape');

describe('WorkflowCanvasNode', () => {
  it('draws a Human node as a rectangle and an AI node as a diamond', () => {
    // The client's locked rule. Asserted on the rendered output, not on the input.
    const human = render(<WorkflowCanvasNode node={node({ kind: 'Human' })} onOpen={() => {}} />);
    expect(shapeOf(human.container)).toBe('rectangle');

    const ai = render(<WorkflowCanvasNode node={node({ kind: 'Ai' })} onOpen={() => {}} />);
    expect(shapeOf(ai.container)).toBe('diamond');
  });

  it('gives the Goal a shape distinct from every other kind', () => {
    const goal = render(
      <WorkflowCanvasNode
        node={node({ kind: 'Goal', label: 'GOAL · Ship it' })}
        onOpen={() => {}}
      />,
    );
    const goalShape = shapeOf(goal.container);
    expect(goalShape).toBe('goal');

    for (const kind of ANALYSIS_NODE_KINDS.filter((candidate) => candidate !== 'Goal')) {
      const other = render(<WorkflowCanvasNode node={node({ kind })} onOpen={() => {}} />);
      expect(shapeOf(other.container)).not.toBe(goalShape);
    }
  });

  it('draws every node kind in the shape the shared rule names', () => {
    // Belt and braces on the rule itself: the renderer follows `node.shape`, and `node.shape` is
    // what the server validated against the kind. A renderer that decided for itself could
    // disagree with the schema and nothing would notice.
    for (const kind of ANALYSIS_NODE_KINDS) {
      const rendered = render(<WorkflowCanvasNode node={node({ kind })} onOpen={() => {}} />);
      expect(shapeOf(rendered.container)).toBe(nodeShapeFor(kind));
    }
  });

  it('says plainly when an AI step has no approved Skill', () => {
    // Not cosmetic: this is a blocker on the Pre-Publish Summary, so the canvas must not look
    // ready when it is not.
    render(<WorkflowCanvasNode node={node({ kind: 'Ai', skillName: null })} onOpen={() => {}} />);
    expect(screen.getByText('No approved Skill')).toBeTruthy();
  });

  it('names the Skill when the step has one', () => {
    render(
      <WorkflowCanvasNode
        node={node({ kind: 'Ai', skillName: 'gspr-checklist', skillVersionId: 'v6' })}
        onOpen={() => {}}
      />,
    );
    expect(screen.getByText('gspr-checklist')).toBeTruthy();
  });

  it('says when a human step has nobody accountable for it', () => {
    render(
      <WorkflowCanvasNode node={node({ kind: 'Human', ownerUserId: null })} onOpen={() => {}} />,
    );
    expect(screen.getByText('No owner assigned')).toBeTruthy();
  });

  it('opens the editor when the node is activated', () => {
    const onOpen = vi.fn();
    render(<WorkflowCanvasNode node={node()} onOpen={onOpen} />);
    fireEvent.click(screen.getByRole('button'));
    expect(onOpen).toHaveBeenCalledOnce();
  });

  it('is reachable by name, so the canvas is navigable without a mouse', () => {
    render(<WorkflowCanvasNode node={node({ label: 'Gap-analysis review' })} onOpen={() => {}} />);
    expect(screen.getByRole('button', { name: 'Edit Gap-analysis review' })).toBeTruthy();
  });

  /*
   * "Node ke upar dikhna chahiye ki kaun sa AI kis person ke paas jayega."
   *
   * A human node printed the owner's *designation* — "Reg. Doc Specialist" — so a plan of nine
   * steps read as a list of job titles and answering "who is doing this" meant opening every box.
   * An AI node printed its Skill and stopped, so the one question a reader has about an agent,
   * whose it is, could not be answered from the canvas at all.
   */
  it('names the person a human step belongs to, rather than their job title', () => {
    render(
      <WorkflowCanvasNode
        node={node({
          kind: 'Human',
          ownerUserId: 'u-1',
          ownerName: 'Meera Iyer',
          ownerDesignation: 'Field Operations Supervisor',
        })}
        onOpen={() => {}}
      />,
    );
    expect(screen.getByText(/Owner: Meera Iyer/)).toBeTruthy();
  });

  it('names the person accountable for an AI step, beside its Skill', () => {
    render(
      <WorkflowCanvasNode
        node={node({
          kind: 'Ai',
          skillName: 'Cash reconciliation summary',
          ownerUserId: 'u-2',
          ownerName: 'Aman Singh',
        })}
        onOpen={() => {}}
      />,
    );
    // Both, because an agent with no Skill and an agent with nobody behind it are different
    // problems and running them together would hide whichever is missing.
    expect(screen.getByText('Cash reconciliation summary')).toBeTruthy();
    expect(screen.getByText('Accountable: Aman Singh')).toBeTruthy();
  });

  it('falls back to the designation while the hierarchy is still loading', () => {
    render(
      <WorkflowCanvasNode
        node={node({ kind: 'Human', ownerUserId: 'u-3', ownerDesignation: 'Treasury Analyst' })}
        onOpen={() => {}}
      />,
    );
    // An owner blinking in and out of existence on first paint would be worse than a job title
    // for a moment.
    expect(screen.getByText(/Owner: Treasury Analyst/)).toBeTruthy();
  });

  it('says an AI step has nobody behind it when it has nobody behind it', () => {
    render(<WorkflowCanvasNode node={node({ kind: 'Ai', ownerUserId: null })} onOpen={() => {}} />);
    expect(screen.getByText('Nobody accountable')).toBeTruthy();
  });

  it('does not offer editing on an assigned plan', () => {
    render(
      <WorkflowCanvasNode
        node={node({ label: 'Locked step' })}
        onOpen={() => {}}
        editable={false}
      />,
    );
    expect(screen.getByRole('button', { name: 'Open Locked step' })).toBeTruthy();
  });
});
