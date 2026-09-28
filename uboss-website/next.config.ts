import type { NextConfig } from 'next';

const config: NextConfig = {
  reactStrictMode: true,
  // No images from anywhere but this repository: the site ships no stock photography and no
  // customer logos, so there is nothing to allow-list.
  images: { remotePatterns: [] },
};

export default config;
