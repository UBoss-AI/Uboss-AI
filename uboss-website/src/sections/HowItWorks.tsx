'use client';

/**
 * From objective to execution — the ten steps, as one narrative rather than ten cards.
 *
 * The brief asks for a cinematic scroll section and explicitly prefers one strong visual to ten
 * disconnected cards. So the steps are a single sticky spine: the list scrolls, the active step
 * lights, and the panel beside it changes. On a phone the same content stacks, because a sticky
 * two-column narrative at 390px is just a column that jumps.
 */

import { motion, useReducedMotion } from 'framer-motion';
import { useEffect, useRef, useState } from 'react';

import { Eyebrow, Heading, Lede, Section } from '@/components/ui';

interface Step {
  n: string;
  title: string;
  body: string;
  actor: 'Manager' | 'UBOSS' | 'Head' | 'Employee' | 'Executor';
}

const STEPS: readonly Step[] = [
  {
    n: '01',
    title: 'Define the objective',
    body: 'A manager states the business outcome, the volume it applies to and when it has to be true by. Not a task list — the result.',
    actor: 'Manager',
  },
  {
    n: '02',
    title: 'UBOSS analyses the work',
    body: 'The objective and its source grid are decomposed into the steps that actually produce it, with the inputs, outputs and hand-offs each one needs.',
    actor: 'UBOSS',
  },
  {
    n: '03',
    title: 'A human and AI workflow appears',
    body: 'Every step is classified. Work that needs judgement stays with a person; work that is repeatable and governed becomes AI work.',
    actor: 'UBOSS',
  },
  {
    n: '04',
    title: 'The manager reviews it',
    body: 'Owners, dependencies, approvals and each step’s Definition of Done are the manager’s to change. The analysis proposes; it does not decide.',
    actor: 'Manager',
  },
  {
    n: '05',
    title: 'Approve and assign',
    body: 'One transaction hands the work out. It refuses while anything would put work in front of nobody, and says exactly what is missing.',
    actor: 'Head',
  },
  {
    n: '06',
    title: 'Human work reaches To-do',
    body: 'Each person sees their own assigned work with its criteria and the evidence it expects. The assignee stays the assignee; a manager watching does not become the owner.',
    actor: 'Employee',
  },
  {
    n: '07',
    title: 'AI work becomes a Job Agent',
    body: 'The AI step is matched to an approved, published Skill and built into an Agent for the person whose work it is — by somebody authorised to build, not by them.',
    actor: 'Manager',
  },
  {
    n: '08',
    title: 'Executor watches it run',
    body: 'Overdue work, failed runs, missing evidence, unavailable connections and approvals waiting too long are surfaced as exceptions with an owner.',
    actor: 'Executor',
  },
  {
    n: '09',
    title: 'Approvals gate what matters',
    body: 'Consequential actions wait for a person. No self-approval, four-eyes where configured, and every decision on the record with its reason.',
    actor: 'Head',
  },
  {
    n: '10',
    title: 'Outcomes become visible',
    body: 'Progress, human and AI split, exceptions, approval aging and governed AI usage — reported against the objective that asked for them.',
    actor: 'UBOSS',
  },
];

const ACTOR_TONE: Record<Step['actor'], string> = {
  Manager: 'text-[#a5f3fc] border-[#22d3ee]/30 bg-[#22d3ee]/10',
  UBOSS: 'text-[#ddd6fe] border-[#8b5cf6]/35 bg-[#8b5cf6]/10',
  Head: 'text-[#fde68a] border-[#fbbf24]/30 bg-[#fbbf24]/10',
  Employee: 'text-[#a5f3fc] border-[#22d3ee]/30 bg-[#22d3ee]/10',
  Executor: 'text-[#6ee7b7] border-[#34d399]/30 bg-[#34d399]/10',
};

