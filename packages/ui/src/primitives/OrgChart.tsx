import { useCallback, useEffect, useId, useMemo, useRef, useState } from 'react';

import { cn } from '../lib/class-names';
import { Icon } from './Icon';
import { exportChartAsPng } from './org-chart-export';

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
  /**
   * The archive action on a department node. Omit to hide it.
   *
   * Archive, not delete — the product has no delete for a department, so that nothing in the
   * history points at a name that no longer exists. The caller is expected to say so, and to
   * collect the reason the server requires.
   */
  onArchiveDepartment?: (id: string) => void;
  /**
   * A hint drawn **under** the chart when nobody is recorded yet.
   *
   * Under, not instead of: the company card is what tells a new administrator the workspace is
   * theirs, and replacing it with a sentence made their first screen look empty.
   */
  emptyMessage?: string;
  /**
   * Put the chart in a frame with zoom, pan, fit and full screen.
   *
   * Off by default, and deliberately. A chart rendered inline in a document — the design-system
   * page shows several — wants to be the size it is and to sit in the flow. A chart that is the
   * screen wants a frame. The difference is the caller's to state, because only the caller knows
   * which of the two it is asking for.
   */
  controls?: boolean;
  className?: string;
}

/**
 * The range stepping stays inside.
 *
 * Below 40% a name is a grey smear and the chart answers nothing a screenshot would not; above
 * 200% a card is bigger than it was designed to be read at and the frame shows two of them. So
 * pressing minus never takes somebody somewhere they cannot read.
 */
const MIN_ZOOM = 0.4;
const MAX_ZOOM = 2;
const ZOOM_STEP = 0.2;

/**
 * How far Fit may go, which is further.
 *
 * A real company is wide: eleven people across five departments is already 5,700px, and fitting
 * that into a 1,270px frame needs 22%. Holding Fit to the readable floor would give a button
 * labelled "Fit the whole chart" that does not — it would stop at 40% and leave two thirds of the
 * company off screen, which is worse than not offering it.
 *
 * So Fit is allowed below the floor, because somebody who presses it has asked for the shape of
 * the company rather than for the names. Minus is disabled once it is there; plus climbs back into
 * the readable range in one press.
 */
const FIT_MIN_ZOOM = 0.08;

const clampZoom = (value: number) => Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, value));

/**
 * Box geometry.
 *
 * Wider and taller than the reference's 214x64. That box put a 36px avatar, a name and a
 * designation into 64px of height with 8px of air, and cut every name to 18 characters, so
 * "Customer Operations" arrived as "Customer Operatio…". The extra room is what lets the type
 * breathe and the names finish.
 */
const BOX_WIDTH = 352;
const BOX_HEIGHT = 84;
const GAP_X = 26;
const GAP_Y = 54;
const PAD_X = 30;
const PAD_Y = 28;

/**
 * When a row of people stops being a row and becomes a block.
 *
 * Giving every leaf its own column is correct for a diagram of eleven people and absurd for a real
 * one. A factory floor has one supervisor with forty-nine reports: laid out side by side that is
 * 18,000px of chart for one manager, the company's own hierarchy fitted at eight percent, and the
 * names were grey smears. The shape of the company was not visible in a picture *of* the company.
 *
 * So a parent whose reports are more than three hangs them instead: a spine drops from the card
 * and they stack down it. Three or fewer still spread across, because a row of two or three reads
 * as a tree and a column of two reads as a queue.
 *
 * Past a point a single column is no better — forty-nine of them is 4,800px of height, which only
 * trades one unreadable direction for another. So the block wraps into columns, enough of them to
 * keep it roughly as wide as it is tall. The cards stay their full size at every count; it is the
 * arrangement that changes, never the card.
 */
