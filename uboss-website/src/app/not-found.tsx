import Link from 'next/link';

import { Button, Heading, Lede, Section } from '@/components/ui';

/** A 404 that offers the two things anybody arriving here actually wants. */
export default function NotFound() {
  return (
    <Section tone="ink-0" glow className="min-h-[calc(100vh-68px)]">
      <div className="mx-auto max-w-[560px] py-24 text-center">
        <p className="font-mono text-[13px] tracking-[0.2em] text-[#8b8b93]">404</p>
        <Heading as="h1" className="mt-6">
          That page does not exist.
        </Heading>
        <Lede className="mx-auto mt-6 text-center">
          The link may be out of date. Explore the platform or see how UBOSS would support your
          work.
        </Lede>
        <div className="mt-10 flex flex-col items-center justify-center gap-3 sm:flex-row">
          <Button href="/">Back to Chief Agent</Button>
          <Button href="/demo" variant="ghost">
            Book a Demo
          </Button>
        </div>
        <p className="mt-10 text-[12.5px] text-[#8b8b93]">
          Looking for something specific?{' '}
          <Link href="/platform" className="text-[#a78bfa] hover:underline">
            The platform overview
          </Link>{' '}
          is a good start.
        </p>
      </div>
    </Section>
  );
}
