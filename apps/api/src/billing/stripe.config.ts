/**
 * What this deployment knows about the payment provider.
 *
 * ## Absent by default, and said so
 *
 * No key is invented and no default is assumed. A deployment with no credentials is **not
 * connected**, every route that would take money refuses with that reason, and the platform
 * console shows it rather than a screen of zeros that looks operational. This follows the same
 * rule the provider and social-sign-in configuration already follow in this codebase: a
 * half-configured integration is treated as absent, because a button that cannot complete looks
 * like a broken product rather than an unconfigured one.
 *
 * ## Half-configured is absent, and which half is named
 *
 * Three values are needed and they fail in different ways, so "not configured" is not enough to
 * act on:
 *
 *   * without the **secret key** nothing can be created at the provider at all;
 *   * without the **webhook secret** deliveries cannot be verified, so payments would be applied
 *     on the word of whoever posted to the endpoint — that is not a degraded mode, it is an open
 *     door, and the endpoint refuses everything until it is set;
 *   * without the **publishable key** the browser cannot mount the provider's own elements. It is
 *     public by design and is the only one of the three this module ever returns.
 *
 * ## Test and live are told apart from the key itself
 *
 * The provider's keys carry their mode in the prefix, so the mode is read rather than configured.
 * A deployment cannot be pointed at live keys while believing it is in test, and a live webhook
 * delivery arriving at a test-keyed deployment is recorded as the misconfiguration it is.
 */

/** The three variables, named once so an error message and the documentation cannot drift. */
export const STRIPE_SECRET_KEY_VAR = 'STRIPE_SECRET_KEY';
export const STRIPE_PUBLISHABLE_KEY_VAR = 'STRIPE_PUBLISHABLE_KEY';
export const STRIPE_WEBHOOK_SECRET_VAR = 'STRIPE_WEBHOOK_SECRET';

export type StripeMode = 'test' | 'live';

export interface StripeConfiguration {
  /** Whether money can actually move: a secret key **and** a webhook secret are both present. */
  readonly connected: boolean;
  /** Which of the three are missing, by variable name, for a message somebody can act on. */
  readonly missing: readonly string[];
  /** Read from the secret key's own prefix. Null when there is no secret key to read. */
  readonly mode: StripeMode | null;
  /** Public by design — the browser needs it. The other two never leave this module. */
  readonly publishableKey: string | null;
}

/** The secret key, or null. Deliberately not part of {@link StripeConfiguration}. */
export function stripeSecretKey(env: NodeJS.ProcessEnv = process.env): string | null {
  const value = env[STRIPE_SECRET_KEY_VAR]?.trim() ?? '';
  return value === '' ? null : value;
}

/** The webhook signing secret, or null. Deliberately not part of {@link StripeConfiguration}. */
export function stripeWebhookSecret(env: NodeJS.ProcessEnv = process.env): string | null {
  const value = env[STRIPE_WEBHOOK_SECRET_VAR]?.trim() ?? '';
  return value === '' ? null : value;
}

/**
 * The mode a key belongs to.
 *
 * Anything that is neither prefix is `null` rather than a guess. A restricted key
 * (`rk_test_`/`rk_live_`) is read the same way, since it carries the same marker.
 */
export function stripeModeOf(key: string | null): StripeMode | null {
  if (key === null) return null;
  if (key.startsWith('sk_test_') || key.startsWith('rk_test_')) return 'test';
  if (key.startsWith('sk_live_') || key.startsWith('rk_live_')) return 'live';
  return null;
}

export function readStripeConfiguration(
  env: NodeJS.ProcessEnv = process.env,
): StripeConfiguration {
  const secret = stripeSecretKey(env);
  const webhook = stripeWebhookSecret(env);
  const publishable = env[STRIPE_PUBLISHABLE_KEY_VAR]?.trim() ?? '';

  const missing: string[] = [];
  if (secret === null) missing.push(STRIPE_SECRET_KEY_VAR);
  if (publishable === '') missing.push(STRIPE_PUBLISHABLE_KEY_VAR);
  if (webhook === null) missing.push(STRIPE_WEBHOOK_SECRET_VAR);

  return {
    /*
     * The publishable key is not part of this test.
     *
     * It is needed to mount the provider's elements in a browser, and this integration sends the
     * browser to the provider's own hosted page instead — so a deployment without it can still
     * take a payment. Requiring it would refuse a working configuration.
     */
    connected: secret !== null && webhook !== null,
    missing,
    mode: stripeModeOf(secret),
    publishableKey: publishable === '' ? null : publishable,
  };
}

/**
 * Why a request that needs the provider cannot be served, in words for whoever reads it.
 *
 * Returns null when there is no such reason. The message names the variables rather than saying
 * "not configured", because the person who sees this is the one who has to set them.
 */
export function stripeUnavailableReason(configuration: StripeConfiguration): string | null {
  if (configuration.connected) return null;
  return (
    'No payment provider is connected. This deployment is missing ' +
    configuration.missing.join(', ') +
    '. Set them in the API environment — never in source control — and restart the API.'
  );
}
