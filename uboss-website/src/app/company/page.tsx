import type { Metadata } from 'next';
import Link from 'next/link';

import { Card, CardGrid, Section } from '@/components/site/Section';
import { RouteIntro } from '@/components/RouteIntro';
import { CATALOG } from '@/lib/catalog';

export const metadata: Metadata = {
  title: 'Company',
  description:
    'Who builds Chief Agent, what it is for, and the rules the product is built to — human authority over AI execution, recorded decisions, and a company’s data kept to itself.',
};

/**
 * Company.
 *
 * ## Why an enterprise site needs one
 *
 * A buyer signing a contract asks who they are signing it with, and the answer is not on any
 * product page. Research on enterprise B2B sites puts a company page in the same group as security
 * and pricing — the pages a procurement reader opens before the ones marketing wrote.
 *
 * ## What is here, and what is deliberately not
 *
 * There are no founder photographs, no invented founding story, no "trusted by" row and no
 * investor logos. None of those are known to be true, and a company page is exactly where a
 * fabricated detail is most likely to be checked.
 *
 * What is here is the part that *is* true and that a buyer actually needs: what the product is
 * for, the principles it is built to — each of which is enforced in the software rather than
 * promised here — and the honest statement that it is early. Saying "we are new" is a better
 * position than implying a decade of customers to somebody who will ask for a reference.
 *
 * **Legal entity details, the registered address and a named data-protection contact are not on
 * this page because they have not been supplied.** Procurement will ask for all three. They belong
 * here the day they are known.
 */

/** The rules the product is built to. Every one is enforced in the software, not stated here. */
const PRINCIPLES = [
  {
    title: 'A person decides. The software does not.',
    body: 'Approval is a step in the work, not a setting somebody can switch off. Where a decision matters, the run stops and waits for a named person — and nobody approves their own request.',
  },
  {
    title: 'Nothing an agent does is unaccounted for',
    body: 'Every action lands in an append-only, hash-chained record: who, what, when, and the reason where one is required. A removed row shows up as a break in the chain rather than as nothing.',
  },
  {
    title: 'Your company’s data stays your company’s',
    body: 'Separation is enforced by the database itself, not only by the code above it. A query that asks for another company’s rows is refused by the row-level policy, whatever the application intended.',
  },
  {
    title: 'An AI run is paid for before it happens',
    body: 'Work is costed against a budget you set, and refused when the budget is gone. There is no arrangement under which a company discovers what it spent afterwards.',
  },
] as const;

export default function CompanyPage() {
  return (
    <div className="subpage">
      <RouteIntro
        eyebrow="COMPANY"
        title="Software that keeps"
        accent="people in charge."
        description="Chief Agent is built by UBoss AI. It exists because AI can do a great deal of a company’s work, and none of it should happen without somebody accountable for the outcome."
        primary="Talk to us"
        secondary={{ label: 'How that is enforced', href: '/security' }}
      />

      <Section
        kicker="What we are building"
        title={
          <>
            An AI workforce with an <em>owner</em> for every outcome.
          </>
        }
        lead="Most AI tools help one person work faster. Chief Agent is for the work a company owes somebody else — where a task has a deadline, a standard and a person whose name is on it. That work can be done by an agent. It cannot be done unaccountably."
      >
        {/*
          The portrait sits here and nowhere else on the site, and the placement is the argument.

          It is an AI rendered with a human face, and on any page that claims a *person* stays in
          charge it would say the opposite of the words beside it — which is why the governance
          panel shows work stopping at a gate instead. On this page the subject is the company and
          what it is trying to build, so the image reads as what it is: the idea, not a claim about
          the product.

          `loading="lazy"` and a fixed aspect: it is below the fold, it is not the point of the
          page, and reserving its box stops the principles below it jumping when it arrives.
        */}
        <div className="company__portrait-row">
          <figure className="company__portrait">
            <img
              src="/company-portrait.png"
              alt=""
              width={543}
              height={524}
              loading="lazy"
              decoding="async"
            />
          </figure>

          <CardGrid as="ul" min={280} className="company__principles">
            {PRINCIPLES.map((principle, index) => (
              <Card as="li" key={principle.title} index={index}>
                <h3 className="card__title">{principle.title}</h3>
                <p className="card__body">{principle.body}</p>
              </Card>
            ))}
          </CardGrid>
        </div>
      </Section>

      <Section
        tone="sunk"
        kicker="Where we are"
        title={
          <>
            Early, and <em>specific</em> about it.
          </>
        }
        lead="Chief Agent is a new product. There is no customer list on this website and no logo wall, because putting one up before it is earned is the fastest way to lose the first real conversation."
      >
        <CardGrid as="ul" min={280}>
          <Card as="li" index={0}>
            <p className="card__eyebrow">What is built</p>
            <span className="card__figure">{CATALOG.skills}</span>
            <p className="card__body">
              Governed Skills in the catalogue, carrying {CATALOG.rules.toLocaleString()} IF-THEN
              rules across {CATALOG.industries} industries. These are figures you can ask us to show
              you in the product.
            </p>
          </Card>

          <Card as="li" index={1}>
            <p className="card__eyebrow">What we will not say</p>
            <span className="card__figure">No</span>
            <p className="card__body">
              Customer counts, uptime percentages or certifications — because there are none to
              quote yet. When there are, they will appear here with the evidence behind them.
            </p>
          </Card>

          <Card as="li" index={2}>
            <p className="card__eyebrow">What we want</p>
            <span className="card__figure">One</span>
            <p className="card__body">
              A real objective from your company, put through the product with your people. That is
              what a demo is for, and it is the only way either of us finds out whether this fits.
            </p>
            <Link className="plan__cta" href="/demo">
              Bring one objective
            </Link>
          </Card>
        </CardGrid>
      </Section>
    </div>
  );
}
