import { Injectable } from '@nestjs/common';

import type { HierarchyResolver } from '@uboss/types';

import { OrganizationRepository } from '../persistence/organization.repository.js';

/**
 * The `HierarchyResolver` the authorization engine has been waiting for since Prompt 7.
 *
 * ## What this closes
 *
 * `TeamSubtree` scope could not be evaluated. `isInScope` returned `scope-unevaluable` — a
 * distinct denial, deliberately not a default either way (ADR-044) — so a `Manager` assignment
 * granted nothing at the row level. Known limitation 6 in `docs/IMPLEMENTATION_STATE.md`, from
 * Prompt 7 to Prompt 11 inclusive. With this provider registered, `TeamSubtree` resolves against
 * the reporting tree built this prompt.
 *
 * ## Why it is one recursive query
 *
 * This runs on **permission decisions**, so it runs on ordinary requests. Walking the tree in
 * application code would be one query per level; a recursive CTE is one round trip regardless of
 * depth. The index on `(tenant_id, reporting_manager_user_id)` exists for exactly this query.
 *
 * ## Fail-closed by construction
 *
 * The repository declares the tenant scope, so Row-Level Security applies. If the scope could
 * not be established the query returns no rows and this answers `false` — the subject is treated
 * as outside the manager's team. For an access decision, "no" is the safe answer, and the
 * scope declaration means it is also the correct one.
 *
 * ## A manager is inside their own subtree
 *
 * The useful reading for authorization: a `TeamSubtree` grant covers the manager's own work as
 * well as their reports'. A manager who could approve their team's work but not see their own
 * would be a strange thing to have built.
 */
@Injectable()
export class ReportingHierarchyResolver implements HierarchyResolver {
  constructor(private readonly organization: OrganizationRepository) {}

  async isInSubtree(input: {
    tenantId: string;
    managerUserId: string;
    subjectUserId: string;
  }): Promise<boolean> {
    return this.organization.isInReportingSubtree(input);
  }
}
