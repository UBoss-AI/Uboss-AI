'use client';

import { useMemo, useRef, useState } from 'react';

import {
  NODE_SHAPES,
  type AnalysisNodeKind,
  type NodeShape,
  type WorkflowEdgeKind,
} from '@uboss/types';

import { WorkflowCanvasNode } from './WorkflowCanvasNode';

import './workflow-canvas.css';

/**
 * What one node is doing, right now.
 *
 * Deliberately not the engine's own `RunState`: the canvas draws human steps, AI steps and
 * approval gates with one vocabulary, and those three have different state machines underneath.
 * Each screen translates its own sources into these five, which keeps the translation beside the
 * data that justifies it rather than inside a drawing.
 */
export type NodeActivity =
  | { state: 'idle' }
  /** Work is happening. `percent` is null whenever the work cannot report a fraction honestly. */
  | { state: 'working'; percent: number | null; message?: string }
  /** Waiting on somebody, or on another step. Nothing is burning. */
  | { state: 'waiting'; message?: string }
  | { state: 'done' }
  | { state: 'failed'; message?: string };

/**
 * One box on the canvas.
 *
 * Deliberately **not** `AnalysisNode`. That type belongs to objective analysis and carries a
 * Definition of Done, a skill version, a source step position — none of which a drawing reads.
 * Binding the renderer to it would mean the only thing that could ever be drawn is an objective's
 * workflow, and the two other places that show work happening would each need their own picture.
 *
 * So the canvas states the five things it actually draws, and each screen says how its own data
 * answers them. An agent's test is three nodes; an objective's plan is thirty; both are graphs of
 * work and both deserve the same picture.
 */
export interface CanvasNode {
  id: string;
  /** The word on the first line, and the colour the node takes. */
  kind: AnalysisNodeKind;
  label: string;
  /** Drawn exactly as given — see the note at the shape switch below. */
  shape: NodeShape;
  /** The second line while the node is idle: who owns it, or what it is. */
  subtitle?: string | null;
  /*
   * The three facts the node draws for itself.
   *
   * They used to be flattened into `subtitle` by every caller, which was enough while a node was
   * three lines of SVG text. `WorkflowCanvasNode` draws the real thing now and asks the node
   * directly — an AI step with no approved Skill has to say so, and a human step should name its
   * owner rather than the word "assigned".
   */
  skillName?: string | null;
  ownerUserId?: string | null;
  ownerDesignation?: string | null;
  /** Where somebody put it. Absent means the layout decides — see `layout`. */
  position?: { x: number; y: number } | null;
}

/** One connector. `condition` is the label on a `Condition` edge, where there is one. */
export interface CanvasEdge {
  fromNodeId: string;
  toNodeId: string;
  kind: WorkflowEdgeKind;
  condition?: string | null;
}

/*
 * The zoom range.
 *
 * The floor was 0.5, with a note saying half size showed a twenty-five step plan end to end. It
 * did when a node was 196x68. A node is up to 300x300 now, so a step costs 356px down the page
 * and a thirty-six node plan is about 12,900 — 6,500 even at half, which is twelve screens. The
 * floor existed to stop somebody zooming into nothing; it was stopping them seeing the plan.
 *
 * A fifth is as far out as is worth going. Labels are gone well before it, and that is what
 * zooming out is for: somebody at this end is reading the shape — how long it runs, where it
 * branches — and reads the words by zooming back in or by opening the node.
 *
 * Further than that was tried and rejected rather than reasoned away. A floor of 4% does make
 * that plan fit a 420px frame end to end, and what it draws is a thread of grey dots 14px wide in
 * a 645px frame. It is a picture of the length of the plan and nothing else, and it costs the one
 * thing zooming out is for. Reading it whole is the frame's job, not the zoom's.
 *
 * Double is where a label stops being small rather than where it stops being readable. Tenths,
 * because a finer step is a button somebody presses eight times.
 */
const MIN_ZOOM = 0.2;
const MAX_ZOOM = 2;
const ZOOM_STEP = 0.1;

/** Tenths accumulate floating-point dust, and `0.7000000000000001` reaches the label. */
const round = (value: number) => Math.round(value * 10) / 10;

/*
 * There used to be seventy lines here that worked out how many characters of a label fitted on
 * each of a node's three lines of SVG text, per shape, from the shape's own geometry.
 *
 * All of it is gone because nodes are HTML now and clip themselves in CSS. The one thing in it
 * worth carrying forward is the fact it was built on, because anything that ever has to fit
 * inside one of these shapes meets it again: **a diamond of width `w` is only
 * `w x (1 - dy / half)` wide at a height `dy` from its centre**, so a line near a point has almost
 * no room at all. That is why the diamond's label is clamped to three lines rather than sized to
 * its bounding box — the box is not the shape.
 */

