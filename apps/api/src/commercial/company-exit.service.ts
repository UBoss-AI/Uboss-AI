import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';

import {
  confirmationIsCorrect,
  decideCancellation,
  DEFAULT_READ_ONLY_DAYS,
  DEFAULT_RETENTION_DAYS,
  DETACH_BEFORE_DELETE,
  exitSchedule,
  EXPORT_EXCLUSIONS,
  EXPORT_SECTION_LABELS,
  EXPORT_SECTIONS,
  EXPORT_STANCE,
  mayMoveExit,
  tablesWithDisposition,
  windowProblems,
  type ExitState,
} from '@uboss/types';

import { AuditEventService } from '../audit/audit-event.service.js';
import { SECURITY_ACTIONS, SecurityEventPublisher } from '../auth/security-event.publisher.js';
import { PrismaService } from '../persistence/prisma.service.js';
import { CompanyLifecycleService } from './company-lifecycle.service.js';

export interface ExitView {
  id: string;
  tenantId: string;
  state: ExitState;
  reason: string;
  requestedByUserId: string;
  requestedAt: string;
  requestedByCustomer: boolean;
  approvedByUserId: string | null;
  approvedAt: string | null;
  readOnlyDays: number;
  retentionDays: number;
  readOnlyFrom: string | null;
  retentionFrom: string | null;
  deletionEligibleFrom: string | null;
  exportedAt: string | null;
  deletedAt: string | null;
  deletedRowCount: number | null;
  preservedRowCount: number | null;
  cancelledAt: string | null;
  cancellationReason: string | null;
  /** Whether it can still be stopped. The question everybody asks first. */
  cancellable: boolean;
  version: number;
}

/**
 * Company exit and data portability — Prompt 38.
 *
 * ## What this service does not rebuild
 *
 * `CompanyLifecycleService` (Prompt 11) already moves a company between `Active`, `ReadOnly` and
 * `Closed`, on a schedule, with a reason and a history — which is steps 3 and part of 5. This
 * service **drives** it. It does not re-implement a second lifecycle, and `beginReadOnly` calls
 * `transition` rather than writing `lifecycleState` itself.
 *
 * ## The deletion is selective, and the classification is the product
 *
 * `TABLE_DISPOSITION` says, for all 91 tenant-scoped tables, whether exit deletes them
 * (`Content`), preserves them as accountability (`Accountability`), or preserves them because they
 * belong to a person rather than the company (`PersonRecord`). An e2e test asserts the
 * classification is exhaustive against `information_schema`, so a table added by a later prompt
 * fails a test rather than defaulting into either bucket.
 *
 * ## Four things have to be true before anything is deleted
 *
 * The exit is in `RetentionHold`; the retention window has elapsed; the request was approved by
 * somebody other than the requester; and the operator has typed the company's own identifier. The
 * service checks all four and the database independently refuses a row that violates the second,
 * third or the certificate's completeness — because a service is a thing somebody eventually adds a
 * code path around, and "delete it now, the customer is on the phone" is exactly that pressure.
 */
@Injectable()
export class CompanyExitService {
  private readonly logger = new Logger(CompanyExitService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly auditEvents: AuditEventService,
    private readonly securityEvents: SecurityEventPublisher,
    private readonly lifecycle: CompanyLifecycleService,
  ) {}

  // -------------------------------------------------------------------------
  // Step 1 — request and approve
  // -------------------------------------------------------------------------

  async request(input: {
    tenantId: string;
    requestedByUserId: string;
    reason: string;
    requestedByCustomer?: boolean;
    readOnlyDays?: number;
    retentionDays?: number;
  }): Promise<ExitView> {
    if (input.reason.trim().length < 10) {
      throw new BadRequestException(
        'Say why the contract is ending. This is the field a dispute is argued from, and an exit ' +
          'nobody explained cannot be reviewed.',
      );
    }

    const readOnlyDays = input.readOnlyDays ?? DEFAULT_READ_ONLY_DAYS;
    const retentionDays = input.retentionDays ?? DEFAULT_RETENTION_DAYS;
    const problems = windowProblems({ readOnlyDays, retentionDays });
    if (problems.length > 0) throw new BadRequestException(problems);

    return this.prisma.runAsPlatformOperation(async () => {
      const tenant = await this.prisma.client.tenant.findUnique({
        where: { id: input.tenantId },
        select: { id: true, slug: true, lifecycleState: true },
      });
      if (tenant === null) throw new NotFoundException('No such company.');

      const open = await this.openExitFor(input.tenantId);
      if (open !== null) {
        throw new ConflictException(
          `This company already has an exit in progress (${open.state}). Cancel that one before ` +
            'raising another — two open exits would mean two answers to "when is our data deleted".',
        );
      }

      const row = await this.prisma.client.companyExit.create({
        data: {
          tenantId: input.tenantId,
          state: 'Requested',
          reason: input.reason.trim(),
          requestedByUserId: input.requestedByUserId,
          requestedByCustomer: input.requestedByCustomer ?? false,
          readOnlyDays,
          retentionDays,
        },
      });

      await this.trace(row.id, input.tenantId, {
        action: 'company_exit.requested',
        summary: `Contract end requested for ${tenant.slug}.`,
        reason: input.reason.trim(),
        actorUserId: input.requestedByUserId,
        metadata: {
          requestedByCustomer: input.requestedByCustomer ?? false,
          readOnlyDays,
          retentionDays,
        },
      });

      return CompanyExitService.toView(row);
    });
  }

