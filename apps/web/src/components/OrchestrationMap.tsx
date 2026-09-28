'use client';

import { Icon, type IconName } from '@uboss/ui';
import { useCallback, useEffect, useRef, useState } from 'react';

import type { DashboardMeta, DashboardTileView } from '../lib/api-client';

/**
 * The dashboard as an orchestration map.
 *
 * ## What it says
 *
 * One coordinating layer in the middle — the Chief Agent — with the work areas this person is
 * authorized to see branching off it, split into the side where work is carried out and the side
 * where it is decided on and reviewed. Each branch ends in a real count, taken by the server in
 * this person's own scope.
 *
 * ## What it does not say
 *
 * The wires are a picture of *which areas exist for this person*, not of traffic. Nothing here is
 * live, nothing is routing in real time, and no wire is brighter because something is happening on
 * it. That matters: a diagram that looks like telemetry and is not is worse than a list. The only
 * information in the drawing is the shape — the numbers do the rest, and they are the server's.
 *
 * There is no token meter, no rate-limit gauge and no cost anywhere on this screen. Those numbers
 * exist elsewhere in the product behind their own permission, and inventing a gauge for the sake
 * of the picture is the exact failure the dashboard contract was written to prevent.
 *
 * ## Why the wires are measured rather than drawn
 *
 * The number of branches depends on permission, so no fixed illustration is correct: an employee
 * sees three areas and an administrator seven, and a hand-drawn diagram would be wrong for one of
 * them. The nodes are laid out by CSS, then measured, and each wire is drawn from where the core
 * actually is to where that node actually ended up. Change the permissions, the font, or the
 * window, and the drawing follows.
 *
 * On the server there is nothing to measure, so the canvas renders empty and fills after layout.
 * The markup is identical either way — branching markup on something the server cannot know is
 * what produces a hydration mismatch.
 */

const TILE_ICONS: Record<string, IconName> = {
  objectives: 'target',
  tasks: 'list',
  agents: 'bot',
  approvals: 'shield',
  exceptions: 'alert',
  performance: 'medal',
  reports: 'chart',
};

/** One drawn branch: the path from the core to a node, and which side it is on. */
interface Wire {
  key: string;
  lane: string;
  d: string;
}

interface Size {
  width: number;
  height: number;
}

