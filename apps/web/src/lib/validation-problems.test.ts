import { describe, expect, it } from 'vitest';

import { isValidationMessage, parseValidationProblems } from './validation-problems';

/*
 * The real messages this exists for, copied from what the server actually sent while trying to
 * save an objective. The first two are exactly what a person was being shown, in a banner, with no
 * field marked wrong.
 */
const REAL_SAVE_FAILURE =
  'content.objectiveName must be longer than or equal to 1 characters content.departmentId must be a UUID content.objectiveOwnerUserId must be a UUID content.expectedFinalResult must be longer than or equal to 1 characters';

describe('parseValidationProblems', () => {
  it('splits a flattened validation array back into separate problems', () => {
    const problems = parseValidationProblems(REAL_SAVE_FAILURE);
    expect(problems).toHaveLength(4);
  });

  it('says what the message meant instead of quoting it', () => {
    const problems = parseValidationProblems(REAL_SAVE_FAILURE);

    expect(problems[0]?.text).toBe('Objective name is required.');
    // A UUID field is a choice from a list in this product, never something anyone types.
    expect(problems[1]?.text).toBe('Department must be chosen from the list.');
    expect(problems[3]?.text).toBe('Expected final result is required.');
  });

  it('names the field so the form can mark it', () => {
    const problems = parseValidationProblems(REAL_SAVE_FAILURE);
    expect(problems.map((p) => p.field)).toEqual([
      'objectiveName',
      'departmentId',
      'objectiveOwnerUserId',
      'expectedFinalResult',
    ]);
  });

  it('keeps the original for a bug report', () => {
    const problems = parseValidationProblems(REAL_SAVE_FAILURE);
    expect(problems[0]?.raw).toContain('must be longer than or equal to 1 characters');
  });

  it('numbers a step the way the grid numbers it', () => {
    const problems = parseValidationProblems(
      'steps.0.whatExactWork must be longer than or equal to 1 characters',
    );

    // The DTO counts from zero; the grid shows Step 1. Reporting "steps.0" would send somebody
    // looking for a row that is not labelled.
    expect(problems[0]?.text).toBe('Step 1: exact work is required.');
    expect(problems[0]?.field).toBe('steps.0.whatExactWork');
  });

  /*
   * The important restraint. A domain refusal is written for people and must arrive intact — a
   * pattern that rewrote it would replace the rule with this screen's guess at the rule.
   */
  it('passes a written refusal through untouched', () => {
    const written =
      'You cannot approve something you created. UBoss requires a different person to approve it.';
    const problems = parseValidationProblems(written);

    expect(problems).toEqual([{ field: null, text: written, raw: written }]);
  });

  it('leaves an unrecognised generated phrase readable rather than dropping it', () => {
    const problems = parseValidationProblems('content.objectiveName must satisfy some new rule');

    // Better a labelled sentence than silence: the field is still named, and the wording survives.
    expect(problems[0]?.text).toBe('Objective name: must satisfy some new rule');
    expect(problems[0]?.field).toBe('objectiveName');
  });

  it('handles an empty message without inventing a problem', () => {
    expect(parseValidationProblems('   ')).toEqual([]);
  });

  it('recognises which kind of message it has', () => {
    expect(isValidationMessage(REAL_SAVE_FAILURE)).toBe(true);
    expect(isValidationMessage('That is outside what your role covers.')).toBe(false);
  });

  it('never leaks a property path into what is shown', () => {
    const problems = parseValidationProblems(REAL_SAVE_FAILURE);
    for (const problem of problems) {
      expect(problem.text).not.toMatch(/content\.|steps\.\d/);
    }
  });
});
