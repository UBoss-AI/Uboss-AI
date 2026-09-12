import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  flagIsOn,
  flagStates,
  RELEASE_FLAG_STANCE,
  RELEASE_FLAGS,
  registryProblems,
  type ReleaseFlag,
} from './release-flags.js';

/**
 * Release flags — Prompt 44.
 *
 * The registry ships empty, which is correct: nothing is currently gated. So the behaviour is
 * tested against example registries rather than the live one — "empty" must not mean "untested",
 * because the first real flag will be added by somebody in a hurry during a deploy.
 */

const EXAMPLE: ReleaseFlag = {
  key: 'UBOSS_FLAG_NEW_OBJECTIVE_CANVAS',
  gates: 'The rebuilt workflow canvas, while the old one is still serving.',
  removeWhen: 'Every environment is on the new canvas and the old renderer is deleted.',
};

const registry = [EXAMPLE];

describe('reading a flag', () => {
  it('is off when the variable is absent', () => {
    // The direction that matters: a missing variable must never switch something on.
    assert.equal(flagIsOn(EXAMPLE, {}, registry), false);
  });

  it('is on only for true, 1 and on', () => {
    for (const value of ['true', 'TRUE', 'True', '1', 'on', 'ON', ' true ']) {
      assert.equal(flagIsOn(EXAMPLE, { [EXAMPLE.key]: value }, registry), true, value);
    }
  });

  it('is off for everything else, including things that look affirmative', () => {
    /*
     * A permissive reader turns `FLAG=false` into "on", which is invisible in a dashboard and
     * obvious only during an incident. `yes` and `enabled` are refused for the same reason: a flag
     * somebody set with the wrong word should stay off, not guess.
     */
    for (const value of ['false', '0', 'off', '', 'yes', 'enabled', 'truthy', 'tru']) {
      assert.equal(flagIsOn(EXAMPLE, { [EXAMPLE.key]: value }, registry), false, value);
    }
  });

  it('refuses to read a flag that was never declared', () => {
    const undeclared: ReleaseFlag = {
      key: 'UBOSS_FLAG_SOMETHING_ELSE',
      gates: 'Something nobody wrote down.',
      removeWhen: 'Never, because nobody knows it exists.',
    };

    assert.throws(
      () => flagIsOn(undeclared, { UBOSS_FLAG_SOMETHING_ELSE: 'true' }, registry),
      /not in RELEASE_FLAGS/,
    );
  });
});

describe('listing the flags', () => {
  it('reports each flag with its state and why it exists', () => {
    const states = flagStates({ [EXAMPLE.key]: 'true' }, registry);

    assert.equal(states.length, 1);
    assert.equal(states[0]?.on, true);
    // A status list that showed only on/off would not tell an operator whether it is safe to
    // change one.
    assert.equal(states[0]?.gates, EXAMPLE.gates);
    assert.equal(states[0]?.removeWhen, EXAMPLE.removeWhen);
  });

  it('reports an empty registry as empty rather than failing', () => {
    assert.deepEqual(flagStates({}, []), []);
  });
});

describe('the registry holds itself to its own rules', () => {
  it('accepts a well-formed flag', () => {
    assert.deepEqual(registryProblems(registry), []);
  });

  it('refuses a flag with no removal condition', () => {
    // The rule that stops a temporary mechanism becoming permanent.
    const problems = registryProblems([{ ...EXAMPLE, removeWhen: '' }]);
    assert.equal(problems.length, 1);
    assert.match(problems[0] ?? '', /when it should be removed/);
  });

  it('refuses a flag that does not say what it gates', () => {
    const problems = registryProblems([{ ...EXAMPLE, gates: 'stuff' }]);
    assert.match(problems[0] ?? '', /what it gates/);
  });

  it('refuses a name that is not recognisable as a flag', () => {
    const problems = registryProblems([{ ...EXAMPLE, key: 'NEW_CANVAS' }]);
    assert.match(problems[0] ?? '', /UBOSS_FLAG_/);
  });

  it('refuses the same flag declared twice', () => {
    const problems = registryProblems([EXAMPLE, EXAMPLE]);
    assert.ok(problems.some((problem) => /declared twice/.test(problem)));
  });

  it('holds the live registry to the same rules', () => {
    // Empty today. This is what fails the moment somebody adds a flag without a removal condition.
    assert.deepEqual(registryProblems(RELEASE_FLAGS), []);
  });
});

describe('what the product says about flags', () => {
  it('says a flag is temporary and not a product setting', () => {
    assert.match(RELEASE_FLAG_STANCE, /deleted once/);
    assert.match(RELEASE_FLAG_STANCE, /not a product setting/);
  });
});
