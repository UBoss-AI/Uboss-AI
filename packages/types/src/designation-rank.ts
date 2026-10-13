/**
 * How senior a designation is, so an org chart can put people in the order a company thinks in.
 *
 * ## Why this is guesswork, and why that is acceptable
 *
 * `designation` is free text — a 160-character column anybody can type into — and there is no
 * grade, band or level anywhere in the schema to read instead. Nothing in the product knows that
 * a Vice President outranks a Junior Engineer except the words themselves.
 *
 * So this reads the words. That is a heuristic and it will be wrong for some company's private
 * vocabulary, which is why it is built to **fail into today's behaviour**: a title it does not
 * recognise gets the ordinary-staff rank, and equal ranks fall back to alphabetical order. A
 * company whose titles this understands none of gets exactly the A-to-Z list it has now, not a
 * scrambled one.
 *
 * It does not replace the reporting structure. The chart already nests a person under the manager
 * they report to; this orders the people *within* one of those levels, which was alphabetical and
 * therefore put the junior engineer above the senior manager.
 *
 * ## The shape of a title
 *
 * Two parts, and both matter: what the job is (Manager, Engineer, Executive) and which way it is
 * modified (Senior, Assistant, Junior). "Assistant Manager" is below "Manager" and above
 * "Supervisor", and only reading both parts gets that right.
 */

/**
 * The ordinary-staff rank, and what an unrecognised title is worth.
 *
 * In the middle on purpose. An unknown title is not evidence of seniority in either direction,
 * and sinking it to the bottom would push a company's own vocabulary below its trainees.
 */
export const DEFAULT_DESIGNATION_RANK = 40;

/**
 * What the job is, highest first. Longest phrase wins, so "general manager" is not read as
 * "manager" and "vice president" is not read as "president".
 */
const ROLE_TIERS: readonly (readonly [string, number])[] = [
  ['chairman', 100],
  ['managing director', 100],
  ['chief executive', 100],
  ['chief operating', 100],
  ['chief financial', 100],
  ['chief technology', 100],
  ['chief', 100],
  ['ceo', 100],
  ['cfo', 100],
  ['coo', 100],
  ['cto', 100],
  ['md', 100],
  ['vice president', 90],
  ['president', 95],
  ['vp', 90],
  ['director', 80],
  ['head', 80],
  ['principal', 75],
  ['general manager', 70],
  ['gm', 70],
  ['manager', 60],
  ['supervisor', 50],
  ['superintendent', 50],
  ['in-charge', 50],
  ['incharge', 50],
  ['lead', 50],
  ['foreman', 45],
  ['engineer', 40],
  ['executive', 40],
  ['officer', 40],
  ['analyst', 40],
  ['specialist', 40],
  ['consultant', 40],
  ['associate', 40],
  ['coordinator', 40],
  ['technician', 35],
  ['operator', 35],
  ['clerk', 35],
  ['assistant', 30],
  ['helper', 25],
  ['trainee', 10],
  ['intern', 10],
  ['apprentice', 10],
];

/** Which way the job is modified. Longest first, for the same reason. */
const MODIFIERS: readonly (readonly [string, number])[] = [
  ['senior', 5],
  ['sr.', 5],
  ['sr', 5],
  ['deputy', -5],
  ['dy.', -5],
  ['assistant', -5],
  ['asst.', -5],
  ['asst', -5],
  ['junior', -5],
  ['jr.', -5],
  ['jr', -5],
];

/** Lower-cased, punctuation flattened to single spaces, so "ASST. MANAGER" reads as two words. */
function normalise(designation: string): string {
  return ` ${designation
    .toLowerCase()
    .replace(/[^a-z]+/g, ' ')
    .trim()} `;
}

/**
 * How senior this designation is. Higher is more senior.
 *
 * The job's tier, adjusted by the modifier in front of it. A modifier only counts when there is
 * also a job to modify: "Senior" on its own is not a rank, it is half a title.
 *
 * A title that is only a modifier of another title — "Assistant" with no noun — is a job in its
 * own right in some companies, so `assistant` appears in both lists and the tier is used when
 * nothing else matched.
 */
export function designationRank(designation: string | null | undefined): number {
  if (designation === null || designation === undefined) return DEFAULT_DESIGNATION_RANK;

  const text = normalise(designation);
  if (text.trim() === '') return DEFAULT_DESIGNATION_RANK;

  const tier = ROLE_TIERS.find(([word]) => text.includes(` ${word} `));
  if (tier === undefined) return DEFAULT_DESIGNATION_RANK;

  /*
   * The modifier has to sit somewhere other than on the tier word itself, or "Assistant" as a
   * whole title would be both tier 30 and a −5 on itself.
   */
  const modifier = MODIFIERS.find(([word]) => word !== tier[0] && text.includes(` ${word} `));
  return tier[1] + (modifier?.[1] ?? 0);
}

/**
 * Compare two people for an org chart: senior first, then by name.
 *
 * The name tie-break is what keeps the result stable and keeps a company whose titles this does
 * not recognise with the alphabetical list it already had.
 */
export function byDesignationThenName(
  // `| undefined` written out, not just the `?`: the repo runs `exactOptionalPropertyTypes`, so
  // an optional property and one that may be passed as undefined are different types, and every
  // real caller reads this off `person?.designation`.
  a: { name: string; designation?: string | null | undefined },
  b: { name: string; designation?: string | null | undefined },
): number {
  const difference = designationRank(b.designation) - designationRank(a.designation);
  if (difference !== 0) return difference;
  return a.name.localeCompare(b.name);
}
