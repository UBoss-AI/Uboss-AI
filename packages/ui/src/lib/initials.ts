/**
 * Avatar initials, matching the UI reference's `initials()` helper: the first letter of up to the
 * first two whitespace-separated parts of a name, upper-cased.
 *
 * Shared so the sidebar footer and the top bar avatar cannot drift apart.
 */
export function initials(name: string): string {
  return name
    .split(' ')
    .map((part) => part[0] ?? '')
    .slice(0, 2)
    .join('')
    .toUpperCase();
}
