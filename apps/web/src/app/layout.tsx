import type { Metadata } from 'next';
import { Inter, JetBrains_Mono } from 'next/font/google';
import type { ReactNode } from 'react';

// The UBoss design system stylesheet: tokens, base layer and component styles.
import '@uboss/ui/styles.css';
import './globals.css';

import { SIDEBAR_BOOT_SCRIPT, THEME_BOOT_SCRIPT } from '../lib/theme';

/**
 * The two typefaces, carried by the application rather than fetched from Google.
 *
 * ## What was wrong
 *
 * `globals.css` pulled Inter with `@import url(https://fonts.googleapis.com/...)`, and that has
 * three faults, in rising order of seriousness:
 *
 *   1. **It blocks the first paint on a third party.** A stylesheet `@import` is discovered only
 *      after the importing sheet has downloaded and parsed, so the request starts late and the
 *      page waits on a host nobody here controls.
 *   2. **It fails closed on an enterprise network.** Plenty of corporate proxies — and the privacy
 *      rules several customers work under — block `fonts.googleapis.com` outright. There, the
 *      import silently does nothing and the product renders in whatever `system-ui` happens to be:
 *      Segoe UI on Windows, something else on a Mac. Nothing errors; the software just looks like
 *      a different product to those customers.
 *   3. **The monospace face was never loaded at all.** `--uboss-font-mono` has named
 *      'JetBrains Mono' since the tokens were written, and no rule anywhere fetched it. Every
 *      figure set in the numeric face — every chart value, every table of money, the whole of
 *      Reports — has been rendering in Consolas.
 *
 * ## Why `next/font`
 *
 * It downloads both faces at build time and serves them from this application's own origin, so
 * there is no third-party request at runtime and nothing to block. It also emits the
 * `size-adjust` metrics for the fallback face, which is what stops the reflow you normally see
 * when a webfont arrives.
 *
 * `display: 'swap'` is deliberate: text is readable in the fallback immediately and re-renders in
 * Inter when it lands. The alternative hides text for up to three seconds, and a screen somebody
 * uses for eight hours a day should never start blank.
 *
 * The weights are the ones the design system actually sets — 400 through 800 for Inter, 400 to 600
 * for the mono. Listing more would ship files nothing references.
 */
const inter = Inter({
  subsets: ['latin'],
  weight: ['400', '500', '600', '700', '800'],
  display: 'swap',
  variable: '--uboss-font-inter',
});

const jetBrainsMono = JetBrains_Mono({
  subsets: ['latin'],
  weight: ['400', '500', '600'],
  display: 'swap',
  variable: '--uboss-font-jetbrains',
});

export const metadata: Metadata = {
  title: 'Chief Agent | Powered by UBoss AI',
  description: 'Chief Agent, powered by UBoss AI — governed AI workforce and operations platform.',
};

/**
 * Root layout.
 *
 * This is a bootstrap shell only. The real application shells — UBoss Master Console sidebar,
 * Company Workspace sidebar (with the `Chief Agent | {Active Workspace Name}` header) and the
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
    /*
      The font variables go on <html> so the tokens can reach them.

      `--uboss-font-family` and `--uboss-font-mono` are declared on `:root` in the design system,
      and a custom property can only be read from an ancestor. On <body> they would be defined one
      level below the element whose rule needs them, and every token would fall through to its
      fallback — which is exactly the state this change is fixing, arrived at a different way.
    */
    <html
      lang="en"
      className={`${inter.variable} ${jetBrainsMono.variable}`}
      suppressHydrationWarning
    >
      <head>
        {/*
          The stored Appearance choice, applied before the first paint.

          This cannot be a React effect: the browser paints before any effect runs, so somebody who
          chose Dark would see a white flash on every single navigation.
        */}
        <script dangerouslySetInnerHTML={{ __html: THEME_BOOT_SCRIPT }} />
        <script dangerouslySetInnerHTML={{ __html: SIDEBAR_BOOT_SCRIPT }} />
      </head>
      <body>{children}</body>
    </html>
  );
}
