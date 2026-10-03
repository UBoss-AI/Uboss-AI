'use client';

/**
 * The hero's product visual: the path an objective takes through UBOSS.
 *
 * Drawn rather than screenshotted, for two reasons. A screenshot of a real workspace would be
 * somebody's data, and a screenshot of an empty one shows nothing — while the thing a visitor has
 * thirty seconds to understand is not what a screen looks like but what the system *does* with a
 * business objective.
 *
 * The shapes carry the meaning and match the product: human work is a rectangle, AI work is a
 * diamond, an approval is a gate. That is the same vocabulary the workflow canvas uses, so the
 * first thing somebody sees here is the thing they will see in the demo.
 *
 * Laid out in an SVG with a fixed viewBox so it scales to any width without reflowing, and
 * replaced by a stacked list under `sm` where a six-deep diagram would be unreadable.
 */

import { motion, useReducedMotion } from 'framer-motion';

const W = 900;
const H = 600;

type NodeKind = 'objective' | 'core' | 'human' | 'ai' | 'gate' | 'outcome';

interface Node {
  id: string;
  label: string;
  sub?: string;
  kind: NodeKind;
  x: number;
  y: number;
  w: number;
}

const NODES: readonly Node[] = [
  {
    id: 'objective',
    label: 'OBJECTIVE',
    sub: 'What the business wants',
    kind: 'objective',
    x: 450,
    y: 42,
    w: 210,
  },
  {
    id: 'core',
    label: 'Chief Agent',
    sub: 'Powered by UBoss AI',
    kind: 'core',
    x: 450,
    y: 140,
    w: 190,
  },
  /* The three AI nodes are 100 apart because a diamond's diagonal is ~85: at the first spacing
     they touched, which read as one shape rather than three steps. */
  { id: 'human', label: 'HUMAN WORK', kind: 'human', x: 240, y: 244, w: 168 },
  { id: 'ai', label: 'AI WORK', kind: 'ai', x: 660, y: 244, w: 150 },
  { id: 'todo', label: 'TO-DO', kind: 'human', x: 240, y: 344, w: 168 },
  { id: 'skills', label: 'SKILLS', kind: 'ai', x: 660, y: 344, w: 150 },
  { id: 'agent', label: 'JOB AGENT', kind: 'ai', x: 660, y: 444, w: 150 },
  { id: 'approvals', label: 'APPROVALS', kind: 'gate', x: 450, y: 508, w: 178 },
  { id: 'outcome', label: 'OUTCOME', kind: 'outcome', x: 450, y: 566, w: 178 },
];

/** Every connector, as a path between two node centres. */
const EDGES: readonly { from: string; to: string; tone: 'ai' | 'human' | 'neutral' }[] = [
  { from: 'objective', to: 'core', tone: 'neutral' },
  { from: 'core', to: 'human', tone: 'human' },
  { from: 'core', to: 'ai', tone: 'ai' },
  { from: 'human', to: 'todo', tone: 'human' },
  { from: 'ai', to: 'skills', tone: 'ai' },
  { from: 'skills', to: 'agent', tone: 'ai' },
  { from: 'todo', to: 'approvals', tone: 'human' },
  { from: 'agent', to: 'approvals', tone: 'ai' },
  { from: 'approvals', to: 'outcome', tone: 'neutral' },
];

const byId = (id: string): Node => NODES.find((n) => n.id === id) as Node;

const STROKE = {
  ai: '#8b5cf6',
  human: '#22d3ee',
  neutral: 'rgba(255,255,255,0.28)',
} as const;

/** A rounded elbow between two nodes: down, across, down. Straight when they share a column. */
function edgePath(fromId: string, toId: string): string {
  const a = byId(fromId);
  const b = byId(toId);
  /* Where a connector meets a node: half the shape's height. A diamond is taller than a
     rectangle at the point the line touches it, so the two are not the same number. */
  const reach = (n: Node): number => (n.kind === 'ai' ? 44 : n.kind === 'core' ? 28 : 24);
  const top = a.y + reach(a);
  const bottom = b.y - reach(b);
  if (Math.abs(a.x - b.x) < 2) return `M${a.x} ${top} L${b.x} ${bottom}`;
  const mid = top + (bottom - top) / 2;
  const sweep = a.x < b.x ? 14 : -14;
  return [
    `M${a.x} ${top}`,
    `L${a.x} ${mid - 14}`,
    `Q${a.x} ${mid} ${a.x + sweep} ${mid}`,
    `L${b.x - sweep} ${mid}`,
    `Q${b.x} ${mid} ${b.x} ${mid + 14}`,
    `L${b.x} ${bottom}`,
  ].join(' ');
}

