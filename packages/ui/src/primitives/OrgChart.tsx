import { useId } from 'react';

import { cn } from '../lib/class-names';

/** One node of the chart. Recursive, and the three kinds render differently. */
export interface OrgChartNode {
  kind: 'company' | 'department' | 'person';
  id: string;
  name: string;
  /** Second line: "Company · 5 departments", "Department · 12 people", or a designation. */
  subtitle: string;
  /**
   * A person's photo, as a URL an `<image>` can load. Only meaningful on `kind: 'person'`.
   *
   * Absent means no photo, which is the normal case rather than an error — most people will not
   * have uploaded one, so the avatar falls back to a silhouette and the card looks deliberate.
   * The caller decides what counts as available: the product's photo service can also answer
   * "stored, but the malware scan has not cleared it", and that has to render as no photo.
   */
  photoUrl?: string;
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
  /**
   * The `+` action on a department node: add somebody to that department.
   *
   * The same Add Employee flow the toolbar offers, with the department already chosen — which is
   * the whole point of it being here rather than only up there.
   */
  onAddToDepartment?: (id: string) => void;
  /**
   * The pencil action on a department node. Omit to hide it.
   *
   * Separate from `onEditPerson` because it is a different form and a different record: a
   * department has a name, a code, a parent and a head, and none of those are fields on a person.
   */
  onEditDepartment?: (id: string) => void;
  /** Shown instead of the chart when a company has departments but nobody recorded. */
  emptyMessage?: string;
  className?: string;
}

/**
 * Box geometry.
 *
 * Wider and taller than the reference's 214x64. That box put a 36px avatar, a name and a
 * designation into 64px of height with 8px of air, and cut every name to 18 characters, so
 * "Customer Operations" arrived as "Customer Operatio…". The extra room is what lets the type
 * breathe and the names finish.
 */
const BOX_WIDTH = 320;
const BOX_HEIGHT = 84;
const GAP_X = 26;
const GAP_Y = 54;
const PAD_X = 30;
const PAD_Y = 28;

/**
 * The coloured band down the left of every card, and where the text starts after it.
 *
 * This replaces a floating 36px square sitting on the card. A band that reaches both edges makes
 * the colour structural rather than decorative — it is the one thing that tells you which
 * department a person belongs to, so it reads better as part of the card's shape than as a chip
 * placed on it. It is also the arrangement in the chart the client sent as the look to aim for.
 */
const RAIL = 58;
const TEXT_X = RAIL + 16;

/**
 * A person's card is built differently from a department's, because a person has a face.
 *
 * The department keeps the wide colour band with its initials in it. A person gets a narrow stripe
 * of the same colour — so the grouping still reads down a column — and then a round avatar on the
 * panel, which is where the photo goes. That is the arrangement the client asked for, and it is
 * also the only one that can hold a photograph without cropping it into a corner.
 */
const STRIPE = 8;
const AVATAR_R = 21;
const AVATAR_CX = STRIPE + 14 + AVATAR_R;
const PERSON_TEXT_X = STRIPE + 14 + AVATAR_R * 2 + 14;

/**
 * Space kept clear at the top right for the actions, on cards that have them.
 *
 * The first arrangement drew the actions over the name and put a panel in the card's colour behind
 * them so they would be legible. It worked, and it looked like the name had been cut off: hovering
 * "Customer Operations" showed "Customer Oper." with a disc over the rest. Covering text is not
 * made acceptable by covering it neatly.
 *
 * So the name gives up the width instead, and only on cards that actually have actions. Nothing is
 * ever hidden, at rest or on hover, and the subtitle keeps the full width because the actions sit
 * above it rather than beside it.
 */
const ACTION_LANE = 76;

/**
 * The department palette, from the reference's `DEPT_COL`.
 *
 * Names the client's own five departments and falls back to the product blue for anything else,
 * so a company with different departments gets a coherent chart rather than a missing colour.
 *
 * Every entry is a literal colour. Executive used to be `var(--uboss-text)`, which made one band
 * near-black in Light and near-white in Dark while the other four stayed put, and made the
 * initials on it impossible to choose without a browser. See `inkOn`. The literal is the value
 * that token had in the theme the reference was drawn in.
 */
