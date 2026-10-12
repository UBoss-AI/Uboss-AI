/**
 * Which plans to offer a company, and in what order.
 *
 * This lives outside the Billing page because getting it wrong is invisible. A plan that ranks
 * below where it belongs does not look broken — it looks like a plan that does not exist, and the
 * company is told the catalogue ends where in fact it does not. That already happened once: the
 * negotiated plan sorted to the bottom, a price filter then removed it, and a company on the
 * largest *sold* plan read "nothing bigger is sold here" while another company was on the bigger
 * one. Nothing on the screen said anything was missing.
 *
 * Only the shape these decisions need is taken, so the rules can be read without a catalogue.
 */
export interface RankablePlan {
  /** The plan's price in this company's currency, or null when it is not sold to them. */
  priceMinor: number | null;
  /** The seat ceiling the plan includes, or null when seats are agreed per company. */
  seatLimit: number | null;
  /** Whether this is the plan the company is on now. */
  current?: boolean;
}

/**
 * The plan that is agreed rather than sold: no price, and no seat ceiling.
 *
 * Both halves matter. A plan with a ceiling but no price in this currency is a different thing —
 * either it has not been published here yet or it is smaller than what the company holds — and
 * neither is an offer worth putting on the page.
 */
export function isNegotiatedPlan(plan: RankablePlan): boolean {
  return plan.priceMinor === null && plan.seatLimit === null;
}

/**
 * How large a plan is, from the point of view of the person paying.
 *
 * Price first, because that is what "bigger plan" means to them, with the seat ceiling breaking a
 * tie between two plans at one price. The negotiated plan ranks above everything priced: an
 * agreed ceiling is by definition not below the highest ceiling sold. An unsold priced plan ranks
 * below everything, which keeps it out of every comparison rather than placing it.
 */
export function rankPlan(plan: RankablePlan): number {
  if (isNegotiatedPlan(plan)) return Number.MAX_SAFE_INTEGER;
  if (plan.priceMinor === null) return -1;
  return plan.priceMinor * 1000 + (plan.seatLimit ?? 0);
}

/**
 * The plans worth offering: those above the one the company is on, smallest first.
 *
 * Never a smaller plan. The first version listed every other plan, so a company paying for the
 * top plan was shown the one below it with a button to take it — a downsell on the billing page
 * of a customer who had already paid for more. Moving down is still supported; it is a request
 * further down the page, because it is a conversation rather than a purchase.
 *
 * `current` is read from the plans themselves so the caller cannot pass a current plan that is
 * not in the list and get an answer measured against nothing.
 */
export function largerPlansThan<T extends RankablePlan>(plans: readonly T[]): T[] {
  const current = plans.find((plan) => plan.current === true) ?? null;
  const floor = current === null ? -Infinity : rankPlan(current);

  return plans
    .filter(
      (plan) =>
        plan.current !== true &&
        (plan.priceMinor !== null || isNegotiatedPlan(plan)) &&
        rankPlan(plan) > floor,
    )
    .sort((a, b) => rankPlan(a) - rankPlan(b));
}
