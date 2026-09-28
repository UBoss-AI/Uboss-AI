'use client';

import { motion, useReducedMotion } from 'framer-motion';
import { ArrowRight } from 'lucide-react';

import { FlowDiagram } from '@/components/FlowDiagram';
import { Button } from '@/components/ui';

/**
 * The hero.
 *
 * One claim, one sentence of support, two routes onward, and then the thing the claim is about.
 * The headline is deliberately about the customer's problem rather than the product's category:
 * "AI-driven workforce operating system" is what it *is*, and that is the eyebrow — what it *does*
 * is turn objectives into work that gets done, and that is the headline.
 */
export function Hero() {
  const still = useReducedMotion() === true;
  /* Same props either way — only the duration changes. See the note on `Reveal`. */
  const rise = (delay: number) => ({
    initial: { opacity: 0, y: 22 },
    animate: { opacity: 1, y: 0 },
    transition: still
      ? { duration: 0 }
      : { duration: 0.8, delay, ease: [0.16, 1, 0.3, 1] as const },
  });

  return (
    <section className="relative isolate overflow-hidden bg-black u-grain pt-[68px]">
      <div className="u-glow" aria-hidden="true" />

      <div className="relative mx-auto w-full max-w-[1200px] px-6 pb-20 pt-16 sm:px-8 md:pb-28 md:pt-24 lg:px-10">
        <div className="mx-auto max-w-[900px] text-center">
          <motion.p
            {...rise(0)}
            className="mb-7 text-[11px] font-medium uppercase tracking-[0.26em] text-[#a78bfa]"
          >
            AI-Driven Workforce Operating System
          </motion.p>

          <motion.h1
            {...rise(0.08)}
            className="text-[clamp(2.5rem,6.2vw,4.9rem)] font-semibold leading-[1.02] tracking-[-0.035em] text-white"
          >
            Turn business objectives
            <br className="hidden sm:block" />{' '}
            <span className="bg-gradient-to-r from-white via-white to-[#c4b5fd] bg-clip-text text-transparent">
              into work that gets done.
            </span>
          </motion.h1>

          <motion.p
            {...rise(0.16)}
            className="mx-auto mt-7 max-w-[60ch] text-[17px] leading-[1.65] text-[#a1a1aa] sm:text-[18px]"
          >
            UBOSS connects human teams and governed AI Agents in one operating system — from
            objectives and workflows to approvals, execution, monitoring and measurable outcomes.
          </motion.p>

          <motion.div
            {...rise(0.24)}
            className="mt-10 flex flex-col items-center justify-center gap-3 sm:flex-row"
          >
            <Button href="/demo" className="w-full sm:w-auto">
              Book a Demo
              <ArrowRight size={16} />
            </Button>
            <Button href="/#platform" variant="ghost" className="w-full sm:w-auto">
              Explore the Platform
            </Button>
          </motion.div>
        </div>

        <motion.div
          initial={{ opacity: 0, y: 34 }}
          animate={{ opacity: 1, y: 0 }}
          transition={
            still ? { duration: 0 } : { duration: 1, delay: 0.34, ease: [0.16, 1, 0.3, 1] }
          }
          className="relative mx-auto mt-16 max-w-[980px] md:mt-20"
        >
          <div className="rounded-3xl border border-white/8 bg-[#050505]/70 p-5 u-dots sm:p-8">
            <FlowDiagram />
          </div>
        </motion.div>
      </div>
    </section>
  );
}
