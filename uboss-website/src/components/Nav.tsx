'use client';

/**
 * The sticky navigation.
 *
 * It starts transparent over the hero and takes on a surface once the page has moved, which is the
 * one transition the brief asks for. The threshold is 24px rather than 0 so a trackpad's idle
 * jitter at the top of the page does not make it flicker.
 */

import { AnimatePresence, motion, useReducedMotion } from 'framer-motion';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { Menu, X } from 'lucide-react';
import { useEffect, useState } from 'react';

import { PRODUCT_START_URL } from '@/lib/product-login';

import { Button, cn } from './ui';

const LINKS: readonly { label: string; href: string }[] = [
  { label: 'Product', href: '/platform' },
  { label: 'Solutions', href: '/solutions' },
  { label: 'Connect', href: '/connect' },
  { label: 'Pricing', href: '/pricing' },
  { label: 'Security', href: '/security' },
  { label: 'Company', href: '/company' },
];

export function Nav() {
  const pathname = usePathname();
  const [moved, setMoved] = useState(false);
  const [open, setOpen] = useState(false);
  const still = useReducedMotion();

  useEffect(() => {
    const onScroll = () => setMoved(window.scrollY > 24);
    onScroll();
    window.addEventListener('scroll', onScroll, { passive: true });
    return () => window.removeEventListener('scroll', onScroll);
  }, []);

  // A menu that stays open while the page scrolls behind it is a menu somebody has lost.
  useEffect(() => {
    if (!open) return;
    const close = () => setOpen(false);
    const escape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        setOpen(false);
        document.getElementById('mobile-menu-button')?.focus();
      }
    };
    window.addEventListener('resize', close);
    document.addEventListener('keydown', escape);
    return () => {
      window.removeEventListener('resize', close);
      document.removeEventListener('keydown', escape);
    };
  }, [open]);

  return (
    <header
      className={cn(
        'site-nav fixed inset-x-0 top-0 z-50 transition-all duration-500',
        moved
          ? 'border-b border-white/8 bg-black/70 backdrop-blur-xl'
          : 'border-b border-transparent bg-transparent',
      )}
    >
      <nav
        aria-label="Main"
        className="mx-auto flex h-[68px] w-full max-w-[1200px] items-center justify-between px-6 sm:px-8 lg:px-10"
      >
        <Link
          href="/"
          className="flex items-center gap-2.5"
          aria-label="Chief Agent — Powered by UBoss AI — home"
        >
          <span className="grid h-7 w-7 place-items-center rounded-[9px] bg-gradient-to-br from-[#a78bfa] to-[#7c3aed] text-[13px] font-bold text-white">
            U
          </span>
          <span className="text-[15px] font-semibold leading-tight tracking-[-0.01em]">
            Chief Agent
            <small className="block pt-0.5 text-[9px] font-medium tracking-normal text-[#a1a1aa]">
              Powered by UBoss AI
            </small>
          </span>
        </Link>

        <ul className="hidden items-center gap-7 lg:flex">
          {LINKS.map((link) => (
            <li key={link.label}>
              <Link
                href={link.href}
                aria-current={pathname === link.href ? 'page' : undefined}
                className={`text-[13.5px] transition-colors duration-200 hover:text-white ${pathname === link.href ? 'text-white' : 'text-[#a1a1aa]'}`}
              >
                {link.label}
              </Link>
            </li>
          ))}
        </ul>

        {/*
          Sign in, and start.

          The primary button was "Book a Demo", so the only two things this header offered were
          signing in to a workspace you already had and asking somebody to call you. A visitor who
          wanted to create one had nowhere to press: self-serve registration existed and nothing
          in the site's chrome reached it, on any page.

          Where the product's address is not configured, the demo form is the honest fallback —
          it is the one route that always exists.
        */}
        <div className="hidden items-center gap-3 lg:flex">
          <Button href="/sign-in" variant="ghost" size="sm">
            Sign In
          </Button>
          <Button href={PRODUCT_START_URL === '' ? '/demo' : PRODUCT_START_URL} size="sm">
            {PRODUCT_START_URL === '' ? 'Book a Demo' : 'Start a workspace'}
          </Button>
        </div>

        <button
          id="mobile-menu-button"
          type="button"
          onClick={() => setOpen((v) => !v)}
          aria-expanded={open}
          aria-controls="mobile-nav"
          aria-label={open ? 'Close menu' : 'Open menu'}
          className="grid h-10 w-10 place-items-center rounded-lg border border-white/12 text-[#f4f4f5] lg:hidden"
        >
          {open ? <X size={18} /> : <Menu size={18} />}
        </button>
      </nav>

      <AnimatePresence>
        {open ? (
          <motion.div
            id="mobile-nav"
            initial={still === true ? false : { opacity: 0, height: 0 }}
            animate={still === true ? {} : { opacity: 1, height: 'auto' }}
            exit={still === true ? {} : { opacity: 0, height: 0 }}
            transition={{ duration: 0.28, ease: [0.16, 1, 0.3, 1] }}
            className="overflow-hidden border-t border-white/8 bg-black/95 backdrop-blur-xl lg:hidden"
          >
            <ul className="mx-auto flex max-w-[1200px] flex-col gap-1 px-6 py-5 sm:px-8">
              {LINKS.map((link) => (
                <li key={link.label}>
                  <Link
                    href={link.href}
                    onClick={() => setOpen(false)}
                    aria-current={pathname === link.href ? 'page' : undefined}
                    className={`block rounded-lg px-3 py-2.5 text-[15px] transition-colors hover:bg-white/[0.04] hover:text-white ${pathname === link.href ? 'bg-white/[0.04] text-white' : 'text-[#a1a1aa]'}`}
                  >
                    {link.label}
                  </Link>
                </li>
              ))}
              <li className="mt-3 flex gap-3 px-3" onClick={() => setOpen(false)}>
                <Button href="/sign-in" variant="ghost" size="sm" className="flex-1">
                  Sign In
                </Button>
                <Button
                  href={PRODUCT_START_URL === '' ? '/demo' : PRODUCT_START_URL}
                  size="sm"
                  className="flex-1"
                >
                  {PRODUCT_START_URL === '' ? 'Book a Demo' : 'Start a workspace'}
                </Button>
              </li>
            </ul>
          </motion.div>
        ) : null}
      </AnimatePresence>
    </header>
  );
}
