'use client';

/**
 * Skill intelligence, and the Agent Builder that uses it.
 *
 * Every figure in this section comes from `@/lib/catalog`, which was read off the running platform
 * catalogue. The count animation only runs on numbers that are real — the brief is explicit that
 * a counter must not be decoration, and a counter that animates to an invented number is the worst
 * version of that.
 */

import { motion, useInView, useReducedMotion } from 'framer-motion';
import { ArrowRight, Boxes, Building2, Layers, Lock, ShieldCheck, TestTube2 } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';

import { Card, Eyebrow, Heading, Lede, Pill, Reveal, Section } from '@/components/ui';
import { CATALOG, CATEGORIES, SAMPLE_SKILLS } from '@/lib/catalog';

/** Counts up to a real number when it comes into view, once. */
function Counter({ to, className }: { to: number; className?: string }) {
  const ref = useRef<HTMLSpanElement>(null);
  const seen = useInView(ref, { once: true, margin: '-60px' });
  const still = useReducedMotion() === true;
  /* Always starts at zero, so the server and the first client paint agree. Reduced motion is
     handled in the effect, which never runs on the server. */
  const [value, setValue] = useState(0);

  useEffect(() => {
    if (!seen) return;
    if (still) {
      setValue(to);
      return;
    }
    const started = performance.now();
    const duration = 1100;
    let frame = 0;
    const tick = (now: number) => {
      const t = Math.min(1, (now - started) / duration);
      // Ease out, so it lands rather than stops.
      setValue(Math.round(to * (1 - (1 - t) ** 3)));
      if (t < 1) frame = requestAnimationFrame(tick);
    };
    frame = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(frame);
  }, [seen, still, to]);

  return (
    <span ref={ref} className={className}>
      {value.toLocaleString('en-US')}
    </span>
  );
}

const LAYERS = [
  {
    icon: ShieldCheck,
    name: 'UBOSS Verified',
    count: CATALOG.ubossVerified,
    body: 'Skills that apply to any company, whatever it makes. Authored and governed at platform level.',
  },
  {
    icon: Boxes,
    name: 'Industry Packs',
    count: CATALOG.industryPack,
    body: `Skills that carry one industry's way of working, across ${CATALOG.industries} industries. Entitled per company.`,
  },
  {
    icon: Building2,
    name: 'Company Custom',
    count: null,
    body: 'Skills a company authors for itself. They stay inside that company and never reach another.',
  },
];

export function Skills() {
  return (
    <Section id="skills" tone="ink-0" glow>
      <div className="grid gap-14 lg:grid-cols-[1fr_1.05fr] lg:items-start lg:gap-20">
        <Reveal>
          <Eyebrow>Skill intelligence</Eyebrow>
          <Heading>
            UBOSS does not send
            <br />
            every task to a generic AI.
          </Heading>
          <Lede className="mt-6">
            It selects a governed Skill — an approved, published, versioned definition of how one
            kind of work is done — and refuses the step when nothing in the catalogue fits.
          </Lede>

          <div className="mt-10 flex flex-wrap gap-x-12 gap-y-6">
            <div>
              <Counter
                to={CATALOG.skills}
                className="block text-[46px] font-semibold leading-none tracking-[-0.04em] text-white"
              />
              <span className="mt-2 block text-[12.5px] uppercase tracking-[0.14em] text-[#7f7f89]">
                Governed Skills
              </span>
            </div>
            <div>
              <Counter
                to={CATALOG.rules}
                className="block text-[46px] font-semibold leading-none tracking-[-0.04em] text-white"
              />
              <span className="mt-2 block text-[12.5px] uppercase tracking-[0.14em] text-[#7f7f89]">
                IF-THEN rules
              </span>
            </div>
          </div>
          <p className="mt-4 max-w-[46ch] text-[12.5px] leading-relaxed text-[#8b8b93]">
            Read from the UBOSS Skill Catalog as it is persisted — {CATALOG.ubossVerified} UBOSS
            Verified and {CATALOG.industryPack} Industry Pack Skills, and the rules their published
            versions carry.
          </p>
        </Reveal>

        <Reveal delay={0.1}>
          <div className="space-y-3">
            {LAYERS.map(({ icon: Icon, name, count, body }) => (
              <Card key={name} interactive className="flex gap-4">
                <span className="mt-0.5 grid h-9 w-9 shrink-0 place-items-center rounded-xl border border-white/10 bg-white/[0.03]">
                  <Icon size={16} className="text-[#a78bfa]" />
                </span>
                <div>
                  <div className="flex items-baseline gap-3">
                    <h3 className="text-[16px] font-medium text-white">{name}</h3>
                    {count === null ? (
                      <Pill>Per company</Pill>
                    ) : (
                      <span className="font-mono text-[12.5px] text-[#a78bfa]">{count}</span>
                    )}
                  </div>
                  <p className="mt-1.5 text-[13.5px] leading-[1.6] text-[#a1a1aa]">{body}</p>
                </div>
              </Card>
            ))}
          </div>
        </Reveal>
      </div>

      {/* How a Skill is chosen. */}
      <Reveal className="mt-20">
        <h3 className="text-[15px] font-medium uppercase tracking-[0.14em] text-[#7f7f89]">
          A Skill is selected against
        </h3>
        <div className="mt-5 flex flex-wrap gap-2">
          {[
            'Objective',
            'Department',
            'Industry',
            'Policy',
            'Required output',
            'Permitted tools',
            'Risk',
            'Approval requirement',
          ].map((item) => (
            <span
              key={item}
              className="rounded-full border border-white/10 bg-white/[0.03] px-3.5 py-1.5 text-[13px] text-[#d4d4d8]"
            >
              {item}
            </span>
          ))}
        </div>
      </Reveal>

      {/* Real categories, with the counts the catalogue actually holds. */}
      <div className="mt-14 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        {CATEGORIES.map((category, i) => (
          <Reveal key={category.name} delay={i * 0.04}>
            <Card interactive className="h-full">
              <div className="flex items-baseline justify-between">
                <h4 className="text-[14.5px] font-medium text-white">{category.name}</h4>
                <span className="font-mono text-[12px] text-[#8b8b93]">{category.count}</span>
              </div>
              <p className="mt-2 text-[13px] leading-[1.6] text-[#7f7f89]">{category.blurb}</p>
            </Card>
          </Reveal>
        ))}
      </div>

      {/* Real Skills, named. */}
      <Reveal className="mt-14">
        <h3 className="mb-5 text-[15px] font-medium uppercase tracking-[0.14em] text-[#7f7f89]">
          From the catalogue
        </h3>
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
          {SAMPLE_SKILLS.map((skill) => (
            <Card key={skill.name} interactive className="flex flex-col gap-2 p-5">
              <div className="flex items-start justify-between gap-3">
                <h4 className="text-[14.5px] font-medium leading-snug text-white">{skill.name}</h4>
                <Pill tone="ai">{skill.category}</Pill>
              </div>
              <p className="text-[12.5px] leading-relaxed text-[#7f7f89]">{skill.department}</p>
            </Card>
          ))}
        </div>
      </Reveal>
    </Section>
  );
}

