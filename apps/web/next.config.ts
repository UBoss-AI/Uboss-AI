import type { NextConfig } from 'next';

/**
 * Hostnames the dev server will serve its own assets to, beyond localhost.
 *
 * ## Why this exists
 *
 * Next refuses cross-origin requests for `/_next/*` in development. That is a real protection —
 * without it, any page on the internet could read this dev server's modules and source maps off a
 * developer's machine — but it also blocks the normal case of reaching the dev server through a
 * tunnel, which is how a work-in-progress gets shown to somebody else. The symptom is not an
 * error page: hot reload stops arriving and the chunk requests look wrong, which reads as a broken
 * build rather than a refused origin.
 *
 * ## Why it is an environment variable and not a list in this file
 *
 * A tunnel hostname changes every time the tunnel restarts, and it belongs to whoever is running
 * it. Committing one would be committing somebody's temporary URL, and the next person would edit
 * this file to demo their own work.
 *
 * Set `WEB_DEV_ORIGINS` to a comma-separated list of hostnames — **not** URLs:
 *
 *     WEB_DEV_ORIGINS=crunching-dramatize-underline.ngrok-free.dev
 *
 * ## It only applies in development
 *
 * A production build serves its assets from its own origin and this key has no effect there, so a
 * stale value cannot widen anything in a deployment.
 */
const devOrigins = (process.env['WEB_DEV_ORIGINS'] ?? '')
  .split(',')
  .map((origin) => origin.trim())
  // A hostname, so a pasted URL still works rather than silently matching nothing.
  .map((origin) => origin.replace(/^https?:\/\//, '').replace(/\/.*$/, ''))
  .filter((origin) => origin !== '');

/**
 * Where `/api/*` is forwarded, so the browser can reach the API on this same origin.
 *
 * ## The problem this solves, and why the obvious fixes are wrong
 *
 * Reached through a tunnel, the page is served from `https://something.ngrok-free.dev` while the
 * API sits on `http://localhost:4000`. To a browser those are **different sites**, and two things
 * then fail at once:
 *
 *   * the API refuses the request, because its allow-list names the local origin;
 *   * the session cookie is `SameSite=Lax`, so it is not sent on a cross-site request even if the
 *     first problem is solved.
 *
 * The two obvious fixes are to widen the API's allow-list and to relax the cookie to
 * `SameSite=None`. Both weaken a real control — the second one in particular is what stops another
 * site making authenticated requests as the signed-in person — and neither is something to do for
 * the convenience of a demo.
 *
 * Forwarding instead means the browser only ever talks to one origin. Same-origin requests carry
 * the cookie by the ordinary rule and need no allow-list entry at all, so nothing is relaxed. The
 * cookie the API sets comes back through this proxy and is stored against the tunnel's own origin,
 * which is exactly what it should be.
 *
 * ## Using it
 *
 * Set `NEXT_PUBLIC_API_BASE_URL=/api` and leave `API_PROXY_TARGET` at its default. For ordinary
 * work on this machine, leave `NEXT_PUBLIC_API_BASE_URL` pointing straight at the API — the
 * forward exists either way and simply goes unused.
 */
const apiTarget = (process.env['API_PROXY_TARGET'] ?? 'http://localhost:4000').replace(/\/$/, '');

const nextConfig: NextConfig = {
  reactStrictMode: true,
  /* @uboss/ui ships as TypeScript source so its "use client" boundaries survive intact
     (see docs/ARCHITECTURE_DECISIONS.md ADR-011); Next compiles it as part of this app. */
  transpilePackages: ['@uboss/ui'],
  // Fail the build on type errors rather than shipping them.
  typescript: { ignoreBuildErrors: false },
  // Next.js 16 removed the built-in ESLint integration (and the `eslint` config key), so
  // linting is owned solely by the root `npm run lint` flat config in packages/config.
  // Do not advertise the framework to clients.
  poweredByHeader: false,
  ...(devOrigins.length === 0 ? {} : { allowedDevOrigins: devOrigins }),

  async rewrites() {
    return [{ source: '/api/:path*', destination: `${apiTarget}/:path*` }];
  },
};

export default nextConfig;
