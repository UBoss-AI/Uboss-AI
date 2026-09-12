import Link from 'next/link';

import { Card, CardBody, PageHeader } from '@uboss/ui';

interface ShowcaseEntry {
  href: string;
  title: string;
  description: string;
}

const ENTRIES: ShowcaseEntry[] = [
  {
    href: '/design-system/components',
    title: 'Components & states',
    description:
      'Every shared primitive with its loading, empty, error, permission-denied and success states.',
  },
  {
    href: '/design-system/company',
    title: 'Company Workspace shell',
    description:
      'Sidebar, UBOSS AI AMS | {Active Workspace Name} header, and the two-slice dashboard donut.',
  },
  {
    href: '/design-system/master',
    title: 'UBoss Master Console shell',
    description: 'The dark platform control plane with its own navigation and KPI cards.',
  },
  {
    href: '/design-system/settings',
    title: 'Settings shell',
    description: 'Left settings navigation with the right detail panel, across all 19 categories.',
  },
  {
    href: '/design-system/login',
    title: 'Login presentation',
    description:
      'The six locked sections — MAP, Optimize, Build, Operate, Govern, Manage Task. No public signup.',
  },
];

/**
 * Internal component showcase.
 *
 * Chosen over Storybook to avoid a second build toolchain: this route renders the real
 * components from @uboss/ui inside the real Next.js app, so what is reviewed here is exactly
 * what screens will use. It carries no business API calls.
 */
export default function DesignSystemPage() {
  return (
    <div className="uboss-content">
      <PageHeader
        title="UBoss design system"
        description="Tokens, shared primitives and application shells. Mock navigation only — no business data."
        breadcrumbs={[{ label: 'Design system' }]}
      />

      <div
        className="uboss-grid"
        style={{ gridTemplateColumns: 'repeat(auto-fit,minmax(280px,1fr))' }}
      >
        {ENTRIES.map((entry) => (
          <Link key={entry.href} href={entry.href} style={{ display: 'block' }}>
            <Card>
              <CardBody>
                <b style={{ fontSize: 15 }}>{entry.title}</b>
                <p className="uboss-muted" style={{ marginTop: 6 }}>
                  {entry.description}
                </p>
              </CardBody>
            </Card>
          </Link>
        ))}
      </div>

      <p className="uboss-notice" style={{ marginTop: 24 }}>
        Prompt 2 delivers the design system and shells only. Feature screens, authentication and
        real data arrive in later prompts.
      </p>
    </div>
  );
}
