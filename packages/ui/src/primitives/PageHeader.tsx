import type { ReactNode } from 'react';

import { cn } from '../lib/class-names';
import { Breadcrumbs, type Crumb } from './Breadcrumbs';

export interface PageHeaderProps {
  title: string;
  description?: string;
  /** Breadcrumb trail rendered above the title. */
  breadcrumbs?: Crumb[];
  /** Right-aligned page actions. */
  actions?: ReactNode;
  className?: string;
}

export function PageHeader({
  title,
  description,
  breadcrumbs,
  actions,
  className,
}: PageHeaderProps) {
  return (
    <div className={cn(className)}>
      {breadcrumbs && breadcrumbs.length > 0 ? <Breadcrumbs items={breadcrumbs} /> : null}
      <div className="uboss-page-head">
        <div>
          <h1>{title}</h1>
          {description ? <p>{description}</p> : null}
        </div>
        {actions ? <div className="uboss-page-actions">{actions}</div> : null}
      </div>
    </div>
  );
}
