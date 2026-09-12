import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';

import {
  mayMoveIncident,
  postmortemIsRequired,
  postmortemReadiness,
  TIMELINE_KINDS,
  type IncidentState,
  type TimelineKind,
} from '@uboss/types';

import { AuditEventService } from '../audit/audit-event.service.js';
import { PrismaService } from '../persistence/prisma.service.js';

export interface TimelineEntryView {
  id: string;
  kind: TimelineKind;
  note: string;
  occurredAt: string;
  authorUserId: string;
}

export interface CorrectiveActionView {
  id: string;
  description: string;
  state: string;
  ownerUserId: string;
  dueOn: string;
  completedAt: string | null;
  outcomeNote: string | null;
  /** True when it is open and its due date has passed. The figure a review reads first. */
  overdue: boolean;
}

/**
 * The incident workflow — Prompt 39, completing what Prompt 36 deliberately left open.
 *
 * `INCIDENT_WORKFLOW_BOUNDARY` said it in the product's own words: *"Prompt 36 records an incident
 * so System Health can show it… The timeline, postmortem and corrective actions belong to the
 * observability and incident-workflow prompt, which extends this record rather than adding a
 * second one."* This is that, and it extends `service_alerts`.
 *
 * ## Three rules that make an incident process worth having
 *
 * **A timeline is written, not derived.** The state changes are already in the audit trail. What an
 * audit trail cannot produce is "we thought it was the database, it was the connection pool" — and
 * that sentence is what a postmortem is written from.
 *
 * **A P0 or P1 cannot be resolved without a postmortem.** In the service and in a check
 * constraint, because *"we'll write it up later"* is the pressure this resists, and later never
 * comes once the incident is off the board.
 *
 * **A corrective action has an owner and a due date.** The commonest failure of an incident
 * process is a postmortem full of actions nobody agreed to do.
 */
