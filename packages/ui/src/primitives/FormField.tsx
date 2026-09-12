'use client';

import type { ReactNode } from 'react';
import { useId } from 'react';

import { cn } from '../lib/class-names';
import { Icon } from './Icon';

export interface FormFieldProps {
  label: string;
  /** Marks the field visually and sets `aria-required` on the control. */
  required?: boolean | undefined;
  /** Helper text shown below the control. */
  hint?: string | undefined;
  /** Validation message. Its presence puts the field into the invalid state. */
  error?: string | undefined;
  /**
   * Render the control. Receives the wiring it must spread onto the input/select/textarea so
   * label association and error announcement are never forgotten.
   */
  children: (props: {
    id: string;
    'aria-describedby': string | undefined;
    'aria-invalid': boolean | undefined;
    'aria-required': boolean | undefined;
  }) => ReactNode;
  className?: string | undefined;
}

/**
 * Field wrapper owning label association, hint text and the error state.
 *
 * The render-prop shape is deliberate: it makes it impossible to render a labelled field whose
 * control is not actually associated with the label or its error message.
 */
export function FormField({
  label,
  required = false,
  hint,
  error,
  children,
  className,
}: FormFieldProps) {
  const id = useId();
  const hintId = `${id}-hint`;
  const errorId = `${id}-error`;

  const describedBy =
    [error ? errorId : undefined, hint ? hintId : undefined].filter(Boolean).join(' ') || undefined;

  return (
    <div className={cn('uboss-field', error && 'uboss-field--invalid', className)}>
      <label htmlFor={id}>
        {label}
        {required ? (
          <span className="uboss-field-required" aria-hidden="true">
            *
          </span>
        ) : null}
      </label>

      {children({
        id,
        'aria-describedby': describedBy,
        'aria-invalid': error ? true : undefined,
        'aria-required': required ? true : undefined,
      })}

      {hint ? (
        <p id={hintId} className="uboss-field-hint">
          {hint}
        </p>
      ) : null}

      {error ? (
        <p id={errorId} className="uboss-field-error" role="alert">
          <Icon name="alert" size={13} />
          {error}
        </p>
      ) : null}
    </div>
  );
}
