import type { NextConfig } from 'next';

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
};

export default nextConfig;
