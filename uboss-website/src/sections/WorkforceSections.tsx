'use client';

import { useState } from 'react';
import type { KeyboardEvent } from 'react';
import Link from 'next/link';
import {
  ArrowDown,
  ArrowRight,
  ArrowUpRight,
  Check,
  CheckCheck,
  CircleDot,
  FileText,
  Fingerprint,
  GitBranch,
  Layers3,
  LockKeyhole,
  Search,
  ShieldCheck,
  Sparkles,
  Workflow,
} from 'lucide-react';
import { ApprovalGate } from '@/components/site/ApprovalGate';
import { CATEGORIES, SAMPLE_SKILLS } from '@/lib/catalog';

function Tabs({
  labels,
  active,
  onChange,
  prefix,
}: {
  labels: readonly string[];
  active: number;
  onChange: (i: number) => void;
  prefix: string;
}) {
  const onKey = (event: KeyboardEvent<HTMLButtonElement>, index: number) => {
    let next: number;
    if (event.key === 'ArrowRight') next = (index + 1) % labels.length;
    else if (event.key === 'ArrowLeft') next = (index + labels.length - 1) % labels.length;
    else if (event.key === 'Home') next = 0;
    else if (event.key === 'End') next = labels.length - 1;
    else return;
    event.preventDefault();
    onChange(next);
    document.getElementById(`${prefix}-tab-${next}`)?.focus();
  };
  return (
    <div
      role="tablist"
      aria-label={prefix === 'tour' ? 'Product views' : 'Departments'}
      className="segment-tabs"
    >
      {labels.map((label, i) => (
        <button
          type="button"
          role="tab"
          id={`${prefix}-tab-${i}`}
          aria-controls={`${prefix}-panel`}
          aria-selected={active === i}
          tabIndex={active === i ? 0 : -1}
          key={label}
          onClick={() => onChange(i)}
          onKeyDown={(event) => onKey(event, i)}
        >
          {label}
        </button>
      ))}
    </div>
  );
}

const TOURS = [
  {
    title: 'An objective becomes a plan.',
    body: 'Start with the result you need. See the work, the people and the approval points that get you there.',
    name: 'Objective workspace',
    code: 'OPS—017',
    status: 'Workflow designed',
    steps: [
      ['Log equipment condition', 'Human task'],
      ['Complete repair and record parts', 'Human task'],
      ['Draft the service record', 'AI task'],
      ['Review and sign off', 'Approval'],
    ],
    label: 'RETURN EVERY REPAIR WITHIN 5 WORKING DAYS',
  },
  {
    title: 'Build for the job at hand.',
    body: 'Combine objective context, approved skills and a governed connection. Test your agent before activating it.',
    name: 'Agent Builder',
    code: 'AGT—004',
    status: 'Ready for testing',
    steps: [
      ['Inherit objective context', 'Context'],
      ['Select an approved drafting skill', 'Skill'],
      ['Choose a permitted connection', 'Connection'],
      ['Test, then decide on activation', 'Review'],
    ],
    label: 'SERVICE RECORD DRAFTING AGENT',
  },
  {
    title: 'Keep the whole operation in view.',
    body: 'Follow human and AI work together. Spot a blocked connection, a missing record or an approval that needs attention.',
    name: 'Executor',
    code: 'EXE—012',
    status: 'Review required',
    steps: [
      ['Condition record received', 'Complete'],
      ['Repair evidence submitted', 'Complete'],
      ['Service record prepared', 'AI output'],
      ['Head review and sign-off', 'Waiting'],
    ],
    label: 'A CLEAR OWNER FOR EVERY NEXT STEP',
  },
] as const;

export function ProductTour() {
  const [active, setActive] = useState(0);
  const tour = TOURS[active]!;
  return (
    <section id="product" className="landing-section product-tour">
      <div className="section-shell">
        <div className="product-intro">
          <span className="section-kicker">INSIDE THE UBOSS WORKSPACE</span>
          <span className="small-caption">A field-service workflow, from request to sign-off.</span>
        </div>
        <div className="tour-layout">
          <div>
            <div className="section-heading">
              <h2>
                Plan the work.
                <br />
                <span>Track the result.</span>
              </h2>
            </div>
            <Tabs
              prefix="tour"
              labels={['Objectives', 'Agent Builder', 'Executor']}
              active={active}
              onChange={setActive}
            />
            <div
              role="tabpanel"
              id="tour-panel"
              aria-labelledby={`tour-tab-${active}`}
              tabIndex={0}
            >
              <h3 className="tour-title">{tour.title}</h3>
              <p className="tour-description">{tour.body}</p>
            </div>
            <Link className="text-arrow" href="/platform">
              Explore the platform <ArrowUpRight size={16} />
            </Link>
          </div>
          <div className="product-window" aria-label={`${tour.name}, product illustration`}>
            <div className="window-toolbar">
              <span className="window-dots">
                <i />
                <i />
                <i />
              </span>
              <span>UBOSS / {tour.name}</span>
              <span className="window-code">{tour.code}</span>
            </div>
            <div className="window-body">
              <div className="window-breadcrumb">
                <Workflow size={15} /> Operations <span>/</span> Field service
              </div>
              <div className="window-objective">
                <span>THE OBJECTIVE</span>
                <h3>{tour.label}</h3>
                <div className="window-status">
                  <span />
                  {tour.status}
                </div>
              </div>
              <div className="workflow-steps">
                {tour.steps.map(([label, kind], i) => (
                  <div className={`workflow-step step-${i}`} key={label}>
                    <span className="step-symbol">
                      {i < 2 ? (
                        <Check size={13} />
                      ) : i === 2 ? (
                        <Sparkles size={13} />
                      ) : (
                        <ShieldCheck size={13} />
                      )}
                    </span>
                    <span>{label}</span>
                    <small>{kind}</small>
                  </div>
                ))}
              </div>
              <div className="window-footer">
                <Fingerprint size={13} /> Decisions have owners. Work has a record.
              </div>
            </div>
            <div className="illustration-label">PRODUCT ILLUSTRATION · NOT LIVE CUSTOMER DATA</div>
          </div>
        </div>
      </div>
    </section>
  );
}

