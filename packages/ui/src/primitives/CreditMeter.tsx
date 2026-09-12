import { cn } from '../lib/class-names';

/**
 * The four stages of the locked AI cost lifecycle:
 * Estimate -> Reserve -> Execute -> Settle/Reconcile.
 *
 * All four are represented here on purpose. The client's UI prototype surfaced only Estimate
 * and Settle, which is a gap recorded in docs/UX_MAP.md; this component closes it so no later
 * screen can show a partial lifecycle.
 */
export interface CreditLifecycle {
  /** Forecast cost, not yet committed. */
  estimated: number;
  /** Held against the budget, awaiting execution. */
  reserved: number;
  /** Spent by runs that are still in flight. */
  executing: number;
  /** Final reconciled spend. */
  settled: number;
}

export interface CreditMeterProps {
  /** Budget ceiling in the same unit as the lifecycle values. */
  budget: number;
  lifecycle: CreditLifecycle;
  /** Unit label, e.g. `'USD'` or `'credits'`. */
  unit?: string;
  /** Accessible name, e.g. "Regulatory Affairs department budget". */
  label: string;
  className?: string;
}

const STAGES: { key: keyof CreditLifecycle; label: string; className: string }[] = [
  { key: 'settled', label: 'Settled', className: 'uboss-credit-seg--settled' },
  { key: 'executing', label: 'Executing', className: 'uboss-credit-seg--executing' },
  { key: 'reserved', label: 'Reserved', className: 'uboss-credit-seg--reserved' },
  { key: 'estimated', label: 'Estimated', className: 'uboss-credit-seg--estimated' },
];

function formatAmount(value: number, unit: string): string {
  return `${value.toLocaleString('en-US', { maximumFractionDigits: 2 })} ${unit}`;
}

export function CreditMeter({
  budget,
  lifecycle,
  unit = 'credits',
  label,
  className,
}: CreditMeterProps) {
  const committed = lifecycle.settled + lifecycle.executing + lifecycle.reserved;
  const projected = committed + lifecycle.estimated;
  const over = budget > 0 && projected > budget;
  // Guard against a zero or negative budget so the bar cannot divide by zero.
  const scale = budget > 0 ? budget : projected > 0 ? projected : 1;

  return (
    <div className={cn('uboss-credit', over && 'uboss-credit--over', className)}>
      <div className="uboss-credit-head">
        <span className="uboss-credit-value">{formatAmount(committed, unit)}</span>
        <span className="uboss-credit-of">
          committed of {formatAmount(budget, unit)}
          {lifecycle.estimated > 0 ? ` · ${formatAmount(lifecycle.estimated, unit)} estimated` : ''}
        </span>
      </div>

      <div
        className="uboss-credit-track"
        role="meter"
        aria-label={label}
        aria-valuemin={0}
        aria-valuemax={budget}
        aria-valuenow={committed}
        aria-valuetext={`${formatAmount(committed, unit)} committed of ${formatAmount(budget, unit)}`}
      >
        {STAGES.map((stage) => {
          const value = lifecycle[stage.key];
          if (value <= 0) {
            return null;
          }
          return (
            <span
              key={stage.key}
              className={cn('uboss-credit-seg', stage.className)}
              style={{ width: `${Math.min((value / scale) * 100, 100)}%` }}
            />
          );
        })}
      </div>

      <div className="uboss-credit-legend">
        {STAGES.map((stage) => (
          <span key={stage.key} className="uboss-credit-legend-item">
            <span
              className={cn('uboss-credit-legend-swatch', stage.className)}
              aria-hidden="true"
            />
            {stage.label} {formatAmount(lifecycle[stage.key], unit)}
          </span>
        ))}
      </div>

      {over ? (
        <p className="uboss-notice" style={{ color: 'var(--uboss-danger)' }}>
          Projected spend exceeds the budget. Activation is blocked until budget is reallocated or
          topped up.
        </p>
      ) : null}
    </div>
  );
}
