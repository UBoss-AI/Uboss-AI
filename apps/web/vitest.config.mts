import { fileURLToPath } from 'node:url';

import react from '@vitejs/plugin-react';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  // The app tsconfig sets `jsx: preserve` because Next.js does its own JSX transform.
  // Unit tests therefore need an explicit React transform; Vite 8 uses Oxc rather than esbuild,
  // so the official plugin is used instead of hand-configuring the transform.
  plugins: [react()],
  resolve: {
    alias: {
      '@': fileURLToPath(new URL('./src', import.meta.url)),
    },
  },
  test: {
    environment: 'jsdom',
    globals: true,
    // The repository path contains spaces; Vitest's default `forks` pool fails to hand off to
    // its worker under that condition on Windows. Worker threads are unaffected.
    pool: 'threads',
    setupFiles: ['./vitest.setup.ts'],
    include: ['src/**/*.{test,spec}.{ts,tsx}'],
    css: false,
  },
});
