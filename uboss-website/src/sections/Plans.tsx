import Link from 'next/link';
import { Check, Minus } from 'lucide-react';

import { Card, CardGrid, Section } from '@/components/site/Section';
import { Reveal } from '@/components/site/Reveal';
import { COMPARED_MODULES, MODULE_LABELS, PLANS } from '@/lib/plans';
import { PRODUCT_START_URL } from '@/lib/product-login';

/**
 * The plans, and what each one actually opens.
 *
 * ## What this replaces
 *
 * Three cards reading "Custom pilot quote", "Team rollout quote" and "Enterprise quote", each with
 * four sentences that could have described any software sold to a company: *a scoped agent and
 * skill configuration*, *usage and onboarding scoped to your needs*. A reader finished it knowing
 * only that there were three of something and that all three required a phone call.
 *
 * The plans are real and they differ in ways that are easy to state: a Pilot opens five modules
 * and no AI, Growth opens twelve including the Agent Builder, Enterprise adds custom roles. That
 * is the answer somebody came for, and it is checkable — every module below is read from the
 * platform's own `entitled_modules`.
 *
 * ## The price is the one thing still missing, and the page says so
 *
 * See `lib/plans.ts`. The product's prices are set in dollars while the company is priced in
 * rupees; printing either the dollar figure or a converted one would put a number here that the
 * invoice contradicts. So this asks, and states what it will cost you to find out: a conversation.
 */
export function Plans(): React.JSX.Element {
  return (
    <Section
      id="pricing"
      kicker="Plans"
      title={
        <>
          Four plans. The difference is <em>what opens</em>.
        </>
      }
      lead="Every plan is the same product. What changes is how much of it a company can see, how many people it seats, and whether AI work is included."
    >
      <CardGrid as="ul" min={268}>
        {PLANS.map((plan, index) => (
          <Card as="li" key={plan.code} index={index} featured={plan.featured}>
            <p className="card__eyebrow">{plan.featured ? 'Most companies start here' : ' '}</p>
            <h3 className="card__title">{plan.name}</h3>
            <p className="card__body">{plan.purpose}</p>

            <div className="plan__figures">
              <span>
                <b>{plan.seats === null ? 'Agreed' : plan.seats}</b>
                {plan.seats === null ? 'seats' : plan.seats === 1 ? 'seat' : 'seats'}
              </span>
              <span>
                <b>{plan.modules.length}</b>
                modules
              </span>
              <span>
                <b>{plan.includesAi ? 'Included' : 'None'}</b>
                AI allowance
              </span>
            </div>

            <div className="card__rule" />

            <ul className="card__list">
              {plan.adds.map((add) => (
                <li key={add}>
                  <Check size={15} strokeWidth={2.4} aria-hidden="true" />
                  <span>{add}</span>
                </li>
              ))}
            </ul>

            {/*
              Every card starts a workspace. None of them ends at a call-back form.

              Only Pilot used to: the other three went to `/demo`, on the reasoning that a paid
              price is a conversation and a signup cannot name its own plan — the server refuses a
              `planCode` outright. Both halves of that were true and the conclusion was still
              wrong. A reader who has decided on Growth and is shown "Talk to us" has been stopped
              at the one moment they were ready, and made to wait for a call to get a workspace
              they could have had in two minutes.

              So every card registers, and the plan travels with it as `?plan=` — not as a promise
              the signup can keep, but so the next screen can say plainly that the workspace opens
              on Pilot and this is where the chosen plan is applied. Naming it and explaining it
              is honest; sending them to a form is not.

              Enterprise keeps a second, quieter route to sales underneath, because a negotiated
              contract really is a conversation — but it is offered *as well as* starting, not
              instead of it.

              Where the product's address is not configured for this deployment, the cards fall
              back to `/demo` rather than linking into the dark.
            */}
            <Link
              className="plan__cta"
              href={PRODUCT_START_URL === '' ? '/demo' : `${PRODUCT_START_URL}?plan=${plan.code}`}
            >
              {plan.cta}
            </Link>

            {plan.code === 'enterprise' && (
              <Link className="plan__secondary" href={`/demo?plan=${plan.code}`}>
                Or talk to sales first
              </Link>
            )}
          </Card>
        ))}
      </CardGrid>

      {/*
        Said once, plainly, rather than as an asterisk under a number that is not there.

        A pricing page with no price has to explain itself or it reads as a page that failed to
        load. This is the explanation, and it is the truth: the figure is being set, and quoting
        one before it is would be worse than asking.
      */}
      <Reveal className="plan__note">
        <p>
          <b>What a plan costs is agreed with you.</b> Seats, the monthly allowance and the plan
          itself are set per company, and an invoice follows what was agreed rather than a number on
          a web page. Tell us the work you want to put through UBoss and you will get the figure for
          that, not for a tier.
        </p>
      </Reveal>

      {/*
        The comparison, derived from the same plan objects as the cards above.

        Written out by hand it is the table that says a plan includes Reports when its module list
        does not — and nobody finds that until a customer does.
      */}
      <Reveal className="plan__table-wrap">
        <table className="plan__table">
          <caption>What each plan opens</caption>
          <thead>
            <tr>
              <th scope="col">Module</th>
              {PLANS.map((plan) => (
                <th key={plan.code} scope="col">
                  {plan.name}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {COMPARED_MODULES.map((module) => (
              <tr key={module}>
                <th scope="row">{MODULE_LABELS[module] ?? module}</th>
                {PLANS.map((plan) => {
                  const has = plan.modules.includes(module);
                  return (
                    <td key={plan.code} data-has={has ? 'yes' : 'no'}>
                      {has ? (
                        <Check size={16} strokeWidth={2.6} aria-label="Included" />
                      ) : (
                        <Minus size={16} strokeWidth={2.2} aria-label="Not in this plan" />
                      )}
                    </td>
                  );
                })}
              </tr>
            ))}
            <tr>
              <th scope="row">Seats</th>
              {PLANS.map((plan) => (
                <td key={plan.code} className="plan__cell-text">
                  {plan.seats === null ? 'Agreed' : plan.seats}
                </td>
              ))}
            </tr>
            <tr>
              <th scope="row">Monthly AI allowance</th>
              {PLANS.map((plan) => (
                <td key={plan.code} className="plan__cell-text">
                  {plan.includesAi ? 'Included' : 'None'}
                </td>
              ))}
            </tr>
          </tbody>
        </table>
      </Reveal>
    </Section>
  );
}