  /**
   * Approve it, which computes and freezes the schedule.
   *
   * **Never the requester.** Checked here and by `exit_approver_is_not_the_requester`, because
   * ending a customer's contract and approving that decision are two people — the same rule as
   * break-glass and every other high-risk act here.
   */
  async approve(input: {
    exitId: string;
    approvedByUserId: string;
    note?: string;
    now?: Date;
  }): Promise<ExitView> {
    // **The separation-of-duties check runs before the transaction, and so does its event.**
    //
    // It used to live inside `runAsPlatformOperation` below: recording the refusal and then
    // throwing rolled the event back with it, so the control worked invisibly. That is the exact
    // bug Prompt 36 fixed for blocked break-glass activations, reintroduced here — and the test
    // caught it only because it asserts the event rather than the 403.
    const gate = await this.prisma.runAsPlatformOperation(() => this.require(input.exitId));

    if (gate.requestedByUserId === input.approvedByUserId) {
      await this.securityEvents.record({
        action: SECURITY_ACTIONS.companyExitSelfApprovalBlocked,
        actorUserId: input.approvedByUserId,
        tenantId: gate.tenantId,
        resourceType: 'company_exit',
        resourceId: gate.id,
        summary: 'An exit approval was refused because the approver raised the request.',
      });
      throw new ForbiddenException(
        'You raised this request, so you cannot approve it. Ending a customer’s contract needs ' +
          'a second person — the same rule as every other high-risk action in UBoss.',
      );
    }

    return this.prisma.runAsPlatformOperation(async () => {
      const exit = await this.require(input.exitId);
      this.assertMove(exit.state as ExitState, 'Approved');

      const approvedAt = input.now ?? new Date();
      const schedule = exitSchedule({
        approvedAt,
        readOnlyDays: exit.readOnlyDays,
        retentionDays: exit.retentionDays,
      });

      const row = await this.prisma.client.companyExit.update({
        where: { id: exit.id },
        data: {
          state: 'Approved',
          approvedByUserId: input.approvedByUserId,
          approvedAt,
          ...(input.note === undefined ? {} : { approvalNote: input.note }),
          // Computed once and stored. A company told "your data is deleted on 14 March" must not
          // see that date move because somebody changed a default.
          readOnlyFrom: schedule.readOnlyFrom,
          retentionFrom: schedule.retentionFrom,
          deletionEligibleFrom: schedule.deletionEligibleFrom,
          version: { increment: 1 },
        },
      });

      await this.trace(row.id, row.tenantId, {
        action: 'company_exit.approved',
        summary: `Contract end approved. Content becomes deletable on ${schedule.deletionEligibleFrom.toISOString().slice(0, 10)}.`,
        reason: input.note ?? null,
        actorUserId: input.approvedByUserId,
        metadata: {
          readOnlyFrom: schedule.readOnlyFrom.toISOString(),
          retentionFrom: schedule.retentionFrom.toISOString(),
          deletionEligibleFrom: schedule.deletionEligibleFrom.toISOString(),
        },
      });

      return CompanyExitService.toView(row);
    });
  }

  // -------------------------------------------------------------------------
  // Step 3 — the read-only period
  // -------------------------------------------------------------------------

