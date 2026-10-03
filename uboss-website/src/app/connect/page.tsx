import type { Metadata } from 'next';

import { ApiSection } from '@/sections/ApiSection';
import { ClosingCTA } from '@/sections/WorkforceSections';
import { RouteIntro } from '@/components/RouteIntro';
import { API_FACTS } from '@/lib/api-surface';

export const metadata: Metadata = {
  title: 'Connect',
  description:
    'Connect Chief Agent to the systems you already run: your directory keeps deciding who exists, your identity provider keeps deciding how they sign in, and your own systems can reach the work through a documented API.',
};

/**
 * Connect.
 *
 * Called **Connect** rather than API, because the question a buyer arrives with is "will this fit
 * what we already run", and "API" answers only a third of it — the other two thirds are their
 * directory and their sign-on. A page called API also tells everybody who is not a developer that
 * the page is not for them, when they are the ones who have to sign off on identity.
 */
export default function ConnectPage() {
  return (
    <div className="subpage">
      <RouteIntro
        eyebrow="CONNECT"
        title="It fits what"
        accent="you already run."
        description="Your directory keeps deciding who exists. Your identity provider keeps deciding how they sign in. And anything the screens can do, your systems can do — as the person who authorised it."
        primary="Talk to us about your stack"
        secondary={{ label: 'How the work runs', href: '/how-it-works' }}
        facts={API_FACTS}
      />
      <ApiSection />
      <ClosingCTA />
    </div>
  );
}
