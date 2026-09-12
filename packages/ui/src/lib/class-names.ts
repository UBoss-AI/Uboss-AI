/**
 * Conditional class-name joining.
 *
 * The UBoss design system (Prompt 2) is built from reusable components rather than one-off page
 * styling, and those components need one predictable way to compose conditional classes.
 * Deliberately dependency-free.
 */
export type ClassValue = string | number | false | null | undefined | ClassValue[];

/**
 * Join truthy class values into a single, de-duplicated, whitespace-normalised string.
 * `false`, `null`, `undefined` and empty strings are dropped, so
 * `cn('btn', isPrimary && 'btn-primary')` is safe.
 */
export function cn(...values: ClassValue[]): string {
  const tokens: string[] = [];

  const collect = (value: ClassValue): void => {
    if (value === null || value === undefined || value === false || value === '') {
      return;
    }
    if (Array.isArray(value)) {
      for (const nested of value) {
        collect(nested);
      }
      return;
    }
    for (const token of String(value).split(/\s+/)) {
      if (token !== '' && !tokens.includes(token)) {
        tokens.push(token);
      }
    }
  };

  for (const value of values) {
    collect(value);
  }

  return tokens.join(' ');
}