  /**
   * Begin the read-only period.
   *
   * Moves the **company's** lifecycle to `ReadOnly` through `CompanyLifecycleService`, rather than
   * writing the column here. That service owns the transition table, the history and the
   * capability model the tenant guard consults on every request; a second writer would be a second
   * answer to "what does ReadOnly mean".
   */
  async beginReadOnly(input: { exitId: string; actorUserId: string }): Promise<ExitView> {
    const exit = await this.prisma.runAsPlatformOperation(() => this.require(input.exitId));
    this.assertMove(exit.state as ExitState, 'ReadOnly');

    // Outside the platform transaction: `CompanyLifecycleService.transition` opens its own.
    await this.lifecycle.transition({
      tenantId: exit.tenantId,
      toState: 'ReadOnly',
      reason: `Contract end: read-only period. ${exit.reason}`,
      actorUserId: input.actorUserId,
    });

    return this.prisma.runAsPlatformOperation(async () => {
      const row = await this.prisma.client.companyExit.update({
        where: { id: exit.id },
        data: { state: 'ReadOnly', version: { increment: 1 } },
      });

      await this.trace(row.id, row.tenantId, {
        action: 'company_exit.read_only_began',
        summary: 'The read-only period has begun. Everything can still be read and exported.',
        reason: null,
        actorUserId: input.actorUserId,
      });

      return CompanyExitService.toView(row);
    });
  }

  // -------------------------------------------------------------------------
  // Step 4 — the retention and legal-hold window
  // -------------------------------------------------------------------------

  /**
   * End access and start the retention window.
   *
   * The company's lifecycle goes to `Closed`, so nobody signs in. The content is still there, and
   * **this is the last point at which the exit can be cancelled** — which is why the window is
   * generous rather than a formality.
   */
  async beginRetentionHold(input: { exitId: string; actorUserId: string }): Promise<ExitView> {
    const exit = await this.prisma.runAsPlatformOperation(() => this.require(input.exitId));
    this.assertMove(exit.state as ExitState, 'RetentionHold');

    await this.lifecycle.transition({
      tenantId: exit.tenantId,
      toState: 'Closed',
      reason: `Contract end: access ended, retention window running. ${exit.reason}`,
      actorUserId: input.actorUserId,
    });

    return this.prisma.runAsPlatformOperation(async () => {
      const row = await this.prisma.client.companyExit.update({
        where: { id: exit.id },
        data: { state: 'RetentionHold', version: { increment: 1 } },
      });

      await this.trace(row.id, row.tenantId, {
        action: 'company_exit.retention_hold_began',
        summary:
          'Access has ended and the retention window is running. This is the last point at which ' +
          'the exit can be cancelled.',
        reason: null,
        actorUserId: input.actorUserId,
        metadata: {
          deletionEligibleFrom: row.deletionEligibleFrom?.toISOString() ?? '',
        },
      });

      return CompanyExitService.toView(row);
    });
  }

  // -------------------------------------------------------------------------
  // Steps 5, 6 and 7 — selective deletion and the certificate
  // -------------------------------------------------------------------------

