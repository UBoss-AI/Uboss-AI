import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { parseDefinitionsOfDone } from '../src/objectives/objective-analysis.service.js';

/**
 * Reading a model's Definition of Done lines.
 *
 * The defect behind this: nothing wrote a Definition of Done at all. `criteria` was the literal
 * empty string on every human and AI node and `failureCondition` was empty on every AI one, so
 * the readiness gate refused to publish any analysed plan until somebody filled in two boxes on
 * eighteen nodes by hand. The approval gate was the only node kind that filled both — which is
 * why a readiness report listed every node in a plan except the approval gates.
 *
 * So this parser decides whether a step gets the model's sentence or the fallback derived from
 * the grid. Returning `undefined` is the honest answer for a line it cannot read, and every case
 * below is something a model actually does.
 */
describe('reading a Definition of Done from a model reply', () => {
  it('takes one line per step, in the order it was asked', () => {
    const answer = [
      '1: done=The reconciliation file is attached to this step. | failed=No file is attached.',
      '2: done=Every mismatch has a written cause. | failed=A mismatch is left unexplained.',
    ].join('\n');

    assert.deepEqual(parseDefinitionsOfDone(answer, 2), [
      {
        criteria: 'The reconciliation file is attached to this step.',
        failureCondition: 'No file is attached.',
      },
      {
        criteria: 'Every mismatch has a written cause.',
        failureCondition: 'A mismatch is left unexplained.',
      },
    ]);
  });

  it('reads the labels however the model capitalised or punctuated them', () => {
    const answer = [
      '1. Done: The invoice is approved. ; Failure: It is rejected.',
      '2) DONE = The report exists. | FAILED = The report is missing.',
    ].join('\n');

    const written = parseDefinitionsOfDone(answer, 2);
    assert.equal(written[0]?.criteria, 'The invoice is approved.');
    assert.equal(written[0]?.failureCondition, 'It is rejected.');
    assert.equal(written[1]?.criteria, 'The report exists.');
    assert.equal(written[1]?.failureCondition, 'The report is missing.');
  });

  it('refuses a line with only one half', () => {
    /*
     * Half a Definition of Done is not one. The readiness gate asks for criteria *and* a failure
     * condition, so accepting this would leave the publish refused while looking like the model
     * had answered — which is the exact failure mode this whole change exists to remove.
     */
    assert.equal(parseDefinitionsOfDone('1: done=The report exists.', 1)[0], undefined);
    assert.equal(parseDefinitionsOfDone('1: failed=Nothing arrives.', 1)[0], undefined);
  });

  it('refuses a line whose halves are empty', () => {
    assert.equal(parseDefinitionsOfDone('1: done= | failed=', 1)[0], undefined);
  });

  it('ignores prose the model wrapped around its answer', () => {
    const answer = [
      'Here is what I think for each step:',
      '',
      '1: done=The stock count matches the system. | failed=The counts differ.',
      '',
      'Let me know if you would like these expanded.',
    ].join('\n');

    assert.equal(parseDefinitionsOfDone(answer, 1).filter(Boolean).length, 1);
  });

  it('drops a step number outside the plan rather than writing past the end', () => {
    const answer = [
      '0: done=A step that does not exist. | failed=Nor this.',
      '5: done=Nor this one. | failed=Nor this.',
      '1: done=This one is real. | failed=It is not done.',
    ].join('\n');

    const written = parseDefinitionsOfDone(answer, 2);
    assert.equal(written.length, 2);
    assert.equal(written[0]?.criteria, 'This one is real.');
    assert.equal(written[1], undefined);
  });

  it('answers undefined for every step when the model said nothing usable', () => {
    /*
     * The case that matters most. An empty or unusable reply must not look like an answer: the
     * caller falls back to a sentence derived from the step's own declared output, and it can
     * only do that if this says plainly that nothing was read.
     */
    assert.deepEqual(parseDefinitionsOfDone('', 3), [undefined, undefined, undefined]);
    assert.deepEqual(parseDefinitionsOfDone('I cannot help with that.', 2), [undefined, undefined]);
  });
});
