'use client';

import { usePathname } from 'next/navigation';
import { useEffect } from 'react';

/**
 * Brings the page's blocks in as they are scrolled to, across every route.
 *
 * ## Why one component rather than a wrapper on every block
 *
 * The site has fifteen section components written before this existed, each with its own card
 * markup. Wrapping every one of them in a `<Reveal>` would be fifteen files edited to add nothing
 * but a class — and the sixteenth section, written next month, would be the one somebody forgot.
 *
 * This observes the blocks by selector instead. The list below is explicit and the reason for each
 * entry is written beside it: a component that silently animated *everything* would catch the
 * footer, the nav and the hero, and a reveal you cannot predict is worse than none.
 *
 * ## It is not allowed to hide anything permanently
 *
 * Two safeguards, and both matter more than the effect:
 *
 *   * The starting state is a class this file adds. Markup ships visible, so a crawler, a reader
 *     with JavaScript off, or a browser where this throws all see the page — a reveal written as
 *     `opacity: 0` in the stylesheet is a blank page whenever the script does not run, and nothing
 *     reports it.
 *   * Anything already on screen when the page loads is marked shown without being armed at all.
 *     Otherwise the top of a page animates *after* it has painted, which reads as a page that
 *     loaded wrong.
 *
 * ## Reduced motion
 *
 * Nothing is armed and no observer is created. Not a faster animation — none.
 */

/**
 * What gets revealed, and why each one is here.
 *
 * Deliberately blocks, never text: a paragraph that fades in is a paragraph somebody is already
 * reading by the time it arrives. These are the things a reader scans rather than reads.
 */
const SELECTORS = [
  '.skill-layers > div', // the three catalogue layers
  '.solution-panel', // a department's panel on Solutions
  '.governance-points > li', // the control claims
  '.pricing-card', // the older pricing cards, where they are still used
  '.section-heading', // a section's own title block
  '.product-window', // the product illustrations
  '.governance-visual',
  '.closing-cta',
].join(', ');

export function ScrollReveal(): null {
  /*
   * Re-run on navigation.
   *
   * These are client-side route changes: the component never unmounts, so without the pathname in
   * the dependency list the second page a visitor opens would have its blocks armed by nobody and
   * sit at rest — which is fine — or, worse, arrive already armed from the previous page and stay
   * invisible.
   */
  const pathname = usePathname();

  useEffect(() => {
    if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;

    /*
     * After paint, not during.
     *
     * Arming an element in the same frame it renders means the browser may never see the starting
     * state as a separate style — it computes the final one and there is nothing to transition
     * from. A frame's delay is what makes the transition run at all.
     */
    const frame = window.requestAnimationFrame(() => {
      const blocks = Array.from(document.querySelectorAll<HTMLElement>(SELECTORS));
      const waiting: HTMLElement[] = [];

      blocks.forEach((block, index) => {
        if (block.dataset['revealed'] === 'yes') return;
        block.dataset['revealed'] = 'yes';

        // On screen already: shown, and never armed, so the top of the page does not move after it
        // has painted.
        if (block.getBoundingClientRect().top < window.innerHeight * 0.92) {
          block.classList.add('reveal', 'is-in');
          return;
        }

        block.classList.add('reveal');
        // A short stagger within a group, capped, so a grid arrives as a sequence rather than as
        // one block and never takes longer than half a second to finish.
        block.style.transitionDelay = `${Math.min(index % 4, 3) * 70}ms`;
        waiting.push(block);
      });

      if (waiting.length === 0) return;

      const observer = new IntersectionObserver(
        (entries) => {
          for (const entry of entries) {
            if (!entry.isIntersecting) continue;
            entry.target.classList.add('is-in');
            observer.unobserve(entry.target);
          }
        },
        { rootMargin: '0px 0px -10% 0px', threshold: 0.04 },
      );

      for (const block of waiting) observer.observe(block);

      cleanup = () => observer.disconnect();
    });

    let cleanup: (() => void) | null = null;
    return () => {
      window.cancelAnimationFrame(frame);
      cleanup?.();
    };
  }, [pathname]);

  return null;
}
