'use client';

/**
 * Objective Optimization, and the split between human and AI work.
 *
 * Two sections that belong together: the first shows an objective becoming a workflow, the second
 * shows what happens to each half of that workflow. The transformation is animated as three
 * states of one panel rather than three separate pictures, because the point is that it is the
 * same record throughout.
 */

import { motion, useReducedMotion } from 'framer-motion';
import {
  CheckCircle2,
  ClipboardList,
  FileText,
  GitBranch,
  Lock,
  MessagesSquare,
  Play,
  ShieldCheck,
  Sparkles,
  TestTube2,
  Wrench,
} from 'lucide-react';
import { useEffect, useState } from 'react';

import { Card, Eyebrow, Heading, Lede, Pill, Reveal, Section } from '@/components/ui';

const STAGES = ['Form 2', 'Analysis', 'Workflow'] as const;

/** The three states of the same objective record, drawn as one panel that changes. */
function Transformation() {
  const [stage, setStage] = useState(0);
  const still = useReducedMotion() === true;

  useEffect(() => {
    if (still) return;
    const timer = window.setInterval(() => setStage((s) => (s + 1) % STAGES.length), 3200);
    return () => window.clearInterval(timer);
  }, [still]);

  return (
    <div className="overflow-hidden rounded-2xl border border-white/8 bg-[#09090b]">
      <div className="flex items-center gap-1 border-b border-white/8 px-4 py-3">
        {STAGES.map((name, i) => (
          <button
            key={name}
            type="button"
            onClick={() => setStage(i)}
            aria-pressed={stage === i}
            className={`rounded-full px-3 py-1 text-[11.5px] font-medium tracking-wide transition-colors duration-300 ${
              stage === i ? 'bg-white/10 text-white' : 'text-[#7f7f89] hover:text-[#a1a1aa]'
            }`}
          >
            {name}
          </button>
        ))}
        <span className="ml-auto font-mono text-[11px] text-[#3f3f46]">OPS-2026-017</span>
      </div>

      <div className="relative min-h-[288px] p-5 u-dots sm:p-6">
        <motion.div
          key={stage}
          initial={{ opacity: 0, y: 10 }}
          animate={{ opacity: 1, y: 0 }}
          transition={still ? { duration: 0 } : { duration: 0.45, ease: [0.16, 1, 0.3, 1] }}
        >
          {stage === 0 ? (
            <div className="space-y-3">
              {[
                ['Objective name', 'Field service turnaround for instrument repairs'],
                ['Department', 'Operations'],
                ['Expected final result', 'Every repair returned within 5 working days'],
                ['Current workload', '18 repair jobs'],
                ['Target completion', '5 working days'],
              ].map(([label, value]) => (
                <div
                  key={label}
                  className="flex flex-col gap-1 sm:flex-row sm:items-baseline sm:gap-4"
                >
                  <span className="w-[150px] shrink-0 text-[11px] uppercase tracking-[0.12em] text-[#8b8b93]">
                    {label}
                  </span>
                  <span className="text-[13.5px] text-[#d4d4d8]">{value}</span>
                </div>
              ))}
            </div>
          ) : stage === 1 ? (
            <ul className="space-y-2.5">
              {[
                'Understanding objective',
                'Reading team structure',
                'Detecting human work',
                'Identifying AI work',
                'Matching Skills',
                'Assigning owners',
                'Building workflow',
              ].map((line, i) => (
                <motion.li
                  key={line}
                  initial={{ opacity: 0, x: -8 }}
                  animate={{ opacity: 1, x: 0 }}
                  transition={still ? { duration: 0 } : { duration: 0.3, delay: i * 0.07 }}
                  className="flex items-center gap-3 text-[13.5px] text-[#a1a1aa]"
                >
                  <CheckCircle2 size={14} className="shrink-0 text-[#a78bfa]" />
                  {line}
                </motion.li>
              ))}
            </ul>
          ) : (
            <div className="space-y-2.5">
              {[
                {
                  label: 'Log the instrument and photograph its condition',
                  kind: 'human' as const,
                },
                { label: 'Carry out the repair and record the parts used', kind: 'human' as const },
                { label: 'Draft the signed service record', kind: 'ai' as const },
                { label: 'Head review and sign-off', kind: 'gate' as const },
              ].map((row, i) => (
                <motion.div
                  key={row.label}
                  initial={{ opacity: 0, y: 8 }}
                  animate={{ opacity: 1, y: 0 }}
                  transition={still ? { duration: 0 } : { duration: 0.34, delay: i * 0.09 }}
                  className={`flex items-center gap-3 rounded-xl border px-4 py-3 ${
                    row.kind === 'ai'
                      ? 'border-[#8b5cf6]/30 bg-[#8b5cf6]/[0.07]'
                      : row.kind === 'gate'
                        ? 'border-[#fbbf24]/25 bg-[#fbbf24]/[0.06]'
                        : 'border-[#22d3ee]/22 bg-[#22d3ee]/[0.05]'
                  }`}
                >
                  <span className="font-mono text-[11px] text-[#8b8b93]">{i + 1}</span>
                  <span className="flex-1 text-[13.5px] text-[#d4d4d8]">{row.label}</span>
                  <Pill tone={row.kind === 'ai' ? 'ai' : row.kind === 'gate' ? 'neutral' : 'human'}>
                    {row.kind === 'ai' ? 'AI' : row.kind === 'gate' ? 'APPROVAL' : 'HUMAN'}
                  </Pill>
                </motion.div>
              ))}
            </div>
          )}
        </motion.div>
      </div>
    </div>
  );
}