  /**
   * Delete eligible content, preserve the rest, and write the certificate.
   *
   * Four gates, all of them checked: the state, the window, the second approval, and the typed
   * confirmation. Then one transaction that deletes every `Content` table in reverse dependency
   * order and counts what it removed.
   *
   * **The counts are taken before the delete**, table by table, because `DELETE` returns a count
   * per statement and a cascade can remove rows a later statement would have counted — so a
   * manifest built from delete results would under-report. The manifest is evidence, and evidence
   * that undercounts is worse than none.
   */
  async deleteContent(input: {
    exitId: string;
    actorUserId: string;
    typedConfirmation: string;
    now?: Date;
  }): Promise<ExitView> {
    const now = input.now ?? new Date();

    const exit = await this.prisma.runAsPlatformOperation(() => this.require(input.exitId));
    this.assertMove(exit.state as ExitState, 'Deleted');

    const tenant = await this.prisma.runAsPlatformOperation(() =>
      this.prisma.client.tenant.findUniqueOrThrow({
        where: { id: exit.tenantId },
        select: { slug: true, name: true },
      }),
    );

    // ---- Gate 1: the retention window ----
    if (exit.deletionEligibleFrom === null || exit.deletionEligibleFrom.getTime() > now.getTime()) {
      throw new ForbiddenException(
        `This company's content is not deletable until ${
          exit.deletionEligibleFrom?.toISOString().slice(0, 10) ?? 'the schedule is set'
        }. The retention window exists so that a customer who changes their mind can still be ` +
          'helped, and it is not skippable.',
      );
    }

    // ---- Gate 2: a second person approved ----
    if (exit.approvedByUserId === null) {
      throw new ForbiddenException('This exit was never approved.');
    }

    // ---- Gate 3: the typed confirmation ----
    if (!confirmationIsCorrect({ typed: input.typedConfirmation, tenantSlug: tenant.slug })) {
      await this.securityEvents.record({
        action: SECURITY_ACTIONS.companyExitConfirmationFailed,
        actorUserId: input.actorUserId,
        tenantId: exit.tenantId,
        resourceType: 'company_exit',
        resourceId: exit.id,
        summary: 'A content deletion was refused: the typed confirmation did not match.',
      });
      throw new BadRequestException(
        `To confirm, type the company's identifier exactly: "${tenant.slug}". This is deliberately ` +
          'not the word DELETE — typing DELETE is muscle memory, and typing the name of the ' +
          'company you are about to erase is a moment of attention.',
      );
    }

    // ---- Gate 4: no file is under a legal hold ----
    //
    // Prompt 35's rule, in its own words: a legal hold beats everything — *"not by retention, and
    // not by request"*. A company exit is a request. This is also the exit's own step 4, the
    // "retention/legal-hold window", so the check belongs here rather than being a happy accident.
    //
    // A **refusal** rather than a skip: deleting everything except the held files would leave the
    // company half-erased under a certificate implying otherwise.
    const held = await this.prisma.runAsPlatformOperation(() =>
      this.prisma.client.storedFile.count({
        where: { tenantId: exit.tenantId, onLegalHold: true, deletedAt: null },
      }),
    );

    if (held > 0) {
      throw new ForbiddenException(
        `${held} file${held === 1 ? ' is' : 's are'} under a legal hold in this company, so ` +
          'nothing can be deleted. A legal hold beats retention and beats a request — lift the ' +
          'holds first, and if they cannot be lifted then this company’s content cannot be ' +
          'deleted yet.',
      );
    }

    const contentTables = CompanyExitService.deletionOrder();

    return this.prisma.runAsPlatformOperation(async () => {
      const manifest: Record<string, number> = {};
      let deleted = 0;
      let detached = 0;

      // **Detach first.** Preserved rows that point at content being deleted have that pointer
      // nulled — an approval keeps what it decided and loses the link to the objective that is
      // gone. Without this the delete fails on a foreign key, which is how the database found
      // five of these in the first place.
      for (const { table, column } of DETACH_BEFORE_DELETE) {
        detached += await this.prisma.client.$executeRawUnsafe(
          `UPDATE "${table}" SET "${column}" = NULL
             WHERE "tenant_id" = $1::uuid AND "${column}" IS NOT NULL`,
          exit.tenantId,
        );
      }

      const retainedByPrivilege: Record<string, number> = {};
      let retained = 0;

      for (const table of contentTables) {
        // Counted first — see the method comment on why a manifest built from delete results
        // would under-report.
        const counted = await this.prisma.client.$queryRawUnsafe<{ count: bigint }[]>(
          `SELECT count(*)::bigint AS "count" FROM "${table}" WHERE "tenant_id" = $1::uuid`,
          exit.tenantId,
        );
        // The pg driver returns int8 as a decimal *string*; `Number` handles both it and a
        // bigint. Indexed rather than destructured because `noUncheckedIndexedAccess` is on and
        // an empty result here would be a silent zero.
        const rows = Number(counted[0]?.count ?? 0);
        if (rows === 0) continue;

        // **Checked before attempting.** Ten tenant tables are append-only by privilege (the
        // Prompt 8 tamper protection), and a `DELETE` that hits 42501 aborts the surrounding
        // transaction — taking the whole deletion with it. Asking first is the difference between
        // an honest partial deletion and no deletion at all.
        const allowed = await this.prisma.client.$queryRawUnsafe<{ may: boolean }[]>(
          `SELECT has_table_privilege(current_user, $1, 'DELETE') AS "may"`,
          table,
        );

        if (allowed[0]?.may !== true) {
          // Recorded, not silently skipped. A company asking "is it all gone" is entitled to the
          // truth, and a certificate that claimed otherwise would be the lie this whole prompt
          // exists to prevent.
          retainedByPrivilege[table] = rows;
          retained += rows;
          continue;
        }

        await this.prisma.client.$executeRawUnsafe(
          `DELETE FROM "${table}" WHERE "tenant_id" = $1::uuid`,
          exit.tenantId,
        );
        manifest[table] = rows;
        deleted += rows;
      }

      const preserved = await this.countPreserved(exit.tenantId);

      const row = await this.prisma.client.companyExit.update({
        where: { id: exit.id },
        data: {
          state: 'Deleted',
          deletedAt: now,
          deletedByUserId: input.actorUserId,
          // Both halves of the truth: what went, and what could not.
          deletionManifest: { deleted: manifest, retainedByPrivilege },
          deletedRowCount: deleted,
          preservedRowCount: preserved + retained,
          version: { increment: 1 },
        },
      });

      // Step 7. Written into the audit trail as well as onto the row, because the row is one
      // record and the trail is the one an auditor reads.
      await this.trace(row.id, row.tenantId, {
        action: 'company_exit.content_deleted',
        summary:
          `${deleted} rows of company content deleted for ${tenant.name}; ${preserved} rows ` +
          'preserved as accountability and person records' +
          (retained === 0
            ? '.'
            : `; ${retained} rows retained because they are append-only by database privilege.`),
        reason: exit.reason,
        actorUserId: input.actorUserId,
        metadata: {
          deletedRowCount: deleted,
          preservedRowCount: preserved,
          tablesEmptied: Object.keys(manifest).length,
          retainedRowCount: retained,
          tablesRetainedByPrivilege: Object.keys(retainedByPrivilege).length,
          // Preserved rows whose pointer into deleted content was nulled. Recorded because "why
          // does this approval have no objective" is a question somebody will ask.
          referencesDetached: detached,
        },
      });

      await this.securityEvents.recordWithinCurrentScope({
        action: SECURITY_ACTIONS.companyExitContentDeleted,
        actorUserId: input.actorUserId,
        tenantId: exit.tenantId,
        resourceType: 'company_exit',
        resourceId: exit.id,
        summary: `Company content deleted: ${deleted} rows.`,
        metadata: { deletedRowCount: deleted, preservedRowCount: preserved },
      });

      this.logger.warn(
        `Company exit ${exit.id}: deleted ${deleted} rows across ${Object.keys(manifest).length} tables.`,
      );

      return CompanyExitService.toView(row);
    });
  }

