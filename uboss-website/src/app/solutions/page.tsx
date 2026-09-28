import type { Metadata } from 'next';
import { RouteIntro } from '@/components/RouteIntro';
import { ClosingCTA, DepartmentSolutions } from '@/sections/WorkforceSections';
import { Solutions } from '@/sections/Platform';

export const metadata: Metadata = {
  title: 'Solutions',
  description: 'Explore example UBOSS workflows across operations, finance, IT, security, compliance and other business teams.',
};

export default function SolutionsPage() {
  return <div className="subpage"><RouteIntro eyebrow="UBOSS SOLUTIONS" title="Business work." accent="Connected end to end." description="Explore how specialist agents and people can share accountable workflows across departments and industry contexts." primary="Map a workflow with us" /><DepartmentSolutions /><Solutions id="industry-packs" /><ClosingCTA /></div>;
}
