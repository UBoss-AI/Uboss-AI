/**
 * The colours a status may be drawn in.
 *
 * ## Why this is a type and not a convention
 *
 * Every `*_TONES` map in this package was `Record<Status, string>`, and `string` accepts any word
 * at all. Five statuses across five maps had been given `'cyan'` — a colour no stylesheet defines
 * — and because a tone reaches the badge as a class name, each of them rendered as bare text
 * beside neighbours that had a coloured pill. `Running`, the status people look at most, was one
 * of them.
 *
 * Nothing caught it. The screens cast the value (`as StatusTone`) on the way in, which told the
 * compiler to stop asking. The test asserted `TONES[status].length > 0`, which `'cyan'` passes.
 * Both checks were looking at the wrong thing: not whether a tone was written, but whether the one
 * written exists.
 *
 * So the vocabulary is closed here, at the only place that can close it for every map at once.
 * `packages/ui` keeps the matching union for `StatusBadge` — the two are asserted equal by a test
 * there rather than by an import, because the stylesheet is what makes a tone real and it lives in
 * that package.
 */
export const STATUS_TONE_NAMES = [
  'success',
  'blue',
  'teal',
  'warn',
  'danger',
  'purple',
  'grey',
] as const;

export type StatusTone = (typeof STATUS_TONE_NAMES)[number];