export interface WorkflowCanvasProps {
  nodes: readonly CanvasNode[];
  edges: readonly CanvasEdge[];
  /** By node id. A node with no entry is idle. */
  activity?: ReadonlyMap<string, NodeActivity> | undefined;
  /**
   * Whether the live channel is connected.
   *
   * Shown, not hidden. A canvas that has lost its stream looks identical to one where nothing is
   * happening, and the difference matters to somebody watching a run they started.
   */
  live?: boolean | undefined;
  /** Opens a node's editor. Omitted where the plan is read-only or not editable here. */
  onOpenNode?: ((nodeId: string) => void) | undefined;
  /**
   * Add a step after this one.
   *
   * A plus on the node itself rather than a position chosen from a list. A 32-node plan makes a
   * dropdown of every step something to read through and match against the picture already on
   * screen; pointing at the place is the answer the picture is for. Omitted where the plan is not
   * editable, which is also what hides the control.
   */
  onAddAfter?: ((nodeId: string) => void) | undefined;
  /**
   * Which way the work travels. Defaults to down the page, which is what this always did.
   *
   * The caller owns it rather than the canvas, because the control that changes it belongs in
   * the screen's toolbar beside the zoom, not floating over the drawing.
   */
  orientation?: CanvasOrientation | undefined;
  /**
   * Told where a node was dropped, so the caller can store it.
   *
   * The canvas does not persist anything itself — it does not know the objective, the revision or
   * what a failed save should say. It reports the move; the screen owns what that means.
   *
   * Omitted where the plan is not editable, and that is also what stops the dragging: a read-only
   * plan whose boxes slide around and spring back is worse than one that does not move.
   */
  onMoveNode?: ((nodeId: string, position: { x: number; y: number }) => void) | undefined;
}

/**
 * Which way the work travels across the drawing.
 *
 * `vertical` runs it down the page, `horizontal` across. Neither is more correct: a plan with
 * many steps and few branches is a long thin column one way and fits a wide screen the other,
 * and which of those a reader wants depends on the plan in front of them.
 */
export type CanvasOrientation = 'vertical' | 'horizontal';

/*
 * One node's box, and why it grew.
 *
 * These were 196x68 and the canvas drew three lines of SVG text inside them, clipped to a
 * character count per shape. The same workflow on the analysis screen was drawn by
 * `WorkflowCanvasNode` as real HTML — the full title, the owner, the shape in CSS — so the product
 * showed one plan two different ways, and the editor's version was the poorer of the two by a
 * long way. The client reported it as the editor not looking like the thing it edits.
 *
 * `WorkflowCanvasNode` already existed, already matched the analysis screen, and was used by
 * nothing but its own test — it has been in the repository since the baseline commit. So the
 * canvas renders it now, in a `foreignObject`, and the box is the size that component needs.
 *
 * Everything downstream — the layout, the row heights, the edge endpoints — is written in terms of
 * these numbers, which is why changing them is a change in one place.
 */
const NODE_W = 300;

/**
 * A diamond, measured rather than assumed.
 *
 * `.uboss-wf-ai-diamond` is a square `inset: 14px` inside a 240px wrapper — 212px — turned 45°.
 * A square turned 45° stands on its point, so the space it occupies is its **diagonal**:
 * 212 × √2 ≈ 300, the same both ways. The CSS has always said 300 across; this file said 240 tall,
 * and a `foreignObject` clips, so the top and bottom points of every AI node were sliced off flat
 * — 30px at each end, on all four diamonds of the plan this was found on.
 *
 * It read as the shape being drawn wrong. Nothing was wrong with the shape: its box was 60px too
 * short to contain it. Width escaped only because `NODE_W` is 300 by coincidence of the rectangle
 * needing that much.
 */
const DIAMOND = 300;
/*
 * The space between two nodes, not the distance between their origins.
 *
 * It used to be a step — a node's height plus 116 — the only thing it could be while every node
 * was the same height. Rows are measured now, so this is the gap itself and it reads as what it
 * is. Keeping it as a step was what made the first version of the taller nodes look like the plan
 * had been pulled apart: the step said 296 and the gap a person saw was that plus the empty half
 * of each box.
 */
const ROW_GAP = 56;
const COL_GAP = 40;

/**
 * How far below its node the "add a step" plus sits.
 *
 * Its circle has a radius of 11, so 13 clears the node's box by two pixels and the whole control
 * is 24px into the 56px gap — comfortably inside it, and clear of the row below. The two pixels
 * are the point: on the edge, half the control lay over the node and lost every hit test to it.
 */
const PLUS_DROP = 13;

/** The plus's invisible target, which is what decides how much room it needs below a node. */
const ADD_HIT_RADIUS = 16;
const PAD_X = 24;
const PAD_Y = 28;

interface Placed {
  node: CanvasNode;
  x: number;
  y: number;
  /** This node's own height — see `nodeHeight`. Carried so the edges can meet its real edge. */
  h: number;
}

/**
 * How tall one node is, by shape.
 *
 * ## Why not one number for all of them
 *
 * It was one number, and the number had to be the tallest: a diamond needs its own diagonal
 * because its text sits in a shape with corners. Every other node then got a box that tall with
 * its content centred in it — a goal pill is 70px tall, so most of its box was empty, and the gap
 * a person saw between two nodes was the real gap *plus* the empty halves of both boxes either
 * side of it. Reported as the steps being miles apart, which they were: about 300px between a goal
 * and the step after it, for a 56px gap.
 *
 * So each shape is its own height and a row is as tall as the tallest thing in it. The horizontal
 * orientation still uses one width for every node, which is true — they are all 300 wide.
 */
