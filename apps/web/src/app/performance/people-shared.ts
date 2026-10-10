import type { TrackerCard } from '../../lib/api-client';

/**
 * The lenses an administrator actually arrives wanting.
 *
 * Not a filter per field — a hundred and fifteen cards and a search box is already most of the
 * way there. These are the three questions this screen exists to answer in one press: who is
 * behind, who cannot sign in yet, and who nobody can even reach.
 */
export type Lens = 'all' | 'attention' | 'notInvited' | 'noAddress';

export const LENS_LABELS: Record<Lens, string> = {
  all: 'Everybody',
  attention: 'Needs attention',
  notInvited: 'Not invited',
  noAddress: 'No address',
};

export const LENS_OPTIONS: readonly { value: Lens; label: string }[] = [
  { value: 'all', label: LENS_LABELS.all },
  { value: 'attention', label: LENS_LABELS.attention },
  { value: 'notInvited', label: LENS_LABELS.notInvited },
  { value: 'noAddress', label: LENS_LABELS.noAddress },
];

/** What the single account button says, per answer the server gave. */
export const ACCOUNT_LABELS: Record<string, string> = {
  Invite: 'Send invitation',
  Resend: 'Resend invitation',
  Reset: 'Send reset link',
  None: 'No address',
};

/** How a membership state reads to a person, rather than how it is stored. */
export const ACCOUNT_STATES: Record<string, string> = {
  NotInvited: 'Not invited yet',
  InvitePending: 'Invitation sent, not accepted',
  Active: 'Active',
  Suspended: 'Suspended',
  Offboarded: 'Offboarded',
};

/** Overdue work or a failed run — the two things on a card that somebody has to act on. */
export function needsAttention(card: TrackerCard): boolean {
  return card.tasks.overdue > 0 || card.runs.failed > 0;
}

/**
 * Two letters for the disc on a card.
 *
 * First and last word rather than the first two, so "ASHISH KUMAR PANDEY" is AP and not AK —
 * a surname distinguishes people on a roster where half the first names repeat.
 */
export function initialsOf(name: string): string {
  const words = name.trim().split(/\s+/).filter(Boolean);
  if (words.length === 0) return '?';
  if (words.length === 1) return words[0]!.slice(0, 2).toUpperCase();
  return (words[0]![0]! + words[words.length - 1]![0]!).toUpperCase();
}

/**
 * How long a run took, in the largest unit that is still honest.
 *
 * Seconds under a minute, minutes under an hour, then hours and minutes — a run that took four
 * thousand seconds is a number nobody converts in their head.
 */
export function elapsed(ms: number): string {
  const seconds = Math.round(ms / 1000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ${seconds % 60}s`;
  return `${Math.floor(minutes / 60)}h ${minutes % 60}m`;
}

/** A date somebody can read, in their own locale, or an em dash when there is none. */
export function when(value: string | null): string {
  if (value === null) return '—';
  return new Date(value).toLocaleString();
}
