import { motion } from 'motion/react';
import { useId } from 'react';

import { cn } from '../lib/class-names';
import { transition } from '../motion/motion';

export interface SegmentedOption {
  value: string;
  label: string;
}

export interface SegmentedControlProps {
  options: readonly SegmentedOption[];
  value: string;
  onChange: (value: string) => void;
  /** Accessible name, e.g. "Hierarchy view". Required: an unlabelled group is unusable. */
  label: string;
  className?: string;
}

/**
 * The reference's `.seg` — a small segmented toggle, used for Tree view / List view.
 *
 * Distinct from {@link Tabs}, which is the reference's `.pill-tabs`. The approved UI has both
 * and they look different, so there are two components here rather than one with a variant: a
 * shared component would have to be told which of the two it is on every use, which is the same
 * decision made worse.
 *
 * `role="group"` with `aria-pressed` on each button rather than `role="tablist"`: the two views
 * are not tab panels — the whole card below changes, and the reference navigates to a different
 * route for each. Announcing them as tabs would promise a relationship that is not there.
 */
export function SegmentedControl({
  options,
  value,
  onChange,
  label,
  className,
}: SegmentedControlProps) {
  // Scoped per instance: two segmented controls on a screen sharing a layout id would send the
  // pill flying between them.
  const indicatorId = useId();

  return (
    <div className={cn('uboss-seg', className)} role="group" aria-label={label}>
      {options.map((option) => (
        <button
          key={option.value}
          type="button"
          className={cn(option.value === value && 'is-on')}
          aria-pressed={option.value === value}
          onClick={() => onChange(option.value)}
        >
          {option.value === value ? (
            <motion.span
              layoutId={indicatorId}
              className="uboss-seg-indicator"
              aria-hidden="true"
              transition={transition('panel', 'standard')}
            />
          ) : null}
          <span className="uboss-seg-label">{option.label}</span>
        </button>
      ))}
    </div>
  );
}
