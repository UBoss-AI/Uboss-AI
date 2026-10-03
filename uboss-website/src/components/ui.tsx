'use client';

/**
 * The site's shared vocabulary: a section, a heading, a reveal, a card, a button.
 *
 * Twenty-odd sections written independently would be twenty slightly different paddings and
 * twenty slightly different heading sizes, which is exactly what makes a long page feel like a
 * template. These are the only places those decisions are made.
 */

import { motion, useReducedMotion } from 'framer-motion';
import Link from 'next/link';
import type { ReactNode } from 'react';

export function cn(...parts: (string | false | null | undefined)[]): string {
  return parts.filter(Boolean).join(' ');
}

/**
 * A section, with the page's one horizontal rhythm.
 *
 * `tone` picks which of the four surfaces it sits on. Alternating them is what gives a long
 * scroll its structure without a single divider line.
 */
export function Section({
  id,
  tone = 'ink-0',
  glow = false,
  className,
  children,
}: {
  id?: string;
  tone?: 'ink-0' | 'ink-1' | 'ink-2';
  glow?: boolean;
  className?: string;
  children: ReactNode;
}) {
  const surface =
    tone === 'ink-1' ? 'bg-[#050505]' : tone === 'ink-2' ? 'bg-[#09090b]' : 'bg-black';
  return (
    <section
      {...(id === undefined ? {} : { id })}
      className={cn('relative isolate overflow-hidden u-grain', surface, className)}
    >
      {glow ? <div className="u-glow" aria-hidden="true" /> : null}
      <div className="relative mx-auto w-full max-w-[1200px] px-6 py-24 sm:px-8 md:py-32 lg:px-10">
        {children}
      </div>
    </section>
  );
}

/** The small capitalised line above a heading. Sets the subject in three words. */
export function Eyebrow({ children }: { children: ReactNode }) {
  return (
    <p className="mb-5 text-[11px] font-medium uppercase tracking-[0.22em] text-[#a78bfa]">
      {children}
    </p>
  );
}

/**
 * A section heading.
 *
 * `clamp` rather than breakpoints: the jump between two fixed sizes is visible on a laptop at an
 * awkward width, and a headline is the one thing on the page nobody forgives for jumping.
 */
export function Heading({
  as: Tag = 'h2',
  className,
  children,
}: {
  as?: 'h1' | 'h2' | 'h3';
  className?: string;
  children: ReactNode;
}) {
  const size =
    Tag === 'h1'
      ? 'text-[clamp(2.6rem,6vw,4.75rem)] leading-[1.03]'
      : 'text-[clamp(1.9rem,3.6vw,3.1rem)] leading-[1.08]';
  return (
    <Tag className={cn('font-semibold tracking-[-0.03em] text-[#f4f4f5]', size, className)}>
      {children}
    </Tag>
  );
}

/** Body copy under a heading. One measure, so no section invents its own. */
export function Lede({ className, children }: { className?: string; children: ReactNode }) {
  return (
    <p className={cn('max-w-[62ch] text-[17px] leading-[1.65] text-[#a1a1aa]', className)}>
      {children}
    </p>
  );
}

/**
 * The reveal used everywhere: a short rise and fade as a block enters.
 *
 * It runs once. A section that re-animates every time it passes the viewport turns a scroll back
 * up into a light show, and this is a site executives read rather than play with.
 */
export function Reveal({
  delay = 0,
  className,
  children,
}: {
  delay?: number;
  className?: string;
  children: ReactNode;
}) {
  /*
   * The same element either way.
   *
   * Returning a plain div when motion is reduced changed the tree between the server and the
   * browser, because the server cannot answer a media query — which is a hydration mismatch, not
   * an accessibility feature. Reduced motion shortens the transition to nothing instead; the
   * result on screen is identical and the markup never differs.
   */
  const still = useReducedMotion() === true;
  return (
    <motion.div
      className={className}
      initial={{ opacity: 0, y: 18 }}
      whileInView={{ opacity: 1, y: 0 }}
      viewport={{ once: true, margin: '-80px' }}
      transition={still ? { duration: 0 } : { duration: 0.65, delay, ease: [0.16, 1, 0.3, 1] }}
    >
      {children}
    </motion.div>
  );
}

/** A bordered surface. The site's only card, so every card is the same card. */
export function Card({
  className,
  interactive = false,
  children,
}: {
  className?: string;
  interactive?: boolean;
  children: ReactNode;
}) {
  return (
    <div
      className={cn(
        'rounded-2xl border border-white/8 bg-[#09090b]/80 p-6',
        interactive &&
          'transition-[border-color,background-color,transform] duration-300 hover:-translate-y-0.5 hover:border-white/16 hover:bg-[#111113]/90',
        className,
      )}
    >
      {children}
    </div>
  );
}

/**
 * The site's buttons.
 *
 * `href` is required: there is no button here that does not go somewhere, because there is nothing
 * on a marketing site for a button to do in place. A control that looks pressable and is not is
 * the fastest way to make a polished page feel fake.
 */
export function Button({
  href,
  variant = 'primary',
  size = 'md',
  className,
  children,
}: {
  href: string;
  variant?: 'primary' | 'ghost';
  size?: 'md' | 'sm';
  className?: string;
  children: ReactNode;
}) {
  const base =
    'inline-flex items-center justify-center gap-2 rounded-full font-medium transition-all duration-300 whitespace-nowrap';
  const scale = size === 'sm' ? 'h-9 px-4 text-[13px]' : 'h-11 px-6 text-[14px]';
  const look =
    variant === 'primary'
      ? 'bg-white text-black hover:bg-white/90 hover:shadow-[0_0_40px_-8px_rgba(255,255,255,0.35)]'
      : 'border border-white/14 text-[#f4f4f5] hover:border-white/28 hover:bg-white/[0.04]';

  const external = href.startsWith('http');
  if (external) {
    return (
      <a href={href} className={cn(base, scale, look, className)}>
        {children}
      </a>
    );
  }
  return (
    <Link href={href} className={cn(base, scale, look, className)}>
      {children}
    </Link>
  );
}

/** A small label on a diagram or a card. */
export function Pill({
  tone = 'neutral',
  children,
}: {
  tone?: 'neutral' | 'ai' | 'human';
  children: ReactNode;
}) {
  const look =
    tone === 'ai'
      ? 'border-[#8b5cf6]/35 bg-[#8b5cf6]/10 text-[#c4b5fd]'
      : tone === 'human'
        ? 'border-[#22d3ee]/30 bg-[#22d3ee]/10 text-[#67e8f9]'
        : 'border-white/12 bg-white/[0.04] text-[#a1a1aa]';
  return (
    <span
      className={cn(
        'inline-flex items-center rounded-full border px-2.5 py-0.5 text-[11px] font-medium tracking-wide',
        look,
      )}
    >
      {children}
    </span>
  );
}

/** The fading hairline between two sections. */
export function Rule({ className }: { className?: string }) {
  return <div className={cn('u-rule', className)} aria-hidden="true" />;
}
