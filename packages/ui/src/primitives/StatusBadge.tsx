import type { ReactNode } from 'react';

import { cn } from '../lib/class-names';

export type StatusTone = 'success' | 'blue' | 'teal' | 'warn' | 'danger' | 'purple' | 'grey';

/**
 * Canonical status vocabulary, transcribed from the client's UI reference so the same business
 * status always reads the same colour across every screen.
 */
export const STATUS_TONES: Record<string, StatusTone> = {
  // Settled / good
  Live: 'success',
  Active: 'success',
  Completed: 'success',
  Approved: 'success',
  Ready: 'success',
  Healthy: 'success',
  'On track': 'success',
  Settled: 'success',
  // In flight
  Draft: 'grey',
  'In Review': 'blue',
  Review: 'blue',
  Queued: 'grey',
  Running: 'teal',
  Analyzing: 'teal',
  Eligible: 'blue',
  // Needs a human
  'Needs input': 'warn',
  'Waiting Human': 'warn',
  'Waiting Approval': 'warn',
  Pending: 'warn',
  Overdue: 'warn',
  'At risk': 'warn',
  Retrying: 'warn',
  // Stopped
  Blocked: 'danger',
  Failed: 'danger',
  Rejected: 'danger',
  Suspended: 'danger',
  Paused: 'grey',
  Archived: 'grey',
  New: 'purple',
};

export interface StatusBadgeProps {
  /** The status text. It is always rendered, because status must never be colour-only. */
  status: string;
  /** Override the tone when a status is not in the canonical vocabulary. */
  tone?: StatusTone;
  /** Show the leading dot. */
  dot?: boolean;
  className?: string;
  children?: ReactNode;
}

/**
 * Locked UI rule: status is never conveyed by colour alone. This component always renders the
 * status label alongside the tone, so the meaning survives greyscale and colour-blindness.
 */
export function StatusBadge({ status, tone, dot = true, className, children }: StatusBadgeProps) {
  const resolved: StatusTone = tone ?? STATUS_TONES[status] ?? 'grey';

  return (
    <span className={cn('uboss-badge', `uboss-badge--${resolved}`, className)}>
      {dot ? <span className="uboss-badge-dot" aria-hidden="true" /> : null}
      {children ?? status}
    </span>
  );
}

export type BadgeLadderTier = 'Bronze' | 'Silver' | 'Gold' | 'Platinum' | 'Diamond';

/** The baseline badge ladder. Thresholds are configurable; the order is not. */
export const BADGE_LADDER: readonly BadgeLadderTier[] = [
  'Bronze',
  'Silver',
  'Gold',
  'Platinum',
  'Diamond',
] as const;

/**
 * What each rung is called.
 *
 * ## Why the stored value and the shown name differ
 *
 * The rungs are stored as `Bronze` … `Diamond` and the client asked for `Starter` … `Legend`.
 * Renaming the stored values would rewrite every badge somebody has already earned and every audit
 * row that names one — history saying a person reached a level that, under the new vocabulary,
 * never existed. So the ladder keeps its identity and gains a label.
 *
 * That is also the client's own rule read literally: "do not let badge UI override actual
 * performance/audit logic". This is the badge UI, and it overrides nothing — the thresholds, the
 * events and the score are untouched, and a person moves up for the same reasons as before.
 */
export const BADGE_LADDER_LABELS: Record<BadgeLadderTier, string> = {
  Bronze: 'Starter',
  Silver: 'Skilled',
  Gold: 'Pro',
  Platinum: 'Elite',
  Diamond: 'Legend',
};

export interface MedalBadgeProps {
  tier: BadgeLadderTier;
  className?: string;
}

export function MedalBadge({ tier, className }: MedalBadgeProps) {
  return (
    <span
      className={cn('uboss-medal', `uboss-medal--${tier.toLowerCase()}`, className)}
      // The stored rung, for anybody reading a screenshot against an audit row. The shown name is
      // what the company calls it; this is what the record calls it, and both are true.
      title={`${BADGE_LADDER_LABELS[tier]} (${tier})`}
    >
      {BADGE_LADDER_LABELS[tier]}
    </span>
  );
}
