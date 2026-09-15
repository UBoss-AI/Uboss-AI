import type { Metadata } from 'next';
import type { ReactNode } from 'react';

// The UBoss design system stylesheet: tokens, base layer and component styles.
import '@uboss/ui/styles.css';
import './globals.css';

import { THEME_BOOT_SCRIPT } from '../lib/theme';

export const metadata: Metadata = {
  title: 'UBOSS AI AMS',
  description: 'UBoss — enterprise AI workforce and operations platform.',
};

/**
 * Root layout.
 *
 * This is a bootstrap shell only. The real application shells — UBoss Master Console sidebar,
 * Company Workspace sidebar (with the `UBOSS AI AMS | {Active Workspace Name}` header) and the
 * Settings shell — are built at Prompt 2 from the client's approved UI reference.
 */
export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <head>
        {/*
          The stored Appearance choice, applied before the first paint.

          This cannot be a React effect: the browser paints before any effect runs, so somebody
          who chose Dark would see a white flash on every single navigation. `suppressHydration`
          is not needed — the attribute is set on <html>, which React does not reconcile.
        */}
        <script dangerouslySetInnerHTML={{ __html: THEME_BOOT_SCRIPT }} />
      </head>
      <body>{children}</body>
    </html>
  );
}
