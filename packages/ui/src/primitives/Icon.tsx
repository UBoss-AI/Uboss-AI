import type { ReactNode, SVGProps } from 'react';

/**
 * The UBoss icon set, transcribed from the client's approved UI reference so shells and
 * navigation keep the same iconography. Stroke-based, 24x24, inheriting `currentColor`.
 */
const ICON_PATHS = {
  grid: 'M3 3h7v7H3zM14 3h7v7h-7zM14 14h7v7h-7zM3 14h7v7H3z',
  tree: 'M9 3h6v4H9zM3 17h6v4H3zM15 17h6v4h-6zM12 7v4M6 17v-3h12v3',
  check: 'M4 12l5 5L20 6',
  list: 'M8 6h13M8 12h13M8 18h13M3 6h.01M3 12h.01M3 18h.01',
  chart: 'M3 3v18h18M8 15v3M13 9v9M18 5v13',
  bell: 'M6 9a6 6 0 0112 0c0 5 2 6 2 6H4s2-1 2-6M10 20a2 2 0 004 0',
  search: 'M21 21l-4-4',
  bolt: 'M13 2L4 14h7l-1 8 9-12h-7z',
  clock: 'M12 7v5l3 2',
  arrow: 'M5 12h14M13 6l6 6-6 6',
  back: 'M19 12H5M11 6l-6 6 6 6',
  plus: 'M12 5v14M5 12h14',
  alert: 'M12 3l9 16H3zM12 9v5M12 17h.01',
  file: 'M14 3H7a2 2 0 00-2 2v14a2 2 0 002 2h10a2 2 0 002-2V8zM14 3v5h5',
  build: 'M3 21h18M6 21V9l6-4 6 4v12M10 21v-5h4v5',
  map: 'M9 3L3 6v15l6-3 6 3 6-3V3l-6 3zM9 3v15M15 6v15',
  govern: 'M12 3l8 4v5c0 5-3.5 8-8 9-4.5-1-8-4-8-9V7zM9 12l2 2 4-4',
  shield: 'M12 3l7 3v5c0 4.5-3 8-7 10-4-2-7-5.5-7-10V6z',
  close: 'M6 6l12 12M18 6L6 18',
  /*
   * The lid, as one stroke out and back. The pupil is a circle in `ICON_SHAPES`, because an eye
   * drawn as a single path has to close the lid and the pupil in one line and reads as a leaf.
   */
  eye: 'M2 12s3.6-6 10-6 10 6 10 6-3.6 6-10 6-10-6-10-6z',
  /* The same lid with a stroke through it — the one shape everybody already reads as "hidden". */
  'eye-off': 'M2 12s3.6-6 10-6 10 6 10 6-3.6 6-10 6-10-6-10-6zM4 4l16 16',
  /*
   * The formatting toolbar.
   *
   * Drawn as strokes like every other icon here rather than as letterforms: a glyph `B` would
   * take the page's own font and change shape with it, and at fifteen pixels these have to read
   * at a glance. The bold and italic marks are the shapes of the letters, not the letters.
   */
  bold: 'M7 5h6a3.5 3.5 0 0 1 0 7H7zM7 12h7a3.5 3.5 0 0 1 0 7H7z',
  italic: 'M15 5h-5M14 19H9M13 5l-2 14',
  underline: 'M7 4v6a5 5 0 0 0 10 0V4M5 20h14',
  'list-bullet': 'M9 6h11M9 12h11M9 18h11M4.5 6h.01M4.5 12h.01M4.5 18h.01',
  'list-numbered': 'M9 6h11M9 12h11M9 18h11M4 5h1v3M4 11h2l-2 2h2M4 16h2v1.5H4.5V19H6',
  // A picture: a horizon inside the frame the shape map draws.
  image: 'M3 16l5-5 4 4 3-3 6 6',
  palette:
    'M12 3a9 9 0 1 0 0 18c1 0 1.6-.7 1.6-1.5 0-.9-.8-1.3-.8-2.1 0-.8.7-1.4 1.5-1.4H16a5 5 0 0 0 5-5c0-4.4-4-8-9-8z',
  card: 'M3 10h18',
  key: 'M10 12l9-9 2 2-2 2 2 2-3 3-2-2-2 2z',
  play: 'M6 4l14 8-14 8z',
  pause: 'M8 5v14M16 5v14',
  medal: 'M9 14l-2 7 5-3 5 3-2-7',
  panel: 'M9 4v16',
  /*
   * A cogged ring, not a sunburst.
   *
   * This was eight free-floating spokes around a circle, which at sidebar size reads as a sun or
   * an asterisk — the one icon in the navigation that did not say what it was. The teeth now join
   * the ring, so it reads as a cog at 18px.
   */
  /*
   * A cog with six square teeth on a ring, drawn the way every settings icon is drawn.
   *
   * Two attempts preceded this one. The first was eight free-floating spokes around a circle,
   * which reads as a sun. The second traced the cog as one continuous outline of twenty-odd short
   * segments, and at 18px those segments round into a blob — a flower, not a gear.
   *
   * This is six separate teeth: short, straight, radial strokes with the round line cap the rest
   * of the set uses, spaced at sixty degrees around the ring that `ICON_SHAPES` draws. Straight
   * strokes stay straight at any size, which is the whole problem with tracing an outline at
   * sidebar scale.
   */
  /*
   * Eight teeth, each starting **on** the ring.
   *
   * They used to float: six strokes running from radius 7 out to 10, over a ring of radius 6.2,
   * leaving a gap between the ring and every tooth. A cog whose teeth do not touch it is a sun,
   * and that is what it read as on screen.
   */
  gear:
    'M18.2 12h2.4M5.8 12H3.4M12 5.8V3.4M12 18.2v2.4' +
    'M16.4 7.6l1.7-1.7M7.6 7.6L5.9 5.9M16.4 16.4l1.7 1.7M7.6 16.4l-1.7 1.7',
  users: 'M3 20c0-3.3 2.7-6 6-6s6 2.7 6 6M16 5.5a3 3 0 010 6M18 20c0-2.2-.8-3.9-2-5',
  bot: 'M12 8V4M8 13h.01M16 13h.01M9 3h6',
  ops: 'M12 2v4M12 18v4M2 12h4M18 12h4',
  // Prompt 40A (CR-03): Workspace Chat. A speech bubble with a tail, in the same stroke idiom as
  // the rest of the set rather than a filled glyph borrowed from elsewhere.
  chat: 'M21 12a8 8 0 0 1-8 8H8l-5 3 1.5-4.5A8 8 0 1 1 21 12z',
  target: '',
  /*
   * Prompt 45: reordering a Form 2 row was drawn with the literal characters ↑ and ↓.
   *
   * A Unicode arrow is not part of this icon set: it renders in whatever the text font supplies,
   * so its weight, size and baseline do not match the stroke icons beside it, and it changes shape
   * between platforms. These are the same 24x24 stroke idiom as `arrow` and `back`, rotated to
   * vertical, so a row control looks like every other control in the product.
   */
  'arrow-up': 'M12 19V5M6 11l6-6 6 6',
  'arrow-down': 'M12 5v14M6 13l6 6 6-6',
  /*
   * The four the org chart's frame needs.
   *
   * `minus` is the pair to `plus` and had never been needed before, because nothing in the
   * product took anything away one step at a time until zoom did. The other three are the arrows
   * every chart viewer uses for the same three jobs, drawn in this set's 24x24 stroke idiom rather
   * than borrowed as glyphs — a Unicode arrow renders in the text font and matches nothing beside
   * it.
   */
  minus: 'M5 12h14',
  expand: 'M4 9V4h5M20 15v5h-5M15 4h5v5M9 20H4v-5',
  collapse: 'M9 4v5H4M15 20v-5h5M20 9h-5V4M4 15h5v5',
  frame: 'M8 10h8v4H8z',
  /*
   * A spanner, for building an agent rather than operating one.
   *
   * Agent Builder and Engine Agents both used `bot`, so two sidebar entries three rows apart were
   * drawn identically and the only thing telling them apart was the word. They are different acts
   * — deciding what an agent is, and running one that exists — and the sidebar should say so
   * before the label is read.
   */
  wrench:
    'M15.5 3.5a5 5 0 00-6.1 6.9L3.8 16a1.8 1.8 0 002.5 2.5l5.6-5.6a5 5 0 006.9-6.1l-3 3-2.8-2.8z',
} as const;

