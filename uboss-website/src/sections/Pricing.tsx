import Link from 'next/link';
import { ArrowRight, Check, ShieldCheck } from 'lucide-react';
import { PLANS, PRICING_COMPARISON } from '@/lib/pricing';
import { PRODUCT_START_URL } from '@/lib/product-login';

export function Pricing({ detailed = false }: { detailed?: boolean }) {
  return (
    <section className="landing-section pricing-section" id="pricing">
      <div className="section-shell">
        <div className="section-heading centered">
          <span className="section-kicker">PLANS FOR YOUR ROLLOUT</span>
          {detailed ? (
            <h1>
              Choose your rollout.
              <br />
              <span>Define the scope.</span>
            </h1>
          ) : (
            <h2>
              Choose your rollout.
              <br />
              <span>Define the scope.</span>
            </h2>
          )}
          <p>
            Start with one use case or plan a wider rollout.
            <br />
            We scope the workflows, skills and expected usage with you.
          </p>
        </div>
        <div className="pricing-grid">
          {PLANS.map((plan) => (
            <article
              className={`pricing-card ${plan.featured ? 'pricing-featured' : ''}`}
              key={plan.name}
            >
              <div className="plan-top">
                <span>{plan.audience}</span>
                <span>{plan.number}</span>
              </div>
              <h3>{plan.name}</h3>
              <p className="plan-description">{plan.description}</p>
              <div className="plan-price">
                {plan.price}
                <span>Custom quote · agreed scope and usage</span>
              </div>
              {/*
                Starts a workspace, like every other plan card on this site.

                All three used to go to `/demo`, so the pricing page — the page a buyer reaches
                *after* deciding — was the one page with no way to begin. A reader who got this
                far and pressed the button was put in a queue for a phone call.
              */}
              <Link
                href={
                  PRODUCT_START_URL === ''
                    ? `/demo?plan=${plan.name.toLowerCase()}`
                    : `${PRODUCT_START_URL}?plan=${plan.name.toLowerCase()}`
                }
                className={`plan-button ${plan.featured ? 'primary' : ''}`}
              >
                {plan.cta}
                <ArrowRight size={15} />
              </Link>
              <ul>
                {plan.features.map((feature) => (
                  <li key={feature}>
                    <Check size={14} />
                    {feature}
                  </li>
                ))}
              </ul>
            </article>
          ))}
        </div>
        <div className="pricing-footnote">
          <span>
            <ShieldCheck size={16} /> Approval requirements are defined with your workflow.
          </span>
          {!detailed && (
            <Link href="/pricing">
              Compare engagement options <ArrowRight size={14} />
            </Link>
          )}
        </div>
        {detailed && (
          <div className="comparison-wrap">
            <table className="pricing-comparison">
              <caption>What we’ll define together</caption>
              <thead>
                <tr>
                  <th scope="col">Your requirements</th>
                  {PLANS.map((plan) => (
                    <th key={plan.name} scope="col">
                      {plan.name}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {PRICING_COMPARISON.map(([label, ...values]) => (
                  <tr key={label}>
                    <th scope="row">{label}</th>
                    {values.map((value, i) => (
                      <td key={i}>{value}</td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        <p className="pricing-disclosure">
          Pricing is provided after scoping. Your quote will specify included AI usage, any
          additional charges, onboarding and support. No subscription is started by requesting a
          demo.
        </p>
      </div>
    </section>
  );
}
