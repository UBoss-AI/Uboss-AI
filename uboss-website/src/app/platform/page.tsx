import type { Metadata } from 'next';
import { Objectives, Workforce } from '@/sections/Objectives';
import { Agents } from '@/sections/Skills';
import { Executor, Hierarchy } from '@/sections/Governance';
import { Architecture, Performance, MasterConsole } from '@/sections/Platform';
import { ClosingCTA } from '@/sections/WorkforceSections';
import { RouteIntro } from '@/components/RouteIntro';
export const metadata: Metadata = { title: 'The Platform', description: 'Explore how UBOSS connects objectives, people, AI agents, skills and governed execution.' };
export default function PlatformPage() { return <div className="subpage"><RouteIntro eyebrow="THE UBOSS PLATFORM" title="From intent" accent="to outcome." description="A connected system for the people, specialist agents and accountable decisions behind your work." primary="See UBOSS for your workflow" /><Objectives /><Workforce /><Agents /><Executor /><Performance /><Hierarchy /><Architecture /><MasterConsole /><ClosingCTA /></div>; }
