/**
 * Typing `@somebody` in the chat composer, and turning it into a person the server can notify.
 *
 * ## What was there before
 *
 * The placeholder read "Use @name to mention somebody in this conversation" and nothing
 * implemented it. The server parses handles out of the body and maps them to people through a
 * `mentionResolutions` object the client sends — and the chat page never sent one, so every
 * mention resolved to nobody and nobody was ever notified. A promise in a placeholder is still a
 * promise.
 *
 * ## Why a handle is not the display name
 *
 * The server's pattern is `@[A-Za-z0-9._-]{2,60}`, which has no spaces in it: "@Aman Singh" is a
 * mention of "Aman" followed by the word "Singh". So a name becomes a handle — spaces to dots —
 * and the resolutions object carries the mapping back to the user id. The handle is a label; the
 * id is the fact.
 */

/** A participant who can be mentioned. */
export interface MentionablePerson {
  userId: string;
  displayName: string;
}

/** Where an unfinished `@…` sits in the text, and what has been typed of it. */
export interface MentionQuery {
  /** What follows the `@`, which is empty the moment `@` is typed. */
  query: string;
  /** Index of the `@`. */
  from: number;
  /** Index just past the last character typed of the handle. */
  to: number;
}

/**
 * A display name as a handle the server's pattern will match.
 *
 * Runs of anything outside the allowed set become a single dot, and leading or trailing dots are
 * dropped — so "Dr. Neha  Verma " is `Dr.Neha.Verma` rather than `Dr..Neha..Verma.`, which would
 * still match but reads as a typo. Two people whose names reduce to the same handle are fine: the
 * resolutions object is keyed by handle, and the picker writes the one that was chosen.
 */
export function handleFor(displayName: string): string {
  return displayName
    .replace(/[^A-Za-z0-9._-]+/g, '.')
    .replace(/\.{2,}/g, '.')
    .replace(/^[.]+|[.]+$/g, '');
}

/**
 * The mention being typed at the caret, or null.
 *
 * Null as soon as it is not a mention any more, which is most of the time: the picker opening
 * over an email address or mid-word would be worse than no picker. The `@` has to start the text
 * or follow a space, exactly as the server's own pattern requires, so `name@example.com` opens
 * nothing.
 *
 * A space ends it. Somebody who types `@ab cd` meant a handle `ab` and then a word.
 */
export function mentionQueryAt(text: string, caret: number): MentionQuery | null {
  const upto = text.slice(0, caret);
  const at = upto.lastIndexOf('@');
  if (at === -1) return null;

  const before = at === 0 ? '' : upto[at - 1];
  if (before !== '' && before !== undefined && /[\w@]/.test(before)) return null;

  const query = upto.slice(at + 1);
  // The handle characters the server accepts, and nothing else — a space or punctuation means
  // the mention finished and this is ordinary text now.
  if (!/^[A-Za-z0-9._-]*$/.test(query)) return null;
  if (query.length > 60) return null;

  return { query, from: at, to: caret };
}

/**
 * The people a query offers, best first.
 *
 * Matched on the display name and on the handle, so "neha" and "dr.neha" both find her. Names
 * that *start* with the query come before names that merely contain it — somebody typing "an"
 * means Aman far more often than they mean Rohan.
 */
export function matchMentions(
  people: readonly MentionablePerson[],
  query: string,
  limit = 6,
): MentionablePerson[] {
  const needle = query.trim().toLowerCase();
  if (needle === '') return people.slice(0, limit);

  const scored = people
    .map((person) => {
      const name = person.displayName.toLowerCase();
      const handle = handleFor(person.displayName).toLowerCase();
      if (name.startsWith(needle) || handle.startsWith(needle)) return { person, rank: 0 };
      if (name.includes(needle) || handle.includes(needle)) return { person, rank: 1 };
      return null;
    })
    .filter((entry): entry is { person: MentionablePerson; rank: number } => entry !== null);

  scored.sort((a, b) => a.rank - b.rank);
  return scored.slice(0, limit).map((entry) => entry.person);
}

/**
 * Put the chosen handle in, and say where the caret goes.
 *
 * A trailing space, because the next thing somebody types is a word and not more of the handle —
 * and because without it the picker stays open over what they type next.
 */
export function applyMention(
  text: string,
  range: MentionQuery,
  person: MentionablePerson,
): { text: string; caret: number } {
  const handle = handleFor(person.displayName);
  const inserted = `@${handle} `;
  return {
    text: text.slice(0, range.from) + inserted + text.slice(range.to),
    caret: range.from + inserted.length,
  };
}

/**
 * The handle-to-user-id map for what is actually in the message.
 *
 * Built from the body at send time rather than accumulated as people are picked, because a draft
 * is edited: a mention that was chosen and then deleted must not notify anybody, and one that was
 * typed by hand and happens to match a handle should. Only people in the list are resolved — the
 * server drops a mention of somebody outside the conversation anyway, and says it did.
 */
export function mentionResolutionsFor(
  body: string,
  people: readonly MentionablePerson[],
): Record<string, string> {
  const byHandle = new Map(
    people.map((person) => [handleFor(person.displayName).toLowerCase(), person.userId]),
  );

  const resolutions: Record<string, string> = {};
  const pattern = /(^|[^\w@])@([A-Za-z0-9._-]{2,60})/g;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(body)) !== null) {
    const handle = match[2];
    if (handle === undefined) continue;
    const userId = byHandle.get(handle.toLowerCase());
    if (userId !== undefined) resolutions[handle] = userId;
  }
  return resolutions;
}