const HANG_MIN = 4;
const HANG_GAP_Y = 16;
/** How far the cards sit from their column's spine, and so how wide the spine's channel is. */
const HANG_INDENT = 34;

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
function actionLane(count: number): number {
  // The rightmost circle is inset 26, each further one is 30 to its left, and 12 for the radius
  // plus 8 of air before the text starts. A third action is always the destructive one, which
  // stands off by ACTION_SEPARATION, so the lane has to grow by the same amount or the name
  // reaches under it.
  return count === 0 ? 16 : 46 + (count - 1) * 30 + (count >= 3 ? ACTION_SEPARATION : 0);
}

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
export function departmentColour(name: string): string {
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
/**
 * How much of the department's colour the band carries.
 *
 * The band used to be the colour itself: 58 by 84 of full-strength orange or green, which is a
 * sixth of the card spent on two letters. It was the loudest thing on the screen in Light and it
 * glowed in Dark, where a saturated slab against a near-black card is brighter than any of the
 * content. A tint says the same thing — this card belongs to that department — at a fraction of
 * the weight, which is what the client asked for and what every current org chart does.
 *
 * It is drawn as the colour at this opacity over the card's own surface rather than as a
 * pre-mixed colour, so the composite follows the theme without the component having to know which
 * theme it is in. That is the whole reason it is an opacity and not a lighter hex.
 */
const BAND_TINT = 0.16;

/**
 * The initials' ink, for each theme, given the department's colour.
 *
 * The band is a tint and therefore nearly the page behind it, so the initials cannot be white or
 * near-black — they have to be the department's own colour, at whatever lightness clears 4.5:1
 * against that theme's tint. This is the one thing the opacity trick cannot do for itself: SVG
 * has no way to ask what it is sitting on.
 *
 * It returns the band as well as the ink, because the two only mean anything together: the guard
 * has to measure one against the other, and a test that recomputed the composite itself would be
 * measuring its own arithmetic rather than the component's.
 *
 * Exported because it is the guard's only way in. Reading the ink off the rendered attribute used
 * to be enough when it was a hex; now it is a custom property whose value depends on the theme,
 * and a test that read the attribute would be reading the word "var".
 */
export function departmentSkin(colour: string): {
  light: { band: string; ink: string };
  dark: { band: string; ink: string };
} {
  const step = (hex: string, towards: number): string => {
    const value = hex.replace('#', '');
    const channel = (offset: number): string => {
      const current = Number.parseInt(value.slice(offset, offset + 2), 16);
      return Math.round(current + (towards - current) * 0.12)
        .toString(16)
        .padStart(2, '0');
    };
    return `#${channel(0)}${channel(2)}${channel(4)}`;
  };

  const contrast = (a: string, b: string): number => {
    const x = luminance(a);
    const y = luminance(b);
    return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05);
  };

  /** The tint as it composites over a surface, which is what the ink actually sits on. */
  const over = (surface: string): string => {
    const s = surface.replace('#', '');
    const c = colour.replace('#', '');
    const channel = (offset: number): string =>
      Math.round(
        Number.parseInt(c.slice(offset, offset + 2), 16) * BAND_TINT +
          Number.parseInt(s.slice(offset, offset + 2), 16) * (1 - BAND_TINT),
      )
        .toString(16)
        .padStart(2, '0');
    return `#${channel(0)}${channel(2)}${channel(4)}`;
  };

  /* Walk the colour toward black on a light tint and toward white on a dark one, 12% at a time,
     and stop the moment it is legible. Capped, because a colour that cannot get there in this
     many steps has hit the end of the range and one more step will not save it. */
  const pair = (surface: string, towards: number): { band: string; ink: string } => {
    const band = over(surface);
    let current = colour;
    for (let i = 0; i < 20 && contrast(current, band) < 4.5; i += 1) {
      current = step(current, towards);
    }
    return { band, ink: current };
  };

  // The two surfaces a card is drawn on, as `--uboss-surface` resolves in each theme.
  return { light: pair('#ffffff', 0), dark: pair('#171821', 255) };
}

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
function nameLimit(actionCount: number, textX: number = TEXT_X): number {
  const available = BOX_WIDTH - textX - actionLane(actionCount);
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

/** Everybody below a node, at any depth. What its toggle offers to show or to put away. */
function countUnder(node: OrgChartNode): number {
  return node.children.reduce((total, child) => total + 1 + countUnder(child), 0);
}

/**
 * How big a company has to be before it arrives folded.
 *
 * A chart of eleven people is the whole picture and should simply be drawn. A chart of a hundred
 * and fifteen cannot be: laid out in full it is 13,500px across, which the frame fits at eight
 * percent, and eight percent of a name is a smudge. Opening at the departments and letting
 * somebody ask for the one they want is not hiding the company — the count is on every card, and
 * one press opens it.
 *
 * The threshold is about the number of cards rather than about pixels on purpose. A rule that
 * reads the frame would fold and unfold as a window is dragged, and a chart that rearranges itself
 * while you look at it is worse than one that is too small.
 */
const FOLD_OVER = 40;

/**
 * What is folded before anybody has touched anything.
 *
 * Everything under the first level, so a large company opens as itself and its departments. Only
 * the topmost folded node of a branch is recorded; what is under it is not rendered, so it has no
 * state worth keeping and would only have to be cleaned up when its parent opens.
 */
function foldedByDefault(root: OrgChartNode): ReadonlySet<string> {
  if (countUnder(root) <= FOLD_OVER) return new Set();

  const folded = new Set<string>();
  const walk = (node: OrgChartNode, depth: number) => {
    if (depth >= 1 && node.children.length > 0) {
      folded.add(node.id);
      return;
    }
    node.children.forEach((child) => walk(child, depth + 1));
  };

  walk(root, 0);
  return folded;
}

/**
 * The tree as it is to be drawn: a folded node keeps its card and loses its children.
 *
 * Which also makes it a leaf, so it joins the hanging block beside its siblings rather than
 * standing in a column of its own. Seventeen folded departments become a block three across
 * instead of a row seventeen wide, without the layout knowing anything about folding.
 */
function pruned(node: OrgChartNode, folded: ReadonlySet<string>): OrgChartNode {
  if (node.children.length === 0) return node;
  if (folded.has(node.id)) return { ...node, children: [] };
  return { ...node, children: node.children.map((child) => pruned(child, folded)) };
}

interface Placed extends OrgChartNode {
  x: number;
  y: number;
  depth: number;
  /** The nearest department ancestor's name, for the node colour. */
  departmentName: string;
  children: Placed[];
  /**
   * Set only on a card in a hanging block: where its column's spine stands, and the height the
   * rail runs at. A card centred under its parent in the ordinary way does not carry it, which is
   * how the connectors tell the two shapes apart.
   */
  hung?: { spineX: number; railY: number };
}

interface Size {
  width: number;
  height: number;
}

/**
 * How many columns a hanging block of `count` cards wraps into.
 *
 * Square-ish in cards rather than in pixels, which lands the block at roughly two-to-one on screen
 * — a card is far wider than it is tall, so a block that is square in cards is a landscape block
 * in pixels, and a landscape frame is what it has to fit into. Four reports stay one column, which
 * is the shape somebody asked for; forty-nine become five columns of ten.
 */
function hangColumns(count: number): number {
  return Math.max(1, Math.round(Math.sqrt(count / 2)));
}

function hangSize(count: number): Size {
  const columns = hangColumns(count);
  const rows = Math.ceil(count / columns);
  return {
    width: HANG_INDENT + columns * BOX_WIDTH + (columns - 1) * GAP_X,
    height: rows * BOX_HEIGHT + (rows - 1) * HANG_GAP_Y,
  };
}

/**
 * What sits under a node, as the things that take up room rather than as its children.
 *
 * A parent with enough leaves gets *one* slot for all of them — the hanging block — and one more
 * for each child that has a subtree of its own. Branches keep spreading across, because a branch
 * needs its width for what is underneath it; only the leaves, which need none, are stacked.
 *
 * That split is what makes the two arrangements compose. A manager with eight assistants and three
 * supervisors under them gets a block of eight beside three ordinary subtrees, rather than either
 * eleven columns or one column eleven deep.
 */
type Slot =
  | { kind: 'hang'; leaves: OrgChartNode[]; size: Size }
  | { kind: 'spread'; node: OrgChartNode; size: Size };

function layout(root: OrgChartNode): { placed: Placed; width: number; height: number } {
  // Memoised because `place` asks the same questions `sizeOf` already answered, one level down.
  const sizes = new Map<OrgChartNode, Size>();

  const slotsOf = (node: OrgChartNode): Slot[] => {
    if (node.children.length === 0) return [];

    const leaves = node.children.filter((child) => child.children.length === 0);
    if (leaves.length < HANG_MIN) {
      return node.children.map((child) => ({
        kind: 'spread' as const,
        node: child,
        size: sizeOf(child),
      }));
    }

    return [
      { kind: 'hang' as const, leaves, size: hangSize(leaves.length) },
      ...node.children
        .filter((child) => child.children.length > 0)
        .map((child) => ({ kind: 'spread' as const, node: child, size: sizeOf(child) })),
    ];
  };

  function sizeOf(node: OrgChartNode): Size {
    const known = sizes.get(node);
    if (known) return known;

    const slots = slotsOf(node);
    const size =
      slots.length === 0
        ? { width: BOX_WIDTH, height: BOX_HEIGHT }
        : {
            width: Math.max(
              BOX_WIDTH,
              slots.reduce((total, slot) => total + slot.size.width, 0) +
                GAP_X * (slots.length - 1),
            ),
            height: BOX_HEIGHT + GAP_Y + Math.max(...slots.map((slot) => slot.size.height)),
          };

    sizes.set(node, size);
    return size;
  }

  const place = (
    node: OrgChartNode,
    left: number,
    top: number,
    depth: number,
    departmentName: string,
  ): Placed => {
    const ownDepartment = node.kind === 'department' ? node.name : departmentName;
    const size = sizeOf(node);
    const slots = slotsOf(node);
    const y = top + BOX_HEIGHT / 2;
    // The parent sits over the middle of everything beneath it. With a single hanging column that
    // puts the spine exactly under the parent's left edge, which is the shape this borrows from.
    const x = left + size.width / 2;

    if (slots.length === 0) {
      return { ...node, x, y, depth, departmentName: ownDepartment, children: [] };
    }

    const childTop = top + BOX_HEIGHT + GAP_Y;
    const railY = top + BOX_HEIGHT + GAP_Y / 2;
    const across =
      slots.reduce((total, slot) => total + slot.size.width, 0) + GAP_X * (slots.length - 1);

    let cursor = left + (size.width - across) / 2;
    const children: Placed[] = [];

    for (const slot of slots) {
      if (slot.kind === 'hang') {
        const columns = hangColumns(slot.leaves.length);
        const rows = Math.ceil(slot.leaves.length / columns);

        slot.leaves.forEach((leaf, index) => {
          // Down a column before across to the next, so each column is one unbroken run and the
          // spine beside it belongs to the cards it touches.
          const cardLeft = cursor + HANG_INDENT + Math.floor(index / rows) * (BOX_WIDTH + GAP_X);
          children.push({
            ...leaf,
            x: cardLeft + BOX_WIDTH / 2,
            y: childTop + (index % rows) * (BOX_HEIGHT + HANG_GAP_Y) + BOX_HEIGHT / 2,
            depth: depth + 1,
            departmentName: ownDepartment,
            children: [],
            hung: { spineX: cardLeft - HANG_INDENT / 2, railY },
          });
        });
      } else {
        children.push(place(slot.node, cursor, childTop, depth + 1, ownDepartment));
      }

      cursor += slot.size.width + GAP_X;
    }

    return { ...node, x, y, depth, departmentName: ownDepartment, children };
  };

  const size = sizeOf(root);

  return {
    placed: place(root, PAD_X, PAD_Y, 0, ''),
    width: Math.round(PAD_X * 2 + size.width),
    height: Math.round(PAD_Y * 2 + size.height),
  };
}

/**
 * Elbow connectors: down, across, down — and, for a hanging block, down a shared rail and along a
 * spine. Overlapping segments are drawn twice and look drawn once, which is what lets each card
 * own a whole path rather than the block needing a stitched-together one.
 */
function connectors(node: Placed): string[] {
  const paths: string[] = [];
  const fromY = Math.round(node.y + BOX_HEIGHT / 2);

  for (const child of node.children) {
    if (child.hung) {
      const { spineX, railY } = child.hung;
      paths.push(
        `M${Math.round(node.x)} ${fromY} V${Math.round(railY)} H${Math.round(spineX)} ` +
          `V${Math.round(child.y)} H${Math.round(child.x - BOX_WIDTH / 2)}`,
      );
    } else {
      const toY = Math.round(child.y - BOX_HEIGHT / 2);
      const midY = Math.round((fromY + toY) / 2);
      paths.push(`M${Math.round(node.x)} ${fromY} V${midY} H${Math.round(child.x)} V${toY}`);
    }

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
  onArchiveDepartment,
  emptyMessage,
  controls,
  className,
}: OrgChartProps) {
  /*
   * Clip paths are referenced by id, and an id is global to the document. Two charts on one page —
   * the design-system screen renders several — would otherwise give every avatar the same id and
   * every photo would be clipped by the first chart's geometry.
   */
  const idPrefix = useId().replace(/[^a-zA-Z0-9-]/g, '');

  /*
   * The frame's state.
   *
   * Declared here, above the early return for an empty company, because hooks cannot be called
   * conditionally — and a company with departments and nobody in them is exactly the case that
   * returns early.
   */
  const shell = useRef<HTMLDivElement>(null);
  const frame = useRef<HTMLDivElement>(null);
  const drawing = useRef<SVGSVGElement>(null);
  const [zoom, setZoom] = useState(1);
  const [pan, setPan] = useState({ x: 0, y: 0 });

  /*
   * What is folded, as a default plus what this person has since decided.
   *
   * Two pieces rather than one set, because the data arrives after the first render and arrives
   * again on every change — a single set seeded once would be seeded from an empty company, and a
   * set recomputed from the tree would throw away the department somebody had just opened. The
   * default is derived from whatever tree is current; the overrides are theirs and survive it.
   */
  const defaultsFolded = useMemo(() => foldedByDefault(root), [root]);
  const [chosen, setChosen] = useState<ReadonlyMap<string, boolean>>(() => new Map());

  const folded = useMemo(() => {
    const set = new Set(defaultsFolded);
    for (const [id, isFolded] of chosen) {
      if (isFolded) set.add(id);
      else set.delete(id);
    }
    return set as ReadonlySet<string>;
  }, [defaultsFolded, chosen]);

  /** Everybody under each node that has anybody, from the tree as given rather than as drawn. */
  const under = useMemo(() => {
    const counts = new Map<string, number>();
    const walk = (node: OrgChartNode) => {
      if (node.children.length > 0) counts.set(node.id, countUnder(node));
      node.children.forEach(walk);
    };
    walk(root);
    return counts;
  }, [root]);

  const toggleFold = useCallback((id: string, isFolded: boolean) => {
    setChosen((previous) => new Map(previous).set(id, isFolded));
  }, []);
  const [full, setFull] = useState(false);
  const [exporting, setExporting] = useState(false);
  /*
   * What the last export could not carry, for the caller to say out loud.
   *
   * Null means nothing has been exported yet or the last one was complete. A photograph that could
   * not be embedded becomes the silhouette the chart already draws, and a missing typeface becomes
   * the system one — neither is worth refusing an export over, and both are worth mentioning
   * rather than leaving somebody to wonder why the file differs from the screen.
   */
  const [exportNote, setExportNote] = useState<string | null>(null);
  const drag = useRef<{ x: number; y: number; from: { x: number; y: number } } | null>(null);
  /*
   * How far the pointer travelled since it went down.
   *
   * A ref rather than state: it is read during the click that follows the release, and a state
   * update scheduled on pointermove has no guarantee of having been applied by then.
   */
  const travelled = useRef(0);
  /*
   * Whether this component took the pointer capture.
   *
   * Remembered rather than asked of the element. `hasPointerCapture` is not everywhere — it is
   * absent under jsdom, where asking threw — and releasing a capture that is not held throws in
   * its own right. Both questions are answered by the one thing that knows: the code that took it.
   */
  const captured = useRef(false);

  /*
   * Fit means: the whole company, as large as it will go.
   *
   * Read off the drawing's own attributes rather than a measurement, because a measurement is of
   * the scaled element and fitting from it would chase its own tail. It never scales past 100% —
   * a two-person company blown up to fill a widescreen monitor looks like a mistake.
   */
  const fit = useCallback(() => {
    const frameEl = frame.current;
    const svgEl = drawing.current;
    if (frameEl === null || svgEl === null) return;
    const box = frameEl.getBoundingClientRect();
    const drawnWidth = Number(svgEl.getAttribute('width'));
    const drawnHeight = Number(svgEl.getAttribute('height'));
    if (!drawnWidth || !drawnHeight) return;
    const wanted = Math.min(1, (box.width - 40) / drawnWidth, (box.height - 40) / drawnHeight);
    setZoom(Math.max(FIT_MIN_ZOOM, wanted));
    setPan({ x: 0, y: 0 });
  }, []);

  const reset = useCallback(() => {
    setZoom(1);
    setPan({ x: 0, y: 0 });
  }, []);

  /**
   * Download the chart as a picture.
   *
   * Exported at its own drawn size, not at the current zoom: the file is the whole company, and
   * whatever magnification somebody happened to be reading at is not a property of the chart.
   */
  const download = useCallback(() => {
    const svgEl = drawing.current;
    const shellEl = shell.current;
    if (svgEl === null || exporting) return;

    setExporting(true);
    setExportNote(null);

    const surface = shellEl === null ? '#ffffff' : getComputedStyle(shellEl).backgroundColor;
    const safeName = root.name.replace(/[^a-zA-Z0-9 _-]/g, '').trim() || 'organization';

    void exportChartAsPng(svgEl, {
      fileName: safeName + ' org chart.png',
      background: surface,
    })
      .then((result) => {
        const missing = [
          result.photosEmbedded ? null : 'some photographs',
          result.fontEmbedded ? null : 'the chart typeface',
        ].filter((item): item is string => item !== null);
        setExportNote(
          missing.length === 0
            ? null
            : 'Downloaded without ' + missing.join(' and ') + '. Everything else is exact.',
        );
      })
      .catch((error: unknown) =>
        setExportNote(
          error instanceof Error ? error.message : 'The chart could not be downloaded.',
        ),
      )
      .finally(() => setExporting(false));
  }, [exporting, root.name]);

  /*
   * Full screen is asked of the browser rather than faked with a fixed position.
   *
   * A div stretched over the viewport is still inside the page: the operating system's chrome,
   * the browser's tab strip and the product's own top bar all stay, which on a laptop is most of
   * the height the reader was trying to gain.
   */
  const toggleFull = useCallback(() => {
    const el = shell.current;
    if (el === null) return;
    if (document.fullscreenElement === el) void document.exitFullscreen();
    else void el.requestFullscreen().catch(() => undefined);
  }, []);

  useEffect(() => {
    const onChange = () => {
      const isFull = document.fullscreenElement === shell.current;
      setFull(isFull);
      // Leaving full screen leaves a zoom chosen for a much larger frame, so the chart would come
      // back cropped. Refitting is the only answer that is right for every chart size.
      if (!isFull) requestAnimationFrame(() => fit());
    };
    document.addEventListener('fullscreenchange', onChange);
    return () => document.removeEventListener('fullscreenchange', onChange);
  }, [fit]);

  /*
   * The wheel, attached by hand because it has to be able to refuse the page.
   *
   * React attaches wheel listeners passively, and a passive listener may not call
   * preventDefault — so ctrl+wheel would zoom the chart *and* the browser, and a plain wheel would
   * scroll the page out from under a chart the reader was reading.
   */
  useEffect(() => {
    const frameEl = frame.current;
    if (frameEl === null) return;
    const onWheel = (event: WheelEvent) => {
      event.preventDefault();
      if (event.ctrlKey || event.metaKey) {
        setZoom((current) => clampZoom(current - Math.sign(event.deltaY) * ZOOM_STEP));
        return;
      }
      setPan((current) => ({ x: current.x - event.deltaX, y: current.y - event.deltaY }));
    };
    frameEl.addEventListener('wheel', onWheel, { passive: false });
    return () => frameEl.removeEventListener('wheel', onWheel);
  }, []);

  /*
   * An empty company still gets drawn.
   *
   * This used to return the message **instead of** the chart, and it swallowed more than it meant
   * to. A company with departments and nobody in them was the case it was written for; a company
   * with no departments at all hits it too, and that is every company on its first day. A new
   * administrator signed in, opened Hierarchy, and found a sentence where their company should
   * have been — reported as the screen being blank, and it is the first screen they see.
   *
   * The card is the thing that tells them the workspace is theirs and real, so it is drawn
   * whatever is or is not inside it, and the message moves underneath as the hint it always was.
   */
  const hasPeople = root.children.some((department) => department.children.length > 0);
  const emptyNote = !hasPeople && emptyMessage !== undefined ? emptyMessage : null;

  const { placed, width, height } = layout(pruned(root, folded));
  const paths = connectors(placed);

  const nodes: Placed[] = [];
  const collect = (node: Placed) => {
    nodes.push(node);
    node.children.forEach(collect);
  };
  collect(placed);

  const chart = (
    <svg
      ref={drawing}
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
          <feDropShadow dx="0" dy="2" stdDeviation="3.5" floodColor="#0b1220" floodOpacity="0.20" />
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
          // Not the company card. Folding it would leave a chart of one box and an offer to
          // unfold, which is a control whose only use is to make the screen useless.
          {...(node.kind !== 'company' && under.has(node.id)
            ? { fold: { hidden: under.get(node.id)!, folded: folded.has(node.id), toggleFold } }
            : {})}
          {...(onSelectPerson === undefined ? {} : { onSelectPerson })}
          {...(onAddReport === undefined ? {} : { onAddReport })}
          {...(onEditPerson === undefined ? {} : { onEditPerson })}
          {...(onAddToDepartment === undefined ? {} : { onAddToDepartment })}
          {...(onEditDepartment === undefined ? {} : { onEditDepartment })}
          {...(onArchiveDepartment === undefined ? {} : { onArchiveDepartment })}
        />
      ))}
    </svg>
  );

  if (controls !== true) {
    return (
      <div className={cn('uboss-org', className)}>
        {chart}
        {emptyNote === null ? null : <p className="uboss-org-empty">{emptyNote}</p>}
      </div>
    );
  }

  const percent = Math.round(zoom * 100);

  return (
    <div className={cn('uboss-org', 'uboss-org--framed', className)} ref={shell}>
      <div className="uboss-org-tools">
        <button
          type="button"
          className="uboss-org-tool"
          onClick={() => setZoom((current) => clampZoom(current - ZOOM_STEP))}
          disabled={zoom <= MIN_ZOOM}
          aria-label="Zoom out"
          title="Zoom out"
        >
          <Icon name="minus" size={15} />
        </button>

        {/*
          The readout is the reset.

          It is the one control whose label already says what pressing it would undo, so a separate
          Reset button beside it would be a second way to say 100%.
        */}
        <button
          type="button"
          className="uboss-org-zoom"
          onClick={reset}
          aria-label={`Zoom is ${percent} per cent. Reset to 100 per cent`}
          title="Reset to 100%"
        >
          {percent}%
        </button>

        <button
          type="button"
          className="uboss-org-tool"
          onClick={() => setZoom((current) => clampZoom(current + ZOOM_STEP))}
          disabled={zoom >= MAX_ZOOM}
          aria-label="Zoom in"
          title="Zoom in"
        >
          <Icon name="plus" size={15} />
        </button>

        <span className="uboss-org-tool-gap" aria-hidden="true" />

        <button
          type="button"
          className="uboss-org-tool"
          onClick={fit}
          aria-label="Fit the whole chart"
          title="Fit the whole chart"
        >
          <Icon name="frame" size={15} />
        </button>

        <button
          type="button"
          className="uboss-org-tool"
          onClick={download}
          disabled={exporting}
          aria-label="Download the chart"
          title="Download the chart as a picture"
        >
          <Icon name={exporting ? 'clock' : 'arrow-down'} size={15} />
        </button>

        <button
          type="button"
          className="uboss-org-tool"
          onClick={toggleFull}
          aria-label={full ? 'Leave full screen' : 'Full screen'}
          title={full ? 'Leave full screen' : 'Full screen'}
        >
          <Icon name={full ? 'collapse' : 'expand'} size={15} />
        </button>
      </div>

      {/*
        The frame.

        Focusable and driven by the keyboard as well as the pointer, because zoom and pan are the
        only way to reach part of a large chart and a reader who cannot use a mouse would otherwise
        be able to see one corner of their own company.
      */}
      <div
        className="uboss-org-frame"
        ref={frame}
        tabIndex={0}
        role="group"
        aria-label="Chart viewport. Plus and minus zoom, arrow keys pan, 0 resets."
        onKeyDown={(event) => {
          const nudge = 60;
          if (event.key === '+' || event.key === '=') setZoom((z) => clampZoom(z + ZOOM_STEP));
          else if (event.key === '-') setZoom((z) => clampZoom(z - ZOOM_STEP));
          else if (event.key === '0') reset();
          else if (event.key === 'ArrowLeft') setPan((o) => ({ ...o, x: o.x + nudge }));
          else if (event.key === 'ArrowRight') setPan((o) => ({ ...o, x: o.x - nudge }));
          else if (event.key === 'ArrowUp') setPan((o) => ({ ...o, y: o.y + nudge }));
          else if (event.key === 'ArrowDown') setPan((o) => ({ ...o, y: o.y - nudge }));
          else return;
          event.preventDefault();
        }}
        /*
         * A press that moved was a pan, not a choice.
         *
         * The first version of this only panned from the background, on the reasoning that the
         * cards are the chart's controls. On a real company there is almost no background: the
         * drawing is wider than the frame in every direction, so nearly every point under the
         * pointer is a card and the chart could barely be moved at all.
         *
         * So a drag starts anywhere, and what separates the two is distance. Under four pixels is
         * a press — the card opens. Past it, the chart moves and the click that follows the
         * release is stopped here, before it reaches the card underneath.
         */
        onClickCapture={(event) => {
          if (travelled.current <= 4) return;
          event.stopPropagation();
          event.preventDefault();
        }}
        onPointerDown={(event) => {
          if (event.button !== 0) return;
          drag.current = { x: event.clientX, y: event.clientY, from: pan };
          travelled.current = 0;
          captured.current = false;
        }}
        onPointerMove={(event) => {
          const from = drag.current;
          if (from === null) return;
          const dx = event.clientX - from.x;
          const dy = event.clientY - from.y;
          travelled.current = Math.max(travelled.current, Math.abs(dx) + Math.abs(dy));
          if (travelled.current <= 4) return;
          /*
           * The pointer is captured here, once the press has become a drag — never on the press
           * itself.
           *
           * Capturing on pointerdown retargets the compatibility mouse events to the capturing
           * element, and the click that follows is then dispatched at the frame rather than at
           * whatever was pressed. Every card silently stopped opening: the chart looked right, the
           * cursor was right, and pressing a person did nothing at all.
           *
           * Taken here instead, a press that does not move is never captured and reaches its card,
           * while a real drag still keeps receiving moves after the pointer leaves the frame.
           */
          if (!captured.current) {
            event.currentTarget.setPointerCapture(event.pointerId);
            captured.current = true;
          }
          setPan({ x: from.from.x + dx, y: from.from.y + dy });
        }}
        onPointerUp={(event) => {
          drag.current = null;
          if (captured.current) {
            event.currentTarget.releasePointerCapture(event.pointerId);
            captured.current = false;
          }
        }}
        onPointerCancel={() => {
          drag.current = null;
          captured.current = false;
        }}
      >
        {/*
          What the export could not carry.

          On the chart rather than in a toast, because it is about the file that just downloaded
          and the person is looking here. It clears on the next export.
        */}
        {exportNote === null ? null : (
          <p className="uboss-org-note" role="status">
            {exportNote}
            <button
              type="button"
              className="uboss-org-note-close"
              onClick={() => setExportNote(null)}
              aria-label="Dismiss"
            >
              <Icon name="close" size={13} />
            </button>
          </p>
        )}

        <div className="uboss-org-stage" style={{ transform: `translate(${pan.x}px, ${pan.y}px)` }}>
          {/*
            The box is told the size the drawing ends up, because a transform does not tell it.

            `scale()` paints smaller and leaves the element's layout box at its original size. So a
            chart fitted to 22% still occupied 692px of height, and centring it in the frame
            centred that phantom box — the drawing stayed pinned to the top with five hundred
            pixels of empty frame beneath it, which reads as a chart that failed to finish loading.
          */}
          <div
            className="uboss-org-scale"
            style={{
              width: width * zoom,
              height: height * zoom,
              transform: `scale(${zoom})`,
            }}
          >
            {chart}
          </div>
        </div>
      </div>
      {/* Under the frame, so the company card above it stays the first thing anybody sees. */}
      {emptyNote === null ? null : <p className="uboss-org-empty">{emptyNote}</p>}
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
  bandOpacity,
}: {
  x: number;
  y: number;
  band: string;
  panel: string;
  stroke: string;
  /** Wide for a department, a stripe for a person. */
  bandWidth?: number;
  /**
   * Draw the band as a wash over the card's surface instead of as the colour itself.
   *
   * A department passes this; a person's 8px stripe and the company's logo band do not, because
   * neither is large enough to shout and the stripe is the only thing grouping a column.
   */
  bandOpacity?: number;
}) {
  const washed = bandOpacity !== undefined;
  return (
    <>
      <rect
        className="uboss-org-card"
        x={x}
        y={y}
        width={BOX_WIDTH}
        height={BOX_HEIGHT}
        rx={16}
        fill={washed ? panel : band}
        filter="url(#uboss-org-shadow)"
      />
      {/*
        The wash, over the surface rather than instead of it, which is what lets one opacity serve
        both themes: the same 16% of green is a pale mint on white and a deep moss on near-black,
        and the component never has to ask which it is in.
      */}
      {washed ? (
        <path
          className="uboss-org-band"
          d={panelPath(x, y, bandWidth, BOX_HEIGHT, 16, 0)}
          fill={band}
          fillOpacity={bandOpacity}
        />
      ) : null}
      <path
        d={panelPath(x + bandWidth, y, BOX_WIDTH - bandWidth, BOX_HEIGHT, 0, 16)}
        fill={panel}
      />
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

/**
 * The initials in the band.
 *
 * The ink used to be derived here, from the band colour, by `inkOn`. It cannot be any more: the
 * band is now a wash whose result depends on the theme, so the two possible inks are computed by
 * `departmentInk` and handed to CSS, and this draws whichever one CSS resolved.
 */
function BandLabel({
  x,
  y,
  ink,
  label,
  fontSize,
}: {
  x: number;
  y: number;
  ink: string;
  label: string;
  fontSize: number;
}) {
  return (
    <text
      x={x + RAIL / 2}
      y={y + BOX_HEIGHT / 2 + fontSize * 0.36}
      fill={ink}
      fontSize={fontSize}
      fontWeight={800}
      textAnchor="middle"
      letterSpacing="0.5"
    >
      {label}
    </text>
  );
}

/**
 * What the hover tooltip says. The last one is not called Delete, because it is not one.
 *
 * Offboard used to be here. It is on the person's own page now: it needs its own permission, an
 * impact assessment and a successor when the person has reports, and none of that belongs behind
 * a 24px disc that appears on hover.
 */
const ACTION_TITLES: Record<'add' | 'edit' | 'archive', string> = {
  add: 'Add',
  edit: 'Edit',
  archive: 'Archive',
};

const ACTION_R = 12;
const ACTION_GAP = 30;
const ACTION_RIGHT_INSET = 26;
/**
 * Extra air between the destructive action and the two that build.
 *
 * Measured before choosing it: all three circles sat 6px apart, edge to edge, so Archive was
 * exactly as close to Edit as Edit was to Add. Three identical discs in a row, one of which takes
 * something away, is a misclick waiting to be reported as a bug — and the standing guidance on
 * destructive actions is to separate them and space them, not to rely on the colour alone.
 */
const ACTION_SEPARATION = 10;
/** Vertically in the top half, clear of the subtitle so that line keeps the card's full width. */
const ACTION_CY = 26;

/**
 * Where a slot sits, counting right to left, so slot 0 is the rightmost.
 *
 * `detached` pushes the building actions further left, away from the destructive one that keeps
 * the right-hand slot. It is the gap that does the work here, not the position: whichever end it
 * sits at, what matters is that the pointer has to travel to reach it.
 */
function actionCx(x: number, slot: number, detached = false): number {
  return (
    x + BOX_WIDTH - ACTION_RIGHT_INSET - slot * ACTION_GAP - (detached ? ACTION_SEPARATION : 0)
  );
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

/**
 * The fold toggle: a pill straddling the card's bottom edge, where the line to the people below
 * leaves it.
 *
 * Sitting on the connector rather than beside it is deliberate — it is the control for that line,
 * and a reader follows the line down to find it. It carries the count at all times, folded or not,
 * because "12" on a closed card is the only thing telling somebody there are twelve people there,
 * and on an open one it is the size of what they are about to put away.
 *
 * Always drawn, never revealed on hover like the edit actions: this is how the chart is navigated,
 * and a navigation control somebody has to go looking for is one they do not know exists.
 */
function FoldToggle({
  x,
  y,
  name,
  fold,
  id,
}: {
  x: number;
  y: number;
  name: string;
  id: string;
  fold: Fold;
}) {
  const label = fold.folded
    ? `Show the ${fold.hidden} under ${name}`
    : `Hide the ${fold.hidden} under ${name}`;

  const text = fold.folded ? `+${fold.hidden}` : `−${fold.hidden}`;
  const width = 26 + 7.5 * text.length;
  const cx = x + BOX_WIDTH / 2;
  const cy = y + BOX_HEIGHT;

  return (
    <g
      className="uboss-org-fold"
      role="button"
      tabIndex={0}
      aria-label={label}
      style={{ cursor: 'pointer' }}
      onClick={(event) => {
        event.stopPropagation();
        fold.toggleFold(id, !fold.folded);
      }}
      onKeyDown={(event) => {
        if (event.key === 'Enter' || event.key === ' ') {
          event.preventDefault();
          event.stopPropagation();
          fold.toggleFold(id, !fold.folded);
        }
      }}
    >
      <title>{label}</title>
      <rect
        x={cx - width / 2}
        y={cy - 11}
        width={width}
        height={22}
        rx={11}
        fill={fold.folded ? 'var(--uboss-blue-050)' : 'var(--uboss-surface)'}
        stroke="var(--uboss-border)"
        strokeWidth={1.2}
      />
      <text
        x={cx}
        y={cy + 4}
        textAnchor="middle"
        fill={fold.folded ? 'var(--uboss-blue)' : 'var(--uboss-text-2)'}
        fontSize={11}
        fontWeight={700}
        pointerEvents="none"
      >
        {text}
      </text>
    </g>
  );
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
  kind: 'add' | 'edit' | 'archive';
  label: string;
  onActivate: () => void;
}) {
  const destructive = kind === 'archive';
  const cx = actionCx(x, slot, !destructive);
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
      <title>{ACTION_TITLES[kind]}</title>
      <circle
        cx={cx}
        cy={cy}
        r={ACTION_R}
        /*
          The destructive one is neutral at rest and turns danger under the pointer, which is the
          arrangement the guidance asks for: red is a warning at the moment of reaching, not a
          decoration the eye stops seeing. It is drawn in currentColor so one CSS rule flips the
          ring and the glyph together — see `.uboss-org-act--danger` in components.css.
        */
        fill={
          kind === 'add'
            ? 'var(--uboss-blue-050)'
            : kind === 'edit'
              ? 'var(--uboss-bg-2)'
              : 'var(--uboss-surface)'
        }
        stroke={
          kind === 'add'
            ? 'var(--uboss-blue-100)'
            : kind === 'edit'
              ? 'var(--uboss-border)'
              : 'currentColor'
        }
      />
      {kind === 'add' ? (
        <path
          d={`M${cx} ${cy - 5} v10 M${cx - 5} ${cy} h10`}
          stroke="var(--uboss-blue)"
          strokeWidth={1.8}
          strokeLinecap="round"
        />
      ) : kind === 'edit' ? (
        <path
          d={`M${cx - 4.6} ${cy + 4.6} l6.2 -6.2 2.3 2.3 -6.2 6.2 -3 .7 z`}
          fill="none"
          stroke="var(--uboss-text-2)"
          strokeWidth={1.4}
          strokeLinejoin="round"
        />
      ) : kind === 'archive' ? (
        /*
          An arrow going down into a tray: filed away, still there.

          The previous glyph was a box with its lid on, which is the right idea and the wrong
          drawing — at a 24px disc the lid reads as the rim of a bin, and the client read it as
          one. The arrow is what carries the meaning here: nothing is being emptied, something is
          being put somewhere. The tray is open at the top for the same reason.
        */
        <g stroke="currentColor" strokeWidth={1.5} fill="none" strokeLinecap="round">
          <path d={`M${cx} ${cy - 5.5} v6.4`} />
          <path d={`M${cx - 2.6} ${cy - 1.6} l2.6 2.6 2.6 -2.6`} strokeLinejoin="round" />
          <path d={`M${cx - 5.4} ${cy + 2.6} v2.9 h10.8 v-2.9`} strokeLinejoin="round" />
        </g>
      ) : (
        /* Somebody leaving through a door, rather than a person being erased. */
        <g stroke="currentColor" strokeWidth={1.4} fill="none" strokeLinecap="round">
          <path d={`M${cx + 0.5} ${cy - 5} h-5 v10 h5`} strokeLinejoin="round" />
          <path d={`M${cx + 5.5} ${cy} h-5.5 m5.5 0 l-2.3 -2.4 m2.3 2.4 l-2.3 2.4`} />
        </g>
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

/** What a node needs to draw its own toggle. Absent on a node with nobody under it. */
interface Fold {
  hidden: number;
  folded: boolean;
  toggleFold: (id: string, folded: boolean) => void;
}

function OrgNode({
  node,
  idPrefix,
  fold,
  onSelectPerson,
  onAddReport,
  onEditPerson,
  onAddToDepartment,
  onEditDepartment,
  onArchiveDepartment,
}: {
  node: Placed;
  idPrefix: string;
  fold?: Fold;
  onSelectPerson?: (id: string) => void;
  onAddReport?: (id: string) => void;
  onEditPerson?: (id: string) => void;
  onAddToDepartment?: (id: string) => void;
  onEditDepartment?: (id: string) => void;
  onArchiveDepartment?: (id: string) => void;
}) {
  const x = node.x - BOX_WIDTH / 2;
  const y = node.y - BOX_HEIGHT / 2;

  if (node.kind === 'company') {
    return (
      <g
        className="uboss-org-node uboss-org-node--company"
        role="treeitem"
        aria-label={`${node.name}. ${node.subtitle}`}
      >
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
          {truncate(node.name, nameLimit(0))}
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
      onArchiveDepartment === undefined
        ? null
        : {
            kind: 'archive' as const,
            label: `Archive the ${node.name} department`,
            onActivate: () => onArchiveDepartment(node.id),
          },
    ].filter((entry) => entry !== null);

    const skin = departmentSkin(colour);

    return (
      <g
        className={cn(
          'uboss-org-node',
          'uboss-org-node--dept',
          actions.length > 0 && 'uboss-org-node--acts',
        )}
        role="treeitem"
        aria-label={`${node.name}. ${node.subtitle}`}
        // Only on a node that has anybody under it: on a leaf the attribute would claim there is
        // something to open.
        {...(fold === undefined ? {} : { 'aria-expanded': !fold.folded })}
        /*
          Both inks travel as custom properties and CSS picks one, because an SVG fill cannot ask
          what theme it is in and the right ink here depends on it. Set on the node rather than in
          the stylesheet because the value is the department's own colour, which the stylesheet
          has no way to know.
        */
        style={{
          ['--uboss-org-ink-l' as string]: skin.light.ink,
          ['--uboss-org-ink-d' as string]: skin.dark.ink,
        }}
      >
        <Card
          x={x}
          y={y}
          band={colour}
          bandOpacity={BAND_TINT}
          /*
            The surface, not `--uboss-bg-2`. A department card in the grey one sat visibly duller
            than the white person cards below it, which read as though departments were disabled.
            They are the structure; they should not look like the faded part of it.
          */
          panel="var(--uboss-surface)"
          stroke="var(--uboss-border)"
        />
        <BandLabel
          x={x}
          y={y}
          ink="var(--uboss-org-ink)"
          label={departmentInitials(node.name)}
          fontSize={16}
        />
        <text x={x + TEXT_X} y={y + 37} fill="var(--uboss-text)" fontSize={14} fontWeight={750}>
          {truncate(node.name, nameLimit(actions.length))}
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

        {fold === undefined ? null : (
          <FoldToggle x={x} y={y} name={node.name} id={node.id} fold={fold} />
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
      : {
          kind: 'edit' as const,
          label: `Edit ${node.name}`,
          onActivate: () => onEditPerson(node.id),
        },
  ].filter((entry) => entry !== null);

  return (
    <g
      className={cn('uboss-org-node', actions.length > 0 && 'uboss-org-node--acts')}
      role="treeitem"
      aria-label={`${node.name}. ${node.subtitle}`}
      {...(fold === undefined ? {} : { 'aria-expanded': !fold.folded })}
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
      <text
        x={x + PERSON_TEXT_X}
        y={y + 37}
        fill="var(--uboss-text)"
        fontSize={13.5}
        fontWeight={700}
      >
        {truncate(node.name, nameLimit(actions.length, PERSON_TEXT_X))}
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

      {fold === undefined ? null : (
        <FoldToggle x={x} y={y} name={node.name} id={node.id} fold={fold} />
      )}
    </g>
  );
}
