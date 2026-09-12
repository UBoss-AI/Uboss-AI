import { cn } from '../lib/class-names';

/** One node of the chart. Recursive, and the three kinds render differently. */
export interface OrgChartNode {
  kind: 'company' | 'department' | 'person';
  id: string;
  name: string;
  /** Second line: "Company · 5 departments", "Department · 12 people", or a designation. */
  subtitle: string;
  children: OrgChartNode[];
}

export interface OrgChartProps {
  root: OrgChartNode;
  /** Clicking a person node. The reference navigates to their profile. */
  onSelectPerson?: (id: string) => void;
  /** The `+` action on a person node: add a direct report. Omit to hide it. */
  onAddReport?: (id: string) => void;
  /** The pencil action on a person node. Omit to hide it. */
  onEditPerson?: (id: string) => void;
  /** Shown instead of the chart when a company has departments but nobody recorded. */
  emptyMessage?: string;
  className?: string;
}

/** Box geometry, from the reference's `orgSVG`. */
const BOX_WIDTH = 214;
const BOX_HEIGHT = 64;
const GAP_X = 22;
const GAP_Y = 50;
const PAD_X = 28;
const PAD_Y = 22;

/**
 * The department palette, from the reference's `DEPT_COL`.
 *
 * Names the client's own five departments and falls back to the product blue for anything else,
 * so a company with different departments gets a coherent chart rather than a missing colour.
 */
const DEPARTMENT_COLOURS: Record<string, string> = {
  Executive: '#12314B',
  'Regulatory Affairs': '#2E86C7',
  'Exports & Tenders': '#E8833A',
  'Quality Assurance': '#4B9C2E',
  Production: '#7A5AF8',
};

const FALLBACK_COLOUR = '#2563EB';

/**
 * A stable colour for any department name.
 *
 * The five named ones keep the reference's exact colours. Anything else is hashed into a fixed
 * palette, so the same department is always the same colour — a chart whose colours moved
 * between page loads would make the grouping useless.
 */
function departmentColour(name: string): string {
  const named = DEPARTMENT_COLOURS[name];
  if (named !== undefined) {
    return named;
  }

  const palette = ['#2563EB', '#0EA5E9', '#7A5AF8', '#E8833A', '#4B9C2E', '#C2410C', '#0F766E'];
  let hash = 0;
  for (let index = 0; index < name.length; index += 1) {
    hash = (hash * 31 + name.charCodeAt(index)) % 100_000;
  }
  return palette[hash % palette.length] ?? FALLBACK_COLOUR;
}

/** Initials for an avatar square: two letters, upper case. */
function initials(name: string): string {
  const words = name.split(/\s+/).filter(Boolean);
  return words
    .map((word) => word[0] ?? '')
    .slice(0, 2)
    .join('')
    .toUpperCase();
}

/** Department initials: two words' first letters, or the first two characters. */
function departmentInitials(name: string): string {
  const parts = name.split(/[ &]+/).filter(Boolean);
  return (
    parts.length > 1
      ? parts
          .map((part) => part[0])
          .slice(0, 2)
          .join('')
      : name.slice(0, 2)
  ).toUpperCase();
}

