import type { Metadata } from 'next';

import { Plans } from '@/sections/Plans';
import { FAQ } from '@/sections/FAQ';
import { RouteIntro } from '@/components/RouteIntro';

export const metadata: Metadata = {
  title: 'Plans',
  description:
    'Four plans of one product. What changes between them is how much of UBoss a company can see, how many people it seats, and whether AI work is included.',
};

/**
 * Plans.
 *
 * The page answers one question — what do I get — and answers it from the platform's own plan
 * table rather than from marketing copy. See `lib/plans.ts` for where each number comes from and
 * why the prices are a conversation rather than a figure.
 */
export default function PricingPage() {
  return (
    <div className="subpage">
      <RouteIntro
        eyebrow="PLANS"
        title="Same product."
        accent="Different amount of it."
        description="Every plan opens the same UBoss. What a plan decides is how many of its modules a company can see, how many people it seats, and whether a monthly AI allowance is included."
        primary="Talk to us about your workload"
        facts={[
          { value: '4', label: 'Plans, from a pilot to a negotiated rollout' },
          { value: '5 to 14', label: 'Modules, depending on the plan' },
          { value: '1 to 40', label: 'Seats, or a number agreed with you' },
        ]}
      />
      <Plans />
      <FAQ />
    </div>
  );
}