const DEPARTMENT_COLOURS: Record<string, string> = {
  Executive: '#111827',
  'Regulatory Affairs': '#2E86C7',
  'Exports & Tenders': '#E8833A',
  'Quality Assurance': '#4B9C2E',
  Production: '#7A5AF8',
};

const FALLBACK_COLOUR = '#2563EB';

/**
 * Text drawn on a surface that does not follow the theme.
 *
 * The company card is navy in both themes and a department's colour is its identity, so text on
 * either one must not change with the theme. It did: both used `var(--uboss-surface)`, which is
 * #fff in Light and #171821 in Dark, and the company name on the dark navy measured **1.12:1**.
 * The client reported that the company name could not be seen in dark mode, and it could not.
 */
const INK_LIGHT = '#f8fafc';
const INK_DARK = '#0b1220';
/** Under the name on the navy card. Measured at 8.9:1 on the lighter navy of the two. */
const INK_LIGHT_MUTED = '#b9c0d4';

/** Relative luminance of a `#rrggbb` literal, for deciding what can be read on it. */
function luminance(hex: string): number {
  const value = hex.replace('#', '');
  const channel = (offset: number): number => {
    const part = Number.parseInt(value.slice(offset, offset + 2), 16) / 255;
    return part <= 0.04045 ? part / 12.92 : ((part + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * channel(0) + 0.7152 * channel(2) + 0.0722 * channel(4);
}

/**
 * Light or dark ink on a fixed background, whichever can actually be read on it.
 *
 * One fixed choice cannot work. The palette runs from #4B9C2E and #E8833A, which need dark ink, to
 * #111827 and #2563EB, which need light. Measured against the real palette, white on the green was
 * 3.45:1 and on the orange 2.71:1, while dark ink on the blues was 3.23:1 — every one a failure,
 * and they failed in *different themes*, which is why swapping the single colour over would have
 * moved the problem rather than fixed it.
 *
 * The rule is a comparison rather than a threshold: whichever ink is further from the background.
 * That stays correct for any colour a department might be given later, including the hashed ones
 * nobody has chosen yet.
 */
function inkOn(background: string): string {
  const contrast = (ink: string): number => {
    const a = luminance(ink);
    const b = luminance(background);
    return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
  };
  return contrast(INK_LIGHT) >= contrast(INK_DARK) ? INK_LIGHT : INK_DARK;
}

/**
 * The same colour, deepened until its own initials can be read on it.
 *
 * One entry in the palette could not carry a label at all. Against #7A5AF8 the better of the two
 * inks reaches 4.32:1, and the worse is no help — no choice of ink clears 4.5:1 on a mid-tone that
 * sits halfway between them. Every other colour in the palette clears it: 4.77 to 16.96:1.
 *
 * Deepening is the fix rather than picking a replacement by hand, for two reasons. The hue is what
 * carries the meaning — a department is "the violet one" — and scaling the channels keeps that
 * while moving the tone far enough for white to work. And a hand-picked value would fix the one
 * colour somebody noticed, while the hashed palette can hand a future department any colour at
 * all; this holds for those too.
 *
 * Convergence is not in doubt: each step is a fixed 6% darker and black takes white ink at 21:1.
 * The cap is there so a bug cannot turn into a hang.
 */
function readable(colour: string): string {
  const best = (candidate: string): number => {
    const contrast = (ink: string): number => {
      const a = luminance(ink);
      const b = luminance(candidate);
      return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
    };
    return Math.max(contrast(INK_LIGHT), contrast(INK_DARK));
  };

  let current = colour;
  for (let step = 0; step < 24 && best(current) < 4.5; step += 1) {
    const value = current.replace('#', '');
    const channel = (offset: number): string =>
      Math.round(Number.parseInt(value.slice(offset, offset + 2), 16) * 0.94)
        .toString(16)
        .padStart(2, '0');
    current = `#${channel(0)}${channel(2)}${channel(4)}`;
  }
  return current;
}

/**
 * A stable colour for any department name.
 *
 * The five named ones keep the reference's exact colours. Anything else is hashed into a fixed
 * palette, so the same department is always the same colour — a chart whose colours moved between
 * page loads would make the grouping useless.
 *
 * These stay outside the violet system on purpose. They are categorical data colours — their job
 * is to be told apart from each other, which a single hue cannot do — whereas the chart's own
 * chrome (the mark, the add-person glyph) belongs to the product and follows the tokens.
 */
function departmentColour(name: string): string {
  const named = DEPARTMENT_COLOURS[name];
  if (named !== undefined) {
    return readable(named);
  }

  const palette = ['#2563EB', '#0EA5E9', '#7A5AF8', '#E8833A', '#4B9C2E', '#C2410C', '#0F766E'];
  let hash = 0;
  for (let index = 0; index < name.length; index += 1) {
    hash = (hash * 31 + name.charCodeAt(index)) % 100_000;
  }
  return readable(palette[hash % palette.length] ?? FALLBACK_COLOUR);
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

/**
 * How many characters of a name fit, given whether this card keeps a lane clear for actions.
 *
 * Characters rather than pixels, because SVG text has no width until a browser has laid it out and
 * this runs before that. The divisor is therefore an estimate, and the first one was wrong in the
 * direction that matters: at 7.2 the limit came out at 19 characters, "Customer Operations" is
 * exactly 19, and it renders 148.5px into 138px of room — so the plus sign landed on its last
 * letter. Measured in a browser, that string averages 7.8px per character at 13.5px and 700, and
 * 7.9 is that with a margin.
 *
 * The card is 320 wide rather than 288 for the same reason. At 288 a correct divisor would have
 * truncated "Customer Operations" to fit, which is a worse answer than giving it the room.
 *
 * `org-widths.mjs` measures every name against the space its card leaves it, so the estimate is
 * checked against a real layout rather than trusted.
 */
function nameLimit(hasActions: boolean, textX: number = TEXT_X): number {
  const available = BOX_WIDTH - textX - (hasActions ? ACTION_LANE : 16);
  return Math.floor(available / 7.9);
}

/**
 * A rectangle whose left and right corners can round independently.
 *
 * The card is a coloured band butted against an information panel, and the panel's left edge has
 * to be square where it meets the band while its right edge follows the card's corner. Two plain
 * rects cannot do that and a clip path per node would be fifteen clip paths, so the panel is a
 * path.
 */
function panelPath(
  x: number,
  y: number,
  width: number,
  height: number,
  leftRadius: number,
  rightRadius: number,
): string {
  const l = leftRadius;
  const r = rightRadius;
  return [
    `M${x + l} ${y}`,
    `H${x + width - r}`,
    r === 0 ? '' : `A${r} ${r} 0 0 1 ${x + width} ${y + r}`,
    `V${y + height - r}`,
    r === 0 ? '' : `A${r} ${r} 0 0 1 ${x + width - r} ${y + height}`,
    `H${x + l}`,
    l === 0 ? '' : `A${l} ${l} 0 0 1 ${x} ${y + height - l}`,
    `V${y + l}`,
    l === 0 ? '' : `A${l} ${l} 0 0 1 ${x + l} ${y}`,
    'Z',
  ]
    .filter(Boolean)
    .join(' ');
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
 * The Organization Hierarchy tree.
 *
 * ## Why an SVG rather than nested elements
 *
 * The chart draws **elbow connectors** between a node and each of its children. CSS cannot draw a
 * line from one box to another, so a div-based tree either loses the connectors or fakes them with
 * borders that break the moment a branch has an odd number of children. The client's reference
 * switched to SVG for this reason (`orgSVG` replaced an earlier `.tree` markup, both of which are
 * still in that file), and this follows the version that ships.
 *
 * ## Accessibility, which an SVG chart has to earn
 *
 * The chart carries `role="tree"` with a label, every person node is focusable and activates on
 * Enter or Space, and each node's text is real `<text>` rather than a path — so a screen reader
 * reads names and designations, and a browser's find-in-page finds them. The chart is a
 * *secondary* representation regardless: the List View shows the same people as a real table, and
 * the client made it a first-class view rather than a fallback.
 *
 * ## Node actions, and why hiding them is safe
 *
 * A department node carries `+` (add somebody to it) and a pencil (edit it); a person node carries
 * `+` (add a direct report) and a pencil. Each is omitted entirely when the caller passes no
 * handler, rather than rendered disabled: a control that cannot act should not be on the screen.
 * There is deliberately **no invite action** on a node — the client's rule is that the invitation
 * source is Settings and Users & Access.
 *
 * They are revealed on hover, which the client asked for and which also lets a name use the
 * card's full width. Two rules in the stylesheet are what make that safe rather than merely
 * tidier: they appear on `:focus-within` as well as `:hover`, so a keyboard can still reach them,
 * and they take no pointer while hidden, because a transparent button that still accepts a click
 * is worse than a visible one.
 */
export function OrgChart({
  root,
  onSelectPerson,
  onAddReport,
  onEditPerson,
  onAddToDepartment,
  onEditDepartment,
  emptyMessage,
  className,
}: OrgChartProps) {
  /*
   * Clip paths are referenced by id, and an id is global to the document. Two charts on one page —
   * the design-system screen renders several — would otherwise give every avatar the same id and
   * every photo would be clipped by the first chart's geometry.
   */
  const idPrefix = useId().replace(/[^a-zA-Z0-9-]/g, '');

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
            <stop offset="0" stopColor="var(--uboss-ai-bright)" />
            <stop offset="1" stopColor="var(--uboss-blue)" />
          </linearGradient>

          {/*
            One shadow, shared by every card. It is what stops the cards reading as rectangles on
            the same plane as the connectors, which is the flatness the client called basic.
            Defined once rather than per node: fifteen identical filter regions would be fifteen
            offscreen buffers for one effect.
          */}
          <filter id="uboss-org-shadow" x="-12%" y="-25%" width="124%" height="170%">
            <feDropShadow
              dx="0"
              dy="2"
              stdDeviation="3.5"
              floodColor="#0b1220"
              floodOpacity="0.20"
            />
          </filter>
        </defs>

        {paths.map((path) => (
          <path key={path} d={path} fill="none" stroke="var(--uboss-border)" strokeWidth={1.6} />
        ))}

        {nodes.map((node) => (
          <OrgNode
            key={`${node.kind}-${node.id}`}
            node={node}
            idPrefix={idPrefix}
            {...(onSelectPerson === undefined ? {} : { onSelectPerson })}
            {...(onAddReport === undefined ? {} : { onAddReport })}
            {...(onEditPerson === undefined ? {} : { onEditPerson })}
            {...(onAddToDepartment === undefined ? {} : { onAddToDepartment })}
            {...(onEditDepartment === undefined ? {} : { onEditDepartment })}
          />
        ))}
      </svg>
    </div>
  );
}

/**
 * The card: a coloured band, an information panel, one shared shadow and one border on top.
 *
 * Drawn in that order for a reason. The band is the full rounded rectangle, so it supplies the
 * card's silhouette and its shadow; the panel covers all but the band's width, square on the left
 * where the two meet and rounded on the right where it is the card's own corner; and the border is
 * last, as an outline over both, so it is one unbroken line around the card rather than two
 * rectangles' worth of edges meeting in the middle.
 */
function Card({
  x,
  y,
  band,
  panel,
  stroke,
  bandWidth = RAIL,
}: {
  x: number;
  y: number;
  band: string;
  panel: string;
  stroke: string;
  /** Wide for a department, a stripe for a person. */
  bandWidth?: number;
}) {
  return (
    <>
      <rect
        className="uboss-org-card"
        x={x}
        y={y}
        width={BOX_WIDTH}
        height={BOX_HEIGHT}
        rx={16}
        fill={band}
        filter="url(#uboss-org-shadow)"
      />
      <path d={panelPath(x + bandWidth, y, BOX_WIDTH - bandWidth, BOX_HEIGHT, 0, 16)} fill={panel} />
      <rect
        className="uboss-org-edge"
        x={x + 0.5}
        y={y + 0.5}
        width={BOX_WIDTH - 1}
        height={BOX_HEIGHT - 1}
        rx={15.5}
        fill="none"
        stroke={stroke}
        pointerEvents="none"
      />
    </>
  );
}

/** The initials in the coloured band, whose ink comes from the band's own colour. */
function BandLabel({
  x,
  y,
  colour,
  label,
  fontSize,
}: {
  x: number;
  y: number;
  colour: string;
  label: string;
  fontSize: number;
}) {
  return (
    <text
      x={x + RAIL / 2}
      y={y + BOX_HEIGHT / 2 + fontSize * 0.36}
      fill={inkOn(colour)}
      fontSize={fontSize}
      fontWeight={800}
      textAnchor="middle"
      letterSpacing="0.5"
    >
      {label}
    </text>
  );
}

const ACTION_R = 12;
const ACTION_GAP = 30;
const ACTION_RIGHT_INSET = 26;
/** Vertically in the top half, clear of the subtitle so that line keeps the card's full width. */
const ACTION_CY = 26;

/** Where a slot sits, counting right to left, so slot 0 is the rightmost. */
function actionCx(x: number, slot: number): number {
  return x + BOX_WIDTH - ACTION_RIGHT_INSET - slot * ACTION_GAP;
}

/**
 * The hover-only cluster.
 *
 * No backdrop behind it any more: the card reserves ACTION_LANE for these, so there is nothing
 * underneath them to hide.
 */
function NodeActions({ children }: { children: React.ReactNode }) {
  return <g className="uboss-org-actions">{children}</g>;
}

function ActionButton({
  x,
  y,
  slot,
  kind,
  label,
  onActivate,
}: {
  x: number;
  y: number;
  slot: number;
  kind: 'add' | 'edit';
  label: string;
  onActivate: () => void;
}) {
  const cx = actionCx(x, slot);
  const cy = y + ACTION_CY;

  return (
    <g
      className={`uboss-org-action uboss-org-action--${kind}`}
      role="button"
      tabIndex={0}
      aria-label={label}
      style={{ cursor: 'pointer' }}
      onClick={(event) => {
        event.stopPropagation();
        onActivate();
      }}
      onKeyDown={(event) => {
        if (event.key === 'Enter' || event.key === ' ') {
          event.preventDefault();
          event.stopPropagation();
          onActivate();
        }
      }}
    >
      <title>{kind === 'add' ? 'Add' : 'Edit'}</title>
      <circle
        cx={cx}
        cy={cy}
        r={ACTION_R}
        fill={kind === 'add' ? 'var(--uboss-blue-050)' : 'var(--uboss-bg-2)'}
        stroke={kind === 'add' ? 'var(--uboss-blue-100)' : 'var(--uboss-border)'}
      />
      {kind === 'add' ? (
        <path
          d={`M${cx} ${cy - 5} v10 M${cx - 5} ${cy} h10`}
          stroke="var(--uboss-blue)"
          strokeWidth={1.8}
          strokeLinecap="round"
        />
      ) : (
        <path
          d={`M${cx - 4.6} ${cy + 4.6} l6.2 -6.2 2.3 2.3 -6.2 6.2 -3 .7 z`}
          fill="none"
          stroke="var(--uboss-text-2)"
          strokeWidth={1.4}
          strokeLinejoin="round"
        />
      )}
    </g>
  );
}

/**
 * A person's avatar: their photograph, or a silhouette when there is none.
 *
 * ## Why the silhouette sits under the photo rather than instead of it
 *
 * Both are drawn, always, with the image on top. If the photo 404s, is still being scanned, or is
 * blocked by the browser, the `<image>` simply paints nothing and the silhouette is already there
 * — no error state, no flash of a broken-image glyph, and nothing for this component to detect.
 * That last part matters: an `onError` handler here would have to re-render, and a chart of forty
 * nodes re-rendering on every failed avatar is a worse problem than the one it solves.
 *
 * The disc is the department's colour and the silhouette is whatever can be read on it, so a
 * person with no photo still shows which department they belong to.
 */
function PersonAvatar({
  x,
  y,
  colour,
  clipId,
  photoUrl,
  name,
}: {
  x: number;
  y: number;
  colour: string;
  clipId: string;
  photoUrl: string | undefined;
  name: string;
}) {
  const cx = x + AVATAR_CX;
  const cy = y + BOX_HEIGHT / 2;
  const ink = inkOn(colour);

  return (
    <>
      <clipPath id={clipId}>
        <circle cx={cx} cy={cy} r={AVATAR_R} />
      </clipPath>

      <circle cx={cx} cy={cy} r={AVATAR_R} fill={colour} />

      {/* Head and shoulders, both clipped to the disc, which is what gives the shoulders their
          flat bottom edge instead of a second circle poking out below. */}
      <g clipPath={`url(#${clipId})`}>
        <circle cx={cx} cy={cy - 4.5} r={7.2} fill={ink} />
        <circle cx={cx} cy={cy + 17} r={12.5} fill={ink} />
      </g>

      {photoUrl === undefined ? null : (
        <image
          href={photoUrl}
          x={cx - AVATAR_R}
          y={cy - AVATAR_R}
          width={AVATAR_R * 2}
          height={AVATAR_R * 2}
          /* Fill the disc and crop, rather than squashing a portrait into a square. */
          preserveAspectRatio="xMidYMid slice"
          clipPath={`url(#${clipId})`}
          /* The group already announces the person's name, so this must not repeat it. */
          aria-hidden="true"
        >
          <title>{name}</title>
        </image>
      )}

      {/* A hairline ring, so a light photo does not bleed into a light panel. */}
      <circle
        cx={cx}
        cy={cy}
        r={AVATAR_R}
        fill="none"
        stroke="rgba(15, 23, 42, 0.18)"
        strokeWidth={1}
        pointerEvents="none"
      />
    </>
  );
}

function OrgNode({
  node,
  idPrefix,
  onSelectPerson,
  onAddReport,
  onEditPerson,
  onAddToDepartment,
  onEditDepartment,
}: {
  node: Placed;
  idPrefix: string;
  onSelectPerson?: (id: string) => void;
  onAddReport?: (id: string) => void;
  onEditPerson?: (id: string) => void;
  onAddToDepartment?: (id: string) => void;
  onEditDepartment?: (id: string) => void;
}) {
  const x = node.x - BOX_WIDTH / 2;
  const y = node.y - BOX_HEIGHT / 2;

  if (node.kind === 'company') {
    return (
      <g className="uboss-org-node uboss-org-node--company" role="treeitem" aria-label={`${node.name}. ${node.subtitle}`}>
        <Card
          x={x}
          y={y}
          band="url(#uboss-org-logo)"
          panel="var(--uboss-navy)"
          stroke="var(--uboss-ai-bright)"
        />
        <text
          x={x + RAIL / 2}
          y={y + BOX_HEIGHT / 2 + 8}
          fill={INK_LIGHT}
          fontSize={21}
          fontWeight={800}
          textAnchor="middle"
        >
          U
        </text>
        {/* Fixed inks: this card is navy in both themes, so its text cannot follow the theme. */}
        <text x={x + TEXT_X} y={y + 37} fill={INK_LIGHT} fontSize={15} fontWeight={800}>
          {/* The company card has no actions, so it keeps the whole width. */}
          {truncate(node.name, nameLimit(false))}
        </text>
        <text x={x + TEXT_X} y={y + 57} fill={INK_LIGHT_MUTED} fontSize={11.5}>
          {truncate(node.subtitle, 34)}
        </text>
      </g>
    );
  }

  if (node.kind === 'department') {
    const colour = departmentColour(node.name);
    const actions = [
      onAddToDepartment === undefined
        ? null
        : {
            kind: 'add' as const,
            label: `Add somebody to ${node.name}`,
            onActivate: () => onAddToDepartment(node.id),
          },
      onEditDepartment === undefined
        ? null
        : {
            kind: 'edit' as const,
            label: `Edit the ${node.name} department`,
            onActivate: () => onEditDepartment(node.id),
          },
    ].filter((entry) => entry !== null);

    return (
      <g
        className={cn('uboss-org-node', actions.length > 0 && 'uboss-org-node--acts')}
        role="treeitem"
        aria-label={`${node.name}. ${node.subtitle}`}
      >
        <Card
          x={x}
          y={y}
          band={colour}
          panel="var(--uboss-bg-2)"
          stroke="var(--uboss-border)"
        />
        <BandLabel x={x} y={y} colour={colour} label={departmentInitials(node.name)} fontSize={16} />
        <text x={x + TEXT_X} y={y + 37} fill="var(--uboss-text)" fontSize={14} fontWeight={750}>
          {truncate(node.name, nameLimit(actions.length > 0))}
        </text>
        <text x={x + TEXT_X} y={y + 57} fill="var(--uboss-text-2)" fontSize={11.5}>
          {truncate(node.subtitle, 34)}
        </text>

        {actions.length === 0 ? null : (
          <NodeActions>
            {actions.map((action, index) => (
              <ActionButton
                key={action.kind}
                x={x}
                y={y}
                slot={actions.length - 1 - index}
                kind={action.kind}
                label={action.label}
                onActivate={action.onActivate}
              />
            ))}
          </NodeActions>
        )}
      </g>
    );
  }

  const colour = departmentColour(node.departmentName);
  const selectable = onSelectPerson !== undefined;
  const actions = [
    onAddReport === undefined
      ? null
      : {
          kind: 'add' as const,
          label: `Add a direct report to ${node.name}`,
          onActivate: () => onAddReport(node.id),
        },
    onEditPerson === undefined
      ? null
      : { kind: 'edit' as const, label: `Edit ${node.name}`, onActivate: () => onEditPerson(node.id) },
  ].filter((entry) => entry !== null);

  return (
    <g
      className={cn('uboss-org-node', actions.length > 0 && 'uboss-org-node--acts')}
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
      <Card
        x={x}
        y={y}
        band={colour}
        panel="var(--uboss-surface)"
        stroke="var(--uboss-border)"
        bandWidth={STRIPE}
      />
      <PersonAvatar
        x={x}
        y={y}
        colour={colour}
        clipId={`${idPrefix}-avatar-${node.id}`}
        photoUrl={node.photoUrl}
        name={node.name}
      />
      <text x={x + PERSON_TEXT_X} y={y + 37} fill="var(--uboss-text)" fontSize={13.5} fontWeight={700}>
        {truncate(node.name, nameLimit(actions.length > 0, PERSON_TEXT_X))}
      </text>
      <text x={x + PERSON_TEXT_X} y={y + 57} fill="var(--uboss-text-2)" fontSize={11}>
        {truncate(node.subtitle, 34)}
      </text>

      {actions.length === 0 ? null : (
        <NodeActions>
          {actions.map((action, index) => (
            <ActionButton
              key={action.kind}
              x={x}
              y={y}
              slot={actions.length - 1 - index}
              kind={action.kind}
              label={action.label}
              onActivate={action.onActivate}
            />
          ))}
        </NodeActions>
      )}
    </g>
  );
}
