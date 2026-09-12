import type { ReactNode } from 'react';

import { cn } from '../lib/class-names';

export type StatusTone = 'success' | 'blue' | 'cyan' | 'warn' | 'danger' | 'purple' | 'grey';

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
  Running: 'cyan',
  Analyzing: 'cyan',
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

export interface MedalBadgeProps {
  tier: BadgeLadderTier;
  className?: string;
}

export function MedalBadge({ tier, className }: MedalBadgeProps) {
  return (
    <span className={cn('uboss-medal', `uboss-medal--${tier.toLowerCase()}`, className)}>
      {tier}
    </span>
  );
}
