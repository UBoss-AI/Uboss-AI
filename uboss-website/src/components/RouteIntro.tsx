import Link from 'next/link';
import { ArrowDown, ArrowRight, Check, Sparkles, UserRound } from 'lucide-react';

export function RouteIntro({
  eyebrow,
  title,
  accent,
  description,
  primary = 'Book a demo',
  href = '/demo',
}: {
  eyebrow: string;
  title: string;
  accent: string;
  description: string;
  primary?: string;
  href?: string;
}) {
  return (
    <header className="route-intro section-shell">
      <div className="route-intro-copy">
        <span className="section-kicker">{eyebrow}</span>
        <h1>{title}<br /><span>{accent}</span></h1>
        <p>{description}</p>
        <div className="route-intro-actions">
          <Link href={href}>{primary}<ArrowRight size={16} /></Link>
          <Link href="/platform">Explore the platform</Link>
        </div>
      </div>
      <div className="route-intro-diagram" aria-hidden="true">
        <div className="route-intro-diagram-top"><span><i /> OBJECTIVE / OPS—017</span><span>READY</span></div>
        <div className="route-intro-objective"><small>BUSINESS OUTCOME</small><strong>Return every repair<br />within five working days</strong><span><Check size={12} /> Workflow defined</span></div>
        <div className="route-intro-branch"><i /><i /><i /></div>
        <div className="route-intro-workers">
          <div><UserRound size={14} /><small>PEOPLE</small><span>Approve & own</span></div>
          <div><Sparkles size={14} /><small>JOB AGENTS</small><span>Do defined work</span></div>
          <div><Check size={14} /><small>OUTCOME</small><span>Recorded</span></div>
        </div>
        <div className="route-intro-diagram-foot"><span>HUMAN AUTHORITY</span><ArrowDown size={13} /><span>GOVERNED EXECUTION</span></div>
      </div>
    </header>
  );
}