const BUILD_STEPS = [
  { label: 'Objective context', detail: 'Inherited, read-only' },
  { label: 'Relevant Skills', detail: 'Approved and published only' },
  { label: 'Connection', detail: 'Chosen by identity, never a key' },
  { label: 'Trigger', detail: 'Schedule or upstream step' },
  { label: 'Output', detail: 'What it produces, and to whom' },
  { label: 'Approval', detail: 'Where a person must decide' },
  { label: 'Test', detail: 'Before it can go live' },
  { label: 'Activate', detail: 'A separate decision' },
];

export function Agents() {
  const still = useReducedMotion() === true;

  return (
    <Section id="agents" tone="ink-2">
      <div className="grid gap-14 lg:grid-cols-[1.05fr_1fr] lg:items-center lg:gap-20">
        <Reveal>
          <Eyebrow>Job Agents</Eyebrow>
          <Heading>
            AI workers built for the job,
            <br />
            not generic prompts.
          </Heading>
          <Lede className="mt-6">
            An Agent is assembled from an approved Skill, a governed connection and the objective it
            serves — then tested, and only then activated. It is built <em>for</em> the person whose
            work it is, by somebody authorised to build; being the operator grants nobody the right
            to configure.
          </Lede>

          <div className="mt-9 grid gap-2.5 sm:grid-cols-2">
            {[
              { icon: Layers, text: 'Approved Skills are reused, not re-authored' },
              { icon: Lock, text: 'Connections chosen by identity' },
              { icon: Boxes, text: 'Versions pinned to what was tested' },
              { icon: TestTube2, text: 'Test before activation' },
              { icon: ShieldCheck, text: 'Human approval where required' },
              { icon: ArrowRight, text: 'Every run on the audit trail' },
            ].map(({ icon: Icon, text }) => (
              <div key={text} className="flex items-start gap-2.5 text-[13.5px] text-[#a1a1aa]">
                <Icon size={14} className="mt-1 shrink-0 text-[#a78bfa]" />
                {text}
              </div>
            ))}
          </div>
        </Reveal>

        <Reveal delay={0.1}>
          <div className="overflow-hidden rounded-2xl border border-white/8 bg-[#050505]">
            <div className="flex items-center justify-between border-b border-white/8 px-5 py-3.5">
              <span className="text-[12.5px] font-medium text-white">Agent Builder</span>
              <Pill tone="ai">Draft</Pill>
            </div>
            <ol className="divide-y divide-white/6">
              {BUILD_STEPS.map((step, i) => (
                <motion.li
                  key={step.label}
                  initial={{ opacity: 0, x: -6 }}
                  whileInView={{ opacity: 1, x: 0 }}
                  viewport={{ once: true }}
                  transition={still ? { duration: 0 } : { duration: 0.34, delay: i * 0.05 }}
                  className="flex items-center gap-4 px-5 py-3.5"
                >
                  <span className="grid h-6 w-6 shrink-0 place-items-center rounded-full border border-white/10 font-mono text-[10.5px] text-[#7f7f89]">
                    {i + 1}
                  </span>
                  <span className="flex-1 text-[13.5px] text-[#d4d4d8]">{step.label}</span>
                  <span className="hidden text-[11.5px] text-[#8b8b93] sm:block">
                    {step.detail}
                  </span>
                </motion.li>
              ))}
            </ol>
            <div className="border-t border-white/8 px-5 py-3.5">
              <p className="text-[11.5px] leading-relaxed text-[#8b8b93]">
                Product illustration of Agent Builder. An Agent cannot be activated until its tests
                have passed.
              </p>
            </div>
          </div>
        </Reveal>
      </div>
    </Section>
  );
}
