import type { Metadata } from 'next';
import { RouteIntro } from '@/components/RouteIntro';
import { Skills, Agents } from '@/sections/Skills';
import { ClosingCTA } from '@/sections/WorkforceSections';

export const metadata: Metadata = {
  title: 'Skills & Agents',
  description: 'Explore the UBOSS Skill Catalog and how governed Skills are assembled, tested and activated as job-specific AI Agents.',
};

export default function SkillsPage() {
  return <div className="subpage"><RouteIntro eyebrow="SKILLS & JOB AGENTS" title="Purpose-built agents." accent="Governed skills." description="Each AI worker is assembled for a defined job from approved skills, bounded connections and a workflow with a human owner." primary="Discuss your use case" /><Skills /><Agents /><ClosingCTA /></div>;
}
