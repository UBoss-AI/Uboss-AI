import type { Metadata } from 'next';
import { Pricing } from '@/sections/Pricing';
import { FAQ } from '@/sections/FAQ';
import { RouteIntro } from '@/components/RouteIntro';
export const metadata: Metadata = {
  title: 'Plans & Pricing',
  description:
    'Explore a scoped UBOSS pilot, a team rollout or an enterprise engagement. Pricing is tailored to your workflows, skills and AI usage.',
};
export default function PricingPage() {
  return (
    <div className="subpage">
      <RouteIntro
        eyebrow="PLANS & PRICING"
        title="Start with one use case."
        accent="Scale with clarity."
        description="Choose a focused pilot, a multi-team rollout or a company-wide engagement. Scope and usage are agreed with your team."
        primary="Discuss rollout options"
      />
      <Pricing detailed />
      <FAQ />
    </div>
  );
}
