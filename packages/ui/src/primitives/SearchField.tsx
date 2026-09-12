'use client';

import type { InputHTMLAttributes } from 'react';
import { useId } from 'react';

import { cn } from '../lib/class-names';
import { Icon } from './Icon';

export interface SearchFieldProps extends Omit<
  InputHTMLAttributes<HTMLInputElement>,
  'type' | 'className'
> {
  /** Accessible label. Always required — a placeholder is not a label. */
  label: string;
  /** Hide the label visually while keeping it available to assistive technology. */
  hideLabel?: boolean;
  /** Compact variant used inside a table toolbar. */
  mini?: boolean;
  className?: string;
}

export function SearchField({
  label,
  hideLabel = true,
  mini = false,
  className,
  id,
  ...rest
}: SearchFieldProps) {
  const generatedId = useId();
  const inputId = id ?? generatedId;

  return (
    <div className={cn('uboss-search', mini && 'uboss-search--mini', className)}>
      <label htmlFor={inputId} className={hideLabel ? 'uboss-sr-only' : undefined}>
        {label}
      </label>
      <span className="uboss-search-icon">
        <Icon name="search" size={mini ? 15 : 16} />
      </span>
      <input id={inputId} type="search" {...rest} />
    </div>
  );
}
