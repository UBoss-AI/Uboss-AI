import { describe, expect, it } from 'vitest';

import { isNegotiatedPlan, largerPlansThan, rankPlan } from './plan-choices';

/**
 * Which plans a company is offered.
 *
 * Reported from the product: a company on Growth was told "Growth is the largest we sell", while
 * the catalogue held an Enterprise plan with no seat ceiling that another company was already on.
 * Nothing looked broken — a plan that sorts to the bottom and is then filtered out leaves no
 * trace on the page — which is why the rule is tested here rather than read off the screen.
 *
 * The catalogue these use is the real one: Pilot, Starter, Growth, Enterprise, with the prices in
 * minor units and Enterprise carrying neither a price nor a ceiling.
 */
const PILOT = { code: 'pilot', priceMinor: 0, seatLimit: 1 };
const STARTER = { code: 'starter', priceMinor: 1499900, seatLimit: 10 };
const GROWTH = { code: 'growth', priceMinor: 4999900, seatLimit: 40 };
const ENTERPRISE = { code: 'enterprise', priceMinor: null, seatLimit: null };

const codesOf = (plans: readonly { code: string }[]) => plans.map((plan) => plan.code);

describe('isNegotiatedPlan', () => {
  it('is the plan with neither a price nor a ceiling', () => {
    expect(isNegotiatedPlan(ENTERPRISE)).toBe(true);
  });

  it('is not a priced plan', () => {
    expect(isNegotiatedPlan(GROWTH)).toBe(false);
  });

  it('is not a plan that caps seats but has no price in this currency', () => {
    /*
     * This is the case the two halves exist to separate. A plan that is simply not published in
     * the company's currency yet still has a ceiling, and treating it as negotiated would promote
     * an unfinished row above everything the company can actually buy.
     */
    expect(isNegotiatedPlan({ priceMinor: null, seatLimit: 10 })).toBe(false);
  });
});

describe('rankPlan', () => {
  it('orders the sold plans by price', () => {
    expect(rankPlan(PILOT)).toBeLessThan(rankPlan(STARTER));
    expect(rankPlan(STARTER)).toBeLessThan(rankPlan(GROWTH));
  });

  it('puts the negotiated plan above the largest sold one', () => {
    expect(rankPlan(ENTERPRISE)).toBeGreaterThan(rankPlan(GROWTH));
  });

  it('breaks a tie on seats', () => {
    const narrow = { priceMinor: 4999900, seatLimit: 20 };
    expect(rankPlan(narrow)).toBeLessThan(rankPlan(GROWTH));
  });
});

describe('largerPlansThan', () => {
  it('offers the negotiated plan to a company on the largest sold plan', () => {
    // The reported defect: this list used to come back empty.
    const offered = largerPlansThan([PILOT, STARTER, { ...GROWTH, current: true }, ENTERPRISE]);
    expect(codesOf(offered)).toEqual(['enterprise']);
  });

  it('never offers a smaller plan than the one being paid for', () => {
    const offered = largerPlansThan([PILOT, STARTER, { ...GROWTH, current: true }]);
    expect(offered).toEqual([]);
  });

  it('offers everything above a small plan, smallest first', () => {
    const offered = largerPlansThan([PILOT, { ...STARTER, current: true }, GROWTH, ENTERPRISE]);
    expect(codesOf(offered)).toEqual(['growth', 'enterprise']);
  });

  it('leaves out a plan that is not sold in this currency', () => {
    /*
     * Shown as free is the failure this prevents: the price is null because there is no price
     * row for the company's currency, not because the plan costs nothing.
     */
    const unsold = { code: 'regional', priceMinor: null, seatLimit: 80 };
    const offered = largerPlansThan([{ ...STARTER, current: true }, unsold, GROWTH]);
    expect(codesOf(offered)).toEqual(['growth']);
  });

  it('offers nothing further to a company already on the negotiated plan', () => {
    const offered = largerPlansThan([STARTER, GROWTH, { ...ENTERPRISE, current: true }]);
    expect(offered).toEqual([]);
  });

  it('offers every sold plan when the company is on none of them', () => {
    const offered = largerPlansThan([GROWTH, STARTER, ENTERPRISE]);
    expect(codesOf(offered)).toEqual(['starter', 'growth', 'enterprise']);
  });
});