  // -------------------------------------------------------------------------
  // Step 2 — the permitted data export package
  // -------------------------------------------------------------------------

  /**
   * Produce the export package.
   *
   * §Prompt 38 asks for a *"permitted data export package"*, and **"permitted" is the operative
   * word**. This is not a database dump, for two concrete reasons rather than one aesthetic one:
   *
   *  * a dump carries identifiers from shared platform tables — `users`, `person_identifiers` —
   *    which belong to people and to other companies, not to this one;
   *  * a dump carries `connection_secrets`, and a secret never leaves UBoss in any form.
   *
   * So the package is a declared set of sections, each a narrow projection, with a **manifest that
   * states what is missing and why**. A customer reading it is entitled to know that file bytes and
   * the security trail are absent before they open the archive rather than after.
   *
   * Available at any state before `Deleted` — including during the read-only period, which is
   * what that period is *for*. After deletion there is nothing left to export, and the method says
   * so rather than returning an empty package.
   */
  async exportPackage(input: {
    exitId: string;
    actorUserId: string;
  }): Promise<{
    manifest: {
      companyName: string;
      producedAt: string;
      sections: { section: string; label: string; rows: number }[];
      exclusions: readonly { what: string; why: string }[];
      stance: string;
      totalRows: number;
    };
    data: Record<string, unknown[]>;
  }> {
    const exit = await this.prisma.runAsPlatformOperation(() => this.require(input.exitId));

    if (exit.state === 'Deleted') {
      throw new ConflictException(
        'This company’s content has been deleted, so there is nothing left to export. The export ' +
          'is available throughout the read-only period and the retention window, which is what ' +
          'those periods are for.',
      );
    }

    return this.prisma.runAsPlatformOperation(async () => {
      const tenantId = exit.tenantId;
      const tenant = await this.prisma.client.tenant.findUniqueOrThrow({
        where: { id: tenantId },
        select: { name: true, slug: true, lifecycleState: true, createdAt: true },
      });

      const data: Record<string, unknown[]> = {
        Company: [
          {
            name: tenant.name,
            slug: tenant.slug,
            lifecycleState: tenant.lifecycleState,
            createdAt: tenant.createdAt.toISOString(),
          },
        ],

        // People: employment facts and the roles they held. **No email, no phone** — those live on
        // `users`, a platform-plane table shared with every other company, and a company's export
        // is not a route to its people's contact details.
        People: (
          await this.prisma.client.employmentRecord.findMany({
            where: { tenantId },
            select: {
              userId: true,
              employeeId: true,
              designation: true,
              departmentId: true,
              reportingManagerUserId: true,
              joinedOn: true,
              endedAt: true,
              state: true,
            },
          })
        ).map((record) => ({
          ...record,
          joinedOn: record.joinedOn?.toISOString() ?? null,
          endedAt: record.endedAt?.toISOString() ?? null,
        })),

        Objectives: await this.prisma.client.objectiveVersion.findMany({
          where: { tenantId },
          select: {
            objectiveId: true,
            versionNumber: true,
            objectiveName: true,
            status: true,
            objectiveOwnerUserId: true,
            departmentId: true,
            createdAt: true,
          },
        }),

        Tasks: await this.prisma.client.humanTask.findMany({
          where: { tenantId },
          select: {
            objectiveId: true,
            title: true,
            assignedToUserId: true,
            status: true,
            dueAt: true,
            completedAt: true,
          },
        }),

        Agents: await this.prisma.client.engineAgent.findMany({
          where: { tenantId },
          select: { id: true, name: true, status: true, ownerUserId: true, createdAt: true },
        }),

        // Metadata only. The bytes are downloaded individually through the files screen, which
        // applies the scan and export-ceiling checks a bulk archive would bypass.
        Knowledge: await this.prisma.client.knowledgeSource.findMany({
          where: { tenantId },
          select: { name: true, kind: true, state: true, classification: true, accessScope: true },
        }),

        Approvals: await this.prisma.client.approvalRequest.findMany({
          where: { tenantId },
          select: {
            type: true,
            title: true,
            status: true,
            requestedByUserId: true,
            decidedByUserId: true,
            decidedAt: true,
            createdAt: true,
          },
        }),

        Performance: await this.prisma.client.performanceEvent.findMany({
          where: { tenantId },
          select: { subjectUserId: true, kind: true, points: true, occurredAt: true, reason: true },
        }),

        // The company's own record of what happened inside it. Exported deliberately: a customer
        // leaving is entitled to carry their audit trail, and it is the section a regulator asks
        // for first.
        AuditTrail: await this.prisma.client.auditEvent.findMany({
          where: { tenantId },
          orderBy: { occurredAt: 'asc' },
          take: 50_000,
          select: {
            occurredAt: true,
            action: true,
            resourceType: true,
            resourceId: true,
            actorUserId: true,
            summary: true,
            reason: true,
          },
        }),
      };

      const sections = EXPORT_SECTIONS.map((section) => ({
        section,
        label: EXPORT_SECTION_LABELS[section],
        rows: (data[section] ?? []).length,
      }));
      const totalRows = sections.reduce((total, section) => total + section.rows, 0);

      await this.prisma.client.companyExit.update({
        where: { id: exit.id },
        data: {
          exportedAt: new Date(),
          exportedByUserId: input.actorUserId,
          exportedRowCount: totalRows,
          version: { increment: 1 },
        },
      });

      await this.trace(exit.id, tenantId, {
        action: 'company_exit.exported',
        summary: `Export package produced: ${totalRows} rows across ${sections.length} sections.`,
        reason: null,
        actorUserId: input.actorUserId,
        metadata: { totalRows, sections: sections.length },
      });

      return {
        manifest: {
          companyName: tenant.name,
          producedAt: new Date().toISOString(),
          sections,
          // Stated up front, so nothing is discovered on opening the archive.
          exclusions: EXPORT_EXCLUSIONS,
          stance: EXPORT_STANCE,
          totalRows,
        },
        data,
      };
    });
  }