/** Extra shapes that cannot be expressed as a single path. */
const ICON_SHAPES: Partial<Record<IconName, ReactNode>> = {
  search: <circle cx="11" cy="11" r="7" />,
  clock: <circle cx="12" cy="12" r="9" />,
  eye: <circle cx="12" cy="12" r="3" />,
  'eye-off': <circle cx="12" cy="12" r="3" />,
  // The palette's three wells, so the icon reads as colour rather than as a blob.
  image: <rect x="3" y="5" width="18" height="14" rx="2" />,
  palette: (
    <>
      <circle cx="9" cy="9" r="1.1" />
      <circle cx="13.5" cy="7.5" r="1.1" />
      <circle cx="16.5" cy="11" r="1.1" />
    </>
  ),
  card: <rect x="3" y="5" width="18" height="14" rx="2" />,
  // Fit: a drawing brought inside a frame. The outer rect is the frame, the path is the drawing.
  frame: <rect x="3" y="5" width="18" height="14" rx="2" />,
  key: <circle cx="7" cy="15" r="4" />,
  medal: <circle cx="12" cy="9" r="6" />,
  panel: <rect x="3" y="4" width="18" height="16" rx="2" />,
  /* The ring the teeth sit on, and the hole in the middle — a cog is two circles, not one. */
  gear: (
    <>
      <circle cx="12" cy="12" r="6.2" />
      <circle cx="12" cy="12" r="2.4" />
    </>
  ),
  users: <circle cx="9" cy="8" r="3.2" />,
  bot: <rect x="4" y="8" width="16" height="11" rx="2" />,
  ops: <circle cx="12" cy="12" r="3" />,
  target: (
    <>
      <circle cx="12" cy="12" r="8" />
      <circle cx="12" cy="12" r="3.5" />
    </>
  ),
};

export type IconName = keyof typeof ICON_PATHS;

export const ICON_NAMES = Object.keys(ICON_PATHS) as IconName[];

export interface IconProps extends Omit<SVGProps<SVGSVGElement>, 'children'> {
  name: IconName;
  /** Rendered width and height in pixels. */
  size?: number;
  /**
   * Accessible label. Omit for purely decorative icons — they are then hidden from assistive
   * technology, which is correct when adjacent text already conveys the meaning.
   */
  label?: string;
}

export function Icon({ name, size = 18, label, ...rest }: IconProps) {
  const path = ICON_PATHS[name];

  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.8}
      strokeLinecap="round"
      strokeLinejoin="round"
      role={label ? 'img' : undefined}
      aria-label={label}
      aria-hidden={label ? undefined : true}
      focusable="false"
      {...rest}
    >
      {ICON_SHAPES[name]}
      {path === '' ? null : <path d={path} />}
    </svg>
  );
}
