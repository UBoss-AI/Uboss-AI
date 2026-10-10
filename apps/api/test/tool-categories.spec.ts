import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { parseToolCategories } from '../src/objectives/objective-analysis.service.js';

/**
 * Reading a model's answer about action categories.
 *
 * This is the one of the seven analysis stages whose reply is now believed, so the parser is the
 * thing standing between a sentence a model wrote and what a plan says an AI step is allowed to
 * do. Every case here is something a model actually does: numbering from zero, wrapping the list
 * in prose, inventing a category, answering some steps and not others.
 *
 * The safety argument is that `TOOL_ACTION_CATEGORIES` is seven fixed words, so the worst
 * possible answer is a bad choice among them — never a tool the company does not have.
 */
describe('reading tool categories from a model reply', () => {
  it('takes one line per step, in the order it was asked', () => {
    const chosen = parseToolCategories('1: Read\n2: Read, Write\n3: Read, FinancialChange', 3);

    assert.deepEqual(chosen[0], ['Read']);
    assert.deepEqual(chosen[1], ['Read', 'Write']);
    assert.deepEqual(chosen[2], ['Read', 'FinancialChange']);
  });

  it('ignores a word that is not one of the seven', () => {
    /*
     * The whole reason this answer is safe to read.
     *
     * "Salesforce" is a tool; `tools` on a node is a list of *categories*. A model that names a
     * product rather than a category must not put that product into a plan, so it is dropped and
     * the recognisable part of the same line is kept.
     */
    const chosen = parseToolCategories('1: Read, Salesforce, Write\n2: EmailBlast', 2);

    assert.deepEqual(chosen[0], ['Read', 'Write']);
    assert.equal(chosen[1], undefined, 'a line naming nothing we know is not an answer');
  });

  it('leaves a step alone when the reply says nothing about it', () => {
    // The caller keeps its own fallback for these. An empty list would read downstream as "this
    // step does nothing", which is a different claim from "nobody said".
    const chosen = parseToolCategories('2: Write', 3);

    assert.equal(chosen[0], undefined);
    assert.deepEqual(chosen[1], ['Write']);
    assert.equal(chosen[2], undefined);
  });

  it('ignores a number outside the steps it asked about', () => {
    // A model that answers for a step that does not exist must not write past the end, and a
    // zero means it numbered from zero — neither is an answer for step one.
    const chosen = parseToolCategories('0: Delete\n9: Delete\n1: Read', 2);

    assert.deepEqual(chosen[0], ['Read']);
    assert.equal(chosen[1], undefined);
  });

  it('reads the separators and the casing a model actually writes', () => {
    const chosen = parseToolCategories('1) read / WRITE\n2. sensitiveexport | delete', 2);

    assert.deepEqual(chosen[0], ['Read', 'Write']);
    assert.deepEqual(chosen[1], ['SensitiveExport', 'Delete']);
  });

  it('does not repeat a category named twice on one line', () => {
    const chosen = parseToolCategories('1: Read, Read, Write', 1);
    assert.deepEqual(chosen[0], ['Read', 'Write']);
  });

  it('survives prose, an empty answer and a refusal without throwing', () => {
    // A reasoning model sometimes returns its thinking, or nothing at all when it spends the
    // ceiling getting there. Neither is an error worth failing an analysis over.
    assert.deepEqual(parseToolCategories('', 2), [undefined, undefined]);
    assert.deepEqual(
      parseToolCategories('I cannot determine the categories from this description.', 2),
      [undefined, undefined],
    );

    const mixed = parseToolCategories(
      'Here is my assessment of each step:\n\n1: Read\nStep two is unclear.\n',
      2,
    );
    assert.deepEqual(mixed[0], ['Read']);
    assert.equal(mixed[1], undefined);
  });

  it('can mark a step as high risk, which the old guess could never do', () => {
    /*
     * The defect this stage was costing money to not fix.
     *
     * Every AI node was given `['Read']` or `['Read', 'Write']` from one line of guesswork, so
     * no step in any plan was ever `FinancialChange`, `ProductionChange` or `SensitiveExport` —
     * the three `isHighRiskToolCategory` exists to flag. A step that moves money looked like a
     * step that reads a file.
     */
    const chosen = parseToolCategories('1: Read, FinancialChange\n2: ProductionChange', 2);

    assert.ok(chosen[0]!.includes('FinancialChange'));
    assert.ok(chosen[1]!.includes('ProductionChange'));
  });
});
