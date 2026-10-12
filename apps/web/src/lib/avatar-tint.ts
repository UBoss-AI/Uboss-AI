/**
 * A person's avatar colour, derived from their name.
 *
 * Chat was a page of grey: every conversation a line of text, every message the same bordered
 * box, and the only way to tell two people apart was to read their names. A colour per person is
 * what makes a list of six conversations scannable without reading any of it — and it has to be
 * *their* colour, the same one every time, or it tells the reader nothing.
 *
 * ## Why it is computed and not stored
 *
 * Nobody picks it and nothing has to migrate. The name is already on every screen that needs the
 * colour, so two screens showing the same person cannot disagree.
 *
 * ## Why these are HSL and not tokens
 *
 * The palette is twelve hues at one saturation and one lightness, chosen dark enough that white
 * initials sit on every one of them. A token set would need twelve new names for a decoration
 * that is never referred to anywhere else, and the two themes do not want different values here:
 * the circle carries its own ink, so it does not have to relate to the surface behind it.
 */

/** Twelve, spread around the wheel, so two names next to each other rarely land on one hue. */
const HUES = [262, 212, 174, 142, 96, 42, 18, 350, 320, 288, 236, 196];

/**
 * A small, stable hash of the name.
 *
 * Not `length` and not the first character: "Aman Singh" and "Aditi Sharma" would collide on the
 * second and be close on the first, and those are the two names on the screen this was built for.
 * Every character contributes.
 */
function hash(name: string): number {
  let total = 0;
  for (let index = 0; index < name.length; index += 1) {
    total = (total * 31 + name.charCodeAt(index)) % 100000;
  }
  return total;
}

/**
 * The background for this person's avatar circle. White initials are readable on all twelve.
 *
 * An empty name gets the first hue rather than throwing: a conversation whose participant has no
 * display name is a data problem, and a missing circle would hide it rather than show it.
 */
export function avatarTint(name: string): string {
  const hue = HUES[hash(name) % HUES.length] ?? HUES[0];
  return `hsl(${hue} 42% 42%)`;
}
