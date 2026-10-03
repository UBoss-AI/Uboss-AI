import assert from 'node:assert/strict';
import test from 'node:test';

import {
  BILLING_CURRENCIES,
  COUNTRY_BILLING_CURRENCY,
  CURRENCY_MINOR_UNITS,
  CURRENCY_SYMBOLS,
  DEFAULT_BILLING_CURRENCY,
  currencyForCountry,
  formatMoney,
  isBillingCurrency,
  priceInCurrency,
} from './money.js';

test('a company is billed in the currency of its own country', () => {
  assert.equal(currencyForCountry('IN'), 'INR');
  assert.equal(currencyForCountry('US'), 'USD');
  assert.equal(currencyForCountry('GB'), 'GBP');
  assert.equal(currencyForCountry('DE'), 'EUR');
  assert.equal(currencyForCountry('AE'), 'AED');
  // Case and whitespace are the caller's accident, not a different country.
  assert.equal(currencyForCountry('in'), 'INR');
  assert.equal(currencyForCountry(' IN '), 'INR');
});

test('a country nobody has agreed terms for falls back rather than guessing', () => {
  /*
   * The alternative would be inferring a currency from the region, which produces a price in a
   * currency this platform has never set — and the company is created with it written into its
   * wallet and its ledger, where it cannot be changed afterwards.
   */
  assert.equal(currencyForCountry('BR'), DEFAULT_BILLING_CURRENCY);
  assert.equal(currencyForCountry(null), DEFAULT_BILLING_CURRENCY);
  assert.equal(currencyForCountry(undefined), DEFAULT_BILLING_CURRENCY);
  assert.equal(currencyForCountry(''), DEFAULT_BILLING_CURRENCY);
});

test('every country maps to a currency the platform actually prices in', () => {
  // Otherwise a signup from that country creates a company no plan has a price for.
  for (const [country, currency] of Object.entries(COUNTRY_BILLING_CURRENCY)) {
    assert.ok(isBillingCurrency(currency), `${country} -> ${currency}`);
  }
  assert.ok(isBillingCurrency(DEFAULT_BILLING_CURRENCY));
});

test('every currency has a symbol and a minor unit', () => {
  // A currency missing its minor unit would be charged a hundred times over or a hundredth.
  for (const currency of BILLING_CURRENCIES) {
    assert.ok(CURRENCY_SYMBOLS[currency].length > 0, currency);
    assert.ok(CURRENCY_MINOR_UNITS[currency] > 0, currency);
  }
});

test('a plan with no price in a currency has none, and nothing is converted', () => {
  const prices = [
    { currency: 'INR' as const, priceMinor: 1_499_900 },
    { currency: 'USD' as const, priceMinor: 49_900 },
  ];

  assert.equal(priceInCurrency(prices, 'INR'), 1_499_900);
  assert.equal(priceInCurrency(prices, 'USD'), 49_900);

  /*
   * Null, and this is the assertion the whole module exists for.
   *
   * A plan sold in rupees and dollars is not sold in dirhams yet. Returning one of the others —
   * or either of them converted — would put a figure in front of a customer that the invoice will
   * not match, and they would discover it after paying.
   */
  assert.equal(priceInCurrency(prices, 'AED'), null);
  assert.equal(priceInCurrency(prices, 'ZZZ'), null);
  assert.equal(priceInCurrency([], 'INR'), null);
});

test('rupees are grouped the way somebody in that market reads them', () => {
  // 12,34,567 and 1,234,567 are the same number written for two different readers, and the wrong
  // one looks like a typo to both.
  assert.equal(formatMoney(1_499_900, 'INR'), '₹14,999');
  assert.equal(formatMoney(4_999_900, 'INR'), '₹49,999');
  assert.equal(formatMoney(12_345_600, 'INR'), '₹1,23,456');
  assert.equal(formatMoney(49_900, 'USD'), '$499');
  assert.equal(formatMoney(49_950, 'USD'), '$499.5');
});

test('an unknown currency formats rather than throwing', () => {
  // A stored value that no longer validates must not blank a screen or crash it.
  assert.equal(formatMoney(10_000, 'ZZZ'), '$100');
});
