import type { Metadata } from 'next';
import { Objectives, Workforce } from '@/sections/Objectives';
import { Agents, Skills } from '@/sections/Skills';
import { Executor, Hierarchy } from '@/sections/Governance';
import { Architecture, Performance, MasterConsole } from '@/sections/Platform';
import { ClosingCTA } from '@/sections/WorkforceSections';
import { RouteIntro } from '@/components/RouteIntro';
export const metadata: Metadata = {
  title: 'The Platform',
  description:
    'Explore how UBOSS connects objectives, people, AI agents, skills and governed execution.',
};
export default function PlatformPage() {
  return (
    <div className="subpage">
      <RouteIntro
        eyebrow="THE UBOSS PLATFORM"
        title="From intent"
        accent="to outcome."
        description="A connected system for the people, specialist agents and accountable decisions behind your work."
        primary="See UBoss for your workflow"
        secondary={{ label: 'What each plan opens', href: '/pricing' }}
        facts={[
          { value: '14', label: 'Modules, from the org chart to the audit trail' },
          { value: 'One', label: 'Objective is where every piece of work starts' },
          { value: 'Every run', label: 'Reserved against a budget before it happens' },
        ]}
      />
      <Objectives />
      <Workforce />
      {/*
        Skills sit here, between the agents and what governs them.

        They had a top-level nav item of their own and a page that repeated the home page. "Skills"
        is the product's internal word — nobody arrives asking how many a vendor has — but it is
        what an agent is made of, and that is a question somebody reading about agents has just
        thought of. The deeper page stays at /skills and is linked from here.
      */}
      <Agents />
      <Skills />
      <Executor />
      <Performance />
      <Hierarchy />
      <Architecture />
      <MasterConsole />
      <ClosingCTA />
    </div>
  );
}