  // -------------------------------------------------------------------------
  // Cancellation
  // -------------------------------------------------------------------------

  async cancel(input: {
    exitId: string;
    actorUserId: string;
    reason: string;
    restoreTo?: 'Active' | 'ReadOnly';
  }): Promise<ExitView> {
    if (input.reason.trim().length < 4) {
      throw new BadRequestException(
        'Say why the exit is being stopped. Cancelling one is as consequential as starting it.',
      );
    }

    const exit = await this.prisma.runAsPlatformOperation(() => this.require(input.exitId));

    const decision = decideCancellation(exit.state as ExitState);
    if (!decision.mayCancel) {
      throw new ConflictException(decision.reason);
    }

    // **Cancelling stops the exit. It does not necessarily restore access.**
    //
    // Prompt 11 locks `Closed` as terminal through the lifecycle service — reopening a closed
    // company would restore access to data whose retention decision has already been made, and
    // that is a deliberate operation with its own review. Prompt 38 asks for cancellation
    // "where policy allows", and this is where the two meet:
    //
    //   * from `ReadOnly` the company is still `ReadOnly`, so it goes back to `Active`;
    //   * from `RetentionHold` the company is `Closed`, and it **stays** `Closed`. Nothing has
    //     been deleted — which is the entire value of the retention window — but somebody has to
    //     re-provision access as its own decision.
    //
    // The audit row says which happened, so nobody is left wondering why the company is still
    // shut.
    let accessRestored = false;
    if (exit.state === 'ReadOnly') {
      await this.lifecycle.transition({
        tenantId: exit.tenantId,
        toState: input.restoreTo ?? 'Active',
        reason: `Contract end cancelled. ${input.reason.trim()}`,
        actorUserId: input.actorUserId,
      });
      accessRestored = true;
    }

    return this.prisma.runAsPlatformOperation(async () => {
      const row = await this.prisma.client.companyExit.update({
        where: { id: exit.id },
        data: {
          state: 'Cancelled',
          cancelledAt: new Date(),
          cancelledByUserId: input.actorUserId,
          cancellationReason: input.reason.trim(),
          version: { increment: 1 },
        },
      });

      await this.trace(row.id, row.tenantId, {
        action: 'company_exit.cancelled',
        summary: accessRestored
          ? 'The contract end was cancelled and access was restored. Nothing was deleted.'
          : 'The contract end was cancelled. Nothing was deleted, and the company remains ' +
            'closed — restoring access is a separate decision.',
        reason: input.reason.trim(),
        actorUserId: input.actorUserId,
        metadata: { accessRestored },
      });

      return CompanyExitService.toView(row);
    });
  }

