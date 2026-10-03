'use client';

import { useEffect, useRef, useState, type ReactNode } from 'react';

/**
 * A card that arrives as it is scrolled to.
 *
 * ## Why this and not a scroll library
 *
 * GSAP's ScrollTrigger is already a dependency and would do this in a line. It would also run a
 * callback on every scroll frame for every element registered, recalculate positions on resize,
 * and pull its own raf loop into a page whose only requirement is "move this once when it appears".
 * An `IntersectionObserver` does that natively: the browser tells the page when the element
 * crosses the line, once, and then the observer stops watching it.
 *
 * The heavy library earns its place where the animation is *driven* by scroll position — a value
 * that tracks the scrollbar. Nothing here does. The cards come in and stay in.
 *
 * ## It never hides content that has not moved
 *
 * The starting state is applied by a class the component adds **after mount**. A visitor whose
 * JavaScript failed, or a crawler, gets the markup with no class on it and sees everything — a
 * reveal implemented as `opacity: 0` in the stylesheet is a page that is blank when the script
 * does not run, and that failure is invisible until somebody reports a blank page.
 *
 * ## Reduced motion
 *
 * No observer is created at all. The content is simply there, at rest, in its final position —
 * not faded in quickly, which is still movement, and not tracked by an observer that will never do
 * anything.
 */
export function Reveal({
  children,
  /** Order within a group, so a row of cards arrives one after another rather than all at once. */
  index = 0,
  className,
  as: Tag = 'div',
}: {
  children: ReactNode;
  index?: number;
  className?: string | undefined;
  as?: 'div' | 'li' | 'section' | 'article';
}): React.JSX.Element {
  const ref = useRef<HTMLElement | null>(null);
  const [armed, setArmed] = useState(false);
  const [shown, setShown] = useState(false);

  useEffect(() => {
    if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
      setShown(true);
      return;
    }

    // Armed only now: before this the element carries no starting state, so it is visible to
    // anything that never runs this effect.
    setArmed(true);

    const node = ref.current;
    if (node === null) return;

    /*
     * Something already on screen at mount is shown immediately and without movement.
     *
     * The observer fires for those too, which would animate the top of the page *after* it had
     * painted — the hero's own content sliding in a moment late, which reads as a page that
     * loaded wrong rather than as a nice effect.
     */
    if (node.getBoundingClientRect().top < window.innerHeight * 0.9) {
      setShown(true);
      return;
    }

    const observer = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          if (entry.isIntersecting) {
            setShown(true);
            observer.disconnect();
          }
        }
      },
      // A little before the edge, so a card is in place by the time it is properly in view rather
      // than starting to move once the reader is already looking at it.
      { rootMargin: '0px 0px -12% 0px', threshold: 0.05 },
    );

    observer.observe(node);
    return () => observer.disconnect();
  }, []);

  return (
    <Tag
      ref={ref as never}
      className={[className, armed ? 'reveal' : null, shown ? 'is-in' : null]
        .filter(Boolean)
        .join(' ')}
      style={armed && !shown ? { transitionDelay: `${Math.min(index, 6) * 70}ms` } : undefined}
    >
      {children}
    </Tag>
  );
}
