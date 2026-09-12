import type { ReactNode } from 'react';

import { cn } from '../lib/class-names';
import { Icon, type IconName } from './Icon';

export interface EmptyStateProps {
  title: string;
  description?: string | undefined;
  icon?: IconName | undefined;
  /**
   * Primary next action. Locked rule (CR-01/3): no dead-end screens — an empty state should
   * offer a way forward or back, not just report emptiness.
   */
  actions?: ReactNode | undefined;
  className?: string | undefined;
}

export function EmptyState({
  title,
  description,
  icon = 'list',
  actions,
  className,
}: EmptyStateProps) {
  return (
    <div className={cn('uboss-state', className)}>
      <div className="uboss-state-icon">
        <Icon name={icon} size={22} />
      </div>
      <h3>{title}</h3>
      {description ? <p>{description}</p> : null}
      {actions ? <div className="uboss-state-actions">{actions}</div> : null}
    </div>
  );
}
