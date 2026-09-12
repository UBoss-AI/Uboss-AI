/**
 * Portable UBoss Profile Search — Prompt 37A.
 *
 * ## What the approved documents ask for
 *
 * UBoss_Final_1 §8: *"Portable profile search — **Authorized HR/Admin** can search a person by
 * UBoss Unique ID. Full Aadhaar is not used as the cross-company search field and is not exposed
 * to another company."*
 *
 * Technical Architecture §UBoss Profile Search: *"Authorized HR/Admin enters UBoss Unique ID to
 * retrieve the permitted portable employment/performance summary. Aadhaar is never the
 * cross-company search field."*
 *
 * §905 lists *"UBoss Profile Search / employment verification permissions and performance/reward
 * policy **where enabled**"* among the company's Settings — so the capability is configured, not
 * universal.
 *
 * ## This is the one feature that legitimately reads across tenancies
 *
 * Everything else in UBoss is confined by Row-Level Security to one company. A portable profile is
 * the exception the product exists to provide: a person's employment history belongs to the
 * person, not to whichever company happens to hold a row about them.
 *
 * That makes it the highest-risk read in the product, and the design treats it that way:
 *
 * 1. **The input is a UBoss Unique ID and nothing else.** Not an email, not a name, not an
 *    employee number, and above all not Aadhaar. A search by name would be an enumeration tool.
 * 2. **The projection is a whitelist**, stated as `PORTABLE_PROFILE_FIELDS` and asserted by a
 *    test — not a row with things stripped off it. A stripping approach leaks the first time
 *    somebody adds a column.
 * 3. **The source company decides whether its performance data travels**, because it recorded it.
 * 4. **Every lookup is audited** in the searching company's trail, with the id that was searched.
 *
 * ## What must never come back, whatever anybody adds later
 *
 * The prompt enumerates it and so does this module, as a value a test can iterate:
 * prior-tenant task contents, customer data, files, Objectives, prompts, AI outputs, credentials,
 * connections, Aadhaar.
 */

// ---------------------------------------------------------------------------
// The input
// ---------------------------------------------------------------------------

/**
 * The only thing you may search by.
 *
 * Stated as a constant because "input is UBoss Unique ID only" is a requirement that erodes by
 * somebody adding a convenience: an email lookup, a name search, "just the last four of the
 * Aadhaar to confirm". Each is defensible alone and each turns a verification tool into an
 * enumeration tool.
 */
export const PROFILE_SEARCH_INPUT = 'UbossUniqueId' as const;

export const PROFILE_SEARCH_INPUT_STANCE =
  'A portable profile is found by UBoss Unique ID and by nothing else. There is no search by ' +
  'name, email, phone or employee number, because a search that accepts those is a way to ' +
  'enumerate people rather than to verify one. Aadhaar is never a search field and is never ' +
  'returned.';

// ---------------------------------------------------------------------------
// The projection
// ---------------------------------------------------------------------------

/**
 * Exactly the fields a portable profile may carry.
 *
 * A whitelist, asserted by a test against the response's own keys. The alternative — building the
 * response from a row and deleting what must not travel — leaks the first time somebody adds a
 * column to `employment_records`, and nothing would fail.
 */
export const PORTABLE_PROFILE_FIELDS: readonly string[] = [
  'ubossUniqueId',
  'displayName',
  'employments',
  'searchedAt',
];

/** Exactly the fields one employment entry may carry. */
export const PORTABLE_EMPLOYMENT_FIELDS: readonly string[] = [
  'companyName',
  'designation',
  'joinedOn',
  'endedAt',
  'isCurrent',
  'performance',
];

/** Exactly the fields a performance summary may carry, when the source company shares it. */
export const PORTABLE_PERFORMANCE_FIELDS: readonly string[] = [
  'score',
  'badge',
  'onTimePercent',
  'achievements',
];

/**
 * What must never appear in a portable profile, whatever anybody adds later.
 *
 * The prompt's own list, as substrings a test greps for in the serialized response. Crude on
 * purpose: a test that checks the *shape* passes once somebody nests a forbidden thing one level
 * deeper, and a test that greps the JSON does not.
 */
export const NEVER_IN_A_PORTABLE_PROFILE: readonly string[] = [
  'aadhaar',
  'objective',
  'task',
  'prompt',
  'credential',
  'connection',
  'secret',
  'file',
  'email',
  'phone',
];

export const PORTABLE_PROFILE_STANCE =
  'A portable profile carries who a person is, where they have worked, for how long, in what ' +
  'role, and — where that company chose to share it — how they performed. It carries nothing ' +
  'that belonged to the company rather than to the person: no task contents, no customer data, ' +
  'no files, no Objectives, no prompts, no AI output, no credentials, no connections, and never ' +
  'Aadhaar.';

// ---------------------------------------------------------------------------
// The shapes
// ---------------------------------------------------------------------------

export interface PortablePerformance {
  /** The company's own performance score. Null when they share the badge but not the number. */
  score: number | null;
  /** The badge level at the end of that employment, or the current one. */
  badge: string | null;
  /**
   * Completed work delivered by its due date, as a percentage.
   *
   * **Null rather than zero when there is nothing to measure.** A person whose work carried no
   * due dates has no on-time percentage, and reporting 0% would read as "never on time" — which
   * is the opposite of the truth and the kind of number that costs somebody a job.
   */
  onTimePercent: number | null;
  /**
   * Approved rewards, as a count and a date.
   *
   * **No titles, and that is forced rather than chosen.** A reward's only human-readable label is
   * the Objective it was earned against, and an Objective is one of the things the prompt forbids
   * a portable profile from carrying. "Three approved rewards, most recently in March" verifies
   * what a verification needs — that this person earned recognition and roughly when — without
   * naming a piece of another company's work.
   */
  achievements: { count: number; mostRecentAt: string | null };
}

