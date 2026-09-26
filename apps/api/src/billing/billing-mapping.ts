import type { BillingState, SubscriptionState } from '../generated/prisma/enums.js';

/**
 * The provider's subscription status, translated into this product's two words.
 *
 * ## Why there are two words and not one
 *
 * This product already separates **what the commercial arrangement is** (`SubscriptionState`:
 * Pending, Active, Suspended, Expired, Cancelled) from **whether it is paid up**
 * (`BillingState`: Current, Grace, Overdue). The provider has one status covering both, so
 * translating it means answering both questions from one word — and getting either wrong has
 * consequences: a company wrongly Suspended cannot work, and a company wrongly Current is using
 * the product for free.
 *
 * ## Why the provider's word is kept as well
 *
 * `trialing`, `incomplete`, `incomplete_expired` and `unpaid` have no equivalent here. Mapping
 * them away would lose the only record of what actually happened, so the raw status is stored
 * beside the translation and the platform console shows both. When the two disagree, that is a
 * fact worth seeing rather than a contradiction to hide.
 *
 * ## The decisions in this table, stated
 *
 * * **`trialing` is Active and Current.** A trial is access the company was given deliberately;
 *   refusing it would be refusing what was offered.
 * * **`past_due` keeps the company working, in Grace.** The provider is still retrying, and
 *   locking somebody out of their own workspace on the first failed card is a support ticket, not
 *   a collection strategy.
 * * **`unpaid` suspends.** The provider only reaches this after the retries are exhausted, and
 *   its own guidance is to revoke access here.
 * * **`incomplete` is Pending, not Active.** The first payment has not succeeded, so there is
 *   nothing to grant yet. It is the state a Checkout that was abandoned at the card step leaves
 *   behind.
 * * **`canceled` is Cancelled and, deliberately, Current.** Nothing is owed by somebody who has
 *   left; marking them Overdue would put them in a collections queue for money that is not due.
 */
export interface MappedSubscriptionStatus {
  state: SubscriptionState;
  billingState: BillingState;
  /** Whether the company should have access to the product in this state. */
  entitled: boolean;
}

const TABLE: Record<string, MappedSubscriptionStatus> = {
  trialing: { state: 'Active', billingState: 'Current', entitled: true },
  active: { state: 'Active', billingState: 'Current', entitled: true },
  past_due: { state: 'Active', billingState: 'Grace', entitled: true },
  unpaid: { state: 'Suspended', billingState: 'Overdue', entitled: false },
  incomplete: { state: 'Pending', billingState: 'Current', entitled: false },
  incomplete_expired: { state: 'Expired', billingState: 'Overdue', entitled: false },
  canceled: { state: 'Cancelled', billingState: 'Current', entitled: false },
  paused: { state: 'Suspended', billingState: 'Current', entitled: false },
};

/**
 * The translation, or null for a status this product has never seen.
 *
 * Null rather than a default, and the caller must record the event as unhandled rather than
 * guessing. A provider adding a status is a real possibility, and the two available guesses are
 * "grant access" and "revoke access" — one gives the product away and the other locks a paying
 * customer out. Neither is a safe default, so nothing is changed and somebody is told.
 */
export function mapStripeSubscriptionStatus(status: string): MappedSubscriptionStatus | null {
  return TABLE[status] ?? null;
}

/** Every status this product knows how to translate, for the tests and the console. */
export const MAPPED_STRIPE_STATUSES = Object.keys(TABLE);