function NodeShape({ node, index, still }: { node: Node; index: number; still: boolean }) {
  const half = node.w / 2;
  const h = node.sub === undefined ? 44 : 52;
  const halfH = h / 2;

  const palette =
    node.kind === 'ai'
      ? { stroke: '#8b5cf6', fill: 'rgba(139,92,246,0.12)', text: '#ddd6fe' }
      : node.kind === 'human'
        ? { stroke: '#22d3ee', fill: 'rgba(34,211,238,0.10)', text: '#a5f3fc' }
        : node.kind === 'gate'
          ? { stroke: 'rgba(251,191,36,0.55)', fill: 'rgba(251,191,36,0.08)', text: '#fde68a' }
          : node.kind === 'core'
            ? { stroke: '#a78bfa', fill: 'rgba(167,139,250,0.16)', text: '#ffffff' }
            : { stroke: 'rgba(255,255,255,0.22)', fill: 'rgba(255,255,255,0.05)', text: '#f4f4f5' };

  /* AI work is a diamond — the product's own shape for it — drawn as a rotated rectangle so the
     label inside stays upright. A gate is a hexagon; everything else is a rounded rectangle. */
  const shape =
    node.kind === 'ai' ? (
      <g transform={`rotate(45 ${node.x} ${node.y})`}>
        <rect
          x={node.x - 30}
          y={node.y - 30}
          width={60}
          height={60}
          rx={10}
          fill={palette.fill}
          stroke={palette.stroke}
          strokeWidth={1.25}
        />
      </g>
    ) : node.kind === 'gate' ? (
      <path
        d={`M${node.x - half + 16} ${node.y - halfH} H${node.x + half - 16} L${node.x + half} ${node.y} L${node.x + half - 16} ${node.y + halfH} H${node.x - half + 16} L${node.x - half} ${node.y} Z`}
        fill={palette.fill}
        stroke={palette.stroke}
        strokeWidth={1.25}
      />
    ) : (
      <rect
        x={node.x - half}
        y={node.y - halfH}
        width={node.w}
        height={h}
        rx={node.kind === 'core' ? 14 : 10}
        fill={palette.fill}
        stroke={palette.stroke}
        strokeWidth={1.25}
      />
    );

  const labelY = node.sub === undefined ? node.y + 4 : node.y - 3;

  return (
    <motion.g
      initial={{ opacity: 0, y: 10 }}
      animate={{ opacity: 1, y: 0 }}
      transition={
        still
          ? { duration: 0 }
          : { duration: 0.5, delay: 0.25 + index * 0.08, ease: [0.16, 1, 0.3, 1] }
      }
    >
      {node.kind === 'ai' || node.kind === 'core' ? (
        <circle
          cx={node.x}
          cy={node.y}
          r={node.kind === 'core' ? 62 : 44}
          fill={palette.stroke}
          opacity={0.07}
        />
      ) : null}
      {shape}
      <text
        x={node.x}
        y={labelY}
        textAnchor="middle"
        fill={palette.text}
        fontSize={node.kind === 'core' ? 13.5 : 11.5}
        fontWeight={node.kind === 'core' ? 700 : 600}
        letterSpacing="0.09em"
      >
        {node.label}
      </text>
      {node.sub === undefined ? null : (
        <text
          x={node.x}
          y={node.y + 14}
          textAnchor="middle"
          fill="rgba(255,255,255,0.45)"
          fontSize={9.5}
          letterSpacing="0.02em"
        >
          {node.sub}
        </text>
      )}
    </motion.g>
  );
}

export function FlowDiagram() {
  const still = useReducedMotion() === true;

  return (
    <div className="relative w-full">
      {/* The diagram proper, from sm upward. */}
      <div className="hidden sm:block">
        <svg
          viewBox={`0 0 ${W} ${H}`}
          className="h-auto w-full"
          role="img"
          aria-label="How UBOSS works: an objective is analysed into human work and AI work. Human work becomes To-do items. AI work is matched to governed Skills and built into a Job Agent. Both pass through Approvals before producing an outcome."
        >
          <defs>
            <linearGradient id="u-edge-ai" x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor="#8b5cf6" stopOpacity="0.15" />
              <stop offset="50%" stopColor="#8b5cf6" stopOpacity="0.65" />
              <stop offset="100%" stopColor="#8b5cf6" stopOpacity="0.15" />
            </linearGradient>
          </defs>

          {EDGES.map((edge) => {
            const d = edgePath(edge.from, edge.to);
            return (
              <g key={`${edge.from}-${edge.to}`}>
                <path d={d} fill="none" stroke={STROKE[edge.tone]} strokeWidth={1} opacity={0.5} />
                {/* The travelling light. Decoration: it carries no rate and no direction of value. */}
                {/* Always rendered; the stylesheet stops the animation under reduced motion. */}
                <path
                  d={d}
                  fill="none"
                  stroke={STROKE[edge.tone]}
                  strokeWidth={1.75}
                  strokeDasharray="4 28"
                  style={{ animation: 'u-dash 2.4s linear infinite' }}
                  opacity={0.85}
                />
              </g>
            );
          })}

          {NODES.map((node, i) => (
            <NodeShape key={node.id} node={node} index={i} still={still} />
          ))}
        </svg>
      </div>

      {/* Under sm the same path, stacked. A six-deep branching diagram at 390px is a smear. */}
      <ol className="space-y-2 sm:hidden" aria-label="How UBOSS works, in order">
        {[
          { label: 'Objective', tone: 'neutral' },
          { label: 'Chief Agent analyses it', tone: 'core' },
          { label: 'Human work → To-do', tone: 'human' },
          { label: 'AI work → Skills → Job Agent', tone: 'ai' },
          { label: 'Approvals', tone: 'gate' },
          { label: 'Outcome', tone: 'neutral' },
        ].map((row, i) => (
          <li
            key={row.label}
            className="flex items-center gap-3 rounded-xl border border-white/8 bg-white/[0.02] px-4 py-3"
          >
            <span
              className="grid h-6 w-6 shrink-0 place-items-center rounded-full text-[11px] font-semibold"
              style={{
                background:
                  row.tone === 'ai'
                    ? 'rgba(139,92,246,0.18)'
                    : row.tone === 'human'
                      ? 'rgba(34,211,238,0.16)'
                      : row.tone === 'gate'
                        ? 'rgba(251,191,36,0.16)'
                        : 'rgba(255,255,255,0.07)',
                color:
                  row.tone === 'ai'
                    ? '#ddd6fe'
                    : row.tone === 'human'
                      ? '#a5f3fc'
                      : row.tone === 'gate'
                        ? '#fde68a'
                        : '#f4f4f5',
              }}
            >
              {i + 1}
            </span>
            <span className="text-[14px] text-[#d4d4d8]">{row.label}</span>
          </li>
        ))}
      </ol>
    </div>
  );
}
