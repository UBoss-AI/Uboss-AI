import type { ReactNode } from 'react';

import { cn } from '../lib/class-names';
import { Icon, type IconName } from './Icon';

export type ErrorStateKind = 'error' | 'permission-denied' | 'blocked' | 'degraded';

const KIND_CONFIG: Record<
  ErrorStateKind,
  { icon: IconName; iconClass: string; defaultTitle: string }
> = {
  error: {
    icon: 'alert',
    iconClass: 'uboss-state-icon--danger',
    defaultTitle: 'Something went wrong',
  },
  'permission-denied': {
    icon: 'shield',
    iconClass: 'uboss-state-icon--danger',
    defaultTitle: "You don't have access to this screen",
  },
  blocked: {
    icon: 'pause',
    iconClass: 'uboss-state-icon--warn',
    defaultTitle: 'This work is blocked',
  },
  degraded: {
    icon: 'alert',
    iconClass: 'uboss-state-icon--warn',
    defaultTitle: 'Showing partial data',
  },
};

export interface ErrorStateProps {
  kind?: ErrorStateKind | undefined;
  title?: string | undefined;
  description?: string | undefined;
  /**
   * Recovery actions. A permission-denied or error screen must always offer a route onward —
   * typically "Go to my dashboard" — so it is never a dead end.
   */
  actions?: ReactNode | undefined;
  className?: string | undefined;
}

/**
 * The error / permission-denied / blocked / degraded family.
 *
 * Permission denial is rendered as a first-class state rather than a redirect, so the user is
 * told what happened. Server-side authorization remains the enforcement point; this only
 * presents the outcome.
 */
export function ErrorState({
  kind = 'error',
  title,
  description,
  actions,
  className,
}: ErrorStateProps) {
  const config = KIND_CONFIG[kind];

  return (
    <div className={cn('uboss-state', className)} role={kind === 'error' ? 'alert' : undefined}>
      <div className={cn('uboss-state-icon', config.iconClass)}>
        <Icon name={config.icon} size={24} />
      </div>
      <h3>{title ?? config.defaultTitle}</h3>
      {description ? <p>{description}</p> : null}
      {actions ? <div className="uboss-state-actions">{actions}</div> : null}
    </div>
  );
}

export type BannerTone = 'info' | 'ok' | 'warn' | 'danger';

export interface BannerProps {
  tone?: BannerTone;
  children: ReactNode;
  className?: string;
}

/** Inline notice for confirmation, success, degraded and unsaved-changes messaging. */
export function Banner({ tone = 'info', children, className }: BannerProps) {
  const icon: IconName = tone === 'ok' ? 'check' : tone === 'info' ? 'shield' : 'alert';

  return (
    <div
      className={cn('uboss-banner', `uboss-banner--${tone}`, className)}
      role={tone === 'danger' ? 'alert' : 'status'}
    >
      <Icon name={icon} size={16} />
      <span>{children}</span>
    </div>
  );
}
