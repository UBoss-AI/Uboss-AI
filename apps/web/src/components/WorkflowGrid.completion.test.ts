import { describe, expect, it } from 'vitest';

import type { Form2WorkflowStep } from '@uboss/types';

import { completionFromColumn } from './WorkflowGrid';

/**
 * Completing a grid cell from what the column already says.
 *
 * A spreadsheet offers the rest of a value you have typed before in the same column, and Tab
 * takes it. The property that makes that safe rather than annoying is the one most of these
 * cases are about: **it suggests nothing when the column leaves a choice.** Tab also means "next
 * cell" in this grid, so a wrong completion is not a mild irritation — it is a value somebody
 * did not type, written by a key they pressed to move.
 */
const step = (position: number, fields: Partial<Form2WorkflowStep>): Form2WorkflowStep =>
  ({
    position,
    whoPersonName: null,
    whoDesignation: null,
    whoEngine: 'Engine',
    whenTrigger: null,
    whenFrequency: null,
    whatExactWork: '',
    inputWhatIsUsed: null,
    inputReceivedFrom: null,
    whereWorkIsDone: null,
    ...fields,
  }) as Form2WorkflowStep;

describe('completing a cell from its own column', () => {
  const rows = [
    step(1, { whenTrigger: 'Month end', whenFrequency: 'Monthly' }),
    step(2, { whenTrigger: 'Month end', whenFrequency: 'Monthly' }),
    step(3, { whenTrigger: 'Month end', whenFrequency: 'Monthly' }),
  ];

  it('offers the rest of a value the column already holds', () => {
    expect(completionFromColumn(rows, 'whenTrigger', 'Mon', 4)).toBe('Month end');
    expect(completionFromColumn(rows, 'whenFrequency', 'Mont', 4)).toBe('Monthly');
  });

  it('offers nothing when two different values could fit', () => {
    /*
     * The case the whole rule exists for. "Mon" fits both, so a guess is right half the time —
     * and the other half writes a value nobody typed into a cell they were tabbing past.
     */
    const mixed = [
      step(1, { whenTrigger: 'Month end' }),
      step(2, { whenTrigger: 'Monday morning' }),
    ];

    expect(completionFromColumn(mixed, 'whenTrigger', 'Mon', 3)).toBeNull();
    // And it comes back as soon as the typing picks a side.
    expect(completionFromColumn(mixed, 'whenTrigger', 'Month', 3)).toBe('Month end');
  });

  it('ignores the row being typed in', () => {
    // Otherwise a cell completes from itself: type "Mon", and the half-finished word it already
    // holds becomes its own suggestion.
    const alone = [step(1, { whenTrigger: 'Month end' })];
    expect(completionFromColumn(alone, 'whenTrigger', 'Mon', 1)).toBeNull();
  });

  it('stays in its own column', () => {
    // "Month end" is a trigger. A frequency cell must never offer it, however well it matches.
    expect(completionFromColumn(rows, 'whenFrequency', 'Month e', 4)).toBeNull();
  });

  it('does not offer a completion that changes nothing', () => {
    // Tab on an exact match would appear to do nothing, which reads as a broken key.
    expect(completionFromColumn(rows, 'whenFrequency', 'Monthly', 4)).toBeNull();
  });

  it('matches whatever casing somebody types, and answers in the column’s', () => {
    // A roster is typed by a person. The completion arrives in the casing the column already
    // uses, which is also what keeps the column consistent.
    expect(completionFromColumn(rows, 'whenFrequency', 'mont', 4)).toBe('Monthly');
    expect(completionFromColumn(rows, 'whenFrequency', 'MONT', 4)).toBe('Monthly');
  });

  it('says nothing for an empty cell, or one holding only spaces', () => {
    // Every value in the column starts with "", so a blank cell would otherwise "match"
    // everything — and with one distinct value it would silently fill itself.
    expect(completionFromColumn(rows, 'whenTrigger', '', 4)).toBeNull();
    expect(completionFromColumn(rows, 'whenTrigger', '   ', 4)).toBeNull();
  });

  it('skips rows where the column is empty', () => {
    const sparse = [
      step(1, { whenTrigger: null }),
      step(2, { whenTrigger: '' }),
      step(3, { whenTrigger: 'Month end' }),
    ];
    expect(completionFromColumn(sparse, 'whenTrigger', 'Mon', 4)).toBe('Month end');
  });
});
