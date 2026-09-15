import type { ButtonHTMLAttributes, ReactNode } from 'react';

import { cn } from '../lib/class-names';
import { Icon, type IconName } from './Icon';

/**
 * `danger` is the committed destructive action — a filled red button, which belongs on the confirm
 * step of a dialog. `danger-ghost` is the destructive action *offered* in a list, where a filled
 * red slab on every row makes a table of five people read as an emergency.
 */
export type ButtonVariant = 'default' | 'primary' | 'navy' | 'danger' | 'danger-ghost' | 'ghost';

export interface ButtonProps extends Omit<ButtonHTMLAttributes<HTMLButtonElement>, 'className'> {
  variant?: ButtonVariant;
  size?: 'md' | 'sm';
  /** Stretch to the full width of the container, for form and login actions. */
  block?: boolean;
  /** Leading icon. Decorative — the button label carries the meaning. */
  icon?: IconName;
  /**
   * The action this button started has not finished.
   *
   * Renders a spinner in place of the icon and sets `aria-busy`, which is both what a screen
   * reader announces and what the stylesheet keys off — so the state you can hear and the state
   * you can see are one attribute and cannot disagree.
   *
   * The label does not change. A button that becomes "Saving…" loses the word that said what it
   * does, and the width shifts under the pointer.
   */
  loading?: boolean;
  children?: ReactNode;
  className?: string;
}

const VARIANT_CLASS: Record<ButtonVariant, string | false> = {
  default: false,
  primary: 'uboss-btn--primary',
  navy: 'uboss-btn--navy',
  danger: 'uboss-btn--danger',
  'danger-ghost': 'uboss-btn--danger-ghost',
  ghost: 'uboss-btn--ghost',
};

export function Button({
  variant = 'default',
  size = 'md',
  block = false,
  icon,
  loading = false,
  children,
  className,
  type = 'button',
  'aria-busy': ariaBusy,
  ...rest
}: ButtonProps) {
  const busy = loading || ariaBusy === true || ariaBusy === 'true';

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
      // Only ever present when it is true. `aria-busy="false"` on every idle button is noise in
      // the accessibility tree, and `exactOptionalPropertyTypes` will not accept undefined here.
      {...(busy ? { 'aria-busy': true as const } : {})}
      {...rest}
    >
      {busy ? (
        // The spinner replaces the icon rather than joining it, so the label does not shift
        // sideways when the action starts.
        <span className="uboss-btn-spinner" aria-hidden="true" />
      ) : icon ? (
        <Icon name={icon} size={size === 'sm' ? 15 : 16} />
      ) : null}
      {children}
    </button>
  );
}
