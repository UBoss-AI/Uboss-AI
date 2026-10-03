import type { NextConfig } from 'next';

const config: NextConfig = {
  reactStrictMode: true,
  // No images from anywhere but this repository: the site ships no stock photography and no
  // customer logos, so there is nothing to allow-list.
  images: { remotePatterns: [] },
  // The framework is not a thing to advertise to a scanner.
  poweredByHeader: false,

  /**
   * The same headers the application sends, for the same reasons less urgently.
   *
   * Nothing here is behind a sign-in, so framing this site wins an attacker little — but a
   * marketing page is the one a stranger loads first, it links straight into registration, and
   * "it is only the marketing site" is how two deployments end up with two security postures.
   *
   * `nosniff` and a referrer policy cost nothing. `frame-ancestors` stops this site being used
   * as the outer frame of something pretending to be UBoss.
   */
  async headers() {
    return [
      {
        source: '/:path*',
        headers: [
          { key: 'X-Frame-Options', value: 'DENY' },
          { key: 'Content-Security-Policy', value: "frame-ancestors 'none'" },
          { key: 'X-Content-Type-Options', value: 'nosniff' },
          { key: 'Referrer-Policy', value: 'strict-origin-when-cross-origin' },
        ],
      },
    ];
  },
};

export default config;