function nodeHeight(shape: NodeShape): number {
  if (shape === 'diamond') return DIAMOND;
  if (shape === 'goal') return 64;
  if (shape === 'gate') return 92;
  return 124;
}

/**
 * The band one node stands in when the plan runs across the page.
 *
 * Sideways there are no rows to measure — siblings stack in a column of equal slots — so the slot
 * has to be the tallest shape there is or the tallest shape hangs out of it. Derived from
 * `nodeHeight` over every shape rather than written down beside it: the two drifted apart once
 * already, and a hard-coded band is exactly how a shape grows without its slot noticing.
 */
const BAND_H = Math.max(...NODE_SHAPES.map(nodeHeight));

/**
 * Where each node sits.
 *
 * ## Why depth rather than the order they are listed in
 *
 * A plan is a graph, and the thing a list cannot show is that two steps happen **at the same
 * time**. Depth — the longest path from a start node — puts exactly those steps on the same row,
 * which is the whole reason for drawing this at all. Ordering by position would redraw the list.
 *
 * ## Why the longest path and not the shortest
 *
 * A node that waits on two branches must sit below both of them. The shortest path would place it
 * beside the branch that finished first and draw an edge travelling upward, which reads as the
 * work going backwards.
 *
 * Failure edges are excluded from the depth calculation: they return to a step that already ran,
 * so counting them would push every recovery node below the thing it recovers to and invert the
 * picture. They are drawn, but they do not decide the layout.
 */
function layout(
  nodes: readonly CanvasNode[],
  edges: readonly CanvasEdge[],
  orientation: CanvasOrientation,
) {
  const forward = edges.filter((edge) => edge.kind !== 'Failure');

  const incoming = new Map<string, string[]>();
  for (const node of nodes) incoming.set(node.id, []);
  for (const edge of forward) {
    const list = incoming.get(edge.toNodeId);
    if (list) list.push(edge.fromNodeId);
  }

  const depth = new Map<string, number>();
  const resolve = (id: string, seen: Set<string>): number => {
    const cached = depth.get(id);
    if (cached !== undefined) return cached;
    // A cycle in the data must not hang the screen. Treated as a root, which is wrong but
    // visible, rather than recursing until the tab dies.
    if (seen.has(id)) return 0;

    seen.add(id);
    const parents = incoming.get(id) ?? [];
    const value =
      parents.length === 0 ? 0 : Math.max(...parents.map((parent) => resolve(parent, seen) + 1));
    seen.delete(id);
    depth.set(id, value);
    return value;
  };

  for (const node of nodes) resolve(node.id, new Set());

  const rows = new Map<number, CanvasNode[]>();
  for (const node of nodes) {
    const level = depth.get(node.id) ?? 0;
    rows.set(level, [...(rows.get(level) ?? []), node]);
  }

  const widest = Math.max(1, ...[...rows.values()].map((row) => row.length));

  /*
   * The same graph, with the two axes exchanged.
   *
   * Depth is what the drawing is about: steps at the same depth happen at the same time, and
   * everything else follows from where depth goes. Down the page gives a tall plan a reader
   * scrolls through; across gives a wide one, which suits a plan with many steps and few
   * branches — and a screen that is wider than it is tall, which every screen is.
   *
   * Nothing about the graph changes — not the depths, not the grouping, not which nodes are
   * siblings. Only which coordinate each of those becomes.
   */
  const down = orientation === 'vertical';

  /** Along the direction work travels. */
  /*
   * Only the horizontal plan steps evenly along the direction work travels.
   *
   * Down the page the rows are measured and accumulated below, because their heights differ —
   * so there is no single step and asking for one would be asking the wrong question.
   */
  const levelStep = NODE_W + COL_GAP;
  /*
   * Across it, where steps that happen together sit beside each other.
   *
   * Both forms are a node plus a gap. Across the page siblings are stacked vertically, so the
   * node in question is a tall one — using the bare gap there, as this did while `ROW_GAP` was a
   * step, would overlap every pair of parallel steps in a horizontal plan.
   */
  const siblingStep = down ? NODE_W + COL_GAP : BAND_H + ROW_GAP;

  const ordered = [...rows.entries()].sort((a, b) => a[0] - b[0]);
  /** A row is as tall as the tallest shape standing in it. */
  const rowHeights = ordered.map(([, row]) => Math.max(...row.map((n) => nodeHeight(n.shape))));

  /*
   * Down the page, each row starts where the last one ended plus the gap — so the distance
   * between two steps is the gap, not the gap plus whatever both boxes left empty.
   *
   * Across the page every node is the same width, so the old even step is still right there.
   */
  const rowOffsets: number[] = [];
  let runningY = PAD_Y;
  for (const rowHeight of rowHeights) {
    rowOffsets.push(runningY);
    runningY += rowHeight + ROW_GAP;
  }

  const levelSpan = down
    ? runningY - ROW_GAP + PAD_Y
    : PAD_X * 2 + rows.size * NODE_W + Math.max(0, rows.size - 1) * (levelStep - NODE_W);
  const siblingSpan = down
    ? PAD_X * 2 + widest * NODE_W + (widest - 1) * (siblingStep - NODE_W)
    : PAD_Y * 2 + widest * BAND_H + (widest - 1) * (siblingStep - BAND_H);

  const width = down ? siblingSpan : levelSpan;
  const height = down ? levelSpan : siblingSpan;

  const placed = new Map<string, Placed>();
  ordered.forEach(([level, row], rowIndex) => {
    // Centred across the axis work does not travel along, so a narrow row sits under the middle
    // of a wide one rather than hugging an edge.
    const rowExtent =
      row.length * (down ? NODE_W : BAND_H) +
      (row.length - 1) * (siblingStep - (down ? NODE_W : BAND_H));
    const start = ((down ? width : height) - rowExtent) / 2;
    const rowHeight = rowHeights[rowIndex] ?? BAND_H;

    row.forEach((node, index) => {
      const h = nodeHeight(node.shape);
      placed.set(node.id, {
        node,
        h,
        x: down ? start + index * siblingStep : PAD_X + level * levelStep,
        /*
          Shorter nodes sit in the middle of the band a taller one defines, so a goal pill lines
          up with the diamond after it instead of hanging off its top edge.

          Both orientations need it, for the same reason and in the same place: across the page
          every node shares one band `BAND_H` tall, and without the centring a 72px pill and a
          300px diamond meet their connector at two different heights — which draws a chain of
          steps as a staircase.
        */
        y: down
          ? (rowOffsets[rowIndex] ?? PAD_Y) + (rowHeight - h) / 2
          : start + index * siblingStep + (BAND_H - h) / 2,
      });
    });
  });

  /*
   * A node somebody has moved sits where they put it.
   *
   * Applied after the layout rather than instead of it, so a node with no stored position still
   * gets the computed one — the two live side by side and a plan can be part arranged and part
   * automatic. That is the common state: somebody drags the two boxes that were in each other's
   * way and leaves the rest alone.
   *
   * The canvas then has to grow to contain whatever was dragged — in all four directions.
   *
   * It grew in two. A node moved right or down extended the drawing, and a node moved left or up
   * went past the viewBox and was sliced off against the edge of the frame: reported as the goal
   * node being cut in half down its left side, and it was, because its stored x was negative and
   * the drawing still began at zero.
   *
   * The window moves rather than the nodes. Shifting every node to make room would change what a
   * stored position means — a drag at one end of the plan would silently renumber a box at the
   * other — so the coordinates stay exactly as they were put and the `viewBox` starts wherever
   * the left-most, top-most thing actually is.
   */
  let minX = 0;
  let minY = 0;
  let maxX = width;
  let maxY = height;

  for (const entry of placed.values()) {
    const position = entry.node.position;
    if (position !== undefined && position !== null) {
      entry.x = position.x;
      entry.y = position.y;
    }

    minX = Math.min(minX, entry.x - PAD_X);
    minY = Math.min(minY, entry.y - PAD_Y);
    maxX = Math.max(maxX, entry.x + NODE_W + PAD_X);
    /*
     * The plus hangs below the node, so the room under the last row is its reach and not the
     * page padding. They are 29 and 28, which is the kind of one-pixel difference that shows up
     * as a control with a flat bottom and no reason for it.
     */
    maxY = Math.max(maxY, entry.y + entry.h + Math.max(PAD_Y, PLUS_DROP + ADD_HIT_RADIUS));
  }

  return { placed, width: maxX - minX, height: maxY - minY, originX: minX, originY: minY };
}

