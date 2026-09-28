import type { Metadata, Viewport } from 'next';

import { Footer } from '@/components/Footer';
import { Nav } from '@/components/Nav';

import '@fontsource-variable/manrope';
import '@fontsource-variable/space-grotesk';
import './globals.css';

/**
 * Metadata written for the people the brief names: executives, operations leaders and security
 * teams. No invented awards, no customer counts, no certification claims — there are none to make.
 */
export const metadata: Metadata = {
  metadataBase: new URL('https://ubossai.com'),
  title: {
    default: 'Chief Agent | Powered by UBoss AI',
    template: '%s | Chief Agent',
  },
  description:
    'UBOSS connects human teams and governed AI Agents in one operating system — from objectives and workflows to approvals, execution, monitoring and measurable outcomes.',
  keywords: [
    'AI workforce',
    'enterprise AI governance',
    'objective optimization',
    'AI agents',
    'workflow automation',
    'approval governance',
  ],
  openGraph: {
    type: 'website',
    siteName: 'Chief Agent',
    title: 'Chief Agent | Powered by UBoss AI',
    description:
      'Turn business objectives into work that gets done. Humans stay accountable; governed AI handles approved repeatable work.',
  },
  robots: { index: true, follow: true },
};

export const viewport: Viewport = {
  themeColor: '#000000',
  colorScheme: 'dark',
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body className="bg-black text-[#f4f4f5] antialiased">
        {/* First stop for a keyboard, before a nav with fourteen controls in it. */}
        <a
          href="#main"
          className="sr-only focus:not-sr-only focus:fixed focus:left-4 focus:top-4 focus:z-[100] focus:rounded-lg focus:bg-white focus:px-4 focus:py-2 focus:text-[14px] focus:font-medium focus:text-black"
        >
          Skip to content
        </a>
        <Nav />
        <main id="main">{children}</main>
        <Footer />
      </body>
    </html>
  );
}
