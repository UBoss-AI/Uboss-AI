#!/usr/bin/env node
/**
 * A release cannot go out without a failover/rollback decision tree — Prompt 44.
 *
 * ## Why this is a release gate rather than a unit test
 *
 * It is both, really: `packages/types/src/disaster-recovery.test.ts` already asserts the tree's
 * content. This runs the same assertions from the **release pipeline**, against the built package,
 * as a deliberate and separate gate.
 *
 * The reason is that UBoss ships **no down-migrations**, and that is a decision rather than an
 * omission — an automated reverse of a destructive change silently destroys the data that change
 * touched. The reverse of `DROP COLUMN` is a column full of nulls, not the column you had.
 *
 * What replaces them is judgement: a written tree that says which tool to reach for at 3am. So the
 * release gate is "is that judgement still present and coherent", and a release that lost it should
 * not reach production on the strength of the unit suite having passed in some other job.
 *
 * A script rather than an inline `node -e` in the workflow: a multi-line script inside a YAML scalar
 * folds its newlines, and the first person to add a line to it will not notice.
 */

import { DECISION_TREE, treeNeverRestoresBlind } from '@uboss/types';

const problems = [];

if (!Array.isArray(DECISION_TREE)) {
  problems.push('DECISION_TREE is not an array — the rollback guidance is gone.');
} else {
  if (DECISION_TREE.length < 5) {
    problems.push(
      `DECISION_TREE has only ${DECISION_TREE.length} branches. The situations an operator ` +
        'actually meets — a bad deploy, a bad migration, an unreachable primary, a lost primary, ' +
        'one company wrongly deleted, and "I am not sure" — need at least five.',
    );
  }

  for (const [index, branch] of DECISION_TREE.entries()) {
    for (const field of ['situation', 'action', 'why', 'cost']) {
      if (typeof branch?.[field] !== 'string' || branch[field].trim().length < 10) {
        problems.push(`Branch ${index + 1} does not say its "${field}".`);
      }
    }
  }
}

if (!treeNeverRestoresBlind()) {
  // The one property that makes the tree safe to follow under pressure: no branch ever says
  // "restore" without first saying where — scratch, a point in time, or a standby.
  problems.push(
    'A branch recommends restoring without a scratch check. Restoring over production to find ' +
      'out whether the data was intact discards every write since the backup.',
  );
}

if (problems.length > 0) {
  console.error('Rollback decision tree check FAILED:\n');
  for (const problem of problems) console.error('  - ' + problem);
  console.error('\nSee packages/types/src/disaster-recovery.ts and docs/DEPLOYMENT.md.');
  process.exit(1);
}

console.log(
  `rollback decision tree present: ${DECISION_TREE.length} branches, none restores blind`,
);
