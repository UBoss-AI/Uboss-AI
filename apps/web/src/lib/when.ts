/**
 * Dates and spans of time, in the words a person would use.
 *
 * ## What this replaces
 *
 * ISO timestamps and raw day counts, printed straight onto customer screens:
 *
 * ```
 * 2034-01-10T06:02:05.809Z — about 2659.1 days away
 * ```
 *
 * Both halves are unreadable, and in different ways. The timestamp is a machine's format —
 * milliseconds and a `Z` on a screen where nobody is thinking about UTC — and the span is worse
 * than unreadable: "2659.1 days" has a tenth of a day of false precision on a figure that is a
 * projection, and the one thing a reader wants from it, roughly how long, takes arithmetic.
 *
 * ## The precision follows the distance
 *
 * Something a week away is counted in days, because the days matter. Something seven years away is
 * "about 7 years", because the days do not — and quoting 2,659 of them implies the model knows
 * which day, which it does not. Rounding down rather than to nearest, so "about 7 years" never
 * describes something closer than seven.
 */

/** A date, as a person writes it: `10 January 2034`. Time dropped — it is noise on a deadline. */
export function formatDay(value: string | Date | null | undefined): string | null {
  const date = toDate(value);
  if (date === null) return null;
  return date.toLocaleDateString(undefined, { day: 'numeric', month: 'long', year: 'numeric' });
}

/** A date with its time, for a trail where the ordering within a day is the point. */
export function formatMoment(value: string | Date | null | undefined): string | null {
  const date = toDate(value);
  if (date === null) return null;
  return date.toLocaleString(undefined, {
    day: 'numeric',
    month: 'short',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
}

/**
 * How long something has been waiting, from a count of hours.
 *
 * The approval queue printed the raw figure with an `h` after it — `623.2h`, `566.7h`, `619.5h`
 * — on fifteen requests of which every single one was more than a day old. The unit never once
 * helped: a reader had to divide by 24 to learn that the oldest had been waiting twenty-six days,
 * and the decimal offered a tenth of an hour of precision on something a month old.
 *
 * Hours while hours are the useful unit, days after that, and days all the way to two months,
 * because "26 days" is the figure that makes somebody act and "3 weeks" is the figure that lets
 * them put it down. Rounded, never truncated: this describes elapsed time, which is known, not a
 * projection.
 */
export function formatElapsedHours(hours: number | null | undefined): string | null {
  if (hours === null || hours === undefined || !Number.isFinite(hours) || hours < 0) return null;

  if (hours < 1) return 'under an hour';
  if (hours < 2) return '1 hour';
  if (hours < 24) return `${Math.round(hours)} hours`;

  const days = hours / 24;
  if (days < 2) return '1 day';
  if (days < 60) return `${Math.round(days)} days`;
  if (days < 730) return `about ${Math.floor(days / 30)} months`;
  return `about ${Math.floor(days / 365)} years`;
}

/**
 * How far off something is, at a precision the figure can carry.
 *
 * Returns null for a span in the past: "in −4 days" is not a phrase, and a caller that has one is
 * describing something that has already happened and should say so in its own words.
 */
export function formatSpan(days: number | null | undefined): string | null {
  if (days === null || days === undefined || !Number.isFinite(days) || days < 0) return null;

  if (days < 1) return 'today';
  if (days < 2) return 'tomorrow';
  if (days < 14) return `${Math.round(days)} days`;
  if (days < 60) return `about ${Math.floor(days / 7)} weeks`;
  if (days < 730) return `about ${Math.floor(days / 30)} months`;
  return `about ${Math.floor(days / 365)} years`;
}

function toDate(value: string | Date | null | undefined): Date | null {
  if (value === null || value === undefined || value === '') return null;
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}