  // -------------------------------------------------------------------------
  // Reads
  // -------------------------------------------------------------------------

  async viewFor(tenantId: string): Promise<ExitView | null> {
    const row = await this.prisma.runAsPlatformOperation(() =>
      this.prisma.client.companyExit.findFirst({
        where: { tenantId },
        orderBy: { createdAt: 'desc' },
      }),
    );
    return row === null ? null : CompanyExitService.toView(row);
  }

  async byId(exitId: string): Promise<ExitView> {
    const row = await this.prisma.runAsPlatformOperation(() => this.require(exitId));
    return CompanyExitService.toView(row);
  }

  /** Exits whose retention window has elapsed and which are waiting for somebody to confirm. */
  async awaitingDeletion(now?: Date): Promise<ExitView[]> {
    const rows = await this.prisma.runAsPlatformOperation(() =>
      this.prisma.client.companyExit.findMany({
        where: {
          state: 'RetentionHold',
          deletionEligibleFrom: { lte: now ?? new Date() },
        },
        orderBy: { deletionEligibleFrom: 'asc' },
      }),
    );
    return rows.map((row) => CompanyExitService.toView(row));
  }

  // -------------------------------------------------------------------------
  // Internals
  // -------------------------------------------------------------------------

  /**
   * The `Content` tables, in an order that respects foreign keys.
   *
   * Child tables first. Most of these would cascade from their parent, but relying on a cascade
   * means the manifest under-reports — a row removed by a cascade is a row this method did not
   * count, and the manifest is the certificate's evidence.
   *
   * The order is derived from `tablesWithDisposition('Content')` and then adjusted for the handful
   * of tables whose parent is also `Content`. Anything left over is deleted last, which is safe
   * because every `Content` table is tenant-scoped and the whole tenant's rows go together.
   */
  private static deletionOrder(): string[] {
    const content = new Set(tablesWithDisposition('Content'));

    // Children before parents, for the ones where both sides are `Content`. Not exhaustive by
    // hand — the fallback below catches the rest — but it keeps the common cases from relying on
    // a cascade and so keeps the manifest honest.
    const first = [
      'human_task_evidence',
      'human_task_notes',
      'human_tasks',
      'agent_run_events',
      'agent_runs',
      'ai_output_feedback',
      'memory_records',
      'executor_exception_events',
      'executor_exceptions',
      'knowledge_source_files',
      'knowledge_sources',
      'files',
      'connection_checks',
      'connection_tool_grants',
      'connection_secrets',
      'connections',
      'skill_regression_comparisons',
      'skill_evaluation_runs',
      'skill_evaluation_cases',
      'skill_candidates',
      'skill_transitions',
      'skill_versions',
      'skills',
      'objective_workflow_steps',
      'objective_workflow_drafts',
      'objective_analysis_runs',
      'objective_outcome_reviews',
      'objective_pauses',
      'objective_rewards',
      'ai_work_assignments',
      'engine_agent_versions',
      'engine_agents',
      'objective_versions',
      'objectives',
      'budget_reservation_holds',
      'budget_reservations',
      'model_gateway_calls',
      'logical_model_routes',
      'provider_models',
      'pricing_versions',
      'provider_profiles',
      'user_group_members',
      'user_groups',
      'sso_auth_requests',
      'sso_connections',
      'departments',
    ].filter((table) => content.has(table));

    const rest = [...content].filter((table) => !first.includes(table)).sort();
    return [...first, ...rest];
  }