export function Objectives() {
  return (
    <Section id="objectives" tone="ink-0" glow>
      <div className="grid gap-14 lg:grid-cols-2 lg:items-center lg:gap-20">
        <Reveal>
          <Eyebrow>Objective Optimization</Eyebrow>
          <Heading>
            Start with the outcome.
            <br />
            UBOSS works backwards.
          </Heading>
          <Lede className="mt-6">
            A manager states what the business needs to be true. UBOSS turns it into the work that
            makes it true — responsibilities, a workflow, the human tasks and the AI tasks, what
            each depends on, what has to be approved, what counts as evidence and what counts as
            done.
          </Lede>
          <ul className="mt-8 grid gap-3 sm:grid-cols-2">
            {[
              'Responsibilities',
              'Workflow steps',
              'Human tasks',
              'AI tasks',
              'Dependencies',
              'Approval gates',
              'Required evidence',
              'Definition of Done',
            ].map((item) => (
              <li key={item} className="flex items-center gap-2.5 text-[14px] text-[#a1a1aa]">
                <span className="h-1 w-1 rounded-full bg-[#8b5cf6]" aria-hidden="true" />
                {item}
              </li>
            ))}
          </ul>
        </Reveal>

        <Reveal delay={0.1}>
          <Transformation />
          <p className="mt-3 text-[12px] text-[#8b8b93]">
            Product illustration of Objective Optimization. Not customer data.
          </p>
        </Reveal>
      </div>
    </Section>
  );
}

const HUMAN = [
  { icon: ClipboardList, label: 'Assigned responsibilities' },
  { icon: FileText, label: 'To-do with criteria' },
  { icon: CheckCircle2, label: 'Evidence on completion' },
  { icon: MessagesSquare, label: 'Collaboration in context' },
  { icon: ShieldCheck, label: 'Approvals' },
  { icon: Lock, label: 'Accountability that does not move' },
];

const AI = [
  { icon: Sparkles, label: 'Governed Skills' },
  { icon: GitBranch, label: 'Job Agents' },
  { icon: Wrench, label: 'Approved tools only' },
  { icon: Lock, label: 'Controlled connections' },
  { icon: TestTube2, label: 'Tested before activation' },
  { icon: Play, label: 'Monitored runs' },
];

export function Workforce() {
  return (
    <Section id="workforce" tone="ink-1">
      <Reveal className="mx-auto max-w-[760px] text-center">
        <Eyebrow>One workforce, two kinds of worker</Eyebrow>
        <Heading>
          Humans remain accountable.
          <br />
          AI handles approved repeatable work.
        </Heading>
      </Reveal>

      <div className="mt-16 grid gap-5 lg:grid-cols-[1fr_auto_1fr] lg:items-stretch lg:gap-0">
        <Reveal>
          <Card className="h-full border-[#22d3ee]/16 bg-gradient-to-b from-[#22d3ee]/[0.05] to-transparent lg:rounded-r-none lg:border-r-0">
            <Pill tone="human">HUMAN WORK</Pill>
            <h3 className="mt-5 text-[22px] font-medium tracking-[-0.015em] text-white">
              People decide, judge and own
            </h3>
            <ul className="mt-6 space-y-3.5">
              {HUMAN.map(({ icon: Icon, label }) => (
                <li key={label} className="flex items-center gap-3 text-[14px] text-[#a1a1aa]">
                  <Icon size={15} className="shrink-0 text-[#67e8f9]" />
                  {label}
                </li>
              ))}
            </ul>
          </Card>
        </Reveal>

        {/* The orchestration layer, drawn as the seam between the two. */}
        <Reveal delay={0.08} className="flex items-center justify-center lg:px-0">
          <div className="flex w-full items-center justify-center lg:h-full lg:w-[104px]">
            <div className="flex w-full flex-row items-center gap-3 lg:h-full lg:w-auto lg:flex-col">
              <span className="h-px flex-1 bg-gradient-to-r from-[#22d3ee]/40 to-[#8b5cf6]/40 lg:h-full lg:w-px lg:flex-1 lg:bg-gradient-to-b" />
              <span className="grid shrink-0 place-items-center rounded-2xl border border-white/12 bg-[#111113] px-4 py-3 text-center">
                <span className="text-[10px] font-semibold uppercase tracking-[0.14em] text-white">
                  UBOSS
                </span>
                <span className="mt-0.5 text-[9.5px] uppercase tracking-[0.1em] text-[#7f7f89]">
                  Orchestration
                </span>
              </span>
              <span className="h-px flex-1 bg-gradient-to-r from-[#8b5cf6]/40 to-[#22d3ee]/40 lg:h-full lg:w-px lg:flex-1 lg:bg-gradient-to-b" />
            </div>
          </div>
        </Reveal>

        <Reveal delay={0.16}>
          <Card className="h-full border-[#8b5cf6]/16 bg-gradient-to-b from-[#8b5cf6]/[0.06] to-transparent lg:rounded-l-none lg:border-l-0">
            <Pill tone="ai">AI WORK</Pill>
            <h3 className="mt-5 text-[22px] font-medium tracking-[-0.015em] text-white">
              Agents execute inside their limits
            </h3>
            <ul className="mt-6 space-y-3.5">
              {AI.map(({ icon: Icon, label }) => (
                <li key={label} className="flex items-center gap-3 text-[14px] text-[#a1a1aa]">
                  <Icon size={15} className="shrink-0 text-[#c4b5fd]" />
                  {label}
                </li>
              ))}
            </ul>
          </Card>
        </Reveal>
      </div>
    </Section>
  );
}
