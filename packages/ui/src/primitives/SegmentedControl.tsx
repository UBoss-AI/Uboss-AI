import { cn } from '../lib/class-names';

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
          {option.label}
        </button>
      ))}
    </div>
  );
}
