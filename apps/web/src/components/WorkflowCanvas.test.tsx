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
   * A node dragged off the top-left corner, reported as the goal node being cut in half.
   *
   * It was. The drawing's window always started at (0, 0) and only ever grew right and down, so a
   * stored position with a negative coordinate sat outside it and was sliced against the edge of
   * the frame. The window starts where the drawing starts now — and the nodes keep the exact
   * coordinates somebody put them at, because shifting them would make a drag at one end of a
   * plan silently renumber a box at the other.
   */
  it('widens its window for a node dragged above or left of the origin', () => {
    const moved: CanvasNode[] = [
      { ...node('goal', 'Goal'), position: { x: -140, y: -60 } },
      node('ai', 'Ai'),
      node('human', 'Human'),
    ];

    const { container } = render(<WorkflowCanvas nodes={moved} edges={EDGES} />);

    const box = container
      .querySelector('svg.wfc__svg')
      ?.getAttribute('viewBox')
      ?.split(' ')
      .map(Number);

    expect(box?.length).toBe(4);
    const [x = 0, y = 0, w = 0, h = 0] = box ?? [];

    // The window has to begin left of and above the node, not at zero.
    expect(x).toBeLessThanOrEqual(-140);
    expect(y).toBeLessThanOrEqual(-60);
    // And still reach past its far side.
    expect(x + w).toBeGreaterThan(-140 + 300);
    expect(y + h).toBeGreaterThan(-60);

    // The node itself is drawn exactly where it was put.
    const first = container.querySelector('g.wfc__node')?.getAttribute('transform');
    expect(first).toBe('translate(-140 -60)');
  });

  /*
   * The drawing scrolls inside its own frame, not inside the page.
   *
   * Without the frame the page was as tall as the plan — about 12,900px for thirty-six steps — so
   * the screen's toolbar was above the window by the time the second node was in view (measured
   * at y = -137). The height itself is CSS and jsdom lays nothing out, so what is asserted here is
   * the structure that height hangs on: the svg is inside the frame rather than a sibling of it.
   */
  it('puts the drawing inside a frame of its own', () => {
    const { container } = render(<WorkflowCanvas nodes={PLAN} edges={EDGES} />);

    const frame = container.querySelector('.wfc__viewport');
    expect(frame).not.toBeNull();
    expect(frame?.querySelector('svg.wfc__svg')).not.toBeNull();
    // And the controls stay outside it, which is the whole point.
    expect(container.querySelector('.wfc__bar')?.closest('.wfc__viewport')).toBeNull();
  });

  /*
   * The second half of the same report: the plus still opened the editor.
   *
   * HTML inside a `foreignObject` paints above the SVG drawn after it, whatever the document
   * order says — so the half of the plus that lay over the node's box was behind the node's own
   * button and lost every hit test to it. jsdom lays nothing out, so this is asserted on the
   * geometry the component asks for rather than on a hit test: the control's circle must clear
   * the box it hangs under.
   *
   * It read as intermittent because it depended on how far each shape filled its box.
   */
  it('hangs the plus clear of the node box, where nothing can paint over it', () => {
    const { container } = render(
      <WorkflowCanvas nodes={PLAN} edges={EDGES} onAddAfter={vi.fn()} />,
    );

    const groups = [...container.querySelectorAll('g.wfc__node')];
    expect(groups.length).toBe(PLAN.length);

    for (const group of groups) {
      const box = group.querySelector('foreignObject.wfc__html');
      const plus = group.querySelector('.wfc__add');
      const radius = Number(plus?.querySelector('.wfc__add-dot')?.getAttribute('r') ?? 0);
      const drop = Number(
        /translate\([\d.]+ ([\d.]+)\)/.exec(plus?.getAttribute('transform') ?? '')?.[1] ?? 0,
      );
      const boxHeight = Number(box?.getAttribute('height') ?? 0);

      expect(radius).toBeGreaterThan(0);
      expect(boxHeight).toBeGreaterThan(0);
      // The top of the circle, against the bottom of the box.
      expect(drop - radius).toBeGreaterThan(boxHeight);
    }
  });

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

  /*
   * Reported as "koi bhi node idhar udhar kar rahe ho to edit wala open ho ja raha hai".
   *
   * Dragging a node moved it **and** opened its editor, every time. The guard meant to swallow
   * that click read the drag out of React state — and `onPointerUp` clears that state, which
   * re-renders before the browser dispatches `click`, so the guard was looking at "nothing is
   * being dragged" on every drag there has ever been. The order below is the browser's own:
   * down, move, up, then click.
   */
  it('does not open a node that was dragged', () => {
    const onOpenNode = vi.fn();
    const onMoveNode = vi.fn();

    const { container } = render(
      <WorkflowCanvas nodes={PLAN} edges={EDGES} onOpenNode={onOpenNode} onMoveNode={onMoveNode} />,
    );

    const box = container.querySelector('.wfc__node') as Element;

    fireEvent.pointerDown(box, { button: 0, pointerId: 3, clientX: 100, clientY: 100 });
    fireEvent.pointerMove(box, { pointerId: 3, clientX: 160, clientY: 140 });
    fireEvent.pointerUp(box, { pointerId: 3, clientX: 160, clientY: 140 });
    fireEvent.click(box);

    expect(onMoveNode).toHaveBeenCalledTimes(1);
    expect(onOpenNode).not.toHaveBeenCalled();
  });

  /*
   * And the press that did not travel is still a click.
   *
   * The cheapest wrong fix here is to swallow the click whenever a pointer went down on a node,
   * which would leave the editor unreachable from the canvas — the same shape of defect as the
   * plus, in the other direction.
   */
  it('still opens a node that was pressed without being dragged', () => {
    const onOpenNode = vi.fn();

    const { container } = render(
      <WorkflowCanvas nodes={PLAN} edges={EDGES} onOpenNode={onOpenNode} onMoveNode={vi.fn()} />,
    );

    const box = container.querySelector('.wfc__node') as Element;

    fireEvent.pointerDown(box, { button: 0, pointerId: 4, clientX: 100, clientY: 100 });
    // Two pixels is a hand, not a gesture.
    fireEvent.pointerMove(box, { pointerId: 4, clientX: 102, clientY: 100 });
    fireEvent.pointerUp(box, { pointerId: 4, clientX: 102, clientY: 100 });
    fireEvent.click(box);

    expect(onOpenNode).toHaveBeenCalledTimes(1);
  });

  /* One swallowed click must not eat the next one: a drag then a click opens the node. */
  it('opens the node on the click after a drag', () => {
    const onOpenNode = vi.fn();

    const { container } = render(
      <WorkflowCanvas nodes={PLAN} edges={EDGES} onOpenNode={onOpenNode} onMoveNode={vi.fn()} />,
    );

    const box = container.querySelector('.wfc__node') as Element;

    fireEvent.pointerDown(box, { button: 0, pointerId: 5, clientX: 10, clientY: 10 });
    fireEvent.pointerMove(box, { pointerId: 5, clientX: 90, clientY: 10 });
    fireEvent.pointerUp(box, { pointerId: 5, clientX: 90, clientY: 10 });
    fireEvent.click(box);
    expect(onOpenNode).not.toHaveBeenCalled();

    fireEvent.pointerDown(box, { button: 0, pointerId: 6, clientX: 90, clientY: 10 });
    fireEvent.pointerUp(box, { pointerId: 6, clientX: 90, clientY: 10 });
    fireEvent.click(box);
    expect(onOpenNode).toHaveBeenCalledTimes(1);
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
