import type { Metadata } from 'next';
import localFont from 'next/font/local';
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
 * It serves both faces from this application's own origin, so there is no third-party request at
 * runtime and nothing to block. It also emits the `size-adjust` metrics for the fallback face,
 * which is what stops the reflow you normally see when a webfont arrives.
 *
 * `display: 'swap'` is deliberate: text is readable in the fallback immediately and re-renders in
 * Inter when it lands. The alternative hides text for up to three seconds, and a screen somebody
 * uses for eight hours a day should never start blank.
 *
 * ## Why the files are in the repository
 *
 * This used to be `next/font/google`, which fetches the fonts from `fonts.gstatic.com` **during
 * the build**. That moved the third-party dependency off the customer's browser and onto the
 * build, where it was no better: a CI run failed with thirty-five "Module not found" errors
 * because that fetch did not come back, and `deploy/Dockerfile.web` runs the same build on the
 * VPS — so a bad minute at Google's CDN could equally have failed a production deployment of a
 * product that does not otherwise need the internet to build.
 *
 * Committing the two files removes the dependency outright. They are 84 KB together, because both
 * families are variable fonts: one file carries every weight, which is also why the ranges below
 * are ranges rather than a list of five and three separate files.
 *
 * The weights are the ones the design system actually sets — 400 through 800 for Inter, 400 to 600
 * for the mono. Declaring the range narrower than the file supports is what keeps a stray
 * `font-weight: 200` somewhere from rendering in a thickness nobody designed.
 *
 * ## What is in the files, and what is not
 *
 * The latin subset, which is what the Google build was serving in practice and covers everything
 * this product renders: ASCII, the general punctuation, the currency and arrow signs the UI uses.
 * The rupee sign is **not** in it — and was not in the Google build either, which has no U+20B9 in
 * any of its subsets, so it has always come from the system face and still does.
 *
 * Text outside that range — accented latin, Greek, Cyrillic — now renders in the fallback rather
 * than in Inter. Nothing the product itself writes is outside it; this would only show on a name
 * or a note somebody types with such a character in it. Covering those would mean committing six
 * more files per family and hand-writing the `unicode-range` rules that `next/font/local` has no
 * way to express, which is a worse trade than the one sentence this paragraph costs.
 */
/*
 * No `fallback` option on either of these.
 *
 * `tokens.css` already spells the chain out — `var(--uboss-font-inter, Inter), system-ui,
 * -apple-system, 'Segoe UI', sans-serif` — so naming one here appends a second copy of it to
 * every element's computed family. It renders the same and reads like a mistake.
 *
 * The metric-matched fallback is not that option: `next/font` emits it either way, as a face of
 * its own with `size-adjust` taken from the real one, and that is what keeps the swap from
 * reflowing the page.
 */
const inter = localFont({
  src: './fonts/inter-variable.woff2',
  weight: '400 800',
  style: 'normal',
  display: 'swap',
  variable: '--uboss-font-inter',
});

const jetBrainsMono = localFont({
  src: './fonts/jetbrains-mono-variable.woff2',
  weight: '400 600',
  style: 'normal',
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
