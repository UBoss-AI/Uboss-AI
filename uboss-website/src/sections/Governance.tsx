'use client';

/**
 * Executor, governance, access control and hierarchy.
 *
 * The four sections that answer the question an enterprise buyer actually arrives with: who is in
 * control when the worker is a machine. Nothing here claims a certification, because there is none
 * to claim — the brief is explicit and so is the product.
 */

import { motion, useReducedMotion } from 'framer-motion';
import {
  AlertTriangle,
  CheckCircle2,
  Clock,
  Eye,
  FileClock,
  GitCommitVertical,
  Layers3,
  PlugZap,
  ShieldAlert,
  UserCheck,
  Users,
} from 'lucide-react';

import { Card, Eyebrow, Heading, Lede, Pill, Reveal, Section } from '@/components/ui';

const LANES = [
  { label: 'Completed', count: 34, icon: CheckCircle2, tone: '#34d399' },
  { label: 'In Progress', count: 12, icon: Clock, tone: '#22d3ee' },
  { label: 'Waiting Approval', count: 5, icon: FileClock, tone: '#fbbf24' },
  { label: 'Exception', count: 2, icon: AlertTriangle, tone: '#f87171' },
  { label: 'Resolved', count: 9, icon: UserCheck, tone: '#a78bfa' },
];

const WATCHES = [
  { icon: Clock, text: 'Work that has gone past when it was due' },
  { icon: ShieldAlert, text: 'Agent runs that failed, and why' },
  { icon: FileClock, text: 'Completions submitted without their evidence' },
  { icon: PlugZap, text: 'Connections that stopped answering' },
  { icon: Eye, text: 'Approvals that have been waiting too long' },
];

export function Executor() {
  const still = useReducedMotion() === true;

  return (
    <Section id="executor" tone="ink-1">
      <div className="grid gap-14 lg:grid-cols-[1fr_1.1fr] lg:items-center lg:gap-20">
        <Reveal>
          <Eyebrow>Executor</Eyebrow>
          <Heading>
            Execution needs supervision.
            <br />
            Even when the worker is AI.
          </Heading>
          <Lede className="mt-6">
            Executor watches human and AI work together and turns what went wrong into something
            with an owner. It routes and escalates; it never decides in a person&rsquo;s place.
          </Lede>
          <ul className="mt-9 space-y-3.5">
            {WATCHES.map(({ icon: Icon, text }) => (
              <li key={text} className="flex items-start gap-3 text-[14px] text-[#a1a1aa]">
                <Icon size={15} className="mt-0.5 shrink-0 text-[#6ee7b7]" />
                {text}
              </li>
            ))}
          </ul>
        </Reveal>

        <Reveal delay={0.1}>
          <div className="overflow-hidden rounded-2xl border border-white/8 bg-[#09090b]">
            <div className="flex items-center justify-between border-b border-white/8 px-5 py-3.5">
              <span className="text-[12.5px] font-medium text-white">Executor</span>
              <span className="font-mono text-[11px] text-[#3f3f46]">Live view</span>
            </div>
            <div className="grid gap-px bg-white/6 sm:grid-cols-5">
              {LANES.map((lane, i) => (
                <motion.div
                  key={lane.label}
                  initial={{ opacity: 0, y: 10 }}
                  whileInView={{ opacity: 1, y: 0 }}
                  viewport={{ once: true }}
                  transition={still ? { duration: 0 } : { duration: 0.4, delay: i * 0.06 }}
                  className="bg-[#09090b] px-4 py-5"
                >
                  <lane.icon size={15} style={{ color: lane.tone }} />
                  <div className="mt-3 text-[26px] font-semibold leading-none tracking-[-0.03em] text-white">
                    {lane.count}
                  </div>
                  <div className="mt-1.5 text-[11px] leading-tight text-[#7f7f89]">
                    {lane.label}
                  </div>
                </motion.div>
              ))}
            </div>
            <div className="space-y-2 border-t border-white/8 p-4">
              {[
                {
                  tone: '#f87171',
                  title: 'Connection unavailable',
                  detail: 'Tender portal · GSPR Drafter · routed to IT',
                },
                {
                  tone: '#fbbf24',
                  title: 'Approval waiting 26h',
                  detail: 'Service record sign-off · escalated to Head',
                },
              ].map((row) => (
                <div
                  key={row.title}
                  className="flex items-center gap-3 rounded-xl border border-white/8 bg-white/[0.02] px-4 py-3"
                >
                  <span
                    className="h-1.5 w-1.5 shrink-0 rounded-full"
                    style={{
                      background: row.tone,
                      /* The stylesheet stops it under reduced motion, so the value is the same either way. */
                      animation: 'u-breathe 2.4s ease-in-out infinite',
                    }}
                    aria-hidden="true"
                  />
                  <div className="min-w-0">
                    <div className="truncate text-[13px] text-[#e4e4e7]">{row.title}</div>
                    <div className="truncate text-[11.5px] text-[#8b8b93]">{row.detail}</div>
                  </div>
                </div>
              ))}
            </div>
            <div className="border-t border-white/8 px-5 py-3">
              <p className="text-[11.5px] text-[#8b8b93]">
                Product illustration of Executor. Figures are illustrative, not customer data.
              </p>
            </div>
          </div>
        </Reveal>
      </div>
    </Section>
  );
}