@Injectable()
export class IncidentWorkflowService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly auditEvents: AuditEventService,
  ) {}

  // -------------------------------------------------------------------------
  // The timeline
  // -------------------------------------------------------------------------

  /**
   * Add an entry.
   *
   * `occurredAt` is a parameter and defaults to now, because **an operator catching up after an
   * outage backfills entries**. A timeline that only knew when each line was typed would misreport
   * the sequence of the very thing it exists to explain.
   */
  async addTimelineEntry(input: {
    alertId: string;
    actorUserId: string;
    kind: TimelineKind;
    note: string;
    occurredAt?: Date;
  }): Promise<TimelineEntryView> {
    if (!TIMELINE_KINDS.includes(input.kind)) {
      throw new BadRequestException(`"${input.kind}" is not a timeline entry kind.`);
    }
    if (input.note.trim() === '') {
      throw new BadRequestException(
        'Say what happened. An empty timeline entry is a timestamp nobody can read.',
      );
    }

    return this.prisma.runAsPlatformOperation(async () => {
      const incident = await this.requireIncident(input.alertId);

      const row = await this.prisma.client.incidentTimelineEntry.create({
        data: {
          serviceAlertId: incident.id,
          kind: input.kind,
          note: input.note.trim(),
          occurredAt: input.occurredAt ?? new Date(),
          authorUserId: input.actorUserId,
        },
      });

      return IncidentWorkflowService.toTimelineView(row);
    });
  }

  async timelineFor(alertId: string): Promise<TimelineEntryView[]> {
    const rows = await this.prisma.runAsPlatformOperation(() =>
      this.prisma.client.incidentTimelineEntry.findMany({
        where: { serviceAlertId: alertId },
        orderBy: { occurredAt: 'asc' },
      }),
    );
    return rows.map((row) => IncidentWorkflowService.toTimelineView(row));
  }

  // -------------------------------------------------------------------------
  // The postmortem
  // -------------------------------------------------------------------------

  /** Whether a postmortem can be written yet, and what is outstanding if not. */
  async readiness(alertId: string): Promise<ReturnType<typeof postmortemReadiness>> {
    return this.prisma.runAsPlatformOperation(async () => {
      const incident = await this.requireIncident(alertId);
      const entries = await this.prisma.client.incidentTimelineEntry.count({
        where: { serviceAlertId: alertId },
      });

      return postmortemReadiness({
        state: incident.state,
        timelineEntries: entries,
        severity: incident.incidentSeverity,
      });
    });
  }

  /**
   * Write the postmortem.
   *
   * Refused on an unresolved incident and on one with no timeline — see `postmortemReadiness` for
   * why each of those is a refusal rather than a warning.
   *
   * Note the ordering this implies: a P0 must be **resolved** before it can be post-mortemed, and
   * cannot be **resolved** without one. That is not a deadlock: `resolve` below performs both in
   * one transaction, which is the only way both rules can hold.
   */
  async writePostmortem(input: {
    alertId: string;
    actorUserId: string;
    postmortem: string;
  }): Promise<{ written: true }> {
    if (input.postmortem.trim().length < 50) {
      throw new BadRequestException(
        'A postmortem needs to say what happened, why, and what would have caught it sooner. ' +
          'Fifty characters is not a high bar and this is under it.',
      );
    }

    return this.prisma.runAsPlatformOperation(async () => {
      const incident = await this.requireIncident(input.alertId);

      const entries = await this.prisma.client.incidentTimelineEntry.count({
        where: { serviceAlertId: input.alertId },
      });
      const readiness = postmortemReadiness({
        // `resolve` writes both together, so a postmortem arriving on a `Mitigated` incident is
        // somebody using this route directly — and the readiness check is what tells them why not.
        state: incident.state,
        timelineEntries: entries,
        severity: incident.incidentSeverity,
      });

      if (!readiness.ready) {
        throw new ConflictException(readiness.reasons.join(' '));
      }

      await this.prisma.client.serviceAlert.update({
        where: { id: incident.id },
        data: {
          postmortem: input.postmortem.trim(),
          postmortemAt: new Date(),
          postmortemByUserId: input.actorUserId,
        },
      });

      return { written: true as const };
    });
  }

  /**
   * Resolve an incident, with its postmortem if one is required.
   *
   * **One transaction, because the two rules would otherwise deadlock**: a P0 cannot be resolved
   * without a postmortem (`serious_incident_is_post_mortemed_before_resolving`), and a postmortem
   * cannot be written on an unresolved incident (`postmortemReadiness`). Doing both at once is the
   * only order in which both hold, and it is also the right product behaviour — the write-up and
   * the closure are one act.
   */
  async resolve(input: {
    alertId: string;
    actorUserId: string;
    postmortem?: string;
  }): Promise<{ state: IncidentState; postmortemRequired: boolean }> {
    return this.prisma.runAsPlatformOperation(async () => {
      const incident = await this.requireIncident(input.alertId);

      if (!mayMoveIncident(incident.state as IncidentState, 'Resolved')) {
        throw new ConflictException(
          `An incident that is "${incident.state}" cannot be resolved.`,
        );
      }

      const required = postmortemIsRequired(incident.incidentSeverity);
      const postmortem = input.postmortem?.trim() ?? incident.postmortem ?? '';

      if (required && postmortem.length < 50) {
        throw new ConflictException(
          `A ${incident.incidentSeverity} cannot be resolved without a postmortem. §30 lists it ` +
            'as part of the incident, and the point of a severity scale is that the serious ones ' +
            'are treated differently — a P2 may close on its mitigation note alone.',
        );
      }

      const entries = await this.prisma.client.incidentTimelineEntry.count({
        where: { serviceAlertId: input.alertId },
      });
      if (required && entries === 0) {
        throw new ConflictException(
          'There is no timeline. A postmortem written from memory is how the same incident ' +
            'happens twice — record what happened first.',
        );
      }

      const now = new Date();
      const updated = await this.prisma.client.serviceAlert.update({
        where: { id: incident.id },
        data: {
          state: 'Resolved',
          resolvedAt: now,
          resolvedByUserId: input.actorUserId,
          ...(postmortem === ''
            ? {}
            : {
                postmortem,
                postmortemAt: incident.postmortemAt ?? now,
                postmortemByUserId: incident.postmortemByUserId ?? input.actorUserId,
              }),
        },
      });

      // A `Resolved` entry on the timeline, so the narrative ends where the record does.
      await this.prisma.client.incidentTimelineEntry.create({
        data: {
          serviceAlertId: incident.id,
          kind: 'Resolved',
          note:
            postmortem === ''
              ? 'Resolved.'
              : 'Resolved, with a postmortem.',
          occurredAt: now,
          authorUserId: input.actorUserId,
        },
      });

      return {
        state: updated.state as IncidentState,
        postmortemRequired: required,
      };
    });
  }

  // -------------------------------------------------------------------------
  // Corrective actions
  // -------------------------------------------------------------------------

  /** Add one. An owner and a due date are mandatory — see the model comment. */
  async addCorrectiveAction(input: {
    alertId: string;
    actorUserId: string;
    description: string;
    ownerUserId: string;
    dueOn: Date;
  }): Promise<CorrectiveActionView> {
    if (input.description.trim().length < 10) {
      throw new BadRequestException(
        'Say what will be done. "Improve monitoring" is not a corrective action.',
      );
    }

    return this.prisma.runAsPlatformOperation(async () => {
      const incident = await this.requireIncident(input.alertId);

      const row = await this.prisma.client.correctiveAction.create({
        data: {
          serviceAlertId: incident.id,
          description: input.description.trim(),
          state: 'Open',
          ownerUserId: input.ownerUserId,
          dueOn: input.dueOn,
          createdByUserId: input.actorUserId,
        },
      });

      return IncidentWorkflowService.toActionView(row, new Date());
    });
  }

  /**
   * Close an action — done, or deliberately dropped.
   *
   * A drop needs a reason and a completion does not. That asymmetry is deliberate: doing what you
   * said you would needs no explanation, and **deciding not to is the decision somebody will be
   * asked about.**
   */
  async closeCorrectiveAction(input: {
    actionId: string;
    actorUserId: string;
    state: 'Done' | 'Dropped';
    outcomeNote?: string;
  }): Promise<CorrectiveActionView> {
    const note = input.outcomeNote?.trim() ?? '';

    if (input.state === 'Dropped' && note === '') {
      throw new BadRequestException(
        'Say why this action is being dropped. Deciding not to fix something a postmortem ' +
          'identified needs a reason more than doing it does.',
      );
    }

    return this.prisma.runAsPlatformOperation(async () => {
      const existing = await this.prisma.client.correctiveAction.findUnique({
        where: { id: input.actionId },
      });
      if (existing === null) throw new NotFoundException('No such corrective action.');
      if (existing.state !== 'Open') {
        throw new ConflictException(`That action is already ${existing.state.toLowerCase()}.`);
      }

      const row = await this.prisma.client.correctiveAction.update({
        where: { id: existing.id },
        data: {
          state: input.state,
          completedAt: new Date(),
          completedByUserId: input.actorUserId,
          ...(note === '' ? {} : { outcomeNote: note }),
          version: { increment: 1 },
        },
      });

      return IncidentWorkflowService.toActionView(row, new Date());
    });
  }

  async actionsFor(alertId: string): Promise<CorrectiveActionView[]> {
    const now = new Date();
    const rows = await this.prisma.runAsPlatformOperation(() =>
      this.prisma.client.correctiveAction.findMany({
        where: { serviceAlertId: alertId },
        orderBy: [{ state: 'asc' }, { dueOn: 'asc' }],
      }),
    );
    return rows.map((row) => IncidentWorkflowService.toActionView(row, now));
  }

  /**
   * Every open action across every incident, oldest due date first.
   *
   * The list a weekly operations review reads. Overdue actions from closed incidents are the thing
   * an incident process quietly stops doing, and this is what makes that visible.
   */
  async openActions(now?: Date): Promise<CorrectiveActionView[]> {
    const at = now ?? new Date();
    const rows = await this.prisma.runAsPlatformOperation(() =>
      this.prisma.client.correctiveAction.findMany({
        where: { state: 'Open' },
        orderBy: { dueOn: 'asc' },
        take: 200,
      }),
    );
    return rows.map((row) => IncidentWorkflowService.toActionView(row, at));
  }

  // -------------------------------------------------------------------------
  // Internals
  // -------------------------------------------------------------------------

  private async requireIncident(alertId: string): Promise<{
    id: string;
    state: string;
    incidentSeverity: string | null;
    postmortem: string | null;
    postmortemAt: Date | null;
    postmortemByUserId: string | null;
  }> {
    const row = await this.prisma.client.serviceAlert.findUnique({
      where: { id: alertId },
      select: {
        id: true,
        state: true,
        incidentSeverity: true,
        postmortem: true,
        postmortemAt: true,
        postmortemByUserId: true,
      },
    });
    if (row === null) throw new NotFoundException('No such alert.');
    return row;
  }

  private static toTimelineView(row: {
    id: string;
    kind: string;
    note: string;
    occurredAt: Date;
    authorUserId: string;
  }): TimelineEntryView {
    return {
      id: row.id,
      kind: row.kind as TimelineKind,
      note: row.note,
      occurredAt: row.occurredAt.toISOString(),
      authorUserId: row.authorUserId,
    };
  }

  private static toActionView(
    row: {
      id: string;
      description: string;
      state: string;
      ownerUserId: string;
      dueOn: Date;
      completedAt: Date | null;
      outcomeNote: string | null;
    },
    now: Date,
  ): CorrectiveActionView {
    return {
      id: row.id,
      description: row.description,
      state: row.state,
      ownerUserId: row.ownerUserId,
      dueOn: row.dueOn.toISOString().slice(0, 10),
      completedAt: row.completedAt?.toISOString() ?? null,
      outcomeNote: row.outcomeNote,
      overdue: row.state === 'Open' && row.dueOn.getTime() < now.getTime(),
    };
  }
}
