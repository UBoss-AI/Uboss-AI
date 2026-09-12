import { cn } from '../lib/class-names';
import { Icon, type IconName } from './Icon';

export type SecurityLevel = 'ok' | 'attention' | 'critical';

/** Text equivalent, so the level is never communicated by colour alone. */
const LEVEL_LABEL: Record<SecurityLevel, string> = {
  ok: 'Healthy',
  attention: 'Needs attention',
  critical: 'Critical',
};

export interface SecurityMetricProps {
  label: string;
  value: string | number;
  /** Supporting line, e.g. "3 sessions older than 30 days". */
  detail?: string;
  level?: SecurityLevel;
  icon?: IconName;
  className?: string;
}

/**
 * A single security posture reading for the Security Center.
 *
 * Never renders secret material — only counts, ages and states. Secrets are shown as metadata
 * only (see docs/SECURITY_DECISIONS.md).
 */
export function SecurityMetric({
  label,
  value,
  detail,
  level = 'ok',
  icon = 'shield',
  className,
}: SecurityMetricProps) {
  return (
    <div className={cn('uboss-secmetric', `uboss-secmetric--${level}`, className)}>
      <div className="uboss-secmetric-icon">
        <Icon name={icon} size={20} />
      </div>
      <div className="uboss-secmetric-body">
        <div className="uboss-secmetric-label">{label}</div>
        <div className="uboss-secmetric-value">{value}</div>
        {detail ? <div className="uboss-secmetric-detail">{detail}</div> : null}
      </div>
      <span className="uboss-sr-only">{LEVEL_LABEL[level]}</span>
    </div>
  );
}
