'use client';

import { motion } from 'motion/react';
import { useEffect, useId, useState } from 'react';

import { cn } from '../lib/class-names';
import { prefersReducedMotion, transition } from '../motion/motion';

/**
 * The Company Workspace Dashboard donut.
 *
 * LOCKED PRODUCT RULE — the Company Workspace Dashboard shows exactly ONE donut/pie chart with
 * exactly TWO slices: Agents and Pending Jobs. No KPI cards, objective tables, token/cost cards,
 * notification lists, hierarchy summaries, performance details or reports appear on that
 * dashboard (`UBoss_Final_2` §29, which declares "LATEST RULE WINS" over older examples).
 *
 * The contract is deliberately expressed as two named numeric props rather than a generic
 * `slices: Slice[]` array, so a third category cannot be introduced by passing more data. If a
 * future approved change adds a category, that is a client decision requiring this component's
 * signature — and the source-of-truth document — to change together.
 *
 * Counts must already be permission-scoped by the caller: the server returns only what the
 * signed-in user is allowed to see.
 *
 * ## The motion, and what it is careful about
 *
 * **The DOM always carries the true numbers.** The arc's `stroke-dasharray` attribute is its real
 * length from the first frame, and the centre figure is the real total; the draw-on is a CSS
 * animation of the *style*, which overrides the attribute while it runs and lands exactly on it.
 * That ordering matters: an arc whose attribute started at zero would be a chart that told the
 * truth only once it had finished moving, and anything reading it before then — a test, a
 * screenshot, a browser with animations off — would read a lie.
 *
 * Later changes are a transition on the same property, so a refresh moves the arc from where it
 * was rather than redrawing it from empty. A dashboard that re-animated from zero on every poll
 * would flash at somebody trying to read it.
 *
 * The hover lift states its `initial` explicitly. Without it Motion has no starting value for
 * `r` — it is an SVG presentation attribute, not a style — and writes `undefined` to it on the
 * first frame. The browser reports "<circle> attribute r: Expected length" and carries on, so it
 * showed up only in the console, on every dashboard, for every role.
 *
 * Nothing loops. The highlight passes the circumference once, on first reveal, and stops. Under
 * `prefers-reduced-motion` the draw and the sweep are both off and the chart is simply complete.
 */
export interface DonutDashboardProps {
  /** Engine Agents visible to the signed-in user. */
  agents: number;
  /** Pending jobs (work awaiting action) visible to the signed-in user. */
  pendingJobs: number;
  /** Drill-down to the Engine Agent list/detail. */
  onSelectAgents?: () => void;
  /** Drill-down to the permitted pending work detail. */
  onSelectPendingJobs?: () => void;
  /** Centre caption above the total. */
  centerLabel?: string;
  className?: string;
}

const RADIUS = 80;
const STROKE = 34;
const CIRCUMFERENCE = 2 * Math.PI * RADIUS;
/** The visual gap between the arcs, as a fraction of the circumference. */
const GAP = 7 / CIRCUMFERENCE;
/** A non-zero count must stay visible, however small its share. */
const MIN_ARC = 2 / CIRCUMFERENCE;
/** How far a hovered arc lifts out of the ring. */
const LIFT = 3;

