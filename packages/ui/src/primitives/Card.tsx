import type { HTMLAttributes, ReactNode } from 'react';

import { cn } from '../lib/class-names';

export interface CardProps extends HTMLAttributes<HTMLDivElement> {
  /** Apply the standard internal padding. Omit when the card holds a table or its own header. */
  padded?: boolean;
  children?: ReactNode;
}

export function Card({ padded = false, className, children, ...rest }: CardProps) {
  return (
    <div className={cn('uboss-card', padded && 'uboss-card-body', className)} {...rest}>
      {children}
    </div>
  );
}

// `title` is omitted from the DOM attributes because here it is the rendered heading content,
// not the HTML tooltip attribute (which only accepts a string).
export interface CardHeaderProps extends Omit<HTMLAttributes<HTMLDivElement>, 'title'> {
  title: ReactNode;
  /** Right-aligned slot for a badge, count or action. */
  aside?: ReactNode | undefined;
}

export function CardHeader({ title, aside, className, ...rest }: CardHeaderProps) {
  return (
    <div className={cn('uboss-card-head', className)} {...rest}>
      <h3>{title}</h3>
      {aside ? <div style={{ marginLeft: 'auto' }}>{aside}</div> : null}
    </div>
  );
}

export interface CardBodyProps extends HTMLAttributes<HTMLDivElement> {
  children?: ReactNode;
}

export function CardBody({ className, children, ...rest }: CardBodyProps) {
  return (
    <div className={cn('uboss-card-body', className)} {...rest}>
      {children}
    </div>
  );
}