export function SkillsLibrary() {
  const [query, setQuery] = useState('');
  const [category, setCategory] = useState('All');
  const skills = SAMPLE_SKILLS.filter(
    (skill) =>
      (category === 'All' || skill.category === category) &&
      `${skill.name} ${skill.department}`.toLowerCase().includes(query.toLowerCase()),
  );
  return (
    <section className="landing-section skills-library" id="skills">
      <div className="section-shell">
        <div className="split-heading">
          <div className="section-heading">
            <span className="section-kicker">THE UBOSS SKILL CATALOG</span>
            <h2>
              Give every agent
              <br />
              <span>a defined way to work.</span>
            </h2>
          </div>
          <p className="section-side-copy">
            Select the skill the job requires. Each one defines the work, the required output and
            the rules the agent must follow.
          </p>
        </div>
        <div className="skill-layers">
          {[
            {
              label: 'UBOSS Verified',
              icon: ShieldCheck,
              body: 'Platform-governed skills for work across departments.',
            },
            {
              label: 'Industry Packs',
              icon: Layers3,
              body: 'Industry-specific processes, checks and required outputs.',
            },
            {
              label: 'Company Custom',
              icon: Fingerprint,
              body: 'Skills authored for your company and kept within its scope.',
            },
          ].map(({ label, icon: Icon, body }, i) => (
            <div key={label}>
              <span className="layer-number">0{i + 1}</span>
              <Icon size={22} />
              <h3>{label}</h3>
              <p>{body}</p>
            </div>
          ))}
        </div>
        <div className="library-toolbar">
          <div className="library-filters" role="group" aria-label="Filter sample skills">
            {['All', 'Analysis', 'Operations', 'Review'].map((name) => (
              <button
                type="button"
                key={name}
                aria-pressed={category === name}
                onClick={() => setCategory(name)}
              >
                {name}
              </button>
            ))}
          </div>
          <label className="skill-search">
            <Search size={15} />
            <input
              type="search"
              aria-label="Search sample skills"
              placeholder="Find a skill…"
              value={query}
              onChange={(event) => setQuery(event.target.value)}
            />
          </label>
        </div>
        <div className="skill-results" aria-live="polite">
          <span className="sr-only">{skills.length} sample skills found</span>
          {skills.length ? (
            skills.map((skill, i) => (
              <article className="skill-tile" key={skill.name}>
                <div>
                  <span className="skill-symbol">
                    <GitBranch size={18} />
                  </span>
                  <span className="skill-type">{skill.category}</span>
                </div>
                <h3>{skill.name}</h3>
                <p>{skill.department}</p>
                <span className="skill-tile-bottom">
                  APPROVED SKILL EXAMPLE <span>0{i + 1}</span>
                </span>
              </article>
            ))
          ) : (
            <p className="no-results">No sample skills match. Try another search or choose All.</p>
          )}
        </div>
        <div className="library-caption">
          <span>A selection from the UBOSS catalog</span>
          <span>
            {CATEGORIES.length} skill categories <span aria-hidden="true">·</span> Built around real
            business work
          </span>
        </div>
      </div>
    </section>
  );
}