/**
 * The curve between two nodes, leaving the face work travels out of and entering the next.
 *
 * Down the page that is bottom to top; across, right to left. The control points bend along the
 * same axis, which is what keeps the curve reading as travel rather than as a loop.
 */
function connector(from: Placed, to: Placed, orientation: CanvasOrientation): string {
  if (orientation === 'horizontal') {
    const x1 = from.x + NODE_W;
    const y1 = from.y + from.h / 2;
    const x2 = to.x;
    const y2 = to.y + to.h / 2;
    const mid = (x1 + x2) / 2;
    return `M${x1} ${y1} C ${mid} ${y1}, ${mid} ${y2}, ${x2} ${y2}`;
  }

  const x1 = from.x + NODE_W / 2;
  const y1 = from.y + from.h;
  const x2 = to.x + NODE_W / 2;
  const y2 = to.y;
  const mid = (y1 + y2) / 2;
  return `M${x1} ${y1} C ${x1} ${mid}, ${x2} ${mid}, ${x2} ${y2}`;
}

/**
 * A failure edge returns to a step the work has already passed, so it goes round the outside
 * rather than back through the middle of the plan.
 *
 * Round the side when the plan runs down the page, and under it when the plan runs across —
 * either way, out past everything drawn and back in.
 */
function returnPath(
  from: Placed,
  to: Placed,
  /*
   * The far edges of the drawing, not its size.
   *
   * These were the width and the height, which is the same thing only while the drawing starts at
   * zero — and it does not once a node has been dragged left or up. A failure edge would then have
   * turned back short of the plan and crossed the nodes it was routed around.
   */
  rightEdge: number,
  bottomEdge: number,
  orientation: CanvasOrientation,
): string {
  if (orientation === 'horizontal') {
    const x1 = from.x + NODE_W / 2;
    const y1 = from.y + from.h;
    const x2 = to.x + NODE_W / 2;
    const y2 = to.y + to.h;
    const out = Math.min(bottomEdge - 8, Math.max(y1, y2) + 40);
    return `M${x1} ${y1} V${out} H${x2} V${y2}`;
  }

  const x1 = from.x + NODE_W;
  const y1 = from.y + from.h / 2;
  const x2 = to.x + NODE_W;
  const y2 = to.y + to.h / 2;
  const out = Math.min(rightEdge - 8, Math.max(x1, x2) + 40);
  return `M${x1} ${y1} H${out} V${y2} H${x2}`;
}

