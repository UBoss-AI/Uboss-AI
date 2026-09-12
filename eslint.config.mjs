import { ubossConfig } from './packages/config/eslint.base.mjs';

/**
 * The repository's single ESLint flat config.
 *
 * Every rule lives in `packages/config/eslint.base.mjs`, which is shared so they cannot drift
 * between workspaces. This file exists only to apply that base at the root, and `eslint .` from the
 * root is what lints all of `apps/**` and `packages/**` — there is no per-workspace ESLint config.
 *
 * Imported by **relative path** rather than as `@uboss/config/eslint`, deliberately: `npm run lint`
 * has to work on a cold clone, before `npm install` has created the workspace symlinks. See ADR-008.
 *
 * ---
 *
 * ## RECONSTRUCTED — Prompt 43
 *
 * **This file was accidentally deleted during Prompt 43 and no backup existed** (the repository is
 * not under version control, and it was not in the editor's local history or the recycle bin). What
 * follows is what could be re-derived, and how — recorded because a config that *looks* original
 * while differing from it is worse than one that admits it was rebuilt.
 *
 * Reconstructed from four independent sources, which agree:
 *
 *   1. **ADR-008** states the design in as many words: *"A single flat config
 *      (`eslint.config.mjs` → `packages/config/eslint.base.mjs`) lints every workspace... It is
 *      imported by relative path so `npm run lint` works on a cold clone."* That is this file.
 *   2. **`packages/config/eslint.base.mjs` survived untouched**, and it holds every rule. The root
 *      file never held rules of its own to lose.
 *   3. **Lint output observed earlier in the same session** matches the surviving base exactly —
 *      `no-console` reporting *"Only these console methods are allowed: warn, error"*, and
 *      `@typescript-eslint/no-unused-vars` reporting *"Allowed unused vars must match /^_/u"*.
 *   4. **No workspace has its own ESLint config**, so the root is the only entry point and must
 *      apply the base unscoped.
 *
 * **What could not be proven:** whether the original passed `extraIgnores` to `ubossConfig()`. The
 * base already ignores `node_modules`, `dist`, `dist-test`, `dist-scripts`, `src/generated`,
 * `.next`, `coverage`, `*.tsbuildinfo` and the client's `index.html`, which covers everything in the
 * tree that must not be linted — and linting the repository with no extra ignores reproduces the
 * violation set observed before the deletion, with nothing spurious. So `ubossConfig()` with no
 * arguments is the reading the evidence supports, and byte-for-byte identity with the original
 * cannot be claimed.
 */
export default ubossConfig();