const SOLUTIONS = [
  {
    name: 'Operations',
    title: 'Close the service loop.',
    body: 'Coordinate field service from the first condition record to the final sign-off.',
    input: 'A repair request and equipment record',
    ai: 'Prepare a service record from submitted evidence',
    human: 'Complete the repair and approve the record',
    output: 'A reviewed service record and clear ownership',
  },
  {
    name: 'Finance',
    title: 'Review payables with context.',
    body: 'Explore how Accounts Payable Control can support a governed review process.',
    input: 'Payables records and relevant company rules',
    ai: 'Support analysis and preparation of review material',
    human: 'Review exceptions and authorize decisions',
    output: 'A documented review with accountable next steps',
  },
  {
    name: 'IT & Security',
    title: 'Review access. Record decisions.',
    body: 'Use Access Review as a starting point for a repeatable, accountable process.',
    input: 'Access records and the review scope',
    ai: 'Help prepare a structured access review',
    human: 'Decide which permissions should change',
    output: 'A reviewed record of decisions and follow-up work',
  },
  {
    name: 'Compliance',
    title: 'Make due diligence traceable.',
    body: 'Explore due diligence with evidence, a defined skill and a person responsible for the decision.',
    input: 'Due diligence inputs and applicable policy',
    ai: 'Support analysis and prepare findings',
    human: 'Assess findings and make the decision',
    output: 'A traceable review and recorded outcome',
  },
] as const;

export function DepartmentSolutions() {
  const [active, setActive] = useState(0);
  const solution = SOLUTIONS[active]!;
  return (
    <section id="solutions" className="landing-section solutions-section">
      <div className="section-shell">
        <div className="section-heading centered">
          <span className="section-kicker">WORKFLOWS BY DEPARTMENT</span>
          <h2>
            Real work.
            <br />
            <span>Mapped to the right team.</span>
          </h2>
        </div>
        <Tabs
          prefix="solutions"
          labels={SOLUTIONS.map((item) => item.name)}
          active={active}
          onChange={setActive}
        />
        <div
          className="solution-panel"
          id="solutions-panel"
          role="tabpanel"
          aria-labelledby={`solutions-tab-${active}`}
          tabIndex={0}
        >
          <div className="solution-copy">
            <span className="solution-code">WORKFLOW / 0{active + 1}</span>
            <h3>{solution.title}</h3>
            <p>{solution.body}</p>
            <Link href="/demo" className="text-arrow">
              Explore your use case <ArrowRight size={15} />
            </Link>
          </div>
          <div className="solution-flow">
            {[
              { icon: FileText, title: 'The input', text: solution.input },
              { icon: Sparkles, title: 'AI prepares', text: solution.ai },
              { icon: ShieldCheck, title: 'People decide', text: solution.human },
              { icon: CheckCheck, title: 'The outcome', text: solution.output },
            ].map(({ icon: Icon, title, text }, i) => (
              <div key={title} className={`solution-flow-row flow-${i}`}>
                <span>
                  <Icon size={17} />
                </span>
                <div>
                  <small>{title}</small>
                  <p>{text}</p>
                </div>
                {i < 3 && <ArrowDown className="flow-arrow" size={12} />}
              </div>
            ))}
          </div>
        </div>
        <p className="solution-note">
          Illustrative workflows. We’ll define the exact skills, connections and scope with your
          team.
        </p>
      </div>
    </section>
  );
}

export function GovernanceSummary() {
  return (
    <section id="security" className="landing-section governance-summary">
      <div className="section-shell">
        <div className="governance-layout">
          {/*
            The still shield became the thing it was describing — see `ApprovalGate`. The words
            beside it say work stops for a person; the picture now shows that happening.
          */}
          <ApprovalGate />
          <div className="section-heading">
            <span className="section-kicker">AUTHORITY STAYS WITH YOUR PEOPLE</span>
            <h2>
              People approve.
              <br />
              <span>UBOSS keeps the record.</span>
            </h2>
            <p>
              Define who can act, what they can access and which steps need approval. Follow the
              decision from request to outcome.
            </p>
            <div className="governance-points">
              {[
                {
                  icon: ShieldCheck,
                  title: 'People approve',
                  body: 'Consequential steps wait for the right decision.',
                },
                {
                  icon: LockKeyhole,
                  title: 'Access has limits',
                  body: 'Roles and scope define who can do what.',
                },
                {
                  icon: CircleDot,
                  title: 'Decisions leave a record',
                  body: 'Versions, approvals and exceptions stay traceable.',
                },
              ].map(({ icon: Icon, title, body }) => (
                <div key={title}>
                  <Icon size={18} />
                  <div>
                    <h3>{title}</h3>
                    <p>{body}</p>
                  </div>
                </div>
              ))}
            </div>
            <Link href="/security" className="text-arrow">
              Explore governance & security <ArrowUpRight size={16} />
            </Link>
          </div>
        </div>
      </div>
    </section>
  );
}

export function ClosingCTA() {
  return (
    <section className="closing-cta" id="company">
      <div className="section-shell">
        <span className="section-kicker">SEE CHIEF AGENT WITH YOUR OWN USE CASE</span>
        <h2>
          Your workflow.
          <br />
          <span>Inside Chief Agent.</span>
        </h2>
        <p>
          Bring a recurring report, a review process or an operational task. We’ll walk through its
          people, agents, skills and approvals.
        </p>
        <Link href="/demo" className="experience-button">
          Book a Workflow Demo <ArrowUpRight size={17} />
        </Link>
        <span className="closing-wordmark" aria-hidden="true">
          Chief Agent
        </span>
      </div>
    </section>
  );
}
