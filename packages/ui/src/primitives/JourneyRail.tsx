import { useEffect, useRef } from 'react';

import { cn } from '../lib/class-names';
import { Icon } from './Icon';

export type JourneyState = 'done' | 'current' | 'halted' | 'upcoming' | 'optional';

export interface JourneyStop {
  key: string;
  /** What the line shows. One or two words; ten long ones do not fit on a screen. */
  label: string;
  /**
   * The full name, when `label` is an abbreviation of it.
   *
   * Read instead of `label` by assistive technology, so shortening the line to fit never shortens
   * what a person who cannot see it is told. Omit when the label is already the whole name.
   */
  fullLabel?: string;
  state: JourneyState;
  /**
   * Where this stage lives, when it is somewhere a person may go.
   *
   * Omitted for a stage that has not been reached — the rail must not offer a door into work that
   * does not exist yet. The caller decides, because only the caller knows which stages have a
   * screen and which have been passed.
   */
  href?: string;
  /**
   * A stage on an optional branch rather than on the main line.
   *
   * Drawn smaller, dashed and unnumbered, because numbering it would promise it happens. The
   * caller decides which stops these are; the rail only agrees to draw them differently.
   */
  detour?: boolean;
}

export interface JourneyRailProps {
  stops: readonly JourneyStop[];
  /** Accessible name for the list, e.g. "Objective journey". */
  label: string;
  className?: string;
}

/**
 * Every state carries a word, because the rail says four things at once with colour and shape —
 * done, here, stopped, not yet — and a person who cannot see those gets none of them. The same
 * rule `ProgressStep` follows.
 */
const STATE_LABEL: Record<JourneyState, string> = {
  done: 'done',
  current: 'current stage',
  halted: 'current stage, stopped',
  upcoming: 'not reached',
  optional: 'optional, not on this path',
};

/**
 * A horizontal rail showing where something has got to in a long journey.
 *
 * ## Why this is not `ProgressStep`
 *
 * `ProgressStep` is a vertical list for work that is running now — an analysis with five stages,
 * each with a sub-line. Its connector is absolutely positioned down the left of the markers, so
 * turning it sideways is not a variant but a different geometry. It also has no vocabulary for the
 * two things this needs: a stage that is **current but stopped**, and a stage that is **optional**
 * and may never be visited.
 *
 * ## What it knows, which is nothing
 *
 * Stops, labels and states arrive as props. The rail does not know what an objective is, which is
 * why it lives in the design system at all — `packages/ui` deliberately has no dependency on
 * `@uboss/types`, and a component that imported the domain enum would be the first one to break
 * that. The caller computes the stages; this draws them.
 *
 * ## Numbering
 *
 * Only main-line stops are numbered, and they are numbered by their position on that line rather
 * than in the array — so a detour between stop 2 and stop 3 does not turn the rest of the journey
 * into 4, 5, 6 and leave somebody counting steps that are not theirs.
 */
export function JourneyRail({ stops, label, className }: JourneyRailProps) {
  let mainLinePosition = 0;

  /*
   * Open the rail where the person actually is.
   *
   * A journey of ten stages does not fit on a laptop, so the rail scrolls — and a rail that opens
   * at stage 1 when the objective is at stage 7 hides the one thing somebody came to see. It
   * scrolls the current stop into view on mount and whenever that stop changes.
   *
   * `block: 'nearest'` so it never scrolls the page itself: the rail sits under a sticky header,
   * and a vertical jump on load is worse than the horizontal one it is fixing.
   *
   * `inline: 'nearest'` and not `'center'`. Centring was tried and it scrolls even when the stage
   * is already on screen — on a `WorkflowDraft` objective it pushed Draft and Review off the left
   * edge to centre a stop that was perfectly visible, hiding exactly the stages somebody goes back
   * to. `nearest` moves the minimum, which is usually nothing.
   */
  const railRef = useRef<HTMLOListElement | null>(null);
  const here = stops.find((stop) => stop.state === 'current' || stop.state === 'halted')?.key;

  useEffect(() => {
    if (here === undefined) return;
    const rail = railRef.current;
    if (rail === null) return;

    const stop = rail.querySelector(`[data-stop="${CSS.escape(here)}"]`);
    // Nothing to do when the whole rail already fits, which is the common case on a wide screen.
    if (stop === null || rail.scrollWidth <= rail.clientWidth) return;

    stop.scrollIntoView({ block: 'nearest', inline: 'nearest' });
  }, [here]);

  return (
    /*
      An ordered list, because the order is the meaning. A row of divs would read to a screen
      reader as six unrelated labels, which is exactly the information this component exists to
      add.
    */
    <ol className={cn('uboss-journey', className)} aria-label={label} ref={railRef}>
      {stops.map((stop) => {
        const detour = stop.detour === true;
        if (!detour) mainLinePosition += 1;

        /** What a screen reader should hear: the full name when there is one, else the label. */
        const spoken = stop.fullLabel ?? stop.label;

        const body = (
          <>
            <span className="uboss-journey-marker" aria-hidden="true">
              {stop.state === 'done' ? (
                <Icon name="check" size={13} />
              ) : stop.state === 'halted' ? (
                <Icon name="pause" size={12} />
              ) : detour ? (
                <Icon name="minus" size={12} />
              ) : (
                mainLinePosition
              )}
            </span>
            {/*
              The short name is drawn; the long one replaces it only when it says more.

              `aria-hidden` on the visible text and the whole name beside it, rather than a `title`
              attribute — a title is a tooltip, it is not reliably announced, and somebody using a
              screen reader would otherwise be told "Review" where the product everywhere else says
              "Submitted / Under Review".

              The equality check is not a micro-optimisation. Half the stages are already one word,
              so `fullLabel` repeats `label` exactly — and the markup then held the name twice. It
              was invisible and correct to a screen reader, and it came out as "DraftDraft — done"
              the moment anybody selected the text or read `innerText`. Reported from a copy-paste,
              which is the only way anyone would ever have seen it.
            */}
            <span className="uboss-journey-label">
              {spoken === stop.label ? (
                <span>
                  {stop.label}
                  <span className="uboss-sr-only"> — {STATE_LABEL[stop.state]}</span>
                </span>
              ) : (
                <>
                  <span aria-hidden="true">{stop.label}</span>
                  <span className="uboss-sr-only">
                    {spoken} — {STATE_LABEL[stop.state]}
                  </span>
                </>
              )}
            </span>
          </>
        );

        return (
          <li
            key={stop.key}
            data-stop={stop.key}
            className={cn(
              'uboss-journey-stop',
              `uboss-journey-stop--${stop.state}`,
              detour && 'uboss-journey-stop--detour',
              stop.href !== undefined && 'uboss-journey-stop--open',
            )}
            /*
              `aria-current="step"` on the one the person is at, which is what assistive technology
              looks for in a progress sequence. A halted stage is still where they are, so it gets
              it too — the word "stopped" in the label is what distinguishes them.
            */
            {...(stop.state === 'current' || stop.state === 'halted'
              ? { 'aria-current': 'step' as const }
              : {})}
          >
            {/*
              A stage you can open is a real link, not a click handler.

              It has to survive middle-click, Ctrl-click and "open in new tab" — going back to the
              form to check something while keeping the workflow open is the obvious thing to want
              here. An `<a href>` gets all of that for nothing, and still works if the router is
              ever not wired.
            */}
            {stop.href === undefined ? (
              body
            ) : (
              <a className="uboss-journey-open" href={stop.href}>
                {body}
              </a>
            )}
          </li>
        );
      })}
    </ol>
  );
}
