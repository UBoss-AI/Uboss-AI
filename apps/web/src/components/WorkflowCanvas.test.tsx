import { fireEvent, render } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { nodeShapeFor, type AnalysisNodeKind } from '@uboss/types';

import { WorkflowCanvas, type CanvasNode } from './WorkflowCanvas';

function node(id: string, kind: AnalysisNodeKind, label = 'A step'): CanvasNode {
  return { id, kind, label, shape: nodeShapeFor(kind) };
}

const PLAN: CanvasNode[] = [
  node('goal', 'Goal', 'Ship the thing'),
  node('ai', 'Ai', 'Reconcile the ledgers'),
  node('human', 'Human', 'Call the branch manager'),
];

const EDGES = [
  { fromNodeId: 'goal', toNodeId: 'ai', kind: 'Sequential' as const },
  { fromNodeId: 'ai', toNodeId: 'human', kind: 'Sequential' as const },
];

/*
 * jsdom has no pointer capture at all, and this file is about what capture does to a click.
 *
 * Supplying it as a spy is the point rather than a workaround: the defect was a call to
 * `setPointerCapture` happening where it should not, so "was it called" is exactly the question,
 * and a real implementation would answer it no more clearly.
 */
let captured: number[];

beforeEach(() => {
  captured = [];
  Element.prototype.setPointerCapture = function setPointerCapture(pointerId: number) {
    captured.push(pointerId);
  };
  Element.prototype.releasePointerCapture = function releasePointerCapture() {};
  Element.prototype.hasPointerCapture = function hasPointerCapture() {
    return false;
  };
});

describe('WorkflowCanvas', () => {
  /*
   * The defect, in the terms it was reported in: "plus pe click karne par node add karne ka nahi
   * aa raha".
   *
   * Pressing + opened the node's editor instead of the Add dialog, and the Add dialog could not be
   * reached from the canvas at all. Nothing was wrong with either handler. The node box captured
   * the pointer on press, and a captured pointer sends its `click` to the element that captured
   * rather than to what was under the finger — so the plus never saw the click that was aimed at
   * it.
   */
  it('does not capture the pointer when the press begins on the plus', () => {
    const onAddAfter = vi.fn();
    const onOpenNode = vi.fn();

    const { container } = render(
      <WorkflowCanvas
        nodes={PLAN}
        edges={EDGES}
        onOpenNode={onOpenNode}
        onAddAfter={onAddAfter}
        onMoveNode={vi.fn()}
      />,
    );

    const plus = container.querySelector('.wfc__add');
    expect(plus).not.toBeNull();

    fireEvent.pointerDown(plus as Element, { button: 0, pointerId: 7 });
    expect(captured).toEqual([]);

    fireEvent.click(plus as Element);
    expect(onAddAfter).toHaveBeenCalledTimes(1);
    // The plus stops the click: adding a step after a node is not also opening it.
    expect(onOpenNode).not.toHaveBeenCalled();
  });

  it('still captures the pointer when the press begins on the node itself', () => {
    const { container } = render(
      <WorkflowCanvas nodes={PLAN} edges={EDGES} onOpenNode={vi.fn()} onMoveNode={vi.fn()} />,
    );

    const box = container.querySelector('.wfc__node');
    expect(box).not.toBeNull();

    fireEvent.pointerDown(box as Element, { button: 0, pointerId: 9 });
    expect(captured).toEqual([9]);
  });

  /*
   * A `foreignObject` clips, so a box shorter than the shape inside it slices the shape.
   *
   * `.uboss-wf-ai-diamond` is a 212px square turned 45°, and a square turned 45° stands on its
   * point — so it occupies its diagonal, 300px, the same both ways. The box was 300 x 240 and the
   * top and bottom points of every AI node came out flat. Asserted as a relationship rather than
   * as the number 300: a diamond's box has to be square, whatever the square is.
   */
  it('gives a diamond a square box, so its points cannot be clipped off', () => {
    const { container } = render(<WorkflowCanvas nodes={PLAN} edges={EDGES} />);

    const boxes = [...container.querySelectorAll('foreignObject.wfc__html')];
    expect(boxes.length).toBe(PLAN.length);

    const diamond = boxes.find((box) => box.querySelector('[data-shape="diamond"]') !== null);
    expect(diamond).not.toBeUndefined();
    expect(diamond?.getAttribute('height')).toBe(diamond?.getAttribute('width'));
  });

  /*
   * Sideways there are no measured rows, so every node stands in one slot — and the slot has to
   * be the tallest shape or the tallest shape hangs out of it and overlaps its neighbour.
   *
   * Checked by drawing the same plan across the page and asserting no two boxes overlap, which is
   * the thing a band that is too short actually causes.
   */
  it('stacks a horizontal plan without overlapping two nodes', () => {
    const parallel: CanvasNode[] = [
      node('goal', 'Goal'),
      node('a', 'Ai', 'Branch one'),
      node('b', 'Ai', 'Branch two'),
    ];
    const edges = [
      { fromNodeId: 'goal', toNodeId: 'a', kind: 'Parallel' as const },
      { fromNodeId: 'goal', toNodeId: 'b', kind: 'Parallel' as const },
    ];

    const { container } = render(
      <WorkflowCanvas nodes={parallel} edges={edges} orientation="horizontal" />,
    );

    const spans = [...container.querySelectorAll('g.wfc__node')]
      .map((g) => {
        const move = /translate\(([-\d.]+) ([-\d.]+)\)/.exec(g.getAttribute('transform') ?? '');
        const box = g.querySelector('foreignObject.wfc__html');
        return {
          y: Number(move?.[2] ?? 0),
          h: Number(box?.getAttribute('height') ?? 0),
          x: Number(move?.[1] ?? 0),
        };
      })
      .filter((span) => span.h > 0);

    expect(spans.length).toBe(parallel.length);

    for (const a of spans) {
      for (const b of spans) {
        if (a === b) continue;
        const sameColumn = a.x === b.x;
        if (!sameColumn) continue;
        const overlaps = a.y < b.y + b.h && b.y < a.y + a.h;
        expect(overlaps).toBe(false);
      }
    }
  });
});
