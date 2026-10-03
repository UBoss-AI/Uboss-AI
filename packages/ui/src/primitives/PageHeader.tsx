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

  /*
   * Does this trail actually lead anywhere?
   *
   * Only crumbs before the last one can: the final crumb is the page you are on, and it is never
   * a link. A trail of one — `[{ label: 'Dashboard' }]` — is a label, not a route, and drawing it
   * inside the shell would restore the "it looks double" complaint for no benefit.
   */
  const leadsBack =
    breadcrumbs !== undefined &&
    breadcrumbs
      .slice(0, -1)
      .some((crumb) => crumb.href !== undefined || crumb.onSelect !== undefined);

  if (nameShownAbove) {
    /*
     * The trail comes back, and only when it is the way back.
     *
     * Suppressing the whole header inside the shell was right about the title and wrong about the
     * trail. The top bar names the section, so repeating it as a heading did look double — but the
     * trail is not a heading, it is the route out, and throwing it away left every sub-screen a
     * dead end. Objective → Workflow, Settings → Billing, Agent Builder → an assignment: each one
     * passed a working `href` and none of them drew it, so the only way back was the sidebar,
     * which returns you to the top of a section rather than to where you came from.
     *
     * That is the locked rule in `Breadcrumbs`' own note — no dead-end screens — and it had been
     * quietly broken for every screen inside a shell.
     */
    if ((actions === undefined || actions === null) && !leadsBack) return null;
    return (
      <div className={cn(className)}>
        {leadsBack ? <Breadcrumbs items={breadcrumbs} /> : null}
        {actions === undefined || actions === null ? null : (
          /* The actions keep their row and their alignment; only the title beside them is gone. */
          <div className="uboss-page-head uboss-page-head--actions-only">
            <div className="uboss-page-actions">{actions}</div>
          </div>
        )}
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
