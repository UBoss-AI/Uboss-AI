import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';

import {
  DEFAULT_SUPPORT_PRIORITY,
  mayMoveTicket,
  OPEN_TICKET_STATES,
  ticketIsOpen,
  type SupportPriority,
  type SupportTicketKind,
  type SupportTicketState,
} from '@uboss/types';

import { AuditEventService } from '../audit/audit-event.service.js';
import { AuthorizationService } from '../authorization/authorization.service.js';
import { PrismaService } from '../persistence/prisma.service.js';
import type { TenantScope } from '../persistence/tenant-context.js';
import { tenantScopeForPlatformOperation } from '../persistence/tenant-context.js';

export interface SupportTicketView {
  id: string;
  reference: number;
  subject: string;
  body: string;
  kind: SupportTicketKind;
  priority: SupportPriority;
  state: SupportTicketState;
  isOpen: boolean;
  raisedByUserId: string;
  assignedOperatorUserId: string | null;
  acknowledgedAt: string | null;
  resolvedAt: string | null;
  resolutionNote: string | null;
  closedAt: string | null;
  serviceAlertId: string | null;
  createdAt: string;
  version: number;
}

export interface SupportTicketNoteView {
  id: string;
  body: string;
  isInternal: boolean;
  authorUserId: string;
  authorIsOperator: boolean;
  createdAt: string;
}

/**
 * Support tickets — Prompt 36.
 *
 * §Support & Operations: *"Tickets, support access requests, issue history, service incidents and
 * operational notes."*
 *
 * ## Two audiences, one table, and the rule that separates them
 *
 * A company sees its own tickets and **only the notes marked as replies**. A UBoss operator sees
 * every company's tickets and every note. The separation is not a screen concern: `notesFor`
 * filters on `isInternal` by actor kind, and the default is internal — so an operator's working
 * note is private unless somebody deliberately shares it.
 *
 * ## A ticket cannot grant access
 *
 * `AccessRequest` is a *kind of conversation*, not a mechanism. When a ticket leads to somebody
 * reaching into the company, that is a break-glass session with its own reason, approval, scope
 * and expiry — and `BreakGlassRequest.supportTicketId` links the two in that direction only.
 * Nothing here widens anybody's access, which is why this service takes no part in authorization
 * beyond checking who may read a ticket.
 */
