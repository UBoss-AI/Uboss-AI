'use client';

import { useMemo, useState } from 'react';

import type { AnalysisNodeKind, NodeShape, WorkflowEdgeKind } from '@uboss/types';

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
 * Half size shows roughly a twenty-five step plan end to end, which is the point of zooming out
 * at all; double is where a label stops being small rather than where it stops being readable.
 * Tenths, because a finer step is a button somebody presses eight times.
 */
const MIN_ZOOM = 0.5;
const MAX_ZOOM = 2;
const ZOOM_STEP = 0.1;

/** Tenths accumulate floating-point dust, and `0.7000000000000001` reaches the label. */
const round = (value: number) => Math.round(value * 10) / 10;

/** One line of a node's text, cut to what fits rather than to what reads well. */
const clip = (value: string, max: number) =>
  value.length > max ? `${value.slice(0, max - 1).trimEnd()}…` : value;

/**
 * Where a node's three lines of text go, and how much of each fits.
 *
 * ## Why this is not one answer for every node
 *
 * Every node drew its text at `x=14`, left-aligned, whatever shape it was. A box 196 wide and 68
 * tall has room at x=14. A **diamond** of the same bounds has its corners at (98,0), (196,34),
 * (98,68) and (0,34), so at the kind line — y=20 — the shape only spans x≈40 to x≈156. The text
 * started 26px outside its own node and ran past the far edge, over the connector beneath it.
 *
 * The widths below come from the geometry rather than from taste. At a height `dy` from the
 * centre a diamond is `196 × (1 − dy/34)` wide, so the three lines have about 115px, 161px and
 * 69px to work in; the hexagonal gate loses 14px at each end and keeps the rest. Divided by the
 * character widths of the three type sizes — 10px bold, 13px semibold, 11px regular — those come
 * to the limits here.
 *
 * Centred rather than inset, for the two shapes that narrow: a left inset on a diamond has to be
 * the inset of its *narrowest* line or it escapes, and that wastes the width the middle line has.
 */
function textMetricsFor(shape: NodeShape): {
  x: number;
  anchor: 'start' | 'middle';
  centred: boolean;
  className: string;
  whoClassName: string;
  chars: { label: number; who: number };
} {
  if (shape === 'diamond') {
    return {
      x: NODE_W / 2,
      anchor: 'middle',
      centred: true,
      className: 'wfc__kind',
      whoClassName: 'wfc__who',
      // The label line is the widest part of the shape; the subtitle sits near the bottom point.
      chars: { label: 24, who: 12 },
    };
  }
  if (shape === 'gate') {
    return {
      x: NODE_W / 2,
      anchor: 'middle',
      centred: true,
      className: 'wfc__kind',
      whoClassName: 'wfc__who',
      chars: { label: 24, who: 22 },
    };
  }
  return {
    x: 14,
    anchor: 'start',
    centred: false,
    className: 'wfc__kind',
    whoClassName: 'wfc__who',
    chars: { label: 26, who: 26 },
  };
}

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
}

const NODE_W = 196;
const NODE_H = 68;
const ROW_GAP = 116;
const COL_GAP = 28;
const PAD_X = 24;
const PAD_Y = 28;

interface Placed {
  node: CanvasNode;
  x: number;
  y: number;
}

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
function layout(nodes: readonly CanvasNode[], edges: readonly CanvasEdge[]) {
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
  const width = PAD_X * 2 + widest * NODE_W + (widest - 1) * COL_GAP;
  const height = PAD_Y * 2 + rows.size * NODE_H + Math.max(0, rows.size - 1) * (ROW_GAP - NODE_H);

  const placed = new Map<string, Placed>();
  for (const [level, row] of [...rows.entries()].sort((a, b) => a[0] - b[0])) {
    const rowWidth = row.length * NODE_W + (row.length - 1) * COL_GAP;
    const startX = (width - rowWidth) / 2;
    row.forEach((node, index) => {
      placed.set(node.id, {
        node,
        x: startX + index * (NODE_W + COL_GAP),
        y: PAD_Y + level * ROW_GAP,
      });
    });
  }

  return { placed, width, height };
}

/** The curve between two nodes, leaving the bottom of one and entering the top of the next. */
function connector(from: Placed, to: Placed): string {
  const x1 = from.x + NODE_W / 2;
  const y1 = from.y + NODE_H;
  const x2 = to.x + NODE_W / 2;
  const y2 = to.y;
  const mid = (y1 + y2) / 2;
  return `M${x1} ${y1} C ${x1} ${mid}, ${x2} ${mid}, ${x2} ${y2}`;
}

