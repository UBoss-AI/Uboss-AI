'use client';

import { cn } from '../lib/class-names';
import { EmptyState } from './EmptyState';

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

const AGENTS_COLOR = '#0EA5E9';
const PENDING_COLOR = '#2563EB';

const RADIUS = 80;
const STROKE = 34;
const CIRCUMFERENCE = 2 * Math.PI * RADIUS;
const GAP = 7;

export function DonutDashboard({
  agents,
  pendingJobs,
  onSelectAgents,
  onSelectPendingJobs,
  centerLabel = 'MY WORK',
  className,
}: DonutDashboardProps) {
  const total = agents + pendingJobs;

  if (total === 0) {
    return (
      <EmptyState
        icon="grid"
        title="Nothing in your scope yet"
        description="Once Engine Agents are activated or work is assigned to you, they appear here."
      />
    );
  }

  const agentsFraction = agents / total;
  const pendingFraction = pendingJobs / total;

  // Leave a small visual gap between the two arcs, but never let an arc collapse to nothing
  // when its count is non-zero — a 1-of-20 slice must still be visible.
  const agentsLength = agents === 0 ? 0 : Math.max(agentsFraction * CIRCUMFERENCE - GAP, 2);
  const pendingLength = pendingJobs === 0 ? 0 : Math.max(pendingFraction * CIRCUMFERENCE - GAP, 2);

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
            <linearGradient id="uboss-donut-agents" x1="0" y1="0" x2="0" y2="1">
              <stop offset="0" stopColor="#2FD0F5" />
              <stop offset="1" stopColor="#0BA6E4" />
            </linearGradient>
            <linearGradient id="uboss-donut-pending" x1="0" y1="0" x2="0" y2="1">
              <stop offset="0" stopColor="#4C86FF" />
              <stop offset="1" stopColor="#2159DC" />
            </linearGradient>
          </defs>

          <circle cx="110" cy="110" r={RADIUS} fill="none" stroke="#EAEFF6" strokeWidth={30} />

          {agentsLength > 0 ? (
            <circle
              className={onSelectAgents ? 'uboss-donut-slice' : undefined}
              cx="110"
              cy="110"
              r={RADIUS}
              fill="none"
              stroke="url(#uboss-donut-agents)"
              strokeWidth={STROKE}
              strokeLinecap="round"
              strokeDasharray={`${agentsLength} ${CIRCUMFERENCE - agentsLength}`}
              strokeDashoffset={0}
              onClick={onSelectAgents}
            />
          ) : null}

          {pendingLength > 0 ? (
            <circle
              className={onSelectPendingJobs ? 'uboss-donut-slice' : undefined}
              cx="110"
              cy="110"
              r={RADIUS}
              fill="none"
              stroke="url(#uboss-donut-pending)"
              strokeWidth={STROKE}
              strokeLinecap="round"
              strokeDasharray={`${pendingLength} ${CIRCUMFERENCE - pendingLength}`}
              strokeDashoffset={-(agentsFraction * CIRCUMFERENCE)}
              onClick={onSelectPendingJobs}
            />
          ) : null}
        </svg>

        <div className="uboss-donut-center">
          <div className="uboss-donut-center-label">{centerLabel}</div>
          <div className="uboss-donut-center-value">{total}</div>
          <div className="uboss-donut-center-sub">items in scope</div>
        </div>
      </div>

      {/*
        The legend is the keyboard-accessible route into both drill-downs: SVG arcs alone would
        leave keyboard users unable to reach the detail screens.
      */}
      <div className="uboss-donut-legend">
        <DonutLegendItem
          color={AGENTS_COLOR}
          value={agents}
          label="Agents"
          onSelect={onSelectAgents}
        />
        <DonutLegendItem
          color={PENDING_COLOR}
          value={pendingJobs}
          label="Pending Jobs"
          onSelect={onSelectPendingJobs}
        />
      </div>
    </div>
  );
}

function DonutLegendItem({
  color,
  value,
  label,
  onSelect,
}: {
  color: string;
  value: number;
  label: string;
  onSelect?: (() => void) | undefined;
}) {
  const content = (
    <>
      <span className="uboss-legend-swatch" style={{ background: color }} aria-hidden="true" />
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
      className="uboss-legend-item uboss-legend-item--clickable"
      onClick={onSelect}
    >
      {content}
    </button>
  );
}
