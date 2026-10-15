import { Injectable } from '@nestjs/common';

import { mayTransitionObjective, type ObjectiveStatus } from '@uboss/types';

import { AuditEventService } from '../audit/audit-event.service.js';
import { PrismaService } from '../persistence/prisma.service.js';
import type { TenantScope } from '../persistence/tenant-context.js';

/**
 * What a decision on an `ObjectiveReview` does to the objective it was about.
 *
 * ## Why this is its own service and not a method on `ObjectiveService`
 *
 * `ObjectiveService.submitForReview` raises the request, so it depends on `ApprovalService`. The
 * decision has to travel the other way — the Approval Engine is where a Head says yes or no, and
 * something must then move the objective. Putting that on `ObjectiveService` would make the two
 * services import each other, which Nest can be told to tolerate and a reader cannot.
 *
 * So this is the one-way half, exactly as `HumanTaskService` and `WorkReleaseService` already are
 * for their own loops: it knows nothing about approvals, takes a decision that has already been
 * made, and applies it. The note on `ApprovalService`'s constructor says the same thing about
 * those two, and the reason is the same here.
 *
 * ## Why there is no "approved" column
 *
 * An approved request **is** the fact. Writing `reviewApprovedAt` onto the version as well would
 * be two records of one decision, free to disagree the moment a request is superseded or a
 * delegation is revoked — and `EngineAgentService.activate` already shows the other way round:
 * it looks the request up and checks it, rather than trusting a flag somebody set. Approving a
 * review therefore writes nothing here at all; only a refusal moves the objective, because a
 * refusal has somewhere to send it.
 */
@Injectable()
export class ObjectiveReviewService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly auditEvents: AuditEventService,
  ) {}

  /**
   * Send an objective back to its author after a Head refused the review.
   *
   * Must be called inside a tenant transaction: the decision and the objective's state commit
   * together, so a crash between them cannot leave a refused review beside a version still
   * sitting in somebody's review queue.
   *
   * Returns false when there was nothing to do, which is not a failure — the version may have
   * been archived, or sent back already by the author withdrawing it, and a decision recorded
   * against a version that has moved on is still a decision worth recording.
   */
  async sendBackWithinTransaction(input: {
    tenantId: string;
    objectiveVersionId: string;
    actorUserId: string;
    reason: string;
  }): Promise<boolean> {
    const version = await this.prisma.client.objectiveVersion.findFirst({
      where: { tenantId: input.tenantId, id: input.objectiveVersionId },
      include: { objective: { select: { id: true, code: true } } },
    });

    if (!version) return false;

    /*
     * The transition table decides, not this service.
     *
     * `UnderReview -> Draft` is the move a refusal makes, and it is already permitted. Asking the
     * table rather than checking the status by hand is what stops a refusal on an archived or
     * already-published version from dragging it backwards.
     */
    if (!mayTransitionObjective(version.status as ObjectiveStatus, 'Draft')) return false;

    await this.prisma.client.objectiveVersion.update({
      where: { id: version.id },
      data: {
        status: 'Draft',
        sentBackAt: new Date(),
        sentBackByUserId: input.actorUserId,
        sentBackReason: input.reason,
        version: { increment: 1 },
      },
    });

    await this.auditEvents.appendWithinCurrentScope(input.tenantId, {
      action: 'objective.sent_back',
      resourceType: 'objective',
      resourceId: version.objective.id,
      actorUserId: input.actorUserId,
      resourceRef: `${version.objective.code} V${version.versionNumber}`,
      resourceVersion: version.version,
      summary: `Refused the review of V${version.versionNumber} and sent it back for changes.`,
      metadata: { versionId: version.id, versionNumber: version.versionNumber },
    });

    return true;
  }

  /**
   * Has this version's review been approved?
   *
   * Asked of the approval record itself, which is the only place the decision lives. Every clause
   * is a way a request could look approving and not be: a decision on a different version, an
   * approval of a different kind of thing, or one that was superseded after being sent back.
   */
  async reviewApprovalOf(
    scope: TenantScope,
    objectiveVersionId: string,
  ): Promise<{ id: string; decidedByUserId: string | null } | null> {
    const approved = await this.prisma.client.approvalRequest.findFirst({
      where: {
        tenantId: scope.tenantId,
        type: 'ObjectiveReview',
        objectiveVersionId,
        status: 'Approved',
      },
      orderBy: { createdAt: 'desc' },
      select: { id: true, decidedByUserId: true },
    });

    return approved ?? null;
  }
}
