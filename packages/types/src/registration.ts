/**
 * Signing a company up without anybody at UBoss doing anything.
 *
 * ## The rule everything here is built around
 *
 * **The company is created last.** Two proofs come first — the person controls the email address,
 * and the company controls the domain — and until both are done there is nothing to create a
 * company for. The states below are the order those proofs are cleared in, and nothing skips one.
 */

export const REGISTRATION_STATES = [
  /** The form was submitted. A link has gone to the address; nothing else exists. */
  'AwaitingEmail',
  /** The address is proved. Now the domain has to be, which means a DNS record. */
  'AwaitingDomain',
  /** Both proofs are in. The company has not been created yet, but everything is ready to. */
  'Ready',
  /** The company exists. This row is now only the record of where it came from. */
  'Completed',
  /** Nobody finished it in time, or it was refused. Expires and is swept. */
  'Abandoned',
] as const;
export type RegistrationState = (typeof REGISTRATION_STATES)[number];

export const REGISTRATION_STATE_LABELS: Record<RegistrationState, string> = {
  AwaitingEmail: 'Waiting for the email link',
  AwaitingDomain: 'Waiting for the DNS record',
  Ready: 'Ready to create',
  Completed: 'Company created',
  Abandoned: 'Not completed',
};

/**
 * How long a signup has to finish before it lapses.
 *
 * Fourteen days because the slow half is the DNS record, and that is somebody waiting on whoever
 * administers their company's domain — frequently a different person, occasionally a different
 * company. An hour would be right for the email link alone and would strand everybody at the
 * second step.
 */
export const REGISTRATION_WINDOW_DAYS = 14;

/**
 * How many times a DNS lookup will be run for one signup.
 *
 * Each check is a network call this product makes because an anonymous caller asked it to, so it
 * is bounded. Generous, because the honest case — a record that has not propagated yet — is
 * somebody pressing the button again every few minutes, and they should not be locked out of
 * their own signup for being eager.
 */
export const MAX_DOMAIN_CHECKS = 50;

/**
 * Domains where nobody can publish a DNS record, so nobody can prove control.
 *
 * ## Why these are refused at the form rather than at the DNS step
 *
 * They would fail anyway: a signup at a free mail provider reaches the second proof and is asked
 * to add a TXT record to `gmail.com`, which it cannot do. This is not a new policy — it is telling
 * somebody at the first step what the second step would tell them, before they have spent any time
 * on it.
 *
 * It is also what keeps a workspace attached to a real company. A domain is how UBoss knows which
 * company a person belongs to, and `someone@gmail.com` names no company at all.
 */
export const UNPROVABLE_EMAIL_DOMAINS: readonly string[] = [
  'gmail.com',
  'googlemail.com',
  'yahoo.com',
  'yahoo.co.in',
  'yahoo.co.uk',
  'outlook.com',
  'hotmail.com',
  'live.com',
  'msn.com',
  'icloud.com',
  'me.com',
  'aol.com',
  'protonmail.com',
  'proton.me',
  'zoho.com',
  'gmx.com',
  'mail.com',
  'yandex.com',
  'rediffmail.com',
];

export function isUnprovableEmailDomain(domain: string): boolean {
  return UNPROVABLE_EMAIL_DOMAINS.includes(domain.trim().toLowerCase());
}

/** The address an invitation or a signup was submitted with, split into its two halves. */
export function emailDomain(email: string): string | null {
  const at = email.lastIndexOf('@');
  if (at <= 0 || at === email.length - 1) return null;
  return email
    .slice(at + 1)
    .trim()
    .toLowerCase();
}

/**
 * Whether this address may start a signup, and what to say when it may not.
 *
 * The domain in the address has to be the domain being claimed. Otherwise somebody signs up with
 * their own address and claims a domain they happen to administer but do not work at — or, more
 * commonly, mistypes one of the two and spends a day on a DNS record for the wrong name.
 */
export function validateRegistrationAddress(
  email: string,
  claimedDomain: string,
): { ok: boolean; reason: string } {
  const domain = emailDomain(email);

  if (domain === null) {
    return { ok: false, reason: 'That is not an email address.' };
  }

  if (isUnprovableEmailDomain(domain)) {
    return {
      ok: false,
      reason:
        'Use your work address. A workspace belongs to a company, and the way UBoss knows which ' +
        'company is a domain you can prove you control — which nobody can do for a free mail ' +
        'provider.',
    };
  }

  if (domain !== claimedDomain.trim().toLowerCase()) {
    return {
      ok: false,
      reason:
        `Your address is at ${domain} but you are claiming ${claimedDomain}. They have to be ` +
        'the same, so that proving the domain proves something about you.',
    };
  }

  return { ok: true, reason: 'The address is at the domain being claimed.' };
}

/**
 * The country a domain most likely belongs to, from its suffix.
 *
 * ## Why guess at all
 *
 * A self-serve signup collects four fields and none of them is a country — asking for one is a
 * fifth field on a form whose whole virtue is being short. But the country decides the currency
 * the company is billed in, and defaulting every signup to dollars would price an Indian customer
 * in dollars for no reason other than that nobody asked.
 *
 * A country-code suffix is a real signal: `aarohan.co.in` is an Indian company far more often
 * than it is not.
 *
 * ## Why a guess is safe here and would not be elsewhere
 *
 * It only chooses a **default**, and the platform can correct it before the first charge. A
 * generic suffix — `.com`, `.org`, `.io` — says nothing about where a company is, so it returns
 * null and the currency falls back rather than being invented. Null is the honest answer for most
 * domains in the world, and that is fine: being right for the obvious cases is worth more than a
 * rule that pretends to be right for all of them.
 */
const DOMAIN_SUFFIX_COUNTRY: Record<string, string> = {
  in: 'IN',
  uk: 'GB',
  ie: 'IE',
  de: 'DE',
  fr: 'FR',
  nl: 'NL',
  es: 'ES',
  it: 'IT',
  ae: 'AE',
  sa: 'SA',
  sg: 'SG',
  my: 'MY',
  au: 'AU',
  nz: 'NZ',
  ca: 'CA',
  us: 'US',
};

export function likelyCountryFromDomain(domain: string): string | null {
  const labels = domain.trim().toLowerCase().split('.');
  const suffix = labels.at(-1);
  if (suffix === undefined) return null;
  return DOMAIN_SUFFIX_COUNTRY[suffix] ?? null;
}
