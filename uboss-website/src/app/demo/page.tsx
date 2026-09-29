import type { Metadata } from 'next';
import { ArrowLeft, Building2, Workflow } from 'lucide-react';
import Link from 'next/link';

import { Card, Eyebrow, Heading, Lede, Section } from '@/components/ui';
import { DemoRequestForm } from '@/components/DemoRequestForm';

export const metadata: Metadata = {
  title: 'Book a Demo',
  description:
    'See UBOSS against one of your own objectives — the workflow it produces, the human and AI split, and what would be governed.',
};

/**
 * Book a Demo.
 *
 * Deliberately not a form. A form here would have to post somewhere, and there is no endpoint on
 * this site to post to — a submit button that silently does nothing is worse than an address, and
 * pretending to capture a lead is the kind of fake control the brief rules out. When a CRM is
 * connected this page is where the form goes.
 */
export default async function DemoPage({
  searchParams,
}: {
  searchParams: Promise<{ plan?: string | string[] }>;
}) {
  const { plan } = await searchParams;
  const selectedPlan =
    typeof plan === 'string' && ['pilot', 'business', 'enterprise'].includes(plan)
      ? plan
      : 'exploring';
  const planLabel =
    selectedPlan === 'exploring' ? null : selectedPlan[0]!.toUpperCase() + selectedPlan.slice(1);
  return (
    <Section tone="ink-0" glow className="min-h-[calc(100vh-68px)]">
      <div className="pt-12">
        <Link
          href="/"
          className="inline-flex items-center gap-2 text-[13.5px] text-[#7f7f89] transition-colors hover:text-white"
        >
          <ArrowLeft size={15} />
          Back
        </Link>

        <div className="mt-10 grid gap-14 lg:grid-cols-[1fr_1fr] lg:gap-20">
          <div>
            <Eyebrow>{planLabel ? `Explore ${planLabel}` : 'Book a demo'}</Eyebrow>
            <Heading as="h1">Bring one real objective.</Heading>
            <Lede className="mt-7">
              The demo is not a slide deck. Bring a piece of work your teams actually do — a
              recurring report, a review cycle, a compliance check — and we will put it through
              UBOSS while you watch.
            </Lede>

            <div className="mt-10 space-y-3">
              {[
                {
                  icon: Workflow,
                  title: 'What you will see',
                  body: 'Your objective decomposed into a workflow, split into human and AI work, with the approvals and evidence each step needs.',
                },
                {
                  icon: Building2,
                  title: 'Who should be there',
                  body: 'The manager who owns the work, and whoever in your organisation has to be satisfied about governance.',
                },
              ].map(({ icon: Icon, title, body }) => (
                <Card key={title} className="flex gap-4">
                  <span className="mt-0.5 grid h-9 w-9 shrink-0 place-items-center rounded-xl border border-white/10 bg-white/[0.03]">
                    <Icon size={15} className="text-[#a78bfa]" />
                  </span>
                  <div>
                    <h2 className="text-[15.5px] font-medium text-white">{title}</h2>
                    <p className="mt-1.5 text-[13.5px] leading-[1.6] text-[#a1a1aa]">{body}</p>
                  </div>
                </Card>
              ))}
            </div>
          </div>

          <div>
            <DemoRequestForm initialPlan={selectedPlan} />
          </div>
        </div>
      </div>
    </Section>
  );
}
