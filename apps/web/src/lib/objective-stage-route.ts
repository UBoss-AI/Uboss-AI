import type { ObjectiveStatus } from '@uboss/types';

/**
 * The screen an objective should open on, given where it has got to.
 *
 * ## The thing this fixes
 *
 * Every link to an objective went to `/objective/form`, whatever stage the objective was at. An
 * objective sitting in `WorkflowDraft` opened on Form 2 with its Submit button greyed out, and the
 * screen where the work actually was — the workflow — was two clicks away behind a button somebody
 * had to know to look for. The list said "Workflow Draft" in a badge and then took you somewhere
 * else.
 *
 * ## Why the published stages are deliberately unchanged
 *
 * Only the stages before publication are routed. From `Active` onwards an objective is a record
 * people are working to rather than a thing being assembled, and which screen is "where it is" is
 * a product question nobody has answered yet — closure, versions and the form are all defensible.
 * Guessing would move every live objective's link on a hunch, so those keep the behaviour they
 * have. See `docs/ui-ux-audit/design-audit-2026-10-14.md`.
 *
 * ## Why routes live here and not in `@uboss/types`
 *
 * The shared package models the lifecycle and knows nothing about this application's URLs. A route
 * table there would make the domain model depend on one front end's folder names.
 */
const STAGE_ROUTE: Partial<Record<ObjectiveStatus, string>> = {
  // Being written, or being read by a reviewer: Form 2 is the objective.
  Draft: '/objective/form',
  UnderReview: '/objective/form',
  // The run and its stages.
  AiAnalysis: '/objective/analyze',
  // The generated plan, which is the thing being edited at this stage.
  WorkflowDraft: '/objective/workflow',
  // The checks that stand between the plan and publication.
  ReadyForApproval: '/objective/prepublish',
};

/**
 * Where to send somebody opening this objective.
 *
 * Falls back to Form 2, which is where every link went before and is never wrong — only sometimes
 * further from the work than it could be.
 */
export function objectiveStageHref(objectiveId: string, status: ObjectiveStatus | null): string {
  const path = (status === null ? undefined : STAGE_ROUTE[status]) ?? '/objective/form';
  return `${path}?objectiveId=${encodeURIComponent(objectiveId)}`;
}

/**
 * Where a stage on the journey rail goes, or nothing if it is not somewhere to go.
 *
 * Two conditions, and both matter:
 *
 * **It must have a screen.** `Completed`, `Closed` and the rest have no destination of their own
 * yet, so they stay plain text rather than becoming links that land on Form 2 and leave somebody
 * wondering why clicking "Closed" showed them the objective definition.
 *
 * **It must have been reached.** Only `done`, `current` and `halted` are offered. An `upcoming`
 * stage is work that has not happened — a link to it would open a screen with nothing on it, and
 * worse, would read as a way of skipping ahead. `optional` is left out for the same reason: the
 * status cannot say whether the analysis was ever run, so the rail must not imply there is one to
 * look at.
 */
export function objectiveStageLink(
  objectiveId: string,
  status: ObjectiveStatus,
  state: 'done' | 'current' | 'halted' | 'upcoming' | 'optional',
): string | undefined {
  if (state !== 'done' && state !== 'current' && state !== 'halted') return undefined;

  const path = STAGE_ROUTE[status];
  if (path === undefined) return undefined;

  return `${path}?objectiveId=${encodeURIComponent(objectiveId)}`;
}
