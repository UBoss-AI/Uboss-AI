import type { Metadata } from 'next';

import { Card, CardGrid, Section } from '@/components/site/Section';
import { RouteIntro } from '@/components/RouteIntro';

export const metadata: Metadata = {
  title: 'Data and privacy',
  description:
    'What Chief Agent stores, where it lives, who can see it and how long it is kept — described from how the product actually behaves.',
};

/**
 * Data and privacy.
 *
 * ## What this page is, and what it is not
 *
 * It is a plain description of how the product handles data, written from the product's own
 * behaviour: the row-level separation between companies, the append-only trail, the Aadhaar rule,
 * where a company's data sits, and what UBoss itself can and cannot see. Every claim here is
 * enforced in software and can be demonstrated.
 *
 * **It is not a privacy notice, and it does not pretend to be one.** A notice under the DPDP Act or
 * the GDPR has to name the legal entity that is the data fiduciary or controller, give a registered
 * address, name a contact for data-protection requests, and list the sub-processors that touch
 * personal data. None of those four facts is known here, and inventing any of them would be worse
 * than the page not existing — an invented registered address on a privacy notice is the single
 * most checkable false statement a website can carry.
 *
 * So the page says what is true, and says plainly what is still required. See `NOT_YET` below: it
 * renders on the page rather than sitting in a comment, because a reader in procurement needs to
 * know what they are still owed, and a note nobody can see is a note that never gets actioned.
 *
 * ### The sub-processor question, which is a decision and not an oversight
 *
 * A notice must disclose the providers that process personal data, and that includes the model
 * provider behind AI runs. The product deliberately never shows a company which model provider is
 * used — that is a commercial decision about the product's surface. A legal notice is a different
 * surface with a different obligation, and the two need reconciling by whoever signs it. That is
 * flagged rather than quietly resolved in either direction.
 */

/** True of the product, and demonstrable. */
const HANDLING = [
  {
    title: 'One company cannot read another',
    body: 'Separation is enforced by the database, not only by the application. Every company-owned table carries a row-level policy, and the account the product connects with cannot bypass it. A query that asks for another company’s rows returns nothing, whatever the code above intended.',
  },
  {
    title: 'What happens is recorded, and the record cannot be edited',
    body: 'Actions land in an append-only trail, hash-chained so that a removed or altered row shows as a break rather than as nothing. It holds who acted, what changed, when, and the reason where the action required one.',
  },
  {
    title: 'A company’s data sits with that company',
    body: 'Data residency is set per company rather than globally, so where your data lives is part of your arrangement rather than a platform-wide default you inherit.',
  },
  {
    title: 'Aadhaar is used for matching, and nothing else',
    body: 'Where an Aadhaar number is entered it is used to match a person to a record inside your own company. UBoss does not perform Aadhaar authentication and does not claim verified Aadhaar status. It is not identity evidence and no decision in the product treats it as such.',
  },
  {
    title: 'A photograph is optional, and it is not identity',
    body: 'An employee photograph is one of the things a company may add and is never required. It appears where a colleague’s name already appears, and nowhere else.',
  },
  {
    title: 'There is no public sign-up',
    body: 'A company exists in UBoss because somebody at UBoss provisioned it. Nobody can create a workspace holding your people’s data by filling in a form.',
  },
] as const;

/** Stated on the page, because procurement needs to know what is still owed. */
const NOT_YET = [
  'The legal entity that is the data fiduciary, and its registered address',
  'A named contact for data-protection and data-subject requests',
  'The list of sub-processors that handle personal data, including the model provider behind AI runs',
  'Retention periods, stated per kind of record',
] as const;

export default function PrivacyPage() {
  return (
    <div className="subpage">
      <RouteIntro
        eyebrow="DATA AND PRIVACY"
        title="What the product does"
        accent="with your data."
        description="Described from how Chief Agent actually behaves, not from what a policy would like to be true. Each of the statements below is enforced in the software and can be shown to you in the product."
        primary="Ask us anything about this"
        secondary={{ label: 'How access is controlled', href: '/security' }}
      />

      <Section
        kicker="How it behaves"
        title={
          <>
            Enforced, not <em>promised</em>.
          </>
        }
        lead="The difference matters. A policy is a statement of intent; these are properties of the running system, and the ones about separation and the audit trail are enforced below the application, where the application cannot talk its way past them."
      >
        <CardGrid as="ul" min={300}>
          {HANDLING.map((item, index) => (
            <Card as="li" key={item.title} index={index}>
              <h3 className="card__title">{item.title}</h3>
              <p className="card__body">{item.body}</p>
            </Card>
          ))}
        </CardGrid>
      </Section>

      <Section
        tone="sunk"
        kicker="Not yet on this page"
        title={
          <>
            What a notice still <em>needs</em>.
          </>
        }
        lead="This page describes the product. It is not a privacy notice under the DPDP Act or the GDPR, and it does not stand in for one — a notice has to carry facts about the company, and those are not written here because they would have to be invented."
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
          Until those are supplied by the company, this page is a description and not an
          undertaking. If you are evaluating Chief Agent and need the notice for procurement, ask
          and it will come from the company rather than from this website.
        </p>
      </Section>
    </div>
  );
}