const CONTROLS = [
  {
    icon: UserCheck,
    title: 'No self-approval',
    body: 'The person who submits work cannot be the person who approves it. The server refuses it, not the screen.',
  },
  {
    icon: Users,
    title: 'Four-eyes',
    body: 'Where it is configured, two different people must decide — and the second cannot be the first.',
  },
  {
    icon: Layers3,
    title: 'Role and scope',
    body: 'What somebody may do, and how far it reaches. Own work, a team, a department, or the company.',
  },
  {
    icon: ShieldAlert,
    title: 'Department boundaries',
    body: 'An action granted in one department does not borrow reach from another.',
  },
  {
    icon: FileClock,
    title: 'Approval gates',
    body: 'Consequential steps wait for a decision. Nothing goes live on an approval that was never given.',
  },
  {
    icon: GitCommitVertical,
    title: 'Versions and audit',
    body: 'Editing a live objective never changes it in place. Every decision is on the record with its reason.',
  },
];

export function Governance() {
  return (
    <Section id="governance" tone="ink-0" glow>
      <Reveal className="mx-auto max-w-[720px] text-center">
        <Eyebrow>Governance</Eyebrow>
        <Heading>AI autonomy with enterprise control.</Heading>
        <Lede className="mx-auto mt-6 text-center">
          Every control here is enforced by the server. Hiding a control in the interface is not
          security, and UBOSS does not treat it as any.
        </Lede>
      </Reveal>

      <div className="mt-16 grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
        {CONTROLS.map(({ icon: Icon, title, body }, i) => (
          <Reveal key={title} delay={i * 0.05}>
            <Card interactive className="h-full">
              <span className="grid h-9 w-9 place-items-center rounded-xl border border-white/10 bg-white/[0.03]">
                <Icon size={16} className="text-[#a78bfa]" />
              </span>
              <h3 className="mt-5 text-[16px] font-medium text-white">{title}</h3>
              <p className="mt-2 text-[13.5px] leading-[1.6] text-[#a1a1aa]">{body}</p>
            </Card>
          </Reveal>
        ))}
      </div>
    </Section>
  );
}

const DIMENSIONS = [
  { label: 'User', detail: 'Who they are' },
  { label: 'Role', detail: 'What kind of work they do' },
  { label: 'Scope', detail: 'How far it reaches' },
  { label: 'Module visibility', detail: 'What they can see' },
  { label: 'Allowed actions', detail: 'What they may do' },
  { label: 'Policy', detail: 'What the company forbids' },
];

const EXAMPLES = [
  { role: 'Employee', scope: 'Own work', can: 'Their To-do and the Agents assigned to them' },
  { role: 'Manager', scope: 'Team / subtree', can: 'Assign work, review output, build Agents' },
  { role: 'Head', scope: 'Department', can: 'Approve, and see the department’s work' },
  { role: 'Approver', scope: 'As granted', can: 'Decide what is routed to them' },
  { role: 'Auditor', scope: 'As granted', can: 'Read the record; change nothing' },
  { role: 'Company Admin', scope: 'Whole company', can: 'Administer people, access and settings' },
];