export function OrchestrationMap({
  tiles,
  meta,
  scope,
  onOpen,
}: {
  tiles: DashboardTileView[];
  meta: DashboardMeta | null;
  scope: string;
  onOpen: (href: string) => void;
}) {
  const frame = useRef<HTMLDivElement>(null);
  const core = useRef<HTMLSpanElement>(null);
  const nodes = useRef(new Map<string, HTMLElement>());

  const [wires, setWires] = useState<Wire[]>([]);
  const [size, setSize] = useState<Size>({ width: 0, height: 0 });

  /*
   * Draw each branch from the edge of the core disc to the inner edge of its node.
   *
   * From the edge rather than the centre, so no wire is visible crossing the disc; to the inner
   * edge rather than the centre, so no wire is visible crossing the node. Both ends are then
   * hidden by the things they join, which is what makes it read as one object.
   */
  const measure = useCallback(() => {
    const frameEl = frame.current;
    const coreEl = core.current;
    if (frameEl === null || coreEl === null) return;

    const bounds = frameEl.getBoundingClientRect();
    if (bounds.width === 0) return;

    const disc = coreEl.getBoundingClientRect();
    const cx = disc.left - bounds.left + disc.width / 2;
    const cy = disc.top - bounds.top + disc.height / 2;
    const radius = disc.width / 2;

    const drawn: Wire[] = [];
    for (const [key, element] of nodes.current) {
      const node = element.getBoundingClientRect();
      if (node.width === 0) continue;

      const onTheLeft = node.left - bounds.left + node.width / 2 < cx;
      const startX = cx + (onTheLeft ? -radius : radius);
      const endX = onTheLeft ? node.right - bounds.left : node.left - bounds.left;
      const endY = node.top - bounds.top + node.height / 2;

      /*
       * The bend is proportional to the gap, so a wide window gives a long lazy curve and a narrow
       * one a tighter curve, instead of a fixed control point that kinks when the gap is small.
       */
      const bend = Math.abs(endX - startX) * 0.52;
      const c1 = startX + (onTheLeft ? -bend : bend);
      const c2 = endX + (onTheLeft ? bend : -bend);

      drawn.push({
        key,
        lane: meta?.tiles.find((entry) => entry.key === key)?.lane ?? 'execution',
        d: `M ${startX} ${cy} C ${c1} ${cy}, ${c2} ${endY}, ${endX} ${endY}`,
      });
    }

    setWires(drawn);
    setSize({ width: bounds.width, height: bounds.height });
  }, [meta]);

  useEffect(() => {
    measure();

    /*
     * A second pass on the next frame.
     *
     * The first runs before the web font has swapped, and a label that grows by a line moves its
     * node — leaving every wire on that side pointing at where the node used to be.
     */
    const again = requestAnimationFrame(measure);

    const frameEl = frame.current;
    const observer = new ResizeObserver(measure);
    if (frameEl !== null) observer.observe(frameEl);
    for (const element of nodes.current.values()) observer.observe(element);

    return () => {
      cancelAnimationFrame(again);
      observer.disconnect();
    };
  }, [measure, tiles]);

  if (meta === null) return null;

  const describe = (key: string) => meta.tiles.find((entry) => entry.key === key);

  /** The tiles the server permitted, in the order the contract lists them, per side. */
  const laneTiles = (lane: string) =>
    tiles.filter((tile) => describe(tile.tile)?.lane === lane);

  const renderLane = (lane: { key: string; label: string; measures: string }) => {
    const inLane = laneTiles(lane.key);

    return (
      <div key={lane.key} className={`uboss-orch-lane uboss-orch-lane--${lane.key}`}>
        <div className="uboss-orch-lane-head">
          <span className="uboss-orch-lane-label">{lane.label}</span>
          <span className="uboss-orch-lane-measure">{lane.measures}</span>
        </div>

        <div className="uboss-orch-lane-nodes">
          {inLane.map((tile) => {
            const detail = describe(tile.tile);
            if (detail === undefined) return null;

            /*
             * Nought is worth saying plainly. An empty queue is good news, and a node that reads
             * "0" beside "Waiting on a decision" says it better than hiding the node would — a
             * work area that disappears when it is clear is one somebody stops trusting.
             */
            const hasCount = tile.count !== null;

            return (
              <button
                key={tile.tile}
                type="button"
                ref={(element) => {
                  if (element === null) nodes.current.delete(tile.tile);
                  else nodes.current.set(tile.tile, element);
                }}
                className={`uboss-orch-node uboss-orch-node--${lane.key}`}
                onClick={() => onOpen(detail.href)}
                aria-label={
                  hasCount
                    ? `${detail.label}: ${tile.count}. ${detail.measures ?? ''}`
                    : `Open ${detail.label}`
                }
              >
                <span className="uboss-orch-node-plate" aria-hidden="true">
                  <Icon name={TILE_ICONS[tile.tile] ?? 'list'} size={17} />
                </span>

                <span className="uboss-orch-node-text">
                  <span className="uboss-orch-node-label">{detail.label}</span>
                  <span className="uboss-orch-node-measure">
                    {detail.measures ?? 'Everything this area holds'}
                  </span>
                </span>

                {hasCount ? (
                  <span className="uboss-orch-node-count">{tile.count}</span>
                ) : (
                  <span className="uboss-orch-node-go" aria-hidden="true">
                    <Icon name="arrow" size={15} />
                  </span>
                )}
              </button>
            );
          })}
        </div>
      </div>
    );
  };

  /*
   * Only the sides this person actually has something on.
   *
   * An employee whose permissions reach no oversight module would otherwise get a heading over an
   * empty column, which reads as something that failed to load rather than as something they are
   * not party to.
   */
  const drawn = (meta.lanes ?? []).filter((lane) => laneTiles(lane.key).length > 0);

  return (
    <div
      className={`uboss-orch-map${drawn.length < 2 ? ' uboss-orch-map--solo' : ''}`}
      ref={frame}
    >
      {/*
        The wires. Decoration in the strict sense — everything they express is already in the
        headings and the nodes, so they are hidden from assistive technology entirely.
      */}
      <svg
        className="uboss-orch-wires"
        aria-hidden="true"
        focusable="false"
        width={size.width}
        height={size.height}
        viewBox={`0 0 ${size.width} ${size.height}`}
      >
        {wires.map((wire) => (
          <path
            key={wire.key}
            className={`uboss-orch-wire uboss-orch-wire--${wire.lane}`}
            d={wire.d}
          />
        ))}
      </svg>

      {/*
        The core.

        Two facts and nothing else: what is coordinating this workspace, and whose view of it this
        is. The scope sentence is the server's own words and it is load-bearing — without it a
        manager and an employee see different numbers on the same screen with no way to tell why.

        It is a label, not a report. Nothing here claims the Chief Agent did anything; it names the
        layer the work areas belong to.
      */}
      <div className="uboss-orch-core">
        <span className="uboss-orch-core-disc" ref={core}>
          <span className="uboss-orch-core-halo" aria-hidden="true" />
          <Icon name="bot" size={24} />
        </span>
        <span className="uboss-orch-core-name">Chief Agent</span>
        <span className="uboss-orch-core-scope">{scope}</span>
      </div>

      {drawn.map(renderLane)}
    </div>
  );
}
