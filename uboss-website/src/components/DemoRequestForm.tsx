'use client';

import type { FormEvent } from 'react';

const inputClass = 'demo-field w-full rounded-lg border border-white/10 bg-[#101116] px-4 py-3 text-[13px] text-white placeholder:text-[#666674]';

export function DemoRequestForm({ initialPlan }: { initialPlan: string }) {
  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const values = new FormData(event.currentTarget);
    const fields = [
      ['Name', values.get('name')],
      ['Company', values.get('company')],
      ['Work email', values.get('email')],
      ['Rollout', values.get('plan')],
      ['Workflow objective', values.get('objective')],
    ];
    const body = fields.map(([label, value]) => `${label}: ${String(value ?? '').trim()}`).join('\n\n');
    window.location.href = `mailto:dev@ubossai.com?subject=${encodeURIComponent('Chief Agent workflow demo request')}&body=${encodeURIComponent(body)}`;
  }

  return (
    <form className="demo-request-form" onSubmit={submit}>
      <div className="demo-form-heading">
        <span className="section-kicker">START A CONVERSATION</span>
        <h2>Tell us about the work.</h2>
        <p>Share one real workflow and we’ll use it to shape the conversation.</p>
      </div>
      <div className="demo-form-grid">
        <label>Name<input className={inputClass} name="name" autoComplete="name" required placeholder="Your name" /></label>
        <label>Company<input className={inputClass} name="company" autoComplete="organization" required placeholder="Company name" /></label>
        <label className="demo-form-wide">Work email<input className={inputClass} type="email" name="email" autoComplete="email" required placeholder="you@company.com" /></label>
        <label className="demo-form-wide">Rollout you’re exploring
          <select className={inputClass} name="plan" defaultValue={initialPlan}>
            <option value="pilot">One workflow pilot</option>
            <option value="business">Multi-team rollout</option>
            <option value="enterprise">Company-wide rollout</option>
            <option value="exploring">Still exploring</option>
          </select>
        </label>
        <label className="demo-form-wide">What work should we look at?
          <textarea className={inputClass} name="objective" required minLength={12} rows={4} placeholder="For example: review each repair request, assign the right team and prepare the service record for approval." />
        </label>
      </div>
      <button className="demo-form-submit" type="submit">Prepare demo request <span aria-hidden="true">→</span></button>
      <p className="demo-form-note">Your email app opens with these details addressed to dev@ubossai.com. Review and send it there. This site does not store or submit your information.</p>
    </form>
  );
}
