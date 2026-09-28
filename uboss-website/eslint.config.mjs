import js from '@eslint/js';
import reactHooks from 'eslint-plugin-react-hooks';
import ts from 'typescript-eslint';

/**
 * The website's lint rules.
 *
 * Deliberately the same shape as the product's own base config — `@eslint/js`, `typescript-eslint`
 * and `eslint-plugin-react-hooks`. `eslint-config-next` is not here: on ESLint 10 it fails inside
 * its bundled scope manager (`scopeManager.addGlobals is not a function`), and the product does not
 * use it either. What it would add over this is Next-specific hints, not correctness.
 */
export default ts.config(
  {
    // `tmp/` holds the verification scripts, which are Node rather than site code.
    ignores: ['.next/**', 'node_modules/**', 'next-env.d.ts', 'out/**', 'tmp/**'],
  },
  js.configs.recommended,
  ...ts.configs.recommended,
  {
    files: ['**/*.{ts,tsx}'],
    plugins: { 'react-hooks': reactHooks },
    languageOptions: {
      globals: {
        window: 'readonly',
        document: 'readonly',
        performance: 'readonly',
        requestAnimationFrame: 'readonly',
        cancelAnimationFrame: 'readonly',
        IntersectionObserver: 'readonly',
        HTMLLIElement: 'readonly',
        HTMLSpanElement: 'readonly',
      },
    },
    rules: {
      'react-hooks/rules-of-hooks': 'error',
      'react-hooks/exhaustive-deps': 'warn',
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_' }],
      '@typescript-eslint/consistent-type-imports': 'error',
      'no-console': ['error', { allow: ['warn', 'error'] }],
    },
  },
);