export function AccessControl() {
  return (
    <Section id="access" tone="ink-2">
      <Reveal className="max-w-[720px]">
        <Eyebrow>Access control</Eyebrow>
        <Heading>Six dimensions, one answer.</Heading>
        <Lede className="mt-6">
          Effective access is computed, not assumed. Any one of the six can narrow it, and none of
          them can be widened by a screen.
        </Lede>
      </Reveal>

      <Reveal className="mt-14">
        <div className="flex flex-wrap items-stretch gap-2">
          {DIMENSIONS.map((dimension, i) => (
            <div key={dimension.label} className="flex items-stretch gap-2">
              <div className="rounded-xl border border-white/10 bg-white/[0.03] px-4 py-3">
                <div className="text-[13px] font-medium text-white">{dimension.label}</div>
                <div className="mt-0.5 text-[11.5px] text-[#7f7f89]">{dimension.detail}</div>
              </div>
              {i < DIMENSIONS.length - 1 ? (
                <span className="self-center text-[15px] text-[#3f3f46]" aria-hidden="true">
                  +
                </span>
              ) : null}
            </div>
          ))}
          <div className="flex items-stretch gap-2">
            <span className="self-center px-1 text-[15px] text-[#3f3f46]" aria-hidden="true">
              =
            </span>
            <div className="rounded-xl border border-[#8b5cf6]/35 bg-[#8b5cf6]/10 px-4 py-3">
              <div className="text-[13px] font-medium text-[#ddd6fe]">Effective access</div>
              <div className="mt-0.5 text-[11.5px] text-[#a78bfa]/70">Enforced by the server</div>
            </div>
          </div>
        </div>
      </Reveal>

      <Reveal className="mt-12">
        <div className="overflow-hidden rounded-2xl border border-white/8">
          <table className="w-full border-collapse text-left">
            <caption className="sr-only">Example roles, their scope and what they may do</caption>
            <thead>
              <tr className="border-b border-white/8 bg-white/[0.02]">
                {['Role', 'Scope', 'What it permits'].map((head) => (
                  <th
                    key={head}
                    scope="col"
                    className="px-5 py-3 text-[11px] font-medium uppercase tracking-[0.12em] text-[#7f7f89]"
                  >
                    {head}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {EXAMPLES.map((row) => (
                <tr key={row.role} className="border-b border-white/6 last:border-0">
                  <td className="px-5 py-3.5 text-[13.5px] font-medium text-white">{row.role}</td>
                  <td className="px-5 py-3.5 text-[13.5px] text-[#a1a1aa]">{row.scope}</td>
                  <td className="px-5 py-3.5 text-[13.5px] text-[#a1a1aa]">{row.can}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Reveal>

      <Reveal className="mt-8">
        <div className="flex items-start gap-3 rounded-xl border border-[#fbbf24]/20 bg-[#fbbf24]/[0.05] px-5 py-4">
          <ShieldAlert size={16} className="mt-0.5 shrink-0 text-[#fbbf24]" />
          <p className="text-[13.5px] leading-[1.6] text-[#d4d4d8]">
            Navigation visibility is not security. A hidden menu item and a refused request are two
            different things — UBOSS does both, and the second is the one that counts.
          </p>
        </div>
      </Reveal>
    </Section>
  );
}

const TREE: readonly { level: number; label: string; note: string }[] = [
  { level: 0, label: 'Company Admin', note: 'Whole company' },
  { level: 1, label: 'Head', note: 'Department' },
  { level: 2, label: 'Manager', note: 'Team / subtree' },
  { level: 3, label: 'Supervisor', note: 'Subordinate work' },
  { level: 4, label: 'Employees', note: 'Own work' },
];

export function Hierarchy() {
  const still = useReducedMotion() === true;

  return (
    <Section id="hierarchy" tone="ink-1">
      <div className="grid gap-14 lg:grid-cols-[1fr_1fr] lg:items-center lg:gap-20">
        <Reveal>
          <Eyebrow>Hierarchy</Eyebrow>
          <Heading>UBOSS knows who reports to whom.</Heading>
          <Lede className="mt-6">
            Departments, reporting lines and responsibility are not a diagram somebody drew once.
            They are what scope is computed from — which work reaches whom, which objectives a
            person owns, and how far a manager&rsquo;s reach actually extends.
          </Lede>
          <ul className="mt-9 grid gap-3 sm:grid-cols-2">
            {[
              'Departments',
              'Reporting hierarchy',
              'Responsibility',
              'Team / subtree scope',
              'Access scope',
              'Objective ownership',
            ].map((item) => (
              <li key={item} className="flex items-center gap-2.5 text-[14px] text-[#a1a1aa]">
                <span className="h-1 w-1 rounded-full bg-[#22d3ee]" aria-hidden="true" />
                {item}
              </li>
            ))}
          </ul>
        </Reveal>

        <Reveal delay={0.1}>
          <div className="rounded-2xl border border-white/8 bg-[#050505] p-6 u-dots sm:p-8">
            <ol className="space-y-2">
              {TREE.map((row, i) => (
                <motion.li
                  key={row.label}
                  initial={{ opacity: 0, x: -10 }}
                  whileInView={{ opacity: 1, x: 0 }}
                  viewport={{ once: true }}
                  transition={still ? { duration: 0 } : { duration: 0.4, delay: i * 0.1 }}
                  style={{ marginLeft: `${row.level * 18}px` }}
                  className="flex items-center gap-3"
                >
                  {row.level > 0 ? (
                    <span className="h-px w-4 bg-white/12" aria-hidden="true" />
                  ) : null}
                  <span className="flex flex-1 items-center justify-between gap-3 rounded-xl border border-white/10 bg-white/[0.03] px-4 py-2.5">
                    <span className="text-[13.5px] text-white">{row.label}</span>
                    <span className="text-[11.5px] text-[#8b8b93]">{row.note}</span>
                  </span>
                </motion.li>
              ))}
            </ol>
            <div className="mt-6 border-t border-white/8 pt-5">
              <div className="mb-3 text-[11px] uppercase tracking-[0.14em] text-[#8b8b93]">
                Departments branch from the same tree
              </div>
              <div className="flex flex-wrap gap-2">
                {['Operations', 'Sales', 'Finance', 'Procurement', 'Quality'].map((d) => (
                  <Pill key={d}>{d}</Pill>
                ))}
              </div>
            </div>
          </div>
        </Reveal>
      </div>
    </Section>
  );
}
