'use client';

/**
 * Performance, architecture, security, the Master Console, solutions, and the closing call.
 *
 * The security section names only what the product implements. There is no SOC 2, no ISO, no
 * HIPAA and no GDPR claim on this page, because none has been verified — and an unearned badge is
 * the first thing an enterprise security review asks to see evidence for.
 */

import {
  Activity,
  BarChart3,
  Boxes,
  Building2,
  Clock,
  Cpu,
  FileSearch,
  Fingerprint,
  GitCompare,
  KeyRound,
  Layers,
  Network,
  Receipt,
  ScrollText,
  ShieldCheck,
  Users,
  Wallet,
} from 'lucide-react';

import { Button, Card, Eyebrow, Heading, Lede, Pill, Reveal, Rule, Section } from '@/components/ui';
import { INDUSTRIES } from '@/lib/catalog';

const SIGNALS = [
  { icon: BarChart3, label: 'Objective progress', detail: 'Against what was approved' },
  { icon: Users, label: 'Human vs AI work', detail: 'Where the work actually went' },
  { icon: Activity, label: 'Workload', detail: 'By person, team and department' },
  { icon: Cpu, label: 'Job Agent health', detail: 'Runs, failures, retries' },
  { icon: Clock, label: 'Approval aging', detail: 'What has been waiting, and on whom' },
  { icon: Wallet, label: 'Governed AI usage', detail: 'Consumption against its budget' },
];

export function Performance() {
  return (
    <Section id="performance" tone="ink-0" glow>
      <Reveal className="max-w-[720px]">
        <Eyebrow>Performance and visibility</Eyebrow>
        <Heading>Management sees the operation, not a dashboard.</Heading>
        <Lede className="mt-6">
          Every figure is reported against the objective that asked for it, scoped to what the
          person looking is permitted to see. Two people with different scopes see different
          numbers, and UBOSS says which scope it counted.
        </Lede>
      </Reveal>

      <div className="mt-14 grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
        {SIGNALS.map(({ icon: Icon, label, detail }, i) => (
          <Reveal key={label} delay={i * 0.05}>
            <Card interactive className="h-full">
              <Icon size={16} className="text-[#a78bfa]" />
              <h3 className="mt-4 text-[15.5px] font-medium text-white">{label}</h3>
              <p className="mt-1.5 text-[13px] text-[#7f7f89]">{detail}</p>
            </Card>
          </Reveal>
        ))}
      </div>

      <Reveal className="mt-8">
        <p className="text-[12.5px] text-[#8b8b93]">
          UBOSS reports what a company&rsquo;s own work produces. This site publishes no customer
          results, because they belong to customers.
        </p>
      </Reveal>
    </Section>
  );
}

const STACK = [
  { label: 'Business objective', tone: 'plain' as const },
  { label: 'UBOSS orchestration', tone: 'core' as const },
  { label: 'Human work · Job Agents', tone: 'split' as const },
  { label: 'Skills · Policy · Connections', tone: 'plain' as const },
  { label: 'Approvals · Executor', tone: 'gate' as const },
  { label: 'Business outcome', tone: 'plain' as const },
];

const FOUNDATION = [
  { icon: Fingerprint, label: 'Identity' },
  { icon: KeyRound, label: 'Permissions' },
  { icon: ScrollText, label: 'Audit' },
  { icon: ShieldCheck, label: 'Security' },
  { icon: GitCompare, label: 'Versions' },
  { icon: Receipt, label: 'Cost controls' },
];

