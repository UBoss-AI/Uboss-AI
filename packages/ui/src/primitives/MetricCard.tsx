import { cn } from '../lib/class-names';
import { Icon } from './Icon';

export type MetricTrend = 'up' | 'down' | 'flat';

export interface MetricCardProps {
  label: string;
  value: string | number;
  /** Optional change indicator, e.g. `'+12 this week'`. */
  delta?: string;
  /**
   * Direction of the change. `up` is not automatically "good" — pass the direction that is
   * factually true and let the caller choose wording.
   */
  trend?: MetricTrend;
  /**
   * Makes the whole card a button. Used on the Master Console dashboard for drill-down.
   * Note: the Company Workspace Dashboard must NOT use metric cards — it carries the
   * two-slice donut only (see DonutDashboard).
   */
  onSelect?: () => void;
  className?: string;
}

export function MetricCard({
  label,
  value,
  delta,
  trend = 'flat',
  onSelect,
  className,
}: MetricCardProps) {
  const content = (
    <>
      <div className="uboss-metric-label">{label}</div>
      <div className="uboss-metric-value">{value}</div>
      {delta ? (
        <div className={cn('uboss-metric-delta', `uboss-metric-delta--${trend}`)}>
          {trend !== 'flat' ? (
            <Icon name="arrow" size={13} style={{ rotate: trend === 'up' ? '-90deg' : '90deg' }} />
          ) : null}
          {delta}
        </div>
      ) : null}
    </>
  );

  if (onSelect) {
    return (
      <button
        type="button"
        className={cn('uboss-metric', 'uboss-metric--clickable', className)}
        onClick={onSelect}
      >
        {content}
      </button>
    );
  }

  return <div className={cn('uboss-metric', className)}>{content}</div>;
}