export interface PortableEmployment {
  companyName: string;
  designation: string;
  joinedOn: string | null;
  endedAt: string | null;
  isCurrent: boolean;
  /** Null when that company does not share performance in portable search. */
  performance: PortablePerformance | null;
}

export interface PortableProfile {
  ubossUniqueId: string;
  displayName: string;
  /** Most recent first. */
  employments: PortableEmployment[];
  searchedAt: string;
}

// ---------------------------------------------------------------------------
// Sharing policy
// ---------------------------------------------------------------------------

/**
 * How much of its own performance record a company lets out.
 *
 * **The source company decides**, because it recorded the data and its policy governed how the
 * score was earned. A company that scores harshly should not have its numbers compared against a
 * company that scores generously by a third party who cannot see either policy — so `Nothing` is
 * a real and reasonable choice, and it is the default.
 */
export const PERFORMANCE_SHARING_MODES = ['Nothing', 'BadgeOnly', 'BadgeAndScore'] as const;
export type PerformanceSharingMode = (typeof PERFORMANCE_SHARING_MODES)[number];

export const PERFORMANCE_SHARING_LABELS: Record<PerformanceSharingMode, string> = {
  Nothing: 'Employment dates and designation only',
  BadgeOnly: 'Also the badge and on-time percentage, but not the score',
  BadgeAndScore: 'Also the performance score',
};

export const PERFORMANCE_SHARING_DESCRIPTIONS: Record<PerformanceSharingMode, string> = {
  Nothing:
    'Another company verifying this person sees that they worked here, when, and in what role. ' +
    'Nothing about how they performed.',
  BadgeOnly:
    'Adds the badge level and the on-time percentage. A badge is comparable between companies in ' +
    'a way a raw score is not, because the score depends on the policy that produced it.',
  BadgeAndScore:
    'Adds the numeric score. Only choose this if you are content for it to be read by somebody ' +
    'who cannot see the policy that produced it.',
};

/**
 * Nothing, by default.
 *
 * The strictest option, and the one worth defending: a company that has never opened this setting
 * has never agreed to publish its performance judgements to other employers. The cost of being
 * too strict is that somebody changes a setting; the cost of being too loose is a person's score
 * travelling to a prospective employer without their employer ever deciding to send it.
 */
export const DEFAULT_PERFORMANCE_SHARING: PerformanceSharingMode = 'Nothing';

/** Whether this company's people may perform a portable lookup at all. Off by default. */
export const DEFAULT_PROFILE_SEARCH_ENABLED = false;

export type ProfileSearchDecision = { permitted: true } | { permitted: false; reason: string };

/**
 * Whether a lookup may proceed.
 *
 * The permission is checked separately, by the authorization engine. This is the **company
 * policy** half — §905's "where enabled" — and it is its own function so the screen can explain
 * the refusal in the same words the service uses.
 */
export function decideProfileSearch(input: { enabledForSearcher: boolean }): ProfileSearchDecision {
  if (!input.enabledForSearcher) {
    return {
      permitted: false,
      reason:
        'Portable profile search is switched off for this company. It is off until somebody ' +
        'turns it on, because looking up a person’s employment history across other companies ' +
        'is a capability a company should choose rather than inherit.',
    };
  }
  return { permitted: true };
}

/**
 * Build the performance part of one employment, or withhold it.
 *
 * Written here rather than in the service so the mode's meaning lives with its vocabulary — and
 * so `BadgeOnly` genuinely cannot return a score. Returning the row and letting the caller decide
 * which fields to read is how a score escapes.
 */
export function shareablePerformance(input: {
  mode: PerformanceSharingMode;
  score: number | null;
  badge: string | null;
  onTimePercent: number | null;
  achievements: { count: number; mostRecentAt: string | null };
}): PortablePerformance | null {
  if (input.mode === 'Nothing') return null;

  return {
    // `BadgeOnly` returns null here **by construction**, not by the caller remembering.
    score: input.mode === 'BadgeAndScore' ? input.score : null,
    badge: input.badge,
    onTimePercent: input.onTimePercent,
    achievements: input.achievements,
  };
}

/**
 * On-time percentage from two counts.
 *
 * Null when nothing had a due date, for the reason on `PortablePerformance.onTimePercent`: 0%
 * would read as "never on time", and a made-up number about somebody's reliability is worse than
 * no number.
 */
export function onTimePercent(input: { onTime: number; withDueDate: number }): number | null {
  if (input.withDueDate <= 0) return null;
  return Math.round((input.onTime / input.withDueDate) * 100);
}

/**
 * The reward states that count as an approved achievement.
 *
 * Everything from approval onwards: `Settled` and `Recorded` are approvals that went further, and
 * a summary that counted only `Approved` would under-report the people whose rewards were
 * actually paid.
 */
export const APPROVED_REWARD_STATES: readonly string[] = ['Approved', 'Settled', 'Recorded'];