export function Architecture() {
  return (
    <Section id="platform" tone="ink-1">
      <Reveal className="mx-auto max-w-[700px] text-center">
        <Eyebrow>Platform architecture</Eyebrow>
        <Heading>One system, from intent to outcome.</Heading>
      </Reveal>

      <Reveal className="mx-auto mt-14 max-w-[720px]">
        <ol className="space-y-2.5">
          {STACK.map((layer, i) => (
            <li key={layer.label}>
              <div
                className={`rounded-2xl border px-6 py-5 text-center ${
                  layer.tone === 'core'
                    ? 'border-[#8b5cf6]/35 bg-[#8b5cf6]/[0.09]'
                    : layer.tone === 'gate'
                      ? 'border-[#fbbf24]/25 bg-[#fbbf24]/[0.06]'
                      : layer.tone === 'split'
                        ? 'border-white/12 bg-gradient-to-r from-[#22d3ee]/[0.07] to-[#8b5cf6]/[0.07]'
                        : 'border-white/10 bg-white/[0.03]'
                }`}
              >
                <span
                  className={`text-[14.5px] font-medium tracking-[-0.01em] ${
                    layer.tone === 'core'
                      ? 'text-[#ddd6fe]'
                      : layer.tone === 'gate'
                        ? 'text-[#fde68a]'
                        : 'text-white'
                  }`}
                >
                  {layer.label}
                </span>
              </div>
              {i < STACK.length - 1 ? (
                <div className="mx-auto h-5 w-px bg-white/12" aria-hidden="true" />
              ) : null}
            </li>
          ))}
        </ol>
      </Reveal>

      <Reveal className="mx-auto mt-12 max-w-[720px]">
        <div className="rounded-2xl border border-white/8 bg-[#09090b] p-6">
          <div className="mb-5 text-center text-[11px] uppercase tracking-[0.16em] text-[#8b8b93]">
            Governance foundation
          </div>
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-6">
            {FOUNDATION.map(({ icon: Icon, label }) => (
              <div key={label} className="flex flex-col items-center gap-2 text-center">
                <Icon size={16} className="text-[#7f7f89]" />
                <span className="text-[12px] text-[#a1a1aa]">{label}</span>
              </div>
            ))}
          </div>
        </div>
      </Reveal>
    </Section>
  );
}

const SECURITY = [
  {
    icon: Building2,
    title: 'Tenant isolation',
    body: 'A company’s data is reachable only inside that company’s context. It is enforced at the database, not only in the application.',
  },
  {
    icon: KeyRound,
    title: 'Role and scope authorization',
    body: 'Every request is checked against the permission and the reach the person actually holds — the interface is never the gate.',
  },
  {
    icon: Network,
    title: 'Governed connections',
    body: 'An Agent reaches a system through a connection an administrator approved, chosen by identity rather than by pasting a key.',
  },
  {
    icon: Fingerprint,
    title: 'Secrets handling',
    body: 'No credential is entered on a builder screen and none is displayed back. Activation tokens are stored as a hash.',
  },
  {
    icon: ScrollText,
    title: 'Audit trail',
    body: 'Who did what, when, and why — including refusals. A decision that was blocked is recorded as one.',
  },
  {
    icon: ShieldCheck,
    title: 'Human authority',
    body: 'Governed actions wait for a person. No self-approval, and four-eyes where the company configures it.',
  },
  {
    icon: Layers,
    title: 'Session controls',
    body: 'Sessions are bound, revocable and visible to the person they belong to.',
  },
  {
    icon: FileSearch,
    title: 'Enterprise identity',
    body: 'MFA and enterprise sign-in where a company enables them.',
  },
];

export function Security() {
  return (
    <Section id="security" tone="ink-2">
      <Reveal className="max-w-[720px]">
        <Eyebrow>Security</Eyebrow>
        <Heading>Controls we can show you.</Heading>
        <Lede className="mt-6">
          What follows is what UBOSS implements. We publish no certification claims on this page —
          if a certification matters to your review, ask us and we will tell you exactly where we
          stand.
        </Lede>
      </Reveal>

      <div className="mt-14 grid gap-3 sm:grid-cols-2">
        {SECURITY.map(({ icon: Icon, title, body }, i) => (
          <Reveal key={title} delay={i * 0.04}>
            <Card interactive className="flex h-full gap-4">
              <span className="mt-0.5 grid h-9 w-9 shrink-0 place-items-center rounded-xl border border-white/10 bg-white/[0.03]">
                <Icon size={15} className="text-[#a78bfa]" />
              </span>
              <div>
                <h3 className="text-[15.5px] font-medium text-white">{title}</h3>
                <p className="mt-1.5 text-[13.5px] leading-[1.6] text-[#a1a1aa]">{body}</p>
              </div>
            </Card>
          </Reveal>
        ))}
      </div>
    </Section>
  );
}

const PLATFORM_DUTIES = [
  'Customer companies',
  'Plans and entitlements',
  'AI providers and models',
  'Skill Catalog',
  'Usage',
  'Releases',
  'Support',
  'Security and audit',
];