/** Truncate to fit the box, with an ellipsis. The reference does the same. */
function truncate(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

interface Placed extends OrgChartNode {
  x: number;
  y: number;
  depth: number;
  /** The nearest department ancestor's name, for the node colour. */
  departmentName: string;
  children: Placed[];
}

/**
 * Lay the tree out: leaves get consecutive slots, parents centre over their children.
 *
 * The reference's algorithm exactly. A single pass, because a node's own x depends only on its
 * children's — which is why this is depth-first and why the leaf counter is threaded through.
 */
function layout(root: OrgChartNode): { placed: Placed; width: number; height: number } {
  let leafIndex = 0;
  let maxDepth = 0;

  const place = (node: OrgChartNode, depth: number, departmentName: string): Placed => {
    maxDepth = Math.max(maxDepth, depth);
    const ownDepartment = node.kind === 'department' ? node.name : departmentName;

    const children = node.children.map((child) => place(child, depth + 1, ownDepartment));

    const y = PAD_Y + depth * (BOX_HEIGHT + GAP_Y) + BOX_HEIGHT / 2;
    let x: number;

    if (children.length > 0) {
      x = (children[0]!.x + children[children.length - 1]!.x) / 2;
    } else {
      x = PAD_X + leafIndex * (BOX_WIDTH + GAP_X) + BOX_WIDTH / 2;
      leafIndex += 1;
    }

    return { ...node, x, y, depth, departmentName: ownDepartment, children };
  };

  const placed = place(root, 0, '');

  return {
    placed,
    width: Math.round(PAD_X * 2 + Math.max(leafIndex, 1) * (BOX_WIDTH + GAP_X) - GAP_X),
    height: Math.round(PAD_Y * 2 + (maxDepth + 1) * (BOX_HEIGHT + GAP_Y) - GAP_Y),
  };
}

/** Elbow connectors: down, across, down. The reference's path shape. */
function connectors(node: Placed): string[] {
  const paths: string[] = [];

  for (const child of node.children) {
    const fromY = node.y + BOX_HEIGHT / 2;
    const toY = child.y - BOX_HEIGHT / 2;
    const midY = (fromY + toY) / 2;
    paths.push(`M${node.x} ${fromY} V${midY} H${child.x} V${toY}`);
    paths.push(...connectors(child));
  }

  return paths;
}

/**
 * The Organization Hierarchy tree, as the client's reference draws it.
 *
 * ## Why an SVG rather than nested elements
 *
 * The reference draws **elbow connectors** between a node and each of its children. CSS cannot
 * draw a line from one box to another, so a div-based tree either loses the connectors or fakes
 * them with borders that break the moment a branch has an odd number of children. The reference
 * itself switched to SVG for this reason (`orgSVG` replaced an earlier `.tree` markup, both of
 * which are still in the file), and this follows the version that ships.
 *
 * ## Accessibility, which an SVG chart has to earn
 *
 * The chart carries `role="tree"` with a label, every person node is focusable and activates on
 * Enter or Space, and each node's text is real `<text>` rather than a path — so a screen reader
 * reads names and designations, and a browser's find-in-page finds them. The chart is a
 * *secondary* representation regardless: the List View shows the same people as a real table,
 * and the client made it a first-class view rather than a fallback.
 *
 * ## Node actions
 *
 * A person node carries the reference's two circular actions — `+` to add a direct report and a
 * pencil to edit. Both are omitted entirely when the caller passes no handler, rather than
 * rendered disabled: a control that cannot act should not be on the screen. There is
 * deliberately **no invite action** on a node — the client's rule is that the invitation source
 * is Settings → Users & Access.
 */
export function OrgChart({
  root,
  onSelectPerson,
  onAddReport,
  onEditPerson,
  emptyMessage,
  className,
}: OrgChartProps) {
  const hasPeople = root.children.some((department) => department.children.length > 0);

  if (!hasPeople && emptyMessage !== undefined) {
    return (
      <div className={cn('uboss-org', className)}>
        <p className="uboss-org-empty">{emptyMessage}</p>
      </div>
    );
  }

  const { placed, width, height } = layout(root);
  const paths = connectors(placed);

  const nodes: Placed[] = [];
  const collect = (node: Placed) => {
    nodes.push(node);
    node.children.forEach(collect);
  };
  collect(placed);

  return (
    <div className={cn('uboss-org', className)}>
      <svg
        width={width}
        height={height}
        viewBox={`0 0 ${width} ${height}`}
        role="tree"
        aria-label={`${root.name} organization chart`}
        fontFamily="Inter, system-ui, sans-serif"
      >
        <defs>
          <linearGradient id="uboss-org-logo" x1="0" y1="0" x2="1" y2="1">
            <stop offset="0" stopColor="#0EA5E9" />
            <stop offset="1" stopColor="#2563EB" />
          </linearGradient>
        </defs>

        {paths.map((path) => (
          <path key={path} d={path} fill="none" stroke="#CDDAEA" strokeWidth={1.6} />
        ))}

        {nodes.map((node) => (
          <OrgNode
            key={`${node.kind}-${node.id}`}
            node={node}
            {...(onSelectPerson === undefined ? {} : { onSelectPerson })}
            {...(onAddReport === undefined ? {} : { onAddReport })}
            {...(onEditPerson === undefined ? {} : { onEditPerson })}
          />
        ))}
      </svg>
    </div>
  );
}

function OrgNode({
  node,
  onSelectPerson,
  onAddReport,
  onEditPerson,
}: {
  node: Placed;
  onSelectPerson?: (id: string) => void;
  onAddReport?: (id: string) => void;
  onEditPerson?: (id: string) => void;
}) {
  const x = node.x - BOX_WIDTH / 2;
  const y = node.y - BOX_HEIGHT / 2;

  if (node.kind === 'company') {
    return (
      <g role="treeitem" aria-label={`${node.name}. ${node.subtitle}`}>
        <rect
          x={x}
          y={y}
          width={BOX_WIDTH}
          height={BOX_HEIGHT}
          rx={13}
          fill="#0F2740"
          stroke="#0A1E33"
        />
        <rect x={x + 12} y={y + 13} width={36} height={36} rx={9} fill="url(#uboss-org-logo)" />
        <text x={x + 30} y={y + 37} fill="#fff" fontSize={17} fontWeight={800} textAnchor="middle">
          U
        </text>
        <text x={x + 58} y={y + 27} fill="#fff" fontSize={15} fontWeight={800}>
          {truncate(node.name, 18)}
        </text>
        <text x={x + 58} y={y + 45} fill="#9DB4CF" fontSize={11}>
          {node.subtitle}
        </text>
      </g>
    );
  }

  if (node.kind === 'department') {
    const colour = departmentColour(node.name);
    return (
      <g role="treeitem" aria-label={`${node.name}. ${node.subtitle}`}>
        <rect
          x={x}
          y={y}
          width={BOX_WIDTH}
          height={BOX_HEIGHT}
          rx={13}
          fill="#F4F8FD"
          stroke="#D6E2F0"
        />
        <rect x={x + 12} y={y + 13} width={36} height={36} rx={9} fill={colour} />
        <text x={x + 30} y={y + 37} fill="#fff" fontSize={13} fontWeight={800} textAnchor="middle">
          {departmentInitials(node.name)}
        </text>
        <text x={x + 58} y={y + 26} fill="#12314B" fontSize={13.5} fontWeight={750}>
          {truncate(node.name, 22)}
        </text>
        <text x={x + 58} y={y + 44} fill="#5C6B82" fontSize={11}>
          {node.subtitle}
        </text>
      </g>
    );
  }

  const colour = departmentColour(node.departmentName);
  const right = x + BOX_WIDTH;
  const selectable = onSelectPerson !== undefined;

  return (
    <g
      className="uboss-org-node"
      role="treeitem"
      aria-label={`${node.name}. ${node.subtitle}`}
      {...(selectable
        ? {
            tabIndex: 0,
            style: { cursor: 'pointer' },
            onClick: () => onSelectPerson(node.id),
            onKeyDown: (event: React.KeyboardEvent<SVGGElement>) => {
              if (event.key === 'Enter' || event.key === ' ') {
                event.preventDefault();
                onSelectPerson(node.id);
              }
            },
          }
        : {})}
    >
      <rect
        className="uboss-org-card"
        x={x}
        y={y}
        width={BOX_WIDTH}
        height={BOX_HEIGHT}
        rx={13}
        fill="#ffffff"
        stroke="#E2EAF4"
      />
      <rect x={x + 12} y={y + 13} width={36} height={36} rx={9} fill={colour} />
      <text x={x + 30} y={y + 37} fill="#fff" fontSize={12.5} fontWeight={800} textAnchor="middle">
        {initials(node.name)}
      </text>
      <text x={x + 58} y={y + 26} fill="#12314B" fontSize={13} fontWeight={700}>
        {truncate(node.name, 18)}
      </text>
      <text x={x + 58} y={y + 43} fill="#5C6B82" fontSize={10.5}>
        {truncate(node.subtitle, 24)}
      </text>

      {onAddReport === undefined ? null : (
        <g
          className="uboss-org-action uboss-org-action--add"
          role="button"
          tabIndex={0}
          aria-label={`Add a direct report to ${node.name}`}
          style={{ cursor: 'pointer' }}
          onClick={(event) => {
            event.stopPropagation();
            onAddReport(node.id);
          }}
          onKeyDown={(event) => {
            if (event.key === 'Enter' || event.key === ' ') {
              event.preventDefault();
              event.stopPropagation();
              onAddReport(node.id);
            }
          }}
        >
          <title>Add report</title>
          <circle cx={right - 40} cy={y + 17} r={10.5} fill="#EEF3FF" stroke="#DBE7FF" />
          <path
            d={`M${right - 40} ${y + 12.5} v9 M${right - 44.5} ${y + 17} h9`}
            stroke="#2563EB"
            strokeWidth={1.7}
            strokeLinecap="round"
          />
        </g>
      )}

      {onEditPerson === undefined ? null : (
        <g
          className="uboss-org-action uboss-org-action--edit"
          role="button"
          tabIndex={0}
          aria-label={`Edit ${node.name}`}
          style={{ cursor: 'pointer' }}
          onClick={(event) => {
            event.stopPropagation();
            onEditPerson(node.id);
          }}
          onKeyDown={(event) => {
            if (event.key === 'Enter' || event.key === ' ') {
              event.preventDefault();
              event.stopPropagation();
              onEditPerson(node.id);
            }
          }}
        >
          <title>Edit</title>
          <circle cx={right - 15} cy={y + 17} r={10.5} fill="#F1F5FA" stroke="#E2EAF4" />
          <path
            d={`M${right - 19} ${y + 21} l5.5 -5.5 2 2 -5.5 5.5 -2.6 .6 z`}
            fill="none"
            stroke="#54637A"
            strokeWidth={1.3}
            strokeLinejoin="round"
          />
        </g>
      )}
    </g>
  );
}
