import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import { ANALYSIS_NODE_KINDS, nodeShapeFor, type AnalysisNode } from '@uboss/types';

import { WorkflowCanvasNode, type DrawableNode } from './WorkflowCanvasNode';

/*
 * An `AnalysisNode`, plus the one field the drawing adds to it.
 *
 * `ownerName` is not stored on a node — the node holds an id and the screen resolves the name
 * from the hierarchy it already loads — so it lives on `DrawableNode` and not on the analysis
 * type. The helper has to be able to set it, or the tests for it cannot be written.
 */
type TestNode = AnalysisNode & Pick<DrawableNode, 'ownerName'>;

function node(overrides: Partial<TestNode> = {}): TestNode {
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

  it('says a human step has nobody because the plan named nobody', () => {
    render(
      <WorkflowCanvasNode node={node({ kind: 'Human', ownerUserId: null })} onOpen={() => {}} />,
    );
    expect(screen.getByText('Nobody named in the plan')).toBeTruthy();
  });

  it('names the person who could not be matched, rather than only saying nobody', () => {
    /*
     * The two causes a reader has to tell apart, and used to be unable to.
     *
     * A plan that named six people and came back with nobody on any step is a Hierarchy
     * problem — those names are not employees on record — and the fix is adding them. A plan
     * whose form left the column blank is a form problem. Both read "No owner assigned", and
     * the distinguishing sentence sat in a gaps list on a different screen.
     */
    render(
      <WorkflowCanvasNode
        node={node({ kind: 'Human', ownerUserId: null, unmatchedOwnerName: 'Nikhil Narwal' })}
        onOpen={() => {}}
      />,
    );
    expect(screen.getByText('Nikhil Narwal is not an employee on record')).toBeTruthy();
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

  it('says an AI step has nobody behind it, and why', () => {
    // An agent with nobody accountable is the same question as an unowned human step, and the
    // answer has to be as specific: the Engine row names the accountable person too.
    render(<WorkflowCanvasNode node={node({ kind: 'Ai', ownerUserId: null })} onOpen={() => {}} />);
    expect(screen.getByText('Nobody named in the plan')).toBeTruthy();

    render(
      <WorkflowCanvasNode
        node={node({ kind: 'Ai', ownerUserId: null, unmatchedOwnerName: 'Umang Mathur' })}
        onOpen={() => {}}
      />,
    );
    expect(screen.getByText('Umang Mathur is not an employee on record')).toBeTruthy();
  });

  it('gives the reason the second line a name does not need', () => {
    /*
     * The diamond clamps this line to one line, because a name is one line. The reason is a
     * sentence, and at one line it rendered as "Nikhil Narwa… not an…" — which says less than
     * the "Nobody accountable" it was written to replace. Asserted on the class because the
     * clamp itself is CSS and jsdom does not lay out text.
     */
    render(
      <WorkflowCanvasNode
        node={node({ kind: 'Ai', ownerUserId: null, unmatchedOwnerName: 'Umang Mathur' })}
        onOpen={() => {}}
      />,
    );
    expect(
      screen.getByText('Umang Mathur is not an employee on record').className,
    ).toContain('uboss-wf-ai-owner--reason');

    // And an owned node keeps the single line, so the title does not lose room to an allowance
    // a name would never use.
    render(
      <WorkflowCanvasNode
        node={node({ kind: 'Ai', ownerUserId: 'u-9', ownerName: 'Aman Singh' })}
        onOpen={() => {}}
      />,
    );
    expect(screen.getByText('Accountable: Aman Singh').className).not.toContain(
      'uboss-wf-ai-owner--reason',
    );
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
