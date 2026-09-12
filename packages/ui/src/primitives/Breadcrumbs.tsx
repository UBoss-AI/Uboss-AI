'use client';

import { cn } from '../lib/class-names';

export interface Crumb {
  label: string;
  /** Omit on the final crumb — the current page is not a link. */
  href?: string;
  onSelect?: () => void;
}

export interface BreadcrumbsProps {
  items: Crumb[];
  className?: string;
}

/**
 * Breadcrumb trail.
 *
 * Locked rule (CR-01/3): no dead-end screens. Every detail screen must show where it sits and
 * offer the route back to its parent and list, which is what this provides.
 */
export function Breadcrumbs({ items, className }: BreadcrumbsProps) {
  if (items.length === 0) {
    return null;
  }

  return (
    <nav aria-label="Breadcrumb" className={cn('uboss-crumb', className)}>
      {items.map((item, index) => {
        const isLast = index === items.length - 1;

        return (
          <span key={`${item.label}-${index}`} className="uboss-spread" style={{ gap: 7 }}>
            {index > 0 ? (
              <span className="uboss-crumb-sep" aria-hidden="true">
                /
              </span>
            ) : null}
            {isLast ? (
              <span aria-current="page">{item.label}</span>
            ) : item.href ? (
              <a href={item.href}>{item.label}</a>
            ) : item.onSelect ? (
              <button type="button" onClick={item.onSelect}>
                {item.label}
              </button>
            ) : (
              <span>{item.label}</span>
            )}
          </span>
        );
      })}
    </nav>
  );
}
