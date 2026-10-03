import { Check } from 'lucide-react';

import { Card, CardGrid, Section } from '@/components/site/Section';
import { API_CAPABILITIES } from '@/lib/api-surface';

/**
 * Connecting UBoss to what a company already runs.
 *
 * Four cards, and the second one is the point: there are no API keys, because a program acts as a
 * person and inherits that person's permissions. Most software sells the opposite — a key, a
 * service account, a scope list — so saying it plainly is worth a card of its own rather than a
 * line in a feature table.
 *
 * What the section leaves out is deliberate and is argued in `lib/api-surface.ts`: the platform
 * plane, the machine-readable document, the database's own row security. All true, none of it a
 * customer's question.
 */
export function ApiSection(): React.JSX.Element {
  return (
    <Section
      id="api"
      tone="sunk"
      kicker="Connect it"
      title={
        <>
          It fits what you <em>already run</em>.
        </>
      }
      lead="Your directory decides who exists. Your identity provider decides how they sign in. And anything the screens can do, your own systems can do — as the person who authorised it, never as more."
    >
      <CardGrid as="ul" min={288}>
        {API_CAPABILITIES.map((capability, index) => (
          <Card as="li" key={capability.title} index={index}>
            <h3 className="card__title">{capability.title}</h3>
            <p className="card__body">{capability.body}</p>
            <div className="card__rule" />
            <ul className="card__list">
              {capability.points.map((point) => (
                <li key={point}>
                  <Check size={15} strokeWidth={2.4} aria-hidden="true" />
                  <span>{point}</span>
                </li>
              ))}
            </ul>
          </Card>
        ))}
      </CardGrid>
    </Section>
  );
}
