'use client';

import type { ReactNode } from 'react';
import { useId } from 'react';

import { cn } from '../lib/class-names';

export interface FilterOption {
  value: string;
  label: string;
}

export interface FilterSelectProps {
  label: string;
  value: string;
  options: FilterOption[];
  onChange: (value: string) => void;
  /** Hide the label visually; it stays available to assistive technology. */
  hideLabel?: boolean;
}

export function FilterSelect({
  label,
  value,
  options,
  onChange,
  hideLabel = true,
}: FilterSelectProps) {
  const id = useId();

  return (
    <>
      <label htmlFor={id} className={hideLabel ? 'uboss-sr-only' : undefined}>
        {label}
      </label>
      <select
        id={id}
        className="uboss-filter"
        value={value}
        onChange={(event) => onChange(event.target.value)}
      >
        {options.map((option) => (
          <option key={option.value} value={option.value}>
            {option.label}
          </option>
        ))}
      </select>
    </>
  );
}

export interface FilterBarProps {
  /** Search input, selects and toggles. */
  children: ReactNode;
  /** Right-aligned actions, e.g. a primary "Create" button. */
  actions?: ReactNode;
  className?: string;
}

/** Toolbar row that sits above a DataTable and owns its search, filters and actions. */
export function FilterBar({ children, actions, className }: FilterBarProps) {
  return (
    <div className={cn('uboss-toolbar', className)}>
      {children}
      {actions ? <div className="uboss-toolbar-right uboss-spread">{actions}</div> : null}
    </div>
  );
}
