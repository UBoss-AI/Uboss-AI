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
  card: 'M3 10h18',
  key: 'M10 12l9-9 2 2-2 2 2 2-3 3-2-2-2 2z',
  play: 'M6 4l14 8-14 8z',
  pause: 'M8 5v14M16 5v14',
  medal: 'M9 14l-2 7 5-3 5 3-2-7',
  panel: 'M9 4v16',
  gear: 'M12 2v3M12 19v3M2 12h3M19 12h3M4.9 4.9l2.1 2.1M17 17l2.1 2.1M19.1 4.9L17 7M7 17l-2.1 2.1',
  users: 'M3 20c0-3.3 2.7-6 6-6s6 2.7 6 6M16 5.5a3 3 0 010 6M18 20c0-2.2-.8-3.9-2-5',
  bot: 'M12 8V4M8 13h.01M16 13h.01M9 3h6',
  ops: 'M12 2v4M12 18v4M2 12h4M18 12h4',
  // Prompt 40A (CR-03): Workspace Chat. A speech bubble with a tail, in the same stroke idiom as
  // the rest of the set rather than a filled glyph borrowed from elsewhere.
  chat: 'M21 12a8 8 0 0 1-8 8H8l-5 3 1.5-4.5A8 8 0 1 1 21 12z',
  target: '',
} as const;

/** Extra shapes that cannot be expressed as a single path. */
const ICON_SHAPES: Partial<Record<IconName, ReactNode>> = {
  search: <circle cx="11" cy="11" r="7" />,
  clock: <circle cx="12" cy="12" r="9" />,
  card: <rect x="3" y="5" width="18" height="14" rx="2" />,
  key: <circle cx="7" cy="15" r="4" />,
  medal: <circle cx="12" cy="9" r="6" />,
  panel: <rect x="3" y="4" width="18" height="16" rx="2" />,
  gear: <circle cx="12" cy="12" r="3.2" />,
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