@Injectable()
export class SupportTicketService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly authorization: AuthorizationService,
    private readonly auditEvents: AuditEventService,
  ) {}

  // -------------------------------------------------------------------------
  // The company's side
  // -------------------------------------------------------------------------

  /**
   * Raise a ticket.
   *
   * `settings:View` — deliberately the lowest company grant there is. Asking UBoss for help is
   * not an administrative act, and a product where only an administrator can report a problem is
   * a product where problems go unreported.
   */
  async raise(input: {
    scope: TenantScope;
    actorUserId: string;
    subject: string;
    body: string;
    kind: SupportTicketKind;
    priority?: SupportPriority;
  }): Promise<SupportTicketView> {
    const context = await this.authorization.contextFor(input.scope, input.actorUserId);
    await this.authorization.assertCan(context, { module: 'settings', action: 'View' });

    if (input.subject.trim().length < 4) {
      throw new BadRequestException('A ticket needs a subject somebody can read in a list.');
    }
    if (input.body.trim().length < 10) {
      throw new BadRequestException(
        'Describe what happened. A ticket with no detail costs a round trip before anybody can ' +
          'start.',
      );
    }

    return this.prisma.runInTenantTransaction(input.scope, async () => {
      // Per-company sequence, computed inside the transaction. Under RLS this only ever sees this
      // company's rows, so two companies cannot collide and the unique index catches a race.
      const latest = await this.prisma.client.supportTicket.findFirst({
        where: { tenantId: input.scope.tenantId },
        orderBy: { reference: 'desc' },
        select: { reference: true },
      });

      const row = await this.prisma.client.supportTicket.create({
        data: {
          tenantId: input.scope.tenantId,
          reference: (latest?.reference ?? 0) + 1,
          subject: input.subject.trim(),
          body: input.body.trim(),
          kind: input.kind,
          priority: input.priority ?? DEFAULT_SUPPORT_PRIORITY,
          state: 'New',
          raisedByUserId: input.actorUserId,
        },
      });

      await this.auditEvents.appendWithinCurrentScope(input.scope.tenantId, {
        action: 'support.ticket_raised',
        resourceType: 'support-ticket',
        resourceId: row.id,
        actorUserId: input.actorUserId,
        summary: `Ticket #${row.reference}: ${row.subject}`,
        metadata: { kind: row.kind, priority: row.priority, reference: row.reference },
      });

      return SupportTicketService.toView(row);
    });
  }

  /** This company's tickets. */
  async listForCompany(input: {
    scope: TenantScope;
    actorUserId: string;
    includeClosed?: boolean;
  }): Promise<SupportTicketView[]> {
    const context = await this.authorization.contextFor(input.scope, input.actorUserId);
    await this.authorization.assertCan(context, { module: 'settings', action: 'View' });

    const rows = await this.prisma.runInTenantTransaction(input.scope, () =>
      this.prisma.client.supportTicket.findMany({
        where: {
          tenantId: input.scope.tenantId,
          ...(input.includeClosed === true ? {} : { state: { not: 'Closed' } }),
        },
        orderBy: [{ reference: 'desc' }],
        take: 200,
      }),
    );

    return rows.map((row) => SupportTicketService.toView(row));
  }

  /** Reply to a ticket as the company. Always visible to both sides — it is a reply. */
  async replyAsCompany(input: {
    scope: TenantScope;
    actorUserId: string;
    ticketId: string;
    body: string;
  }): Promise<SupportTicketNoteView> {
    const context = await this.authorization.contextFor(input.scope, input.actorUserId);
    await this.authorization.assertCan(context, { module: 'settings', action: 'View' });

    if (input.body.trim().length < 2) {
      throw new BadRequestException('An empty reply tells nobody anything.');
    }

    return this.prisma.runInTenantTransaction(input.scope, async () => {
      const ticket = await this.requireTicket(input.scope.tenantId, input.ticketId);
      if (!ticketIsOpen(ticket.state as SupportTicketState)) {
        throw new ConflictException(
          'That ticket is finished. Raise a new one referencing it rather than reopening a ' +
            'closed record.',
        );
      }

      const note = await this.prisma.client.supportTicketNote.create({
        data: {
          tenantId: input.scope.tenantId,
          supportTicketId: ticket.id,
          body: input.body.trim(),
          // A company's reply is never internal: they are one of the two audiences, so there is
          // nobody to hide it from.
          isInternal: false,
          authorUserId: input.actorUserId,
          authorIsOperator: false,
        },
      });

      // The company answering moves the ticket back into UBoss's queue. Without this, a ticket
      // parked on `WaitingOnCustomer` would stay there after they replied and nobody would see it.
      if (ticket.state === 'WaitingOnCustomer') {
        await this.prisma.client.supportTicket.update({
          where: { id: ticket.id },
          data: { state: 'InProgress', version: { increment: 1 } },
        });
      }

      return SupportTicketService.toNoteView(note);
    });
  }

  // -------------------------------------------------------------------------
  // The operator's side
  // -------------------------------------------------------------------------

  /**
   * The support queue across every company.
   *
   * Runs as a platform operation, which is how every Master Console read reaches tenant data and
   * is what the audit trail records. **It returns ticket metadata, not company content**: a
   * subject and a body the company wrote *to UBoss*, which is the one thing they did intend an
   * operator to read.
   */
  async listForOperator(filter: {
    state?: SupportTicketState;
    assignedOperatorUserId?: string;
    onlyOpen?: boolean;
    limit?: number;
  }): Promise<(SupportTicketView & { tenantId: string })[]> {
    const rows = await this.prisma.runAsPlatformOperation(() =>
      this.prisma.client.supportTicket.findMany({
        where: {
          ...(filter.state === undefined ? {} : { state: filter.state }),
          ...(filter.assignedOperatorUserId === undefined
            ? {}
            : { assignedOperatorUserId: filter.assignedOperatorUserId }),
          ...(filter.onlyOpen === true ? { state: { in: [...OPEN_TICKET_STATES] } } : {}),
        },
        orderBy: [{ priority: 'desc' }, { createdAt: 'asc' }],
        take: Math.min(filter.limit ?? 100, 300),
      }),
    );

    return rows.map((row) => ({ ...SupportTicketService.toView(row), tenantId: row.tenantId }));
  }

  /** One ticket, with its history, as an operator sees it: every note, internal ones included. */
  async operatorDetail(ticketId: string): Promise<{
    ticket: SupportTicketView & { tenantId: string };
    notes: SupportTicketNoteView[];
  }> {
    return this.prisma.runAsPlatformOperation(async () => {
      const ticket = await this.prisma.client.supportTicket.findUnique({
        where: { id: ticketId },
      });
      if (ticket === null) throw new NotFoundException('No such ticket.');

      const notes = await this.prisma.client.supportTicketNote.findMany({
        where: { supportTicketId: ticket.id },
        orderBy: { createdAt: 'asc' },
      });

      return {
        ticket: { ...SupportTicketService.toView(ticket), tenantId: ticket.tenantId },
        notes: notes.map((note) => SupportTicketService.toNoteView(note)),
      };
    });
  }

  /** The company's own view of a ticket's history: replies only, never internal notes. */
  async companyDetail(input: {
    scope: TenantScope;
    actorUserId: string;
    ticketId: string;
  }): Promise<{ ticket: SupportTicketView; notes: SupportTicketNoteView[] }> {
    const context = await this.authorization.contextFor(input.scope, input.actorUserId);
    await this.authorization.assertCan(context, { module: 'settings', action: 'View' });

    return this.prisma.runInTenantTransaction(input.scope, async () => {
      const ticket = await this.requireTicket(input.scope.tenantId, input.ticketId);

      const notes = await this.prisma.client.supportTicketNote.findMany({
        where: {
          tenantId: input.scope.tenantId,
          supportTicketId: ticket.id,
          // The whole separation, in one clause. Applied in the query rather than after it, so a
          // future change to the mapping cannot accidentally widen what comes back.
          isInternal: false,
        },
        orderBy: { createdAt: 'asc' },
      });

      return {
        ticket: SupportTicketService.toView(ticket),
        notes: notes.map((note) => SupportTicketService.toNoteView(note)),
      };
    });
  }

  /** Take a ticket, or hand it to somebody. */
  async assign(input: {
    ticketId: string;
    operatorUserId: string;
    actorUserId: string;
  }): Promise<SupportTicketView> {
    return this.prisma.runAsPlatformOperation(async () => {
      const ticket = await this.prisma.client.supportTicket.findUnique({
        where: { id: input.ticketId },
      });
      if (ticket === null) throw new NotFoundException('No such ticket.');

      const row = await this.prisma.client.supportTicket.update({
        where: { id: ticket.id },
        data: {
          assignedOperatorUserId: input.operatorUserId,
          ...(ticket.state === 'New'
            ? { state: 'Acknowledged', acknowledgedAt: new Date() }
            : {}),
          version: { increment: 1 },
        },
      });

      await this.auditEvents.appendWithinCurrentScope(ticket.tenantId, {
        action: 'support.ticket_assigned',
        resourceType: 'support-ticket',
        resourceId: ticket.id,
        actorUserId: input.actorUserId,
        summary: `Ticket #${ticket.reference} assigned.`,
        resourceVersion: row.version,
        metadata: { operatorUserId: input.operatorUserId },
      });

      return SupportTicketService.toView(row);
    });
  }

  /** Move a ticket along. The transition table decides, not the caller. */
  async transition(input: {
    ticketId: string;
    actorUserId: string;
    to: SupportTicketState;
    resolutionNote?: string;
  }): Promise<SupportTicketView> {
    return this.prisma.runAsPlatformOperation(async () => {
      const ticket = await this.prisma.client.supportTicket.findUnique({
        where: { id: input.ticketId },
      });
      if (ticket === null) throw new NotFoundException('No such ticket.');

      const from = ticket.state as SupportTicketState;
      if (!mayMoveTicket(from, input.to)) {
        throw new ConflictException(
          `A ticket that is "${from}" cannot become "${input.to}".` +
            (from === 'Closed' ? ' A closed ticket stays closed; raise a new one.' : ''),
        );
      }

      const needsNote = input.to === 'Resolved' || input.to === 'Closed';
      const note = input.resolutionNote?.trim() ?? ticket.resolutionNote ?? '';
      if (needsNote && note === '') {
        throw new BadRequestException(
          'Say what the answer was. "Resolved" with no explanation is not an answer to a company ' +
            'that asked a question, and it is the first thing a support review reads.',
        );
      }

      const now = new Date();
      const row = await this.prisma.client.supportTicket.update({
        where: { id: ticket.id },
        data: {
          state: input.to,
          ...(needsNote ? { resolutionNote: note } : {}),
          ...(input.to === 'Resolved' ? { resolvedAt: now } : {}),
          // Closing from `New` or `InProgress` skips `Resolved`, so the resolution timestamp has
          // to be filled in here too or `resolved_ticket_records_when` refuses the row.
          ...(input.to === 'Closed'
            ? { closedAt: now, resolvedAt: ticket.resolvedAt ?? now }
            : {}),
          ...(input.to === 'Acknowledged' && ticket.acknowledgedAt === null
            ? { acknowledgedAt: now }
            : {}),
          version: { increment: 1 },
        },
      });

      await this.auditEvents.appendWithinCurrentScope(ticket.tenantId, {
        action: 'support.ticket_state_changed',
        resourceType: 'support-ticket',
        resourceId: ticket.id,
        actorUserId: input.actorUserId,
        summary: `Ticket #${ticket.reference}: ${from} → ${input.to}.`,
        resourceVersion: row.version,
        metadata: { from, to: input.to, ...(needsNote ? { resolution: note } : {}) },
      });

      return SupportTicketService.toView(row);
    });
  }

  /**
   * Add a note as an operator.
   *
   * **`isInternal` defaults to true.** A reply to the company is a deliberate act, because the
   * cost of the two mistakes is not symmetric: a reply accidentally kept internal is a slow
   * answer, and an internal note accidentally shared is an operator's unguarded words in front of
   * a customer.
   */
  async addOperatorNote(input: {
    ticketId: string;
    actorUserId: string;
    body: string;
    isInternal?: boolean;
  }): Promise<SupportTicketNoteView> {
    if (input.body.trim().length < 2) {
      throw new BadRequestException('An empty note tells nobody anything.');
    }

    return this.prisma.runAsPlatformOperation(async () => {
      const ticket = await this.prisma.client.supportTicket.findUnique({
        where: { id: input.ticketId },
      });
      if (ticket === null) throw new NotFoundException('No such ticket.');

      const isInternal = input.isInternal ?? true;

      const note = await this.prisma.client.supportTicketNote.create({
        data: {
          tenantId: ticket.tenantId,
          supportTicketId: ticket.id,
          body: input.body.trim(),
          isInternal,
          authorUserId: input.actorUserId,
          authorIsOperator: true,
        },
      });

      // Only a visible reply is audited into the company's own trail — an internal note is UBoss
      // talking to itself, and putting it in the customer's audit trail would both leak it and
      // clutter the record they read.
      if (!isInternal) {
        await this.auditEvents.appendWithinCurrentScope(ticket.tenantId, {
          action: 'support.ticket_reply_sent',
          resourceType: 'support-ticket',
          resourceId: ticket.id,
          actorUserId: input.actorUserId,
          summary: `UBoss replied on ticket #${ticket.reference}.`,
        });
      }

      return SupportTicketService.toNoteView(note);
    });
  }

  /** Tie a ticket to a declared incident, so "how many companies did this affect" is answerable. */
  async linkToIncident(input: {
    ticketId: string;
    serviceAlertId: string | null;
    actorUserId: string;
  }): Promise<SupportTicketView> {
    return this.prisma.runAsPlatformOperation(async () => {
      const ticket = await this.prisma.client.supportTicket.findUnique({
        where: { id: input.ticketId },
      });
      if (ticket === null) throw new NotFoundException('No such ticket.');

      if (input.serviceAlertId !== null) {
        const alert = await this.prisma.client.serviceAlert.findUnique({
          where: { id: input.serviceAlertId },
          select: { id: true, incidentSeverity: true },
        });
        if (alert === null) throw new NotFoundException('No such incident.');
        if (alert.incidentSeverity === null) {
          throw new ConflictException(
            'That alert has not been declared an incident. Declare it first — linking tickets to ' +
              'an undeclared alert would report an incident nobody decided there was.',
          );
        }
      }

      const row = await this.prisma.client.supportTicket.update({
        where: { id: ticket.id },
        data: { serviceAlertId: input.serviceAlertId, version: { increment: 1 } },
      });

      await this.auditEvents.appendWithinCurrentScope(ticket.tenantId, {
        action: 'support.ticket_linked_to_incident',
        resourceType: 'support-ticket',
        resourceId: ticket.id,
        actorUserId: input.actorUserId,
        summary:
          input.serviceAlertId === null
            ? `Ticket #${ticket.reference} unlinked from its incident.`
            : `Ticket #${ticket.reference} linked to an incident.`,
        resourceVersion: row.version,
        metadata: { serviceAlertId: input.serviceAlertId ?? '' },
      });

      return SupportTicketService.toView(row);
    });
  }

  /** How many companies a declared incident is known to have affected. */
  async ticketsForIncident(serviceAlertId: string): Promise<{
    ticketCount: number;
    affectedTenantIds: string[];
  }> {
    const rows = await this.prisma.runAsPlatformOperation(() =>
      this.prisma.client.supportTicket.findMany({
        where: { serviceAlertId },
        select: { tenantId: true },
      }),
    );

    return {
      ticketCount: rows.length,
      affectedTenantIds: [...new Set(rows.map((row) => row.tenantId))],
    };
  }

  /** The queue figures the Master Console shows. */
  async queueSummary(): Promise<{
    open: number;
    waitingOnCustomer: number;
    unassigned: number;
    urgent: number;
  }> {
    return this.prisma.runAsPlatformOperation(async () => {
      const [open, waitingOnCustomer, unassigned, urgent] = await Promise.all([
        this.prisma.client.supportTicket.count({ where: { state: { in: [...OPEN_TICKET_STATES] } } }),
        this.prisma.client.supportTicket.count({ where: { state: 'WaitingOnCustomer' } }),
        this.prisma.client.supportTicket.count({
          where: { state: { in: [...OPEN_TICKET_STATES] }, assignedOperatorUserId: null },
        }),
        this.prisma.client.supportTicket.count({
          where: { state: { in: [...OPEN_TICKET_STATES] }, priority: 'Urgent' },
        }),
      ]);

      return { open, waitingOnCustomer, unassigned, urgent };
    });
  }

  /** The scope a platform caller uses to reach one company's rows for an audit write. */
  static scopeFor(tenantId: string): TenantScope {
    return tenantScopeForPlatformOperation(tenantId);
  }

  private async requireTicket(
    tenantId: string,
    ticketId: string,
  ): Promise<{
    id: string;
    tenantId: string;
    reference: number;
    subject: string;
    body: string;
    kind: string;
    priority: string;
    state: string;
    raisedByUserId: string;
    assignedOperatorUserId: string | null;
    acknowledgedAt: Date | null;
    resolvedAt: Date | null;
    resolutionNote: string | null;
    closedAt: Date | null;
    serviceAlertId: string | null;
    createdAt: Date;
    version: number;
  }> {
    const row = await this.prisma.client.supportTicket.findFirst({
      where: { tenantId, id: ticketId },
    });
    if (row === null) {
      throw new NotFoundException('That ticket does not exist in this company.');
    }
    return row;
  }

  private static toView(row: {
    id: string;
    reference: number;
    subject: string;
    body: string;
    kind: string;
    priority: string;
    state: string;
    raisedByUserId: string;
    assignedOperatorUserId: string | null;
    acknowledgedAt: Date | null;
    resolvedAt: Date | null;
    resolutionNote: string | null;
    closedAt: Date | null;
    serviceAlertId: string | null;
    createdAt: Date;
    version: number;
  }): SupportTicketView {
    return {
      id: row.id,
      reference: row.reference,
      subject: row.subject,
      body: row.body,
      kind: row.kind as SupportTicketKind,
      priority: row.priority as SupportPriority,
      state: row.state as SupportTicketState,
      isOpen: ticketIsOpen(row.state as SupportTicketState),
      raisedByUserId: row.raisedByUserId,
      assignedOperatorUserId: row.assignedOperatorUserId,
      acknowledgedAt: row.acknowledgedAt?.toISOString() ?? null,
      resolvedAt: row.resolvedAt?.toISOString() ?? null,
      resolutionNote: row.resolutionNote,
      closedAt: row.closedAt?.toISOString() ?? null,
      serviceAlertId: row.serviceAlertId,
      createdAt: row.createdAt.toISOString(),
      version: row.version,
    };
  }

  private static toNoteView(row: {
    id: string;
    body: string;
    isInternal: boolean;
    authorUserId: string;
    authorIsOperator: boolean;
    createdAt: Date;
  }): SupportTicketNoteView {
    return {
      id: row.id,
      body: row.body,
      isInternal: row.isInternal,
      authorUserId: row.authorUserId,
      authorIsOperator: row.authorIsOperator,
      createdAt: row.createdAt.toISOString(),
    };
  }
}
