import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  DEFAULT_DESIGNATION_RANK,
  byDesignationThenName,
  designationRank,
} from './designation-rank.js';

/**
 * Ordering an org chart by seniority rather than by name.
 *
 * The titles below are the real ones in the development database, typed by a real company, in
 * the shape they were typed: shouting, abbreviated, and inconsistent about whether an assistant
 * manager is "ASSISTANT" or "ASST". A ranking that only works on tidy input would not survive
 * contact with this table, so this is the input it is tested against.
 */
describe('designationRank', () => {
  it('puts the board above the managers and the managers above the floor', () => {
    const order = [
      'VICE PRESIDENT',
      'ASST GENERAL MANAGER',
      'SENIOR MANAGER',
      'MANAGER',
      'ASSISTANT MANAGER',
      'SUPERVISOR',
      'SENIOR ENGINEER',
      'ENGINEER',
      'JUNIOR ENGINEER',
    ];

    const ranks = order.map(designationRank);
    for (let i = 1; i < ranks.length; i += 1) {
      assert.ok(
        ranks[i - 1]! >= ranks[i]!,
        `${order[i - 1]} (${ranks[i - 1]}) should not rank below ${order[i]} (${ranks[i]})`,
      );
    }
  });

  it('reads the modifier, not just the job', () => {
    assert.ok(designationRank('SENIOR MANAGER') > designationRank('MANAGER'));
    assert.ok(designationRank('MANAGER') > designationRank('ASSISTANT MANAGER'));
    assert.ok(designationRank('SENIOR EXECUTIVE') > designationRank('EXECUTIVE'));
    assert.ok(designationRank('ENGINEER') > designationRank('JUNIOR ENGINEER'));
  });

  it('treats the abbreviations this company actually types as the words they stand for', () => {
    assert.equal(designationRank('ASST MANAGER'), designationRank('ASSISTANT MANAGER'));
    assert.equal(designationRank('SR. ENGINEER'), designationRank('SENIOR ENGINEER'));
    assert.equal(designationRank('JR ENGINEER'), designationRank('JUNIOR ENGINEER'));
  });

  it('does not read a longer title as the shorter one inside it', () => {
    /*
     * "GENERAL MANAGER" contains "MANAGER" and "VICE PRESIDENT" contains "PRESIDENT". Matching
     * the first word found would rank a GM as a manager and a VP as a president.
     */
    assert.ok(designationRank('GENERAL MANAGER') > designationRank('MANAGER'));
    assert.ok(designationRank('VICE PRESIDENT') < designationRank('PRESIDENT'));
  });

  it('keeps an assistant with no noun as a job rather than a modifier of itself', () => {
    assert.equal(designationRank('ASSISTANT'), 30);
  });

  it('gives a title it does not know the ordinary-staff rank, in the middle', () => {
    /*
     * The failure this avoids: a company whose vocabulary this understands none of having its
     * whole chart pushed below its trainees. An unknown title is not evidence either way.
     */
    assert.equal(designationRank('Regulatory Associate II'), DEFAULT_DESIGNATION_RANK);
    assert.equal(designationRank('Gemba Steward'), DEFAULT_DESIGNATION_RANK);
    assert.ok(designationRank('Gemba Steward') > designationRank('TRAINEE'));
  });

  it('survives a missing or empty designation', () => {
    assert.equal(designationRank(null), DEFAULT_DESIGNATION_RANK);
    assert.equal(designationRank(undefined), DEFAULT_DESIGNATION_RANK);
    assert.equal(designationRank('   '), DEFAULT_DESIGNATION_RANK);
  });
});

describe('byDesignationThenName', () => {
  it('orders a real department the way the company thinks of it', () => {
    const people = [
      { name: 'Anita Rao', designation: 'JUNIOR ENGINEER' },
      { name: 'Bhavesh Patel', designation: 'VICE PRESIDENT' },
      { name: 'Chetan Shah', designation: 'ASSISTANT MANAGER' },
      { name: 'Divya Menon', designation: 'SENIOR MANAGER' },
    ];

    assert.deepEqual(
      [...people].sort(byDesignationThenName).map((person) => person.name),
      ['Bhavesh Patel', 'Divya Menon', 'Chetan Shah', 'Anita Rao'],
    );
  });

  it('falls back to alphabetical when the titles rank the same', () => {
    /*
     * This is what keeps the change safe. A company this understands nothing of gets exactly the
     * A-to-Z order it already had, rather than an arbitrary one.
     */
    const people = [
      { name: 'Zoya Khan', designation: 'Gemba Steward' },
      { name: 'Arjun Das', designation: 'Kaizen Steward' },
    ];

    assert.deepEqual(
      [...people].sort(byDesignationThenName).map((person) => person.name),
      ['Arjun Das', 'Zoya Khan'],
    );
  });

  it('sorts people with no designation at all without throwing', () => {
    const people = [{ name: 'Bina Roy' }, { name: 'Amit Sen' }];
    assert.deepEqual(
      [...people].sort(byDesignationThenName).map((person) => person.name),
      ['Amit Sen', 'Bina Roy'],
    );
  });
});
