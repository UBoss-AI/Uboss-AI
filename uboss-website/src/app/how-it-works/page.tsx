import type { Metadata } from 'next';
import { RouteIntro } from '@/components/RouteIntro';
import { HowItWorks } from '@/sections/HowItWorks';
import { Workforce } from '@/sections/Objectives';
import { Executor } from '@/sections/Governance';
import { ClosingCTA } from '@/sections/WorkforceSections';

export const metadata: Metadata = {
  title: 'How It Works',
  description:
    'Follow how UBOSS turns a business objective into human and AI work, approved assignments and supervised outcomes.',
};

export default function HowItWorksPage() {
  return (
    <div className="subpage">
      <RouteIntro
        eyebrow="HOW UBOSS WORKS"
        title="One objective."
        accent="A team in motion."
        description="See how an outcome becomes a governed workflow, how the work is shared, and where people keep authority."
        primary="See it with your workflow"
        secondary={{ label: 'The skills behind it', href: '/skills' }}
        facts={[
          { value: '4 steps', label: 'Objective, plan, work, decision' },
          { value: 'Human', label: 'Approval is a step, not a setting' },
          { value: 'Hash-chained', label: 'Every action lands in an append-only trail' },
        ]}
      />
      <HowItWorks />
      <Workforce />
      <Executor />
      <ClosingCTA />
    </div>
  );
}
