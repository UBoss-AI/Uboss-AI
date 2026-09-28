import type { Metadata } from 'next';
import { Governance, AccessControl } from '@/sections/Governance';
import { Security } from '@/sections/Platform';
import { ClosingCTA } from '@/sections/WorkforceSections';
import { RouteIntro } from '@/components/RouteIntro';
export const metadata: Metadata = { title: 'Governance & Security', description: 'Explore human approval, role and scope authorization, audit trails and governed connections in UBOSS.' };
export default function SecurityPage() { return <div className="subpage"><RouteIntro eyebrow="GOVERNANCE & SECURITY" title="Built for work." accent="Grounded in trust." description="Understand the boundaries, responsibilities and records that keep people in control of the AI workforce." primary="Talk through your requirements" /><Governance /><AccessControl /><Security /><ClosingCTA /></div>; }
