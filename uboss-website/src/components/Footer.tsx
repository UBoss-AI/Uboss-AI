/**
 * The footer.
 *
 * Every link here goes to a route that exists. The brief allows Privacy and Terms "only if actual
 * pages are provided" — there are none, so they are not here. A dead link in a footer is the
 * cheapest way to tell an enterprise buyer the rest of the site is a mock-up too.
 */

import Link from 'next/link';

import { Rule } from './ui';

const COLUMNS: readonly { heading: string; links: { label: string; href: string }[] }[] = [
  {
    heading: 'Product',
    links: [
      { label: 'Objective Optimization', href: '/platform#objectives' },
      { label: 'Human & AI Work', href: '/platform#workforce' },
      { label: 'Skills and rules', href: '/skills' },
      { label: 'Job Agents', href: '/platform#agents' },
      { label: 'Executor', href: '/platform#executor' },
    ],
  },
  {
    heading: 'Platform',
    links: [
      { label: 'Architecture', href: '/platform#platform' },
      { label: 'Access Control', href: '/security#access' },
      { label: 'Hierarchy', href: '/platform#hierarchy' },
      { label: 'Performance', href: '/platform#performance' },
      { label: 'Master Console', href: '/platform#master-console' },
    ],
  },
  {
    heading: 'Security',
    links: [
      { label: 'Governance', href: '/security#governance' },
      { label: 'Security model', href: '/security#security' },
    ],
  },
  {
    heading: 'Solutions',
    links: [
      { label: 'By department', href: '/solutions' },
      { label: 'Plans & pricing', href: '/pricing' },
    ],
  },
  {
    heading: 'Company',
    links: [
      { label: 'About UBoss', href: '/company' },
      { label: 'Book a demo', href: '/demo' },
      { label: 'Sign in', href: '/sign-in' },
    ],
  },
  {
    /*
     * A footer without these is a footer an enterprise buyer reads as a mock-up.
     *
     * Both pages describe how the product behaves and both say, on the page, which facts a
     * contract still has to supply — see their own notes. Linking them is right; pretending they
     * are a signed notice would not be.
     */
    heading: 'Legal',
    links: [
      { label: 'Data and privacy', href: '/privacy' },
      { label: 'How it is sold', href: '/terms' },
    ],
  },
];

export function Footer() {
  return (
    <footer className="relative bg-black">
      <Rule />
      <div className="mx-auto w-full max-w-[1200px] px-6 py-16 sm:px-8 lg:px-10">
        <div className="grid gap-12 md:grid-cols-[1.4fr_repeat(3,1fr)] lg:grid-cols-[1.4fr_repeat(6,1fr)]">
          <div>
            <Link href="/" className="flex items-center gap-2.5">
              <span className="grid h-7 w-7 place-items-center rounded-[9px] bg-gradient-to-br from-[#a78bfa] to-[#7c3aed] text-[13px] font-bold text-white">
                U
              </span>
              <span className="text-[15px] font-semibold tracking-[-0.01em]">Chief Agent</span>
            </Link>
            <p className="mt-1 text-[12px] text-[#8b8b93]">Powered by UBoss AI</p>
            <p className="mt-4 max-w-[30ch] text-[13.5px] leading-relaxed text-[#7f7f89]">
              The AI-driven workforce operating system. Objectives in, governed execution out.
            </p>
          </div>

          {COLUMNS.map((column) => (
            <nav key={column.heading} aria-label={column.heading}>
              <h2 className="mb-4 text-[12px] font-medium uppercase tracking-[0.14em] text-[#f4f4f5]">
                {column.heading}
              </h2>
              <ul className="space-y-2.5">
                {column.links.map((link) => (
                  <li key={link.label}>
                    <Link
                      href={link.href}
                      className="text-[13.5px] text-[#7f7f89] transition-colors duration-200 hover:text-[#a1a1aa]"
                    >
                      {link.label}
                    </Link>
                  </li>
                ))}
              </ul>
            </nav>
          ))}
        </div>

        <div className="mt-14 flex flex-col gap-3 border-t border-white/8 pt-7 sm:flex-row sm:items-center sm:justify-between">
          <p className="text-[12.5px] text-[#8b8b93]">
            © {new Date().getFullYear()} Chief Agent. Powered by UBoss AI.
          </p>
          <p className="text-[12.5px] text-[#8b8b93]">
            Product illustrations on this site depict Chief Agent screens and workflows. They are
            not customer data.
          </p>
        </div>
      </div>
    </footer>
  );
}
