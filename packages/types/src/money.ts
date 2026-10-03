/**
 * What currency a company is billed in, and how that is decided.
 *
 * ## The rule
 *
 * **A company's currency follows the country it is in, and is then fixed.** The country decides
 * the default at the moment the company is created; after that `Tenant.currency` is the truth and
 * nothing re-derives it.
 *
 * That second half matters more than the first. A currency that were recomputed on every read
 * would change under a company the day somebody corrected its country — and every minor-unit
 * amount already stored against it, every invoice, every wallet balance and every ledger entry,
 * would silently mean something different. Those columns are integers in *a* currency; which one
 * is not negotiable after the first transaction.
 *
 * ## Why nothing here converts
 *
 * There is no exchange rate in this file and there must not be one. A plan is either priced in a
 * currency or it is not: a price converted at a rate this product invented is a number no invoice
 * will match, and the customer finds out at the worst possible moment. Where a plan has no price
 * in a company's currency, the honest answer is that it has none, and the screen asks for a
 * conversation instead of inventing one.
 *
 * That is the same rule the marketing site already follows for the same reason.
 */

/** The currencies UBoss prices plans in. Adding one means adding a price, not a rate. */
export const BILLING_CURRENCIES = ['INR', 'USD', 'EUR', 'GBP', 'AED', 'SGD', 'AUD'] as const;
export type BillingCurrency = (typeof BILLING_CURRENCIES)[number];

export function isBillingCurrency(value: string): value is BillingCurrency {
  return (BILLING_CURRENCIES as readonly string[]).includes(value);
}

/**
 * The currency a company in each country is billed in.
 *
 * Deliberately a short list of the markets UBoss sells into, not every country in the world. A
 * country that is not here is a country nobody has agreed terms for, and guessing its currency
 * from its region would produce a price in a currency this platform has never set.
 *
 * The euro entries are each listed separately rather than inferred from "the EU", because
 * membership is not the question — what currency the customer's bank works in is.
 */
export const COUNTRY_BILLING_CURRENCY: Record<string, BillingCurrency> = {
  IN: 'INR',
  US: 'USD',
  CA: 'USD',
  GB: 'GBP',
  IE: 'EUR',
  DE: 'EUR',
  FR: 'EUR',
  NL: 'EUR',
  ES: 'EUR',
  IT: 'EUR',
  AE: 'AED',
  SA: 'AED',
  SG: 'SGD',
  MY: 'SGD',
  AU: 'AUD',
  NZ: 'AUD',
};

/**
 * The currency to default a new company to, from its country.
 *
 * `USD` where the country is unknown or not one of the listed markets. A default is needed because
 * a company has to be created with *some* currency, and the alternative — refusing to create one
 * until somebody picks — would block a signup on a question the buyer cannot answer. The platform
 * can change it before the first charge, and it is visible on the company's own settings.
 */
export const DEFAULT_BILLING_CURRENCY: BillingCurrency = 'USD';

export function currencyForCountry(countryRegion: string | null | undefined): BillingCurrency {
  if (!countryRegion) return DEFAULT_BILLING_CURRENCY;
  return COUNTRY_BILLING_CURRENCY[countryRegion.trim().toUpperCase()] ?? DEFAULT_BILLING_CURRENCY;
}

/**
 * The symbol a person expects in front of the number, per currency.
 *
 * Used for display only. Never for parsing, and never stored — the stored value is always the ISO
 * code and an integer of minor units.
 */
export const CURRENCY_SYMBOLS: Record<BillingCurrency, string> = {
  INR: '₹',
  USD: '$',
  EUR: '€',
  GBP: '£',
  AED: 'AED ',
  SGD: 'S$',
  AUD: 'A$',
};

/**
 * How many minor units make one major unit.
 *
 * Every currency listed here happens to use two decimal places, and the field exists anyway: a
 * product that assumes 100 breaks on the day it sells in a zero-decimal currency like the yen,
 * and it breaks by charging a hundred times too much.
 */
export const CURRENCY_MINOR_UNITS: Record<BillingCurrency, number> = {
  INR: 100,
  USD: 100,
  EUR: 100,
  GBP: 100,
  AED: 100,
  SGD: 100,
  AUD: 100,
};

/**
 * A minor-unit amount, written the way somebody in that currency's market reads it.
 *
 * Indian grouping for rupees, because `12,34,567` and `1,234,567` are the same number written for
 * two different readers, and the wrong one looks like a typo to both.
 */
export function formatMoney(minor: number, currency: string): string {
  const code = isBillingCurrency(currency) ? currency : DEFAULT_BILLING_CURRENCY;
  const major = minor / CURRENCY_MINOR_UNITS[code];
  const locale = code === 'INR' ? 'en-IN' : 'en-US';

  return (
    CURRENCY_SYMBOLS[code] +
    major.toLocaleString(locale, { minimumFractionDigits: 0, maximumFractionDigits: 2 })
  );
}

/** One plan's price in one currency. Null `priceMinor` is a negotiated plan, not a free one. */
export interface PlanPrice {
  currency: BillingCurrency;
  priceMinor: number;
}

/**
 * The price to charge a company, in its own currency, or null.
 *
 * Null means **this plan has no price in that currency** — which is a real state and not an
 * error: a plan sold in rupees and dollars simply is not sold in dirhams yet. The caller says so
 * and offers a conversation. What it must never do is take one of the other prices and convert
 * it, because the number that reaches the customer's card comes from the payment provider, which
 * will charge the figure the plan actually carries.
 */
export function priceInCurrency(prices: readonly PlanPrice[], currency: string): number | null {
  if (!isBillingCurrency(currency)) return null;
  return prices.find((price) => price.currency === currency)?.priceMinor ?? null;
}
