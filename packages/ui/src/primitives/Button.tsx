import type { ButtonHTMLAttributes, ReactNode } from 'react';

import { cn } from '../lib/class-names';
import { Icon, type IconName } from './Icon';

export type ButtonVariant = 'default' | 'primary' | 'navy' | 'danger' | 'ghost';

export interface ButtonProps extends Omit<ButtonHTMLAttributes<HTMLButtonElement>, 'className'> {
  variant?: ButtonVariant;
  size?: 'md' | 'sm';
  /** Stretch to the full width of the container, for form and login actions. */
  block?: boolean;
  /** Leading icon. Decorative — the button label carries the meaning. */
  icon?: IconName;
  children?: ReactNode;
  className?: string;
}

const VARIANT_CLASS: Record<ButtonVariant, string | false> = {
  default: false,
  primary: 'uboss-btn--primary',
  navy: 'uboss-btn--navy',
  danger: 'uboss-btn--danger',
  ghost: 'uboss-btn--ghost',
};

export function Button({
  variant = 'default',
  size = 'md',
  block = false,
  icon,
  children,
  className,
  type = 'button',
  ...rest
}: ButtonProps) {
  return (
    <button
      // Default to `type="button"`: an unset type inside a form submits it, which is never
      // what a toolbar or dialog action wants.
      type={type}
      className={cn(
        'uboss-btn',
        VARIANT_CLASS[variant],
        size === 'sm' && 'uboss-btn--sm',
        block && 'uboss-btn--block',
        className,
      )}
      {...rest}
    >
      {icon ? <Icon name={icon} size={size === 'sm' ? 15 : 16} /> : null}
      {children}
    </button>
  );
}
