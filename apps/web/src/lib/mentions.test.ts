import { describe, expect, it } from 'vitest';

import {
  applyMention,
  handleFor,
  matchMentions,
  mentionQueryAt,
  mentionResolutionsFor,
} from './mentions';

/**
 * Mentions in the chat composer.
 *
 * The composer promised "@name to mention somebody" and sent no resolutions at all, so every
 * mention resolved to nobody. These cover the two halves that make it real: finding the mention
 * somebody is typing, and turning what they typed into user ids the server can notify.
 */
const PEOPLE = [
  { userId: 'u-aman', displayName: 'Aman Singh' },
  { userId: 'u-neha', displayName: 'Neha Verma' },
  { userId: 'u-rohan', displayName: 'Rohan Das' },
];

describe('handleFor', () => {
  it('turns a name into something the server pattern matches', () => {
    expect(handleFor('Aman Singh')).toBe('Aman.Singh');
  });

  it('collapses punctuation and trailing spaces instead of doubling dots', () => {
    expect(handleFor('Dr. Neha  Verma ')).toBe('Dr.Neha.Verma');
  });
});

describe('mentionQueryAt', () => {
  it('opens the moment @ is typed', () => {
    expect(mentionQueryAt('hello @', 7)).toEqual({ query: '', from: 6, to: 7 });
  });

  it('carries what has been typed of the handle', () => {
    expect(mentionQueryAt('hello @am', 9)?.query).toBe('am');
  });

  it('does not open inside an email address', () => {
    /*
     * The failure this prevents: a picker appearing over somebody's address while they type it.
     * The server's own pattern requires the @ to start the text or follow a non-word character,
     * so `pat@example.com` is not a mention either.
     */
    expect(mentionQueryAt('write to pat@example.com', 24)).toBeNull();
  });

  it('closes once a space is typed', () => {
    expect(mentionQueryAt('hello @am cd', 12)).toBeNull();
  });

  it('ignores an @ that is behind the caret', () => {
    expect(mentionQueryAt('@aman said hello', 16)).toBeNull();
  });
});

describe('matchMentions', () => {
  it('puts a name that starts with the query above one that merely contains it', () => {
    // "an" is in both Aman and Rohan; somebody typing it means Aman.
    expect(matchMentions(PEOPLE, 'an').map((p) => p.userId)).toEqual(['u-aman', 'u-rohan']);
  });

  it('matches the handle as well as the name', () => {
    expect(matchMentions(PEOPLE, 'neha.v').map((p) => p.userId)).toEqual(['u-neha']);
  });

  it('offers everybody before anything is typed', () => {
    expect(matchMentions(PEOPLE, '')).toHaveLength(3);
  });
});

describe('applyMention', () => {
  it('replaces what was typed and leaves the caret past a trailing space', () => {
    const range = mentionQueryAt('hi @am', 6);
    expect(range).not.toBeNull();
    const result = applyMention('hi @am', range!, PEOPLE[0]!);
    expect(result.text).toBe('hi @Aman.Singh ');
    expect(result.caret).toBe(result.text.length);
  });

  it('keeps whatever followed the mention', () => {
    const range = mentionQueryAt('hi @am please', 6);
    const result = applyMention('hi @am please', range!, PEOPLE[0]!);
    expect(result.text).toBe('hi @Aman.Singh  please');
  });
});

describe('mentionResolutionsFor', () => {
  it('maps a handle in the body to the user id', () => {
    expect(mentionResolutionsFor('hi @Aman.Singh', PEOPLE)).toEqual({ 'Aman.Singh': 'u-aman' });
  });

  it('resolves nothing for a mention that was deleted from the draft', () => {
    /*
     * Why this is computed from the body at send time rather than collected as people are picked:
     * a draft gets edited, and notifying somebody whose name was taken back out is the failure.
     */
    expect(mentionResolutionsFor('hi there', PEOPLE)).toEqual({});
  });

  it('leaves a handle that belongs to nobody alone', () => {
    expect(mentionResolutionsFor('hi @Someone.Else', PEOPLE)).toEqual({});
  });

  it('does not read an email address as a mention', () => {
    expect(mentionResolutionsFor('write to pat@Aman.Singh', PEOPLE)).toEqual({});
  });

  it('resolves several, including one typed by hand in another case', () => {
    expect(mentionResolutionsFor('@Aman.Singh and @neha.verma', PEOPLE)).toEqual({
      'Aman.Singh': 'u-aman',
      'neha.verma': 'u-neha',
    });
  });
});