/** A failure edge returns to a step above, so it goes round the side rather than through. */
function returnPath(from: Placed, to: Placed, width: number): string {
  const x1 = from.x + NODE_W;
  const y1 = from.y + NODE_H / 2;
  const x2 = to.x + NODE_W;
  const y2 = to.y + NODE_H / 2;
  const out = Math.min(width - 8, Math.max(x1, x2) + 40);
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
}: WorkflowCanvasProps) {
  const { placed, width, height } = useMemo(() => layout(nodes, edges), [nodes, edges]);

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
            d: edge.kind === 'Failure' ? returnPath(from, to, width) : connector(from, to),
            // An edge is carrying work when the step it leaves is working: that is what makes the
            // light on it true rather than decorative.
            carrying: activity?.get(edge.fromNodeId)?.state === 'working',
          };
        })
        .filter((item): item is NonNullable<typeof item> => item !== null),
    [edges, placed, width, activity],
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

      <svg
        className="wfc__svg"
        viewBox={`0 0 ${width} ${height}`}
        /*
         * Drawn size, not the viewBox.
         *
         * The viewBox is the plan's own coordinates and never changes; giving the element a width
         * in pixels is what makes the same drawing bigger or smaller, and the wrapper scrolls to
         * whatever that comes to.
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
                  y={(drawn[index]?.from.y ?? 0) + NODE_H + 16}
                >
                  {edge.kind === 'Parallel' ? 'at the same time' : (edge.condition ?? 'if')}
                </text>
              ) : null}
            </g>
          ))}
        </g>

        <g className="wfc__nodes">
          {[...placed.values()].map(({ node, x, y }) => {
            const state = activity?.get(node.id) ?? { state: 'idle' as const };
            const text = textMetricsFor(node.shape);
            return (
              <g
                key={node.id}
                className={`wfc__node wfc__node--${node.kind.toLowerCase()} wfc__node--${state.state}`}
                transform={`translate(${x} ${y})`}
                onClick={onOpenNode === undefined ? undefined : () => onOpenNode(node.id)}
                style={onOpenNode === undefined ? undefined : { cursor: 'pointer' }}
              >
                {/*
                  The shape comes from `node.shape`, never from the kind.

                  The client's locked rule is that a Human node is a rectangle, an AI node is a
                  diamond and the Goal is distinct — and the server stores and validates the shape
                  against the kind. Deciding it again here would be two places deciding one thing,
                  which is how a renderer ends up disagreeing with the schema it draws.
                */}
                {node.shape === 'diamond' ? (
                  <polygon
                    className="wfc__box"
                    points={`${NODE_W / 2},0 ${NODE_W},${NODE_H / 2} ${NODE_W / 2},${NODE_H} 0,${NODE_H / 2}`}
                  />
                ) : node.shape === 'gate' ? (
                  <polygon
                    className="wfc__box"
                    points={`14,0 ${NODE_W - 14},0 ${NODE_W},${NODE_H / 2} ${NODE_W - 14},${NODE_H} 14,${NODE_H} 0,${NODE_H / 2}`}
                  />
                ) : (
                  <rect
                    className="wfc__box"
                    width={NODE_W}
                    height={NODE_H}
                    rx={node.shape === 'goal' ? NODE_H / 2 : 10}
                  />
                )}

                <text className={text.className} x={text.x} y="20" textAnchor={text.anchor}>
                  {node.kind === 'Ai' ? 'AI' : node.kind}
                </text>

                <text
                  className={`wfc__label${text.centred ? ' wfc__label--centred' : ''}`}
                  x={text.x}
                  y="40"
                  textAnchor={text.anchor}
                >
                  {clip(node.label, text.chars.label)}
                </text>

                <text className={text.whoClassName} x={text.x} y="56" textAnchor={text.anchor}>
                  {clip(
                    state.state === 'working'
                      ? /*
                         * The fraction only where there is one.
                         *
                         * Null means the work cannot report a fraction honestly, so the node says it
                         * is working and nothing more. Rendering "0%" or a crawling bar there would
                         * be inventing the one number the type exists to withhold.
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
                            : (node.subtitle ?? ''),
                    text.chars.who,
                  )}
                </text>

                {/* A quiet pulse on the edge of whatever is working. Bound to state, not to a clock. */}
                {state.state === 'working' ? (
                  <rect className="wfc__pulse" width={NODE_W} height={NODE_H} rx="10" />
                ) : null}

                {/*
                  Add a step here, said by pointing rather than by choosing from a list.

                  On the lower edge, where the next step will go, so the control sits at the place
                  it acts on. It stops the click reaching the node underneath — the two mean
                  different things and the plus is the smaller target of the two.

                  Drawn for every node including the Goal, because a plan may legitimately start a
                  new branch straight off it.
                */}
                {onAddAfter === undefined ? null : (
                  <g
                    className="wfc__add"
                    transform={`translate(${NODE_W / 2} ${NODE_H})`}
                    onClick={(event) => {
                      event.stopPropagation();
                      onAddAfter(node.id);
                    }}
                    style={{ cursor: 'pointer' }}
                  >
                    <title>Add a step after “{node.label}”</title>
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
  );
}