export function DonutDashboard({
  agents,
  pendingJobs,
  onSelectAgents,
  onSelectPendingJobs,
  centerLabel = 'MY WORK',
  className,
}: DonutDashboardProps) {
  const gradientId = useId();
  const [hovered, setHovered] = useState<'agents' | 'pending' | null>(null);
  const [revealed, setRevealed] = useState(prefersReducedMotion());

  const total = agents + pendingJobs;
  const agentsFraction = total === 0 ? 0 : agents / total;
  const pendingFraction = total === 0 ? 0 : pendingJobs / total;

  const agentsTarget = agents === 0 ? 0 : Math.max(agentsFraction - GAP, MIN_ARC);
  const pendingTarget = pendingJobs === 0 ? 0 : Math.max(pendingFraction - GAP, MIN_ARC);

  const agentsDash = `${agentsTarget} ${Math.max(1 - agentsTarget, 0)}`;
  const pendingDash = `${pendingTarget} ${Math.max(1 - pendingTarget, 0)}`;

  // One pass of the highlight, once the arcs have drawn. Not a loop: a dashboard that pulses for
  // ever is a dashboard nobody can read beside.
  useEffect(() => {
    if (prefersReducedMotion()) return undefined;
    const timer = window.setTimeout(() => setRevealed(true), 520);
    return () => window.clearTimeout(timer);
  }, []);

  /*
   * No early return for an empty scope.
   *
   * This used to hand back an EmptyState instead of the chart, so a person with nothing assigned
   * got a generic card and no donut at all — measured on a standard Employee: zero donuts on the
   * one screen whose contract is exactly one. The lock is one donut with two categories, and zero
   * is a truthful reading of it, not an absence of one.
   *
   * The explanation the empty state carried is kept, below the legend, where it says the same
   * thing without taking the chart's place.
   */

  const centre =
    hovered === 'agents'
      ? { label: 'AGENTS', value: agents.toString(), sub: 'Engine Agents in scope' }
      : hovered === 'pending'
        ? { label: 'PENDING JOBS', value: pendingJobs.toString(), sub: 'awaiting action' }
        : { label: centerLabel, value: null, sub: 'items in scope' };

  return (
    <div className={cn('uboss-donut-wrap', className)}>
      <div className="uboss-donut-figure">
        <svg
          width="240"
          height="240"
          viewBox="0 0 220 220"
          style={{ transform: 'rotate(-90deg)' }}
          role="img"
          aria-label={`${agents} Agents and ${pendingJobs} Pending Jobs, ${total} items in your scope`}
        >
          <defs>
            {/*
              Two violets from the same family, one darker and one lighter, so the slices are
              distinguishable by value as well as by hue. Colour is still not the only signal: the
              arcs never touch, and the legend below names each one with its count.
            */}
            <linearGradient id={`${gradientId}-agents`} x1="0" y1="0" x2="1" y2="1">
              <stop offset="0%" stopColor="var(--uboss-donut-agents-from)" />
              <stop offset="100%" stopColor="var(--uboss-donut-agents-to)" />
            </linearGradient>
            <linearGradient id={`${gradientId}-pending`} x1="0" y1="0" x2="1" y2="1">
              <stop offset="0%" stopColor="var(--uboss-donut-pending-from)" />
              <stop offset="100%" stopColor="var(--uboss-donut-pending-to)" />
            </linearGradient>
          </defs>

          <circle
            cx="110"
            cy="110"
            r={RADIUS}
            fill="none"
            stroke="var(--uboss-bg-2)"
            strokeWidth={30}
          />

          {agentsTarget > 0 ? (
            <g style={{ '--uboss-arc': agentsDash } as React.CSSProperties}>
              <motion.circle
                className={cn('uboss-donut-arc', onSelectAgents && 'uboss-donut-slice')}
                cx="110"
                cy="110"
                r={RADIUS}
                pathLength={1}
                fill="none"
                stroke={`url(#${gradientId}-agents)`}
                strokeWidth={STROKE}
                strokeLinecap="round"
                strokeDasharray={agentsDash}
                strokeDashoffset={0}
                initial={{ r: RADIUS, opacity: 1 }}
                animate={{
                  r: hovered === 'agents' ? RADIUS + LIFT : RADIUS,
                  opacity: hovered === 'pending' ? 0.55 : 1,
                }}
                transition={transition('small')}
                onClick={onSelectAgents}
                onMouseEnter={() => setHovered('agents')}
                onMouseLeave={() => setHovered(null)}
              />
            </g>
          ) : null}

          {pendingTarget > 0 ? (
            <g style={{ '--uboss-arc': pendingDash } as React.CSSProperties}>
              <motion.circle
                className={cn('uboss-donut-arc', onSelectPendingJobs && 'uboss-donut-slice')}
                cx="110"
                cy="110"
                r={RADIUS}
                pathLength={1}
                fill="none"
                stroke={`url(#${gradientId}-pending)`}
                strokeWidth={STROKE}
                strokeLinecap="round"
                strokeDasharray={pendingDash}
                strokeDashoffset={-agentsFraction}
                initial={{ r: RADIUS, opacity: 1 }}
                animate={{
                  r: hovered === 'pending' ? RADIUS + LIFT : RADIUS,
                  opacity: hovered === 'agents' ? 0.55 : 1,
                }}
                transition={transition('small')}
                onClick={onSelectPendingJobs}
                onMouseEnter={() => setHovered('pending')}
                onMouseLeave={() => setHovered(null)}
              />
            </g>
          ) : null}

          {/* The single highlight pass. Mounted once the arcs have drawn, and it runs exactly once. */}
          {revealed && !prefersReducedMotion() ? (
            <motion.circle
              key="sweep"
              cx="110"
              cy="110"
              r={RADIUS}
              pathLength={1}
              fill="none"
              stroke="var(--uboss-ai-highlight)"
              strokeWidth={STROKE}
              strokeLinecap="round"
              strokeDasharray="0.06 0.94"
              initial={{ strokeDashoffset: 0, opacity: 0.45 }}
              animate={{ strokeDashoffset: -1, opacity: 0 }}
              transition={{ duration: 0.9, ease: 'linear' }}
              style={{ pointerEvents: 'none' }}
            />
          ) : null}
        </svg>

        <div className="uboss-donut-center">
          <div className="uboss-donut-center-label">{centre.label}</div>
          <div className="uboss-donut-center-value">{centre.value ?? total}</div>
          <div className="uboss-donut-center-sub">{centre.sub}</div>
        </div>
      </div>

      {/*
        The legend is the keyboard-accessible route into both drill-downs: SVG arcs alone would
        leave keyboard users unable to reach the detail screens. Focus highlights the matching arc
        too, so the connection is not hover-only.
      */}
      <div className="uboss-donut-legend">
        <DonutLegendItem
          swatch="var(--uboss-donut-agents-to)"
          value={agents}
          label="Agents"
          active={hovered === 'agents'}
          onSelect={onSelectAgents}
          onHighlight={(on) => setHovered(on ? 'agents' : null)}
        />
        <DonutLegendItem
          swatch="var(--uboss-donut-pending-to)"
          value={pendingJobs}
          label="Pending Jobs"
          active={hovered === 'pending'}
          onSelect={onSelectPendingJobs}
          onHighlight={(on) => setHovered(on ? 'pending' : null)}
        />
      </div>

      {total === 0 ? (
        <p className="uboss-donut-note uboss-muted">
          Nothing is in your scope yet. Engine Agents activated for you, and work assigned to you,
          appear here.
        </p>
      ) : null}
    </div>
  );
}

function DonutLegendItem({
  swatch,
  value,
  label,
  active,
  onSelect,
  onHighlight,
}: {
  swatch: string;
  value: number;
  label: string;
  active: boolean;
  onSelect?: (() => void) | undefined;
  onHighlight: (on: boolean) => void;
}) {
  const content = (
    <>
      <span className="uboss-legend-swatch" style={{ background: swatch }} aria-hidden="true" />
      <span>
        <span className="uboss-legend-value">{value}</span>
        <span className="uboss-legend-label">{label}</span>
      </span>
    </>
  );

  if (!onSelect) {
    return <span className="uboss-legend-item">{content}</span>;
  }

  return (
    <button
      type="button"
      className={cn(
        'uboss-legend-item',
        'uboss-legend-item--clickable',
        active && 'uboss-legend-item--active',
      )}
      onClick={onSelect}
      onMouseEnter={() => onHighlight(true)}
      onMouseLeave={() => onHighlight(false)}
      onFocus={() => onHighlight(true)}
      onBlur={() => onHighlight(false)}
    >
      {content}
    </button>
  );
}