export function MasterConsole() {
  return (
    <Section id="master-console" tone="ink-0">
      <div className="grid gap-12 lg:grid-cols-[1fr_1fr] lg:items-center lg:gap-20">
        <Reveal>
          <Eyebrow>Master Console</Eyebrow>
          <Heading>Platform operations, kept separate.</Heading>
          <Lede className="mt-6">
            UBOSS operates the platform your company runs on. What that means is bounded and
            deliberate: platform staff administer the service, not your workspace.
          </Lede>
          <div className="mt-8 rounded-xl border border-white/8 bg-white/[0.02] px-5 py-4">
            <p className="text-[13.5px] leading-[1.6] text-[#d4d4d8]">
              Reaching into a company&rsquo;s data is break-glass, not impersonation. It requires
              identity verification, a second approver, a named scope, an expiry and a notification
              to the customer — and every step is written into that company&rsquo;s own audit trail.
            </p>
          </div>
        </Reveal>

        <Reveal delay={0.1}>
          <Card className="p-7">
            <div className="mb-5 flex items-center gap-2">
              <Boxes size={15} className="text-[#a78bfa]" />
              <span className="text-[12px] uppercase tracking-[0.14em] text-[#7f7f89]">
                The platform manages
              </span>
            </div>
            <ul className="grid gap-2.5 sm:grid-cols-2">
              {PLATFORM_DUTIES.map((duty) => (
                <li key={duty} className="flex items-center gap-2.5 text-[13.5px] text-[#a1a1aa]">
                  <span className="h-1 w-1 rounded-full bg-[#8b5cf6]" aria-hidden="true" />
                  {duty}
                </li>
              ))}
            </ul>
          </Card>
        </Reveal>
      </div>
    </Section>
  );
}

const DEPARTMENTS = [
  'Operations',
  'Sales',
  'Finance',
  'Procurement',
  'Quality',
  'HR / People',
  'Compliance',
  'Executive Management',
];

export function Solutions({ id = 'solutions' }: { id?: string }) {
  return (
    <Section id={id} tone="ink-1">
      <Reveal className="max-w-[720px]">
        <Eyebrow>Solutions</Eyebrow>
        <Heading>Where UBOSS is put to work.</Heading>
        <Lede className="mt-6">
          The Skill Catalog carries {INDUSTRIES.length} industry packs alongside its universal
          Skills. A company is entitled to the packs it needs; nothing else is visible to it.
        </Lede>
      </Reveal>

      <Reveal className="mt-14">
        <h3 className="mb-5 text-[12px] font-medium uppercase tracking-[0.14em] text-[#7f7f89]">
          By department
        </h3>
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
          {DEPARTMENTS.map((name) => (
            <Card key={name} interactive className="p-5">
              <span className="text-[14.5px] font-medium text-white">{name}</span>
            </Card>
          ))}
        </div>
      </Reveal>

      <Reveal className="mt-14">
        <h3 className="mb-5 text-[12px] font-medium uppercase tracking-[0.14em] text-[#7f7f89]">
          By industry · {INDUSTRIES.length} packs in the catalogue
        </h3>
        <div className="flex flex-wrap gap-2">
          {INDUSTRIES.map((industry) => (
            <span
              key={industry}
              className="rounded-full border border-white/10 bg-white/[0.03] px-3.5 py-1.5 text-[13px] text-[#d4d4d8] transition-colors duration-300 hover:border-white/20 hover:text-white"
            >
              {industry}
            </span>
          ))}
        </div>
      </Reveal>
    </Section>
  );
}

export function Closing() {
  return (
    <Section id="company" tone="ink-0" glow>
      <Reveal className="mx-auto max-w-[760px] text-center">
        <Pill tone="ai">Chief Agent · Powered by UBoss AI</Pill>
        <Heading className="mt-7">
          Humans decide.
          <br />
          UBOSS coordinates the work.
        </Heading>
        <Lede className="mx-auto mt-7 text-center">
          See it against one of your own objectives. We will take a real piece of work your teams do
          today and show you what UBOSS makes of it — the workflow, the split, the approvals and
          what would be governed.
        </Lede>
        <div className="mt-10 flex flex-col items-center justify-center gap-3 sm:flex-row">
          <Button href="/demo" className="w-full sm:w-auto">
            Book a Demo
          </Button>
          <Button href="/sign-in" variant="ghost" className="w-full sm:w-auto">
            Sign In
          </Button>
        </div>
      </Reveal>

      <Rule className="mt-24" />
    </Section>
  );
}
