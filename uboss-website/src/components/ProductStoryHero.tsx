'use client';

import Link from 'next/link';
import { ArrowRight, Check, ChevronRight, Sparkles } from 'lucide-react';

const agents = [
  { role: 'Signal Analyst', action: 'Map the request', tone: 'violet' },
  { role: 'Operations Agent', action: 'Coordinate the work', tone: 'blue' },
  { role: 'Review Agent', action: 'Prepare the decision', tone: 'silver' },
] as const;

export function ProductStoryHero() {
  return (
    <section className="product-story-hero" aria-label="UBOSS workforce overview">
      <div className="product-story-shell">
        <div className="product-story-copy">
          <p className="product-story-kicker"><span />THE AI WORKFORCE OPERATING SYSTEM</p>
          <h1>Set the objective.<br /><em>UBOSS builds the team.</em></h1>
          <p>Turn business intent into a working system of agents, skills and people—each with a clear role, approved boundaries and visible ownership.</p>
          <div className="product-story-actions">
            <Link href="/demo" className="product-story-primary">See UBOSS for your workflow <ArrowRight size={17} /></Link>
            <a href="#product" className="product-story-secondary">Explore the workspace <ChevronRight size={16} /></a>
          </div>
          <div className="product-story-note"><Sparkles size={15} /> Objective → agents → human approval</div>
        </div>

        <div className="product-story-machine">
          <div className="machine-topline"><span><i /> UBOSS / LIVE WORKFLOW</span><span>OPS—017</span></div>
          <div className="machine-objective">
            <span className="machine-label">01 / BUSINESS OBJECTIVE</span>
            <strong>Return every repair<br />within five working days.</strong>
            <span className="objective-status"><i /> Workflow ready</span>
          </div>
          <div className="machine-connector connector-one" aria-hidden="true"><span /></div>
          <div className="machine-agents" aria-label="Specialist agents at work">
            {agents.map((agent, index) => <div key={agent.role} className={`machine-agent ${agent.tone}`}>
              <span className="agent-number">0{index + 1}</span>
              <div className="agent-core" />
              <div><strong>{agent.role}</strong><small>{agent.action}</small></div>
            </div>)}
          </div>
          <div className="machine-connector connector-two" aria-hidden="true"><span /></div>
          <div className="machine-approval">
            <div className="approval-icon"><Check size={18} /></div>
            <div><span className="machine-label">03 / PEOPLE DECIDE</span><strong>Operations lead review</strong><small>Ready for approval</small></div>
            <span className="approval-pulse" />
          </div>
          <div className="machine-footer"><span>OBJECTIVE</span><b>→</b><span>SPECIALIST AGENTS</span><b>→</b><span>HUMAN DECISION</span></div>
        </div>
      </div>
    </section>
  );
}
