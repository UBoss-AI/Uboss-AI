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
    /*
      `suppressHydrationWarning` is on <html> because this element is deliberately different by
      the time React looks at it.

      The script below sets `data-theme` on `document.documentElement` before the first paint. The
      server rendered no such attribute — it cannot know the choice, which lives in localStorage —
      so the server HTML and the live DOM disagree on purpose, and React 19 reports that as a
      hydration mismatch.

      An earlier comment here claimed the flag was unnecessary "because React does not reconcile
      <html>". That is no longer true, and the warning is what says so.

      It suppresses the warning for this element's own attributes only, not for its subtree, so a
      genuine mismatch anywhere inside the application is still reported.
    */
    <html lang="en" suppressHydrationWarning>
      <head>
        {/*
          The stored Appearance choice, applied before the first paint.

          This cannot be a React effect: the browser paints before any effect runs, so somebody who
          chose Dark would see a white flash on every single navigation.
        */}
        <script dangerouslySetInnerHTML={{ __html: THEME_BOOT_SCRIPT }} />
      </head>
      <body>{children}</body>
    </html>
  );
}
