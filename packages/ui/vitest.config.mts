import react from '@vitejs/plugin-react';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  plugins: [react()],
  test: {
    environment: 'jsdom',
    globals: true,
    // The repository path contains spaces, which breaks Vitest's default `forks` pool on
    // Windows. See docs/ARCHITECTURE_DECISIONS.md (ADR-007).
    pool: 'threads',
    setupFiles: ['./vitest.setup.ts'],
    include: ['src/**/*.{test,spec}.{ts,tsx}'],
    css: false,
  },
});
