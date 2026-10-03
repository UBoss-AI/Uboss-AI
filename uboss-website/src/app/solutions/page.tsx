import type { Metadata } from 'next';
import { RouteIntro } from '@/components/RouteIntro';
import { ClosingCTA, DepartmentSolutions } from '@/sections/WorkforceSections';
import { Solutions } from '@/sections/Platform';

export const metadata: Metadata = {
  title: 'Solutions',
  description:
    'Explore example UBOSS workflows across operations, finance, IT, security, compliance and other business teams.',
};

export default function SolutionsPage() {
  return (
    <div className="subpage">
      <RouteIntro
        eyebrow="UBOSS SOLUTIONS"
        title="Business work."
        accent="Connected end to end."
        description="Explore how specialist agents and people can share accountable workflows across departments and industry contexts."
        primary="Map a workflow with us"
        secondary={{ label: 'The skills behind them', href: '/skills' }}
        facts={[
          { value: '24', label: 'Industries the catalogue already covers' },
          { value: '192', label: 'Skills that belong to one industry way of working' },
          { value: '208', label: 'Skills that apply whatever a company makes' },
        ]}
      />
      <DepartmentSolutions />
      <Solutions id="industry-packs" />
      <ClosingCTA />
    </div>
  );
}
