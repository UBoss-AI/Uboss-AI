import type { Metadata } from 'next';

import { Card, CardGrid, Section } from '@/components/site/Section';
import { RouteIntro } from '@/components/RouteIntro';

export const metadata: Metadata = {
  title: 'How it is sold',
  description:
    'How Chief Agent is bought and used: what a plan decides, how AI work is paid for, what happens when an allowance runs out, and what happens to your data when you leave.',
};

/**
 * How it is sold.
 *
 * ## Why this is not called "Terms of Service"
 *
 * A terms page is a contract. This is not one: there is no agreed governing law, no liability
 * position, no notice period and no signed entity behind it, and writing plausible legal prose for
 * any of those would produce a document that reads as binding and is not. That is worse than
 * having no page — a customer who relies on it and a customer who checks it are both misled.
 *
 * What a buyer actually needs before the contract stage is the *commercial mechanics*: what a plan
 * decides, how AI use is measured and paid for, what happens when the allowance is gone, and what
 * happens to their data if they leave. All four are properties of the product, all four are true,
 * and all four are usually the questions a contract discussion opens with.
 *
 * `NOT_YET` renders on the page, for the same reason as on the privacy page: a procurement reader
 * has to know what they are still owed, and the missing items are the contract itself.
 */

const MECHANICS = [
  {
    title: 'A plan decides how much of the product opens',
    body: 'Every plan is the same software. What a plan sets is which modules a company can see, how many people it seats, and whether a monthly AI allowance is included. Nothing is a different product; it is a different amount of one.',
  },
  {
    title: 'AI work is paid for before it happens',
    body: 'Each run reserves against your allowance before it calls anything, and settles at what it actually used. There is no arrangement under which a company finds out afterwards that it has spent more than it meant to.',
  },
  {
    title: 'When the allowance is gone, work stops',
    body: 'It is a hard stop, not a warning: further AI work is refused until the period renews or more is added. Your people keep working — the product does not stop — but nothing bills beyond what you agreed.',
  },
  {
    title: 'Seats are a commercial limit, not a permission',
    body: 'Buying more seats grants nobody any authority. What a person may do comes from their role, and the two are separate on purpose so that a commercial change can never widen access.',
  },
  {
    title: 'Reducing your seats deletes nobody',
    body: 'Lowering a seat count is assessed before it is applied and removes no user, no employment record, no task and no history. The ceiling changes; the people do not disappear.',
  },
  {
    title: 'Leaving does not erase what happened',
    body: 'Offboarding a person, or a company exiting, preserves the record: the membership, the employment record and every audit event remain. Access ends; history does not, because a record that can be deleted was never a record.',
  },
] as const;

const NOT_YET = [
  'The contracting entity, and the law the agreement is governed by',
  'Liability, warranty and indemnity positions',
  'Notice periods, renewal and termination terms',
  'Any service level, which does not exist until it is measured and committed to',
] as const;

export default function TermsPage() {
  return (
    <div className="subpage">
      <RouteIntro
        eyebrow="HOW IT IS SOLD"
        title="What you are"
        accent="actually buying."
        description="The commercial mechanics, stated before the contract stage: what a plan decides, how AI use is paid for, what happens when the allowance runs out, and what happens to your data when somebody leaves."
        primary="Talk to us about a contract"
        secondary={{ label: 'What each plan opens', href: '/pricing' }}
      />

      <Section
        kicker="The mechanics"
        title={
          <>
            How the commercial side <em>works</em>.
          </>
        }
        lead="Each of these is how the product behaves rather than a position taken in writing — which means you can ask to be shown any of them instead of taking it on trust."
      >
        <CardGrid as="ul" min={300}>
          {MECHANICS.map((item, index) => (
            <Card as="li" key={item.title} index={index}>
              <h3 className="card__title">{item.title}</h3>
              <p className="card__body">{item.body}</p>
            </Card>
          ))}
        </CardGrid>
      </Section>

      <Section
        tone="sunk"
        kicker="Not on this page"
        title={
          <>
            This is not a <em>contract</em>.
          </>
        }
        lead="Nothing here is an agreement, and it is not written as one. The terms that bind either side come from the contract you sign, and these are the parts of it that no website should improvise."
      >
        <ul className="card__list legal__owed">
          {NOT_YET.map((item) => (
            <li key={item}>
              <span aria-hidden="true">—</span>
              <span>{item}</span>
            </li>
          ))}
        </ul>
        <p className="legal__note">
          If you are at the stage of needing those, ask — they come from the company, in a document
          somebody signs, rather than from a page on a website.
        </p>
      </Section>
    </div>
  );
}
