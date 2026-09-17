/**
 * The motion system, in one place.
 *
 * ## Why these numbers live here as well as in CSS
 *
 * `tokens.css` owns the scale. Most motion in this product is CSS, because hover, focus, press,
 * open and close are things CSS does better than JavaScript and at no runtime cost. But the few
 * things CSS genuinely cannot do — a shared indicator that glides between two elements, an element
 * that animates on the way *out*, a list that reflows when an item is removed — are done with
 * Motion, and Motion needs the numbers as numbers.
 *
 * So this module restates the scale in seconds, and `motion-scale.test.ts` asserts the two agree.
 * A duration changed in CSS and not here would otherwise show up as a dropdown that closes at a
 * different speed from the drawer beside it, which is exactly the drift the tokens exist to stop.
 *
 * ## The split, in practice
 *
 *   * **CSS** — hover, focus, press, selection, expand/collapse, tables, buttons, inputs. If the
 *     element is on screen before and after, CSS can do it.
 *   * **Motion** — shared layout (`layoutId`), exit animations (`AnimatePresence`), list reflow
 *     (`layout`), SVG path drawing, and the staggered signature reveals.
 *
 * Nothing here loops. Every duration below is a one-shot; an idle screen is idle.
 */

/** Durations, in seconds, matching `--uboss-motion-*` in `tokens.css`. */
export const DURATION = {
  /** Hover, focus, press. Felt rather than seen. */
  micro: 0.1,
  /** Selection, row change, toast. */
  small: 0.16,
  /** Dropdown, popover, tab content. */
  panel: 0.24,
  /** Drawer, dialog, route. */
  large: 0.32,
  /** The signature moments: donut draw, workflow reveal, brand. */
  signature: 0.48,
} as const;

/** Easing curves, matching `--uboss-ease-*`. */
export const EASE = {
  /** Anything that stays on screen. */
  standard: [0.2, 0, 0.2, 1],
  /** Arriving: decelerates, so the thing settles rather than stops. */
  enter: [0.05, 0.7, 0.1, 1],
  /** Leaving: accelerates, so it gets out of the way. */
  exit: [0.3, 0, 0.8, 0.15],
  /** Signature only. A little overshoot in the tail. */
  emphasized: [0.34, 1.2, 0.64, 1],
} as const;

/**
 * Does this person want motion reduced?
 *
 * Read directly rather than through a hook so it can be called in a transition definition. Returns
 * false where `matchMedia` is unavailable — the server, and old browsers — which is the safe
 * direction: the animation is then defined normally and simply never runs before hydration.
 */
export function prefersReducedMotion(): boolean {
  if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return false;
  return window.matchMedia('(prefers-reduced-motion: reduce)').matches;
}

/**
 * A transition, with reduced motion already accounted for.
 *
 * Returns a duration of zero rather than dropping the animation, so the end state is identical and
 * only the travel disappears. That is the behaviour the accessibility rule asks for: the interface
 * still changes, it just does not move.
 */
export function transition(
  duration: keyof typeof DURATION = 'small',
  ease: keyof typeof EASE = 'standard',
): { duration: number; ease: readonly [number, number, number, number] } {
  return {
    duration: prefersReducedMotion() ? 0 : DURATION[duration],
    ease: EASE[ease] as unknown as readonly [number, number, number, number],
  };
}

/**
 * A stagger for a list that reveals in order.
 *
 * Capped on purpose. A workflow with forty nodes staggered at 40ms would take a second and a half
 * to appear, which stops being a reveal and starts being a wait — so the per-item delay shrinks as
 * the list grows and the whole sequence stays inside the signature budget.
 */
export function stagger(index: number, count: number, total = DURATION.signature): number {
  if (prefersReducedMotion() || count <= 1) return 0;
  const perItem = Math.min(0.04, total / count);
  return index * perItem;
}
