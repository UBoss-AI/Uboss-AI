import { cn } from '../lib/class-names';
import { BADGE_LADDER, MedalBadge, type BadgeLadderTier } from './StatusBadge';

export interface BadgeProgressionProps {
  /** The level held now. */
  current: BadgeLadderTier;
  /**
   * The threshold for each tier, so the strip can state what each rung costs. Configurable per
   * company — the order is not.
   */
  thresholds?: Partial<Record<BadgeLadderTier, number>>;
  className?: string;
}

/**
 * The badge ladder as a horizontal strip: five medals, each over a bar that is filled up to and
 * including the level held.
 *
 * Matched to the reference's `SCR.performance` badge progression. Uses `MedalBadge` rather than
 * re-styling a medal, so the five tiers look the same everywhere they appear.
 *
 * ## Why the current level is named in text as well as filled
 *
 * A filled bar and a coloured medal are both colour-and-shape signals. Somebody reading this in
 * greyscale, or with a screen reader, still needs to know which rung they are on — so the strip
 * carries an accessible sentence and the current tier is marked with `aria-current`.
 *
 * The thresholds are shown when supplied rather than assumed, because they are company policy.
 * A hard-coded "Gold @ 78" would be a claim about somebody else's configuration.
 */
export function BadgeProgression({ current, thresholds, className }: BadgeProgressionProps) {
  const reached = BADGE_LADDER.indexOf(current);

  return (
    <div className={cn('uboss-ladder', className)}>
      <p className="uboss-sr-only">
        Current level {current}, rung {reached + 1} of {BADGE_LADDER.length}.
      </p>
      {BADGE_LADDER.map((tier, index) => {
        const attained = index <= reached;

        return (
          <div
            key={tier}
            className={cn('uboss-ladder-rung', attained && 'uboss-ladder-rung--attained')}
            {...(tier === current ? { 'aria-current': 'step' as const } : {})}
          >
            <MedalBadge tier={tier} />
            <span className="uboss-ladder-bar" aria-hidden="true" />
            {thresholds?.[tier] === undefined ? null : (
              <span className="uboss-ladder-threshold">{thresholds[tier]}</span>
            )}
          </div>
        );
      })}
    </div>
  );
}
