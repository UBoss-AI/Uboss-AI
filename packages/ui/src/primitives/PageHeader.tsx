'use client';

import type { ReactNode } from 'react';
import { useContext } from 'react';

import { cn } from '../lib/class-names';
import { PageNameShownAboveContext } from '../lib/page-name-context';
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

/**
 * A screen's heading, and the controls that belong to the screen as a whole.
 *
 * ## Why the heading can disappear
 *
 * Inside an application shell the top bar already names the section, so rendering the trail, the
 * title and the description here as well said the same thing twice on every single screen — the
 * client's words were that it "looks double". Inside a shell this therefore renders **only the
 * actions**; outside one it renders everything, as it always did.
 *
 * The props do not change and no caller has to choose. That matters more than it looks: 45 places
 * render this, and any rule that had to be repeated at each of them would be wrong at some of them
 * within a week. It also means the internal platform screens, which have no shell, keep their
 * headings without anybody having to remember that they are different.
 *
 * `title` is still required and still used — the shell shows the section name, and a page that
 * ends up outside a shell needs its own. It is not dead: it is the fallback, and the day a screen
 * is rendered somewhere unexpected is the day it matters.
 */
export function PageHeader({
  title,
  description,
  breadcrumbs,
  actions,
  className,
}: PageHeaderProps) {
  const nameShownAbove = useContext(PageNameShownAboveContext);

  if (nameShownAbove) {
    /*
     * Nothing at all when there is nothing to put here. An empty div still carries the page-head
     * rule's margin, which would leave a gap above the first card on every screen that has no
     * actions — which is most of them.
     */
    if (actions === undefined || actions === null) return null;
    return (
      <div className={cn(className)}>
        {/* The actions keep their row and their alignment; only the text beside them is gone. */}
        <div className="uboss-page-head uboss-page-head--actions-only">
          <div className="uboss-page-actions">{actions}</div>
        </div>
      </div>
    );
  }

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