/**
 * The plan, drawn as the graph it is — and the work moving through it.
 *
 * ## Why this exists
 *
 * The workflow was printed as numbered rows. Three things a plan says cannot be said that way:
 * that two steps run **at the same time**, that a failure **returns** to an earlier step, and that
 * work **stops** at a gate until a person decides. Those are the differences between a plan and a
 * to-do list, and all three were invisible.
 *
 * ## Nothing here moves on its own
 *
 * Every animation is bound to `activity`, which each screen computes from what the product
 * actually recorded — a task's status, a run's state, an approval's status. There is no timer
 * advancing anything. A node that is working while nothing is happening would be fake execution,
 * which this product refuses everywhere else and must refuse here most of all: this is the screen
 * that claims to show the truth.
 *
 * `percent` is honoured exactly as typed. Where the engine reports a fraction, the ring fills to
 * it; where it reports null — meaning the work cannot say honestly — the node shows an
 * indeterminate pulse instead of a bar inventing a number.
 */
export function WorkflowCanvas({
  nodes,
  edges,
  activity,
  live,
  onOpenNode,
  onAddAfter,
  orientation = 'vertical',
  onMoveNode,
}: WorkflowCanvasProps) {
  const { placed, width, height, originX, originY } = useMemo(
    () => layout(nodes, edges, orientation),
    [nodes, edges, orientation],
  );

  /*
   * The node being dragged, and where it currently is.
   *
   * Held here rather than written through on every pointer move. A move is a request to the
   * server with a revision in it, and sending one per frame would both flood the audit trail and
   * lose races with itself — the last reply to arrive would win, which is not necessarily the
   * last place the person let go of. So the canvas draws the drag locally and reports once, on
   * drop.
   *
   * `null` means nothing is being dragged, which is almost always.
   */
  const [dragging, setDragging] = useState<{
    nodeId: string;
    /** Where the pointer was when it went down, in client pixels. */
    fromClientX: number;
    fromClientY: number;
    /** Where the node was then, in canvas units. */
    originX: number;
    originY: number;
    /** How far it has travelled since, in canvas units. */
    dx: number;
    dy: number;
    /** True once it has moved far enough to be a drag rather than a click. */
    moved: boolean;
  } | null>(null);

  /**
   * That the last gesture was a drag, kept somewhere the click can still read it.
   *
   * The state above cannot answer this. `onPointerUp` clears it, React re-renders before the
   * browser gets round to dispatching `click`, and the click handler then reads a fresh render
   * where nothing is being dragged — so the branch meant to swallow the click after a drag was
   * looking at `null` every single time. Dragging a node moved it **and** opened its editor, on
   * every drag, which is how it was reported.
   *
   * A ref survives that re-render. Set when a drag ends, cleared when the next press begins, so
   * it describes the gesture that just happened rather than a lingering mode.
   */
  const justDragged = useRef(false);

  /** The frame the drawing scrolls inside, measured when somebody asks for a fit. */
  const viewport = useRef<HTMLDivElement | null>(null);

  /*
   * How large the plan is drawn.
   *
   * Not persisted. A zoom is about the thing somebody is reading right now, and a remembered one
   * means opening a different objective at a size chosen for another.
   */
  const [zoom, setZoom] = useState(1);

  const drawn = useMemo(
    () =>
      edges
        .map((edge) => {
          const from = placed.get(edge.fromNodeId);
          const to = placed.get(edge.toNodeId);
          if (!from || !to) return null;
          return {
            edge,
            from,
            to,
            d:
              edge.kind === 'Failure'
                ? returnPath(from, to, originX + width, originY + height, orientation)
                : connector(from, to, orientation),
            // An edge is carrying work when the step it leaves is working: that is what makes the
            // light on it true rather than decorative.
            carrying: activity?.get(edge.fromNodeId)?.state === 'working',
          };
        })
        .filter((item): item is NonNullable<typeof item> => item !== null),
    // `height` and `orientation` as well as the rest: both decide the path a failure edge takes
    // round the outside, and leaving them out left every edge drawn for the previous direction
    // after the toggle had already moved the nodes. The origin is in for the same reason — it
    // moves the far edge a failure edge turns back at.
    [edges, placed, width, height, originX, originY, orientation, activity],
  );

  if (nodes.length === 0) return null;

  return (
    <div className="wfc">
      <div className="wfc__bar">
        {live === undefined ? null : (
          <p className={`wfc__live${live ? ' wfc__live--on' : ''}`}>
            {live ? 'Live' : 'Not live — reload to reconnect'}
          </p>
        )}

        {/*
          Zoom.

          A plan is as tall as the company's process is long, and this drew it at one size in a
          box that scrolled sideways — so a twenty-five step objective could be read a node at a
          time or not at all. Out to see the shape, in to read a label.

          Buttons rather than a wheel handler: a wheel over a page that also scrolls is a fight
          between the two, and this canvas sits inside a scrolling screen.
        */}
        <div className="wfc__zoom">
          <button
            type="button"
            className="wfc__zoom-btn"
            onClick={() => setZoom((current) => Math.max(MIN_ZOOM, round(current - ZOOM_STEP)))}
            disabled={zoom <= MIN_ZOOM}
            aria-label="Zoom out"
          >
            −
          </button>
          {/* The figure is a button: pressing it is the way back to actual size. */}
          <button
            type="button"
            className="wfc__zoom-value"
            onClick={() => setZoom(1)}
            aria-label={`Zoom ${Math.round(zoom * 100)} percent. Press to reset to 100 percent.`}
          >
            {Math.round(zoom * 100)}%
          </button>
          {/*
            Fill the frame across the way the work does not travel.

            Not "fit the whole plan". That was the first version and it is the wrong promise for
            the shape these plans are: thirty-six steps is 348 wide and 10,372 tall, so fitting
            both ways means 4% — a thread of dots 14px wide in a 645px frame, which says how long
            the plan is and nothing else. Fitting the long way is what the frame is for.

            So it fits the short way, and the result is a plan that fills the width it has instead
            of leaving 300px of frame empty beside it. Sideways it is the same idea turned over:
            the plan fills the height and runs off to the right.

            It reads the frame at the moment it is pressed rather than tracking it, because the
            answer is only wanted when somebody asks for it — and a zoom that re-fitted itself
            whenever the window changed would move the plan under a person who was reading it.
          */}
          <button
            type="button"
            className="wfc__zoom-btn wfc__zoom-fit"
            onClick={() => {
              const frame = viewport.current;
              if (frame === null) return;
              /*
                Not put through `round`, which snaps to the tenths the buttons step in.

                A fit is a measurement, not a step. Rounding one to a tenth is how an earlier
                version of this turned a zoom of 0.0405 into 0.0 — a drawing of 0x0 and an empty
                frame where the plan had been. The buttons stay on their grid; this does not.
              */
              const fit =
                orientation === 'vertical'
                  ? frame.clientWidth / width
                  : frame.clientHeight / height;
              setZoom(Math.max(MIN_ZOOM, Math.min(MAX_ZOOM, fit)));
            }}
            aria-label={
              orientation === 'vertical'
                ? 'Fit the plan to the width of the frame'
                : 'Fit the plan to the height of the frame'
            }
            title={
              orientation === 'vertical'
                ? 'Fit the plan to the width of the frame'
                : 'Fit the plan to the height of the frame'
            }
          >
            Fit
          </button>
          <button
            type="button"
            className="wfc__zoom-btn"
            onClick={() => setZoom((current) => Math.min(MAX_ZOOM, round(current + ZOOM_STEP)))}
            disabled={zoom >= MAX_ZOOM}
            aria-label="Zoom in"
          >
            +
          </button>
        </div>
      </div>

      {/*
        The plan scrolls inside this, not inside the page.

        It used to be as tall as the drawing, so the page was: a thirty-six step plan came to
        about 12,900px and the screen's own toolbar — direction, zoom, the way back from a
        rearranged canvas — was off the top of the window by the time the second node was in
        view. Measured: scrolled to node two, the toolbar sat at y = -137.

        A frame of its own keeps the controls where they were put and leaves the page the length
        of a page. The frame scrolls both ways, because a horizontal plan is wide for exactly the
        reason a vertical one is long.
      */}
      <div className="wfc__viewport" ref={viewport}>
        <svg
          className="wfc__svg"
          /*
            Starts where the drawing starts, which is not always zero.

            A node dragged left or up has a negative coordinate, and a window that always began at
            zero cut it off against the edge of the frame. Moving the window instead of the nodes
            keeps every stored position meaning exactly what it meant when somebody put it there.
          */
          viewBox={`${originX} ${originY} ${width} ${height}`}
          /*
           * Drawn size, not the viewBox.
           *
           * The viewBox is the plan's own coordinates and never changes; giving the element a
           * width in pixels is what makes the same drawing bigger or smaller, and the frame
           * scrolls to whatever that comes to.
           */
          width={Math.round(width * zoom)}
          height={Math.round(height * zoom)}
          role="img"
          aria-label="The workflow for this objective, and what each step is doing"
        >
          <defs>
            <marker
              id="wfc-arrow"
              viewBox="0 0 10 10"
              refX="9"
              refY="5"
              markerWidth="6"
              markerHeight="6"
              orient="auto-start-reverse"
            >
              <path d="M0 0L10 5L0 10z" className="wfc__arrowhead" />
            </marker>
          </defs>

          <g className="wfc__edges">
            {drawn.map(({ edge, d, carrying }, index) => (
              <g key={`${edge.fromNodeId}-${edge.toNodeId}-${index}`}>
                <path
                  className={`wfc__edge wfc__edge--${edge.kind.toLowerCase()}`}
                  d={d}
                  markerEnd="url(#wfc-arrow)"
                />
                {/*
                The light, and only while the step above it is actually working.

                Three sparks a beat apart so the connector is never empty — one dot crawling reads
                as a loading bar. They exist only while `carrying` is true, so a still picture is a
                picture of nothing happening, which is what it should be.
              */}
                {carrying
                  ? [0, 1, 2].map((spark) => (
                      <circle
                        key={spark}
                        className="wfc__spark"
                        r="3.2"
                        style={{ offsetPath: `path("${d}")`, animationDelay: `${spark * 0.6}s` }}
                      />
                    ))
                  : null}
                {edge.kind === 'Parallel' || edge.kind === 'Condition' ? (
                  <text
                    className="wfc__edge-label"
                    x={(drawn[index]?.from.x ?? 0) + NODE_W + 6}
                    y={(drawn[index]?.from.y ?? 0) + (drawn[index]?.from.h ?? BAND_H) + 16}
                  >
                    {edge.kind === 'Parallel' ? 'at the same time' : (edge.condition ?? 'if')}
                  </text>
                ) : null}
              </g>
            ))}
          </g>

          <g className="wfc__nodes">
            {[...placed.values()].map(({ node, x, y, h }) => {
              const state = activity?.get(node.id) ?? { state: 'idle' as const };
              const held = dragging?.nodeId === node.id ? dragging : null;
              // Drawn where the pointer has taken it, while the pointer still has it.
              const drawX = x + (held?.dx ?? 0);
              const drawY = y + (held?.dy ?? 0);

              return (
                <g
                  key={node.id}
                  className={`wfc__node wfc__node--${node.kind.toLowerCase()} wfc__node--${state.state}${
                    held !== null && held.moved ? ' wfc__node--dragging' : ''
                  }`}
                  transform={`translate(${drawX} ${drawY})`}
                  /*
                  Click opens, drag moves, and the difference is six pixels.

                  Both start with the same pointer going down on the same box, so the only honest
                  way to tell them apart is to wait and see whether it travels. Below the threshold
                  it was a click and the node opens; past it the click is swallowed, because
                  somebody who has just dragged a box across the canvas did not also ask to open it.

                  Read from `justDragged` rather than from the drag state, which by now says
                  nothing is being dragged — see the ref's own note. The flag is cleared here as
                  well as on the next press so one swallowed click cannot eat the one after it.
                */
                  onClick={
                    onOpenNode === undefined
                      ? undefined
                      : (event) => {
                          if (justDragged.current) {
                            justDragged.current = false;
                            event.stopPropagation();
                            return;
                          }
                          onOpenNode(node.id);
                        }
                  }
                  onPointerDown={
                    onMoveNode === undefined
                      ? undefined
                      : (event) => {
                          // Only a plain left press. A right-click is the context menu and a
                          // middle-click is not a gesture this canvas claims.
                          if (event.button !== 0) return;
                          /*
                           * A press that began on the plus is not the start of a drag.
                           *
                           * Capturing the pointer sends every later event for it to the element
                           * that captured — and the browser then fires `click` on that element
                           * rather than on whatever was under the finger. So the plus sits inside
                           * the box it belongs to, the box captured the pointer, and the click
                           * arrived at the box: pressing + opened the node for editing and the
                           * "Add a step" dialog could not be reached from the canvas at all. The
                           * plus has its own handler and its own `stopPropagation`; both work as
                           * soon as the click is allowed to land on it.
                           *
                           * Nothing is lost by not capturing here. The plus is 22px across and a
                           * press on it is a press, not a gesture — and a drag that genuinely
                           * starts on the box is unaffected, because this only returns for the one
                           * control.
                           */
                          if ((event.target as Element).closest('.wfc__add') !== null) return;
                          // A new press, so whatever the last gesture was is over.
                          justDragged.current = false;
                          event.currentTarget.setPointerCapture(event.pointerId);
                          setDragging({
                            nodeId: node.id,
                            fromClientX: event.clientX,
                            fromClientY: event.clientY,
                            originX: x,
                            originY: y,
                            dx: 0,
                            dy: 0,
                            moved: false,
                          });
                        }
                  }
                  onPointerMove={
                    onMoveNode === undefined
                      ? undefined
                      : (event) => {
                          setDragging((current) => {
                            if (current === null || current.nodeId !== node.id) return current;
                            /*
                             * Client pixels divided by the zoom, because the canvas units are what
                             * the position is stored in. At 50% a 10px hand movement is 20 units,
                             * and reading the pointer straight would make a zoomed-out plan feel
                             * like the node was stuck in treacle.
                             */
                            const dx = (event.clientX - current.fromClientX) / zoom;
                            const dy = (event.clientY - current.fromClientY) / zoom;
                            /*
                             * Six pixels, not three.
                             *
                             * Three was enough to tell a click from a drag, and not enough to tell
                             * a drag from a hand. Testing this produced two stored positions from
                             * one deliberate drag: a press that shifted a few pixels on the way to
                             * being a click had been saved, audited and reloaded. A gesture that
                             * writes to the server should need to look like one.
                             */
                            const moved = current.moved || Math.abs(dx) + Math.abs(dy) > 6;
                            return { ...current, dx, dy, moved };
                          });
                        }
                  }
                  onPointerUp={
                    onMoveNode === undefined
                      ? undefined
                      : () => {
                          const held = dragging;
                          setDragging(null);
                          if (held === null || held.nodeId !== node.id || !held.moved) return;
                          // Remembered for the `click` the browser is about to send, which arrives
                          // after this render has already forgotten the drag.
                          justDragged.current = true;
                          onMoveNode(node.id, {
                            x: held.originX + held.dx,
                            y: held.originY + held.dy,
                          });
                        }
                  }
                  // A capture lost to the browser — a dialog opening, the tab losing focus — must
                  // not leave a node following a pointer that is no longer pressed.
                  onPointerCancel={onMoveNode === undefined ? undefined : () => setDragging(null)}
                  style={
                    onMoveNode !== undefined
                      ? { cursor: held !== null && held.moved ? 'grabbing' : 'grab' }
                      : onOpenNode === undefined
                        ? undefined
                        : { cursor: 'pointer' }
                  }
                >
                  {/*
                  The shape comes from `node.shape`, never from the kind.

                  The client's locked rule is that a Human node is a rectangle, an AI node is a
                  diamond and the Goal is distinct — and the server stores and validates the shape
                  against the kind. Deciding it again here would be two places deciding one thing,
                  which is how a renderer ends up disagreeing with the schema it draws.
                */}
                  {/*
                  The node itself, drawn as HTML rather than as SVG text.

                  `foreignObject` because the layout, the edges and the zoom are all SVG and work
                  well — only the *contents* of a node were the problem. Three clipped lines of
                  `<text>` could never carry what the analysis screen shows, and every attempt to
                  make them fit was a character count tuned against a font.

                  `WorkflowCanvasNode` draws the shapes in CSS, so the polygons and the rounded
                  rect that used to be here are gone with the text: one component decides what a
                  node looks like, for both screens.
                */}
                  <foreignObject width={NODE_W} height={h} className="wfc__html">
                    <WorkflowCanvasNode
                      node={node}
                      activityLabel={
                        state.state === 'working'
                          ? /*
                             * The fraction only where there is one.
                             *
                             * Null means the work cannot report a fraction honestly, so the node says
                             * it is working and nothing more. Rendering "0%" or a crawling bar there
                             * would be inventing the one number the type exists to withhold.
                             */
                            state.percent === null
                            ? 'working…'
                            : `working — ${state.percent}%`
                          : state.state === 'waiting'
                            ? (state.message ?? 'waiting')
                            : state.state === 'failed'
                              ? (state.message ?? 'failed')
                              : state.state === 'done'
                                ? 'done'
                                : null
                      }
                      {...(onOpenNode === undefined
                        ? { onOpen: () => undefined }
                        : { onOpen: () => onOpenNode(node.id) })}
                    />
                  </foreignObject>

                  {/* A quiet pulse on the edge of whatever is working. Bound to state, not to a clock. */}
                  {state.state === 'working' ? (
                    <rect className="wfc__pulse" width={NODE_W} height={h} rx="10" />
                  ) : null}

                  {/*
                  Add a step here, said by pointing rather than by choosing from a list.

                  Just below the lower edge, where the next step will go, so the control sits at
                  the place it acts on. It stops the click reaching the node underneath — the two
                  mean different things and the plus is the smaller target of the two.

                  Drawn for every node including the Goal, because a plan may legitimately start a
                  new branch straight off it.

                  ## Why `h + PLUS_DROP` and not `h`

                  It was on the edge itself, and half of it therefore lay over the `foreignObject`
                  above — and HTML inside a `foreignObject` paints above the SVG drawn after it,
                  whatever the document order says. So on a node whose box reaches that far the
                  plus was *behind* the node's own button: `elementFromPoint` at the centre of the
                  plus returned the button, a press there opened the editor, and "add a step" could
                  not be reached. It looked intermittent because it depended on how far each shape
                  filled its box — the goal pill left the plus exposed and the diamond did not.

                  Clear of the box entirely, there is nothing to lose a hit test to. It sits in the
                  56px gap on the connector itself, which is where the step it makes will appear.
                */}
                  {onAddAfter === undefined ? null : (
                    <g
                      className="wfc__add"
                      transform={`translate(${NODE_W / 2} ${h + PLUS_DROP})`}
                      onClick={(event) => {
                        event.stopPropagation();
                        onAddAfter(node.id);
                      }}
                      style={{ cursor: 'pointer' }}
                    >
                      <title>Add a step after “{node.label}”</title>
                      {/*
                      A target larger than the mark, and a bridge back to the node.

                      Two jobs. A 22px control is a small thing to hit, and this makes it 32
                      without drawing anything bigger. And the plus only appears while the node is
                      hovered — with the visible circle held clear of the box there would be a
                      two-pixel band on the way to it where neither is under the pointer and the
                      control blinks out just as somebody reaches for it. This spans that band.
                    */}
                      <circle className="wfc__add-hit" r={ADD_HIT_RADIUS} />
                      <circle className="wfc__add-dot" r="11" />
                      <path className="wfc__add-mark" d="M -5 0 H 5 M 0 -5 V 5" />
                    </g>
                  )}
                </g>
              );
            })}
          </g>
        </svg>
      </div>
    </div>
  );
}