  /** How many rows survive, so the certificate can state both halves. */
  private async countPreserved(tenantId: string): Promise<number> {
    const preserved = [
      ...tablesWithDisposition('Accountability'),
      ...tablesWithDisposition('PersonRecord'),
    ];

    let total = 0;
    for (const table of preserved) {
      const counted = await this.prisma.client.$queryRawUnsafe<{ count: bigint }[]>(
        `SELECT count(*)::bigint AS "count" FROM "${table}" WHERE "tenant_id" = $1::uuid`,
        tenantId,
      );
      total += Number(counted[0]?.count ?? 0);
    }
    return total;
  }

  private async openExitFor(tenantId: string): Promise<{ state: string } | null> {
    return this.prisma.client.companyExit.findFirst({
      where: { tenantId, state: { notIn: ['Deleted', 'Cancelled'] } },
      select: { state: true },
    });
  }

  private async require(exitId: string): Promise<{
    id: string;
    tenantId: string;
    state: string;
    reason: string;
    requestedByUserId: string;
    requestedAt: Date;
    requestedByCustomer: boolean;
    approvedByUserId: string | null;
    approvedAt: Date | null;
    readOnlyDays: number;
    retentionDays: number;
    readOnlyFrom: Date | null;
    retentionFrom: Date | null;
    deletionEligibleFrom: Date | null;
    exportedAt: Date | null;
    deletedAt: Date | null;
    deletedRowCount: number | null;
    preservedRowCount: number | null;
    cancelledAt: Date | null;
    cancellationReason: string | null;
    version: number;
  }> {
    const row = await this.prisma.client.companyExit.findUnique({ where: { id: exitId } });
    if (row === null) throw new NotFoundException('No such exit.');
    return row;
  }

  private assertMove(from: ExitState, to: ExitState): void {
    if (!mayMoveExit(from, to)) {
      throw new ConflictException(
        `An exit that is "${from}" cannot become "${to}".` +
          (from === 'Deleted' ? ' The content is already gone, and that cannot be undone.' : ''),
      );
    }
  }

  /** One audit row per step, in the company's own trail. */
  private async trace(
    exitId: string,
    tenantId: string,
    detail: {
      action: string;
      summary: string;
      reason: string | null;
      actorUserId: string;
      metadata?: Record<string, string | number | boolean | null>;
    },
  ): Promise<void> {
    await this.auditEvents.appendWithinCurrentScope(tenantId, {
      action: detail.action,
      resourceType: 'company_exit',
      resourceId: exitId,
      actorUserId: detail.actorUserId,
      summary: detail.summary,
      ...(detail.reason === null ? {} : { reason: detail.reason }),
      ...(detail.metadata === undefined ? {} : { metadata: detail.metadata }),
    });
  }

  private static toView(row: {
    id: string;
    tenantId: string;
    state: string;
    reason: string;
    requestedByUserId: string;
    requestedAt: Date;
    requestedByCustomer: boolean;
    approvedByUserId: string | null;
    approvedAt: Date | null;
    readOnlyDays: number;
    retentionDays: number;
    readOnlyFrom: Date | null;
    retentionFrom: Date | null;
    deletionEligibleFrom: Date | null;
    exportedAt: Date | null;
    deletedAt: Date | null;
    deletedRowCount: number | null;
    preservedRowCount: number | null;
    cancelledAt: Date | null;
    cancellationReason: string | null;
    version: number;
  }): ExitView {
    const state = row.state as ExitState;
    return {
      id: row.id,
      tenantId: row.tenantId,
      state,
      reason: row.reason,
      requestedByUserId: row.requestedByUserId,
      requestedAt: row.requestedAt.toISOString(),
      requestedByCustomer: row.requestedByCustomer,
      approvedByUserId: row.approvedByUserId,
      approvedAt: row.approvedAt?.toISOString() ?? null,
      readOnlyDays: row.readOnlyDays,
      retentionDays: row.retentionDays,
      readOnlyFrom: row.readOnlyFrom?.toISOString() ?? null,
      retentionFrom: row.retentionFrom?.toISOString() ?? null,
      deletionEligibleFrom: row.deletionEligibleFrom?.toISOString() ?? null,
      exportedAt: row.exportedAt?.toISOString() ?? null,
      deletedAt: row.deletedAt?.toISOString() ?? null,
      deletedRowCount: row.deletedRowCount,
      preservedRowCount: row.preservedRowCount,
      cancelledAt: row.cancelledAt?.toISOString() ?? null,
      cancellationReason: row.cancellationReason,
      cancellable: decideCancellation(state).mayCancel,
      version: row.version,
    };
  }
}