export function HowItWorks() {
  const [active, setActive] = useState(0);
  const refs = useRef<(HTMLLIElement | null)[]>([]);
  const still = useReducedMotion() === true;

  /*
   * Which step is the reader on? An observer on each row rather than a scroll listener doing
   * arithmetic: the browser already knows, and asking it costs nothing per frame.
   */
  useEffect(() => {
    const seen = new Map<number, number>();
    const observer = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          const index = Number(entry.target.getAttribute('data-step'));
          seen.set(index, entry.intersectionRatio);
        }
        let best = 0;
        let bestRatio = 0;
        for (const [index, ratio] of seen) {
          if (ratio > bestRatio) {
            bestRatio = ratio;
            best = index;
          }
        }
        if (bestRatio > 0) setActive(best);
      },
      { rootMargin: '-45% 0px -45% 0px', threshold: [0, 0.5, 1] },
    );
    for (const node of refs.current) if (node !== null) observer.observe(node);
    return () => observer.disconnect();
  }, []);

  const current = STEPS[active] ?? STEPS[0];
  if (current === undefined) return null;

  return (
    <Section id="how-it-works" tone="ink-1">
      <div className="max-w-[720px]">
        <Eyebrow>From objective to execution</Eyebrow>
        <Heading>Ten steps. One system.</Heading>
        <Lede className="mt-6">
          Nothing here is a hand-off between tools. The objective a manager writes is the same
          record the work is assigned from, the approvals hang off, and the outcome is measured
          against.
        </Lede>
      </div>

      <div className="mt-16 grid gap-10 lg:grid-cols-[1fr_420px] lg:gap-16">
        <ol className="space-y-1">
          {STEPS.map((step, i) => {
            const on = i === active;
            return (
              <li
                key={step.n}
                data-step={i}
                ref={(node) => {
                  refs.current[i] = node;
                }}
                className="group relative border-l border-white/8 py-5 pl-7 transition-colors duration-500 lg:py-6"
              >
                <span
                  className={`absolute -left-px top-0 h-full w-[2px] transition-all duration-500 ${
                    on ? 'bg-gradient-to-b from-[#8b5cf6] to-[#22d3ee] opacity-100' : 'opacity-0'
                  }`}
                  aria-hidden="true"
                />
                <div className="flex flex-wrap items-center gap-3">
                  <span
                    className={`font-mono text-[12px] transition-colors duration-500 ${
                      on ? 'text-[#a78bfa]' : 'text-[#8b8b93]'
                    }`}
                  >
                    {step.n}
                  </span>
                  <h3
                    className={`text-[19px] font-medium tracking-[-0.01em] transition-colors duration-500 sm:text-[21px] ${
                      on ? 'text-white' : 'text-[#8b8b93]'
                    }`}
                  >
                    {step.title}
                  </h3>
                  <span
                    className={`rounded-full border px-2 py-0.5 text-[10.5px] font-medium tracking-wide transition-opacity duration-500 ${ACTOR_TONE[step.actor]} ${on ? 'opacity-100' : 'opacity-45'}`}
                  >
                    {step.actor}
                  </span>
                </div>
                <p
                  className={`mt-2 max-w-[56ch] text-[14.5px] leading-[1.6] transition-colors duration-500 ${
                    on ? 'text-[#a1a1aa]' : 'text-[#8b8b93]'
                  }`}
                >
                  {step.body}
                </p>
              </li>
            );
          })}
        </ol>

        {/* The panel. Sticky on large screens, where there is room for it to stay put. */}
        <div className="hidden lg:block">
          <div className="sticky top-28">
            <div className="relative overflow-hidden rounded-2xl border border-white/8 bg-[#09090b] p-8 u-dots">
              <div className="absolute inset-x-0 top-0 h-px bg-gradient-to-r from-transparent via-[#8b5cf6]/50 to-transparent" />
              <motion.div
                key={current.n}
                initial={{ opacity: 0, y: 12 }}
                animate={{ opacity: 1, y: 0 }}
                transition={still ? { duration: 0 } : { duration: 0.45, ease: [0.16, 1, 0.3, 1] }}
              >
                <span className="font-mono text-[42px] font-semibold leading-none text-white/10">
                  {current.n}
                </span>
                <h4 className="mt-5 text-[22px] font-medium tracking-[-0.015em] text-white">
                  {current.title}
                </h4>
                <p className="mt-4 text-[14.5px] leading-[1.65] text-[#a1a1aa]">{current.body}</p>
                <div className="mt-7 flex items-center gap-2 border-t border-white/8 pt-5">
                  <span className="text-[11px] uppercase tracking-[0.16em] text-[#8b8b93]">
                    Who acts
                  </span>
                  <span
                    className={`rounded-full border px-2.5 py-0.5 text-[11px] font-medium ${ACTOR_TONE[current.actor]}`}
                  >
                    {current.actor}
                  </span>
                </div>
              </motion.div>
            </div>
          </div>
        </div>
      </div>
    </Section>
  );
}
