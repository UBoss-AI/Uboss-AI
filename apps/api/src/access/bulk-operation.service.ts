import {
  BadRequestException,
  ConflictException,
  Injectable,
  Logger,
  Optional,
} from '@nestjs/common';

import { AuditEventService } from '../audit/audit-event.service.js';
import { FileService } from '../knowledge/file.service.js';
import { EmployeePhotoService } from '../organization/employee-photo.service.js';
import { SECURITY_ACTIONS, SecurityEventPublisher } from '../auth/security-event.publisher.js';
import {
  AuthorizationService,
  type AuthorizationContext,
} from '../authorization/authorization.service.js';
import type { BulkOperation, BulkOperationKind } from '../generated/prisma/client.js';
import { normaliseAadhaar } from '../organization/aadhaar.js';
import { DepartmentService } from '../organization/department.service.js';
import { EmploymentService } from '../organization/employment.service.js';
import type { HierarchyReference } from '../organization/hierarchy-workbook.js';
import { AccessRepository } from '../persistence/access.repository.js';
import { OrganizationRepository } from '../persistence/organization.repository.js';
import { TenantMembershipRepository } from '../persistence/tenant-membership.repository.js';
import { UserRepository } from '../persistence/user.repository.js';
import { PrismaService } from '../persistence/prisma.service.js';
import type { TenantScope } from '../persistence/tenant-context.js';
import { InvitationAccessService } from './invitation-access.service.js';
import { OffboardingService } from './offboarding.service.js';
import { UserAccessService } from './user-access.service.js';

/** A hard ceiling on rows per operation. */
/**
 * The mark on a photograph that arrived inside an import spreadsheet -- PRD 3.1.
 *
 * Distinct from the company-identity pictures, because these are transient: they exist between a
 * validation and the apply that consumes them, and an import that is cancelled leaves them with
 * nothing pointing at them. The mark is what a retention sweep would find them by.
 */
const IMPORT_PHOTO_PURPOSE = 'ImportPhoto';

export const MAX_BULK_ROWS = 5000;

/** The action each bulk kind requires. One table, so no call site can pick the wrong one. */
export const BULK_PERMISSIONS: Record<
  BulkOperationKind,
  { module: 'users' | 'roles' | 'hierarchy'; action: 'Administer' | 'ManageAccess' }
> = {
  ImportEmployees: { module: 'hierarchy', action: 'Administer' },
  InviteOrResend: { module: 'users', action: 'ManageAccess' },
  RoleAndScope: { module: 'roles', action: 'ManageAccess' },
  ManagerOrDepartment: { module: 'hierarchy', action: 'Administer' },
  SuspendOrOffboard: { module: 'users', action: 'ManageAccess' },
};

export interface BulkPreview {
  operationId: string;
  kind: BulkOperationKind;
  state: string;
  totalRows: number;
  validRows: number;
  invalidRows: number;
  /** Every row, with its errors. The client asks for per-row errors and this is them. */
  rows: {
    rowNumber: number;
    state: string;
    input: Record<string, unknown>;
    errors: string[];
  }[];
  /** What applying would do, in words, before anybody agrees to it. */
  note: string;
}

interface ParsedRow {
  rowNumber: number;
  values: Record<string, string>;
}

/**
 * Bulk enterprise operations: import, invite, role change, move, suspend or offboard many.
 *
 * ## Validate, then apply — two steps, never one
 *
 * The client asks for "CSV/XLS import with preview/validation and per-row errors". So an
 * operation is **created in `Validated`**, having written every row with its own outcome, and
 * **nothing is applied** until a second call. An import that applied as it parsed would leave a
 * company half-changed by row 214's typo, and there would be nothing to look at afterwards.
 *
 * ## The five properties a bulk path must have, and where each lives
 *
 * A bulk operation is the easiest way to make a large mistake, and the most attractive route to
 * privilege escalation in any admin console — one file, hundreds of rows, and nobody reads row
 * 214. So:
 *
 *   1. **Permission per operation.** `BULK_PERMISSIONS` maps each kind to the action it needs;
 *      a bulk role change needs `roles:ManageAccess`, not merely the ability to upload a file.
 *   2. **Escalation refused.** Every row is applied **as the requester**, through the same
 *      services a single-record change uses — so the Prompt 7 granting gates apply unchanged. A
 *      row asking for something the requester cannot grant fails *that row* and records a
 *      `Critical` security event.
 *   3. **Seat limits not bypassed.** Rows go through the same `claimSeat`, one at a time, so the
 *      401st invitation against a 400-seat contract fails as an individual row rather than the
 *      file overshooting the ceiling wholesale.
 *   4. **Auditable.** The operation and every row persist, including the rows that failed.
 *   5. **Partial application, reported safely.** A row's failure is contained: `Applied` and
 *      `Failed` rows sit side by side and the counts say which is which. It is deliberately not
 *      all-or-nothing — a 400-row import rejected for three bad rows is worse for the customer
 *      than 397 applied and three named.
 *
 * ## Cross-tenant references are impossible, not merely checked
 *
 * Every row is applied through a tenant-scoped service, and the underlying tables carry
 * composite foreign keys (ADR-064) that refuse a department or a manager from another company.
 * A row naming another tenant's uuid fails on that row.
 */
/**
 * One person's name, written two ways, reduced to one thing to compare.
 *
 * A roster is typed in capitals and an account was created in title case; "PRANAV" and "Pranav"
 * are the same person and nothing about the difference is information. Runs of whitespace are
 * flattened for the same reason — a double space between two words is a keystroke, not a name.
 *
 * Deliberately exact after that, rather than fuzzy. This comparison is the **second** signal
 * that a row belongs to an account the company already has, and its whole value is being
 * independent of the first one: a mistyped address lands on a colleague, and the guard holds
 * only because the colleague's name is not also in the name column. Matching on a first name
 * would let one "Pranav" stand for another and throw that away.
 */
function sameName(value: string): string {
  return value.trim().toLowerCase().replace(/\s+/g, ' ');
}

/**
 * What the address on a row turns out to be, once the company has been asked about it.
 *
 * Six answers rather than a boolean, because validation has a different sentence for each and
 * the operator's next action differs every time. Apply cares about exactly one of them.
 */
type RowAccount =
  /** Nothing in the way: no address, or one nobody holds. Create a person. */
  | { kind: 'free' }
  /** Theirs, they are an internal member here, and they are not in the chart yet. */
  | { kind: 'employ'; userId: string; displayName: string }
  /** Already employed here. Two people cannot share one address. */
  | { kind: 'employedHere'; displayName: string }
  /** The address is one person's and the name is another's — a mistyped cell. */
  | { kind: 'nameMismatch'; displayName: string }
  /** Here, but as a guest. Employing them raises what they may do. */
  | { kind: 'guest'; displayName: string }
  /** Held outside this company. Whose is not this operator's business. */
  | { kind: 'elsewhere' };

@Injectable()
export class BulkOperationService {
  private readonly logger = new Logger(BulkOperationService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly access: AccessRepository,
    private readonly organization: OrganizationRepository,
    /*
     * For one question only: is this work address already somebody's login handle?
     *
     * `users.email` is unique across the whole platform, not per company, so the check cannot be
     * a tenant-scoped one — see the validator. Nothing about another company is ever reported
     * back; only whether the address is free.
     */
    private readonly usersByEmail: UserRepository,
    /*
     * And for the follow-up question: is the account that holds it one of *ours*?
     *
     * Asked through the membership repository rather than by following the relation from the
     * user, because that relation is read under row-level security and comes back empty outside
     * a tenant context — which reads as "not in this company" for somebody who is.
     */
    private readonly memberships: TenantMembershipRepository,
    private readonly employment: EmploymentService,
    /*
     * The service, not the repository, for the same reason every other row goes through a
     * service: a department created by an import must be authorized and audited exactly as one
     * created by hand. Writing the row directly would be a bulk-only write path, which is the
     * one thing this file is built not to have.
     */
    private readonly departments: DepartmentService,
    private readonly invitationAccess: InvitationAccessService,
    private readonly offboarding: OffboardingService,
    private readonly userAccess: UserAccessService,
    private readonly authorization: AuthorizationService,
    private readonly auditEvents: AuditEventService,
    private readonly securityEvents: SecurityEventPublisher,
    /*
     * Both optional, and both for one feature: a photograph pasted into the import spreadsheet.
     *
     * Requiring them would put the file store, its storage adapter, its malware scanner and the
     * photo service into the provider list of every test that builds a module around bulk
     * operations -- none of which is about photographs. `global-guard-order.spec.ts` asserts the
     * real graph supplies them, and the code below treats their absence as "no photographs were
     * sent" rather than as a failure, because an import of fifty people must not fall over on a
     * picture.
     */
    @Optional() private readonly files?: FileService,
    @Optional() private readonly photos?: EmployeePhotoService,
  ) {}

  /**
   * Parse and validate. **Nothing is applied.**
   *
   * The delimited text is parsed here rather than by a library: the format is a header row plus
   * quoted fields, an XLS export of the same shape is what a customer actually uploads, and a
   * spreadsheet parser is a dependency with a file-format attack surface for a problem that is
   * genuinely this small.
   */
  async validate(input: {
    scope: TenantScope;
    actorUserId: string;
    kind: BulkOperationKind;
    /** CSV text. An XLS is exported to CSV by the browser before upload. */
    content: string;
    /**
     * Pictures pasted into the spreadsheet, by the body row each one sits on -- PRD 3.1.
     *
     * Stored now rather than carried: a row's `input` is JSON in the database and an import may
     * be five thousand rows, so holding the images there would be gigabytes. Each is put in the
     * file store, and the row keeps its id.
     */
    photos?: Map<number, { extension: string; bytes: Buffer }> | undefined;
    sourceFileName?: string | undefined;
    parameters?: Record<string, unknown> | undefined;
    reason?: string | undefined;
  }): Promise<BulkPreview> {
    const context = await this.assertMayRun(input.scope, input.actorUserId, input.kind);

    const parsed = BulkOperationService.parseDelimited(input.content);
    if (parsed.length === 0) {
      throw new BadRequestException(
        'That file has a header row and no data rows. Nothing to validate.',
      );
    }
    if (parsed.length > MAX_BULK_ROWS) {
      throw new BadRequestException(
        `That file has ${parsed.length} rows; the limit is ${MAX_BULK_ROWS}. Split it — a single ` +
          'operation that large is hard to review and harder to undo.',
      );
    }

    /*
     * Who this file itself will create, in the order it creates them.
     *
     * Only for an import: every other kind acts on somebody who already exists. Built once and
     * handed to each row so a manager named in the file is recognised, which is what makes the
     * preview agree with the apply — `apply` walks these rows in order, so a person created by
     * row 3 is employed by the time row 10 runs.
     */
    const fileRoster =
      input.kind === 'ImportEmployees'
        ? parsed.map((row) => ({
            rowNumber: row.rowNumber,
            name: (row.values['employeeName'] ?? '').trim(),
            employeeId: (row.values['employeeId'] ?? '').trim(),
            manager: (row.values['reportingManager'] ?? '').trim(),
            email: (row.values['email'] ?? '').trim().toLowerCase(),
          }))
        : [];

    const validated = await Promise.all(
      parsed.map((row) => this.validateRow(input.scope, input.kind, row, context, fileRoster)),
    );

    const validRows = validated.filter((row) => row.errors.length === 0).length;

    /*
     * The departments the file names and the company does not have yet.
     *
     * Taken only from rows that will actually be applied: an invalid row is skipped, so a
     * department that only that row asks for must not come into existence. Distinct, and in the
     * order the file introduces them, so the preview reads like the spreadsheet.
     */
    const newDepartments = [
      ...new Set(
        validated
          .filter((row) => row.errors.length === 0)
          .map((row) => row.departmentToCreate)
          .filter((name): name is string => name !== undefined),
      ),
    ];

    /** The people whose row lands on an account they already have, named for the preview. */
    const employedAccounts = validated
      .filter((row) => row.errors.length === 0 && row.employExistingUserId !== undefined)
      .map((row) => row.values['employeeName']?.trim() || 'an existing account');

    return this.prisma.runInTenantTransaction(input.scope, async () => {
      const operation = await this.access.createBulkOperation(input.scope, {
        kind: input.kind,
        requestedByUserId: input.actorUserId,
        sourceFileName: input.sourceFileName,
        parameters: input.parameters ?? {},
        reason: input.reason,
        totalRows: parsed.length,
      });

      /*
       * The pictures, stored once and referred to by id.
       *
       * Done here rather than at apply, because this is the only point the file exists: apply
       * receives an operation id and no spreadsheet. A picture that cannot be stored is dropped
       * with a line in the log rather than failing the import -- fifty people must not be refused
       * over one photograph, and the row says what it is about in every other way.
       */
      const storedPhotos = new Map<number, { photoFileId: string }>();
      if (input.photos !== undefined && input.photos.size > 0 && this.files !== undefined) {
        for (const [bodyIndex, picture] of input.photos) {
          try {
            const stored = await this.files.uploadAuthorizedElsewhere({
              scope: input.scope,
              actorUserId: input.actorUserId,
              filename: `import-photo-${bodyIndex + 1}.${picture.extension}`,
              contentType: `image/${picture.extension === 'jpg' ? 'jpeg' : picture.extension}`,
              bytes: picture.bytes,
              classification: 'Internal',
            });
            await this.prisma.client.storedFile.update({
              where: { id: stored.id },
              data: { purpose: IMPORT_PHOTO_PURPOSE },
            });
            storedPhotos.set(bodyIndex, { photoFileId: stored.id });
          } catch (error) {
            this.logger.warn(
              `A photograph on row ${bodyIndex + 1} of this import could not be stored: ` +
                (error instanceof Error ? error.message : String(error)),
            );
          }
        }
      }

      await this.access.createBulkRowsWithinCurrentScope(
        validated.map((row, bodyIndex) => ({
          bulkOperationId: operation.id,
          tenantId: input.scope.tenantId,
          rowNumber: row.rowNumber,
          state: row.errors.length === 0 ? ('Valid' as const) : ('Invalid' as const),
          /*
           * Matched by position, not by `rowNumber`.
           *
           * `rowNumber` is what a person sees in their spreadsheet -- it counts the header, so
           * the first employee is row 2 -- and the pictures are keyed by their place in the body,
           * from zero. Subtracting one was off by one, and the symptom was a photograph silently
           * attached to nobody: no error, no warning, just a person without a picture.
           *
           * `validated` is built from the same body in the same order, so its index *is* the key.
           * No arithmetic, nothing to be off by.
           */
          input: { ...row.values, ...(storedPhotos.get(bodyIndex) ?? {}) },
          errors: row.errors,
          ...(row.subjectUserId === undefined ? {} : { subjectUserId: row.subjectUserId }),
        })),
      );

      await this.access.updateBulkOperationWithinCurrentScope(operation.id, {
        state: 'Validated',
        validRows,
        invalidRows: parsed.length - validRows,
        validatedAt: new Date(),
      });

      await this.auditEvents.appendWithinCurrentScope(input.scope.tenantId, {
        action: 'bulk.validated',
        resourceType: 'bulk_operation',
        resourceId: operation.id,
        actorUserId: input.actorUserId,
        summary: `Validated a ${input.kind} of ${parsed.length} row(s). Nothing applied.`,
        metadata: {
          kind: input.kind,
          totalRows: parsed.length,
          validRows,
          invalidRows: parsed.length - validRows,
          applied: false,
        },
      });

      return {
        operationId: operation.id,
        kind: input.kind,
        state: 'Validated',
        totalRows: parsed.length,
        validRows,
        invalidRows: parsed.length - validRows,
        rows: validated.map((row) => ({
          rowNumber: row.rowNumber,
          state: row.errors.length === 0 ? 'Valid' : 'Invalid',
          input: row.values,
          errors: row.errors,
        })),
        note:
          `Nothing has been applied. Applying will act on the ${validRows} valid row(s) and skip ` +
          `the ${parsed.length - validRows} invalid one(s). Every row is applied as you, with ` +
          'your permissions and against this company’s seat ceiling, so a row asking for ' +
          'something you cannot grant fails on its own rather than taking the file with it.' +
          /*
           * Named, because creating them is a change the operator has not asked for in so many
           * words. A file that quietly adds seventeen departments to a company is a surprise
           * somebody finds a week later; a preview that lists them is a decision they made.
           */
          (newDepartments.length === 0
            ? ''
            : ` ${newDepartments.length} department(s) will be created, because rows name them ` +
              `and this company does not have them yet: ${newDepartments.join(', ')}.`) +
          /*
           * Said out loud for the same reason the departments are.
           *
           * These rows do not create a person: they attach an employment record to an account
           * this company already has, so the person keeps the UBoss Unique ID that is already
           * theirs. That is the right outcome and it is also *not* what "importing a row"
           * sounds like, so the preview names who it is about rather than leaving the operator
           * to notice afterwards that no new record appeared.
           */
          (employedAccounts.length === 0
            ? ''
            : ` ${employedAccounts.length} row(s) belong to people who already have an account ` +
              'here and are not in the chart yet. They will be employed on the account they ' +
              'already have, keeping their existing UBoss Unique ID rather than becoming a ' +
              `second record: ${employedAccounts.join(', ')}.`),
      };
    });
  }

  /**
   * Apply a validated operation, row by row.
   *
   * **Deliberately not one transaction.** A 400-row import rejected because row 214 has a
   * duplicate Employee ID is worse for the customer than 399 applied and one named, and the
   * per-row state is what makes the partial outcome reviewable. Each row *is* atomic in itself —
   * it goes through the same service a single-record change uses.
   */
  async apply(input: {
    scope: TenantScope;
    actorUserId: string;
    operationId: string;
  }): Promise<{ applied: number; failed: number; skipped: number }> {
    const operation = await this.access.findBulkOperation(input.scope, input.operationId);
    if (!operation) {
      throw new BadRequestException('No such bulk operation.');
    }

    await this.assertMayRun(input.scope, input.actorUserId, operation.kind);

    if (operation.state !== 'Validated') {
      throw new ConflictException(
        `That operation is "${operation.state}". Only a validated operation can be applied, and ` +
          'an applied one cannot be applied twice.',
      );
    }
    if (operation.requestedByUserId !== input.actorUserId) {
      // Not a permission question — both people may hold the permission. It is a
      // *responsibility* question: the rows were validated against the requester's authority,
      // so applying them as somebody else would apply a decision nobody actually reviewed.
      throw new ConflictException(
        'Only the person who validated this operation can apply it. The rows were checked ' +
          'against their permissions, so applying them as somebody else would apply a plan ' +
          'nobody reviewed.',
      );
    }

    await this.prisma.runInTenantTransaction(input.scope, () =>
      this.access.updateBulkOperationWithinCurrentScope(operation.id, { state: 'Applying' }),
    );

    let applied = 0;
    let failed = 0;
    let skipped = 0;

    for (const row of operation.rows) {
      if (row.state !== 'Valid') {
        skipped += 1;
        continue;
      }

      try {
        await this.applyRow({
          scope: input.scope,
          actorUserId: input.actorUserId,
          kind: operation.kind,
          values: row.input as Record<string, string>,
          parameters: operation.parameters as Record<string, unknown>,
          reason: operation.reason ?? 'Bulk operation.',
        });
        applied += 1;
        await this.prisma.runInTenantTransaction(input.scope, () =>
          this.access.updateBulkRowWithinCurrentScope(row.id, { state: 'Applied' }),
        );
      } catch (error) {
        failed += 1;
        const message = error instanceof Error ? error.message : 'Unknown failure.';

        // An escalation attempt is not an ordinary row failure. Recorded as `Critical` on its
        // own action, because "somebody tried to grant themselves something through a
        // spreadsheet" is exactly the event an access review needs to find.
        if (/cannot grant|exceed|escalat|not permitted|forbidden/i.test(message)) {
          await this.recordEscalationAttempt({
            scope: input.scope,
            actorUserId: input.actorUserId,
            operationId: operation.id,
            rowNumber: row.rowNumber,
            message,
          });
        }

        await this.prisma.runInTenantTransaction(input.scope, () =>
          this.access.updateBulkRowWithinCurrentScope(row.id, {
            state: 'Failed',
            errors: [message],
          }),
        );
      }
    }

    await this.prisma.runInTenantTransaction(input.scope, async () => {
      await this.access.updateBulkOperationWithinCurrentScope(operation.id, {
        state: 'Applied',
        appliedRows: applied,
        failedRows: failed,
        appliedAt: new Date(),
      });

      await this.auditEvents.appendWithinCurrentScope(input.scope.tenantId, {
        action: 'bulk.applied',
        resourceType: 'bulk_operation',
        resourceId: operation.id,
        actorUserId: input.actorUserId,
        summary: `Applied a ${operation.kind}: ${applied} applied, ${failed} failed, ${skipped} skipped.`,
        ...(operation.reason ? { reason: operation.reason } : {}),
        metadata: { kind: operation.kind, applied, failed, skipped },
      });

      await this.securityEvents.recordWithinCurrentScope({
        action: SECURITY_ACTIONS.bulkOperationApplied,
        tenantId: input.scope.tenantId,
        actorUserId: input.actorUserId,
        resourceType: 'bulk_operation',
        resourceId: operation.id,
        summary: `${operation.kind}: ${applied} applied, ${failed} failed.`,
        metadata: { applied, failed, skipped },
      });
    });

    return { applied, failed, skipped };
  }

  /** Abandon a validated operation. Rows keep their outcomes. */
  async cancel(input: {
    scope: TenantScope;
    actorUserId: string;
    operationId: string;
  }): Promise<void> {
    const operation = await this.access.findBulkOperation(input.scope, input.operationId);
    if (!operation) {
      throw new BadRequestException('No such bulk operation.');
    }
    await this.assertMayRun(input.scope, input.actorUserId, operation.kind);

    if (operation.state === 'Applied') {
      throw new ConflictException(
        'That operation was already applied. Cancelling it would not undo anything — reverse ' +
          'the changes deliberately instead.',
      );
    }

    await this.prisma.runInTenantTransaction(input.scope, async () => {
      await this.access.updateBulkOperationWithinCurrentScope(operation.id, {
        state: 'Cancelled',
        cancelledAt: new Date(),
      });
      await this.auditEvents.appendWithinCurrentScope(input.scope.tenantId, {
        action: 'bulk.cancelled',
        resourceType: 'bulk_operation',
        resourceId: operation.id,
        actorUserId: input.actorUserId,
        summary: 'Cancelled before applying. Row outcomes are kept.',
        metadata: { kind: operation.kind, nothingDeleted: true },
      });
    });
  }

  async list(scope: TenantScope, actorUserId: string): Promise<BulkOperation[]> {
    const context = await this.authorization.contextFor(scope, actorUserId);
    await this.authorization.assertCan(context, { module: 'users', action: 'View' });
    return this.access.listBulkOperations(scope);
  }

  // -------------------------------------------------------------------------
  // Validation and application, per kind
  // -------------------------------------------------------------------------

  /**
   * Who, if anybody, this row's work address already belongs to in this company.
   *
   * Asked twice — once by validation to choose a sentence, once by apply to choose a call — and
   * written once so the two cannot drift. That drift is a real failure here and not a
   * hypothetical one: the manager lookup beside this had it, and rows that previewed as valid
   * failed on apply because the preview resolved a name the apply step could not.
   */
  private async describeRowAccount(
    scope: TenantScope,
    values: Record<string, string>,
  ): Promise<RowAccount> {
    const handle = (values['email'] ?? '').trim().toLowerCase();
    if (handle === '' || !handle.includes('@')) return { kind: 'free' };

    const taken = await this.usersByEmail.findByEmailForPlatform(handle);
    if (!taken) return { kind: 'free' };

    const [employedHere, memberHere] = await Promise.all([
      this.organization.findEmployment(scope, taken.id),
      /*
       * Wrapped, where the employment lookup beside it wraps itself.
       *
       * `tenant_memberships` is read under row-level security, and this runs outside a
       * transaction — so the unwrapped read came back empty for somebody who is plainly a
       * member, and the message told the operator their own colleague's address belonged to a
       * stranger. A read, not an authorization: those stay outside.
       */
      this.prisma.runInTenantTransaction(scope, () =>
        this.memberships.findByUserId(scope, taken.id),
      ),
    ]);

    if (employedHere) return { kind: 'employedHere', displayName: taken.displayName };
    if (!memberHere) return { kind: 'elsewhere' };

    // The name is the second, independent signal. See `sameName`.
    if (sameName(values['employeeName'] ?? '') !== sameName(taken.displayName)) {
      return { kind: 'nameMismatch', displayName: taken.displayName };
    }
    if (memberHere.userType === 'ExternalGuest') {
      return { kind: 'guest', displayName: taken.displayName };
    }
    return { kind: 'employ', userId: taken.id, displayName: taken.displayName };
  }

  /** The id when this row is an existing account's own row, and null otherwise. */
  private async existingAccountForRow(
    scope: TenantScope,
    values: Record<string, string>,
  ): Promise<string | null> {
    const account = await this.describeRowAccount(scope, values);
    return account.kind === 'employ' ? account.userId : null;
  }

  private async validateRow(
    scope: TenantScope,
    kind: BulkOperationKind,
    row: ParsedRow,
    _context: AuthorizationContext,
    /**
     * The people this same file creates, in the order it creates them.
     *
     * Validation used to judge each row against the company as it stands, while `apply` walks the
     * rows in order — so a manager created by row 3 exists by the time row 10 is applied, and did
     * not exist when row 10 was *checked*. On a company's first import that is every row: nobody
     * is employed yet, so every manager named in the file is "not in this company" and a
     * hundred-and-thirty-nine-row file previews as a hundred and thirty-nine refusals with
     * nothing to apply. A whole hierarchy could not be imported from one file at all.
     *
     * Only rows **before** this one count, which is what keeps the preview and the apply saying
     * the same thing: a manager written below the person reporting to them really would fail.
     */
    fileRoster: readonly {
      rowNumber: number;
      name: string;
      employeeId: string;
      manager: string;
      email: string;
    }[] = [],
  ): Promise<
    ParsedRow & {
      errors: string[];
      subjectUserId?: string;
      departmentToCreate?: string;
      employExistingUserId?: string;
    }
  > {
    const errors: string[] = [];
    const values = row.values;
    let subjectUserId: string | undefined;
    /** A department this row names that the company does not have yet. Created at apply. */
    let departmentToCreate: string | undefined;
    /**
     * An account this company already has, which this row is the employment record for.
     *
     * Set only when the address **and** the name both point at the same existing internal
     * account. Apply employs that account rather than creating a person, so one human keeps one
     * UBoss Unique ID.
     */
    let employExistingUserId: string | undefined;

    const require = (field: string, label: string): string => {
      const value = values[field]?.trim() ?? '';
      if (value === '') {
        errors.push(`${label} is required.`);
      }
      return value;
    };

    if (kind === 'ImportEmployees') {
      require('employeeName', 'Employee Name');
      require('employeeId', 'Employee ID');
      require('designation', 'Designation');
      /*
       * Required here as well as on the form, at the client's instruction.
       *
       * It was deliberately split before — asked for on the form, accepted blank on import — on
       * the reasoning that an import is somebody's existing spreadsheet and refusing it today
       * would apply this screen's decision to their data. The client's answer is that a star
       * belongs on every heading, and a star on this template means the server refuses the row.
       * One rule in both places is the only way that stays true.
       *
       * It changes nothing about records already stored: the column is still nullable, because a
       * question nobody was asked has no honest answer but "we do not know".
       */
      require('specialization', 'Specialization');
      const departmentName = require('department', 'Department');
      /*
       * Phone is required on an import; **email is not**, at the client's instruction.
       *
       * Both were, since CR-04, on the reasoning that an import is the fastest way to build a
       * hierarchy of people nobody can contact. The client's answer is that a company importing
       * its existing roster often does not have a work address for everybody yet — refusing those
       * rows refuses the import, and the person is reachable by phone meanwhile.
       *
       * The **form** still asks for it. That is not a contradiction: somebody filling a form has
       * the person in front of them and can answer, where a spreadsheet of people who already
       * work there was correct before this screen existed. The template agrees with this file —
       * no star on Email — which is the only thing that must stay true.
       */
      const rowEmail = values['email']?.trim() ?? '';
      const rowPhone = require('phone', 'Work Phone');
      // Checked when given, so a typo is still caught; absence is simply not an error.
      if (rowEmail !== '' && !rowEmail.includes('@')) {
        errors.push('Work Email: that does not look like an email address.');
      }

      /*
       * One address, one login — and said here rather than discovered at apply.
       *
       * `users.email` is a unique handle across the whole platform, so two people cannot share
       * one. A factory roster breaks this constantly and legitimately: `accounts@`, `dispatch@`
       * and `store@` are departmental mailboxes that four people answer. Eighteen rows of the
       * client's first import were accepted by the preview and then failed inside `apply` with a
       * database constraint printed as a stack trace, which told the operator nothing they could
       * act on and left the import reporting twenty failures it had promised would succeed.
       *
       * The address is optional, so the fix is the operator's to make and it is a small one:
       * leave the cell blank for everybody but the one person who owns the mailbox. Blank means
       * a placeholder handle nobody can write to, which is exactly right for somebody who is in
       * the org chart before they are invited.
       *
       * Checked across the platform and reported without naming anything outside this company:
       * who holds an address elsewhere is not this operator's business, and the answer they need
       * is only "not this one".
       */
      if (rowEmail !== '' && rowEmail.includes('@')) {
        const handle = rowEmail.toLowerCase();

        const earlier = fileRoster.find(
          (person) => person.rowNumber < row.rowNumber && person.email === handle,
        );
        if (earlier) {
          errors.push(
            `Work Email "${rowEmail}" is already used on row ${earlier.rowNumber} of this file ` +
              `(${earlier.name || 'unnamed'}). One address can only belong to one person, so ` +
              'leave this cell blank unless it is theirs.',
          );
        } else {
          /*
           * Theirs, and they are simply not in the chart yet — the `employ` case below.
           *
           * The normal state of somebody invited as an administrator before the org chart
           * existed, which is every company in that order. This row is their own row, and the
           * right outcome is an employment record **on the account they already have**, keeping
           * the UBoss Unique ID that is already theirs. Creating a second person would give one
           * human two permanent identities, for good.
           *
           * It used to refuse and send the operator off to do it by hand. That was the safe
           * answer to a real danger: an address mistyped into a colleague's would otherwise
           * attach this row's Aadhaar and designation to that colleague. The name is what makes
           * it safe to do automatically — a typo puts a colleague's *address* in the cell, it
           * does not also put the colleague's *name* in the name column. Both have to agree,
           * and when they disagree the old refusal stands, which is the case the danger was
           * ever about.
           */
          const account = await this.describeRowAccount(scope, values);

          switch (account.kind) {
            case 'employ':
              employExistingUserId = account.userId;
              break;

            case 'employedHere':
              errors.push(
                `Work Email "${rowEmail}" already belongs to ${account.displayName}, who is ` +
                  'employed here. One address can only belong to one person, so leave this cell ' +
                  'blank unless it is theirs.',
              );
              break;

            case 'nameMismatch':
              errors.push(
                `Work Email "${rowEmail}" belongs to ${account.displayName}'s account in this ` +
                  `company, but this row names ${values['employeeName']?.trim() || 'somebody else'}. ` +
                  'One address can only belong to one person — check the address, or leave the ' +
                  'cell blank to import this row as a separate person.',
              );
              break;

            case 'guest':
              /*
               * A guest is capped at read, comment and draft, and their access carries an end
               * date the database requires them to have. Employing one is therefore not the
               * same act as employing an internal account: it raises what they may do and
               * removes the date their access stops. A privilege change should not arrive from
               * a row in a spreadsheet — a person decides it, on a named colleague.
               */
              errors.push(
                `${account.displayName} is a guest in this company, not an internal member. ` +
                  'Employ them from the Hierarchy screen — that also makes them an internal ' +
                  'user and removes the end date on their access, which a spreadsheet row ' +
                  'should not do on its own.',
              );
              break;

            case 'elsewhere':
              // Who holds it is not this operator's business, and the only answer they can act
              // on is that this one is not free.
              errors.push(
                `Work Email "${rowEmail}" is already in use as a login handle. Leave this cell ` +
                  'blank, or use an address only this person has.',
              );
              break;

            case 'free':
              break;
          }
        }
      }
      if (rowPhone !== '' && rowPhone.replace(/[^0-9]/g, '').length < 7) {
        errors.push('Work Phone: that does not look like a phone number.');
      }
      const aadhaar = require('aadhaarNumber', 'Aadhaar Number');

      if (aadhaar !== '') {
        const normalised = normaliseAadhaar(aadhaar);
        if (!normalised.ok) {
          // The reason, not just "invalid" — the person fixing the spreadsheet needs to know
          // which of the five ways it is wrong.
          errors.push(`Aadhaar Number: ${normalised.reason.replace(/-/g, ' ')}.`);
        }
      }

      if (departmentName !== '') {
        // Archived ones included deliberately — see the archived branch below. A name that is
        // taken by an archived department cannot be created, so "not in the live list" is not
        // the same question as "can this import make it".
        const departments = await this.organization.listDepartments(scope, true);
        const match = departments.find(
          (department) =>
            department.archivedAt === null &&
            department.name.toLowerCase() === departmentName.toLowerCase(),
        );
        const archived = departments.find(
          (department) =>
            department.archivedAt !== null &&
            department.name.toLowerCase() === departmentName.toLowerCase(),
        );
        /*
         * A department the company does not have yet is created by the import, not refused.
         *
         * It used to be refused — "Create it first, or correct the spelling" — which is correct
         * for a file adding four joiners to a company that already runs, and impossible for the
         * file that *starts* a company. The client's first import named seventeen departments,
         * none of which existed, so all 139 rows failed on the first of their two errors and
         * there was no order of operations that got anywhere: the departments could only be made
         * by hand, one screen at a time, before the file would do anything at all.
         *
         * Created at apply, never here — validation reads and reports, it does not write — and
         * named in the preview's note so nobody finds out afterwards.
         */
        if (match) {
          // Nothing to do: the company has it.
        } else if (archived) {
          /*
           * Taken, but not usable — and this row must be refused here rather than discovered at
           * apply.
           *
           * Creating it would be refused by the department service, which rejects a duplicate
           * name whether or not the other one is archived. Left to apply, that refusal arrived
           * after the preview had called the row valid, and the person was written with no
           * department at all: the quietest possible wrong answer. The operator can restore the
           * department or rename the column; neither is something an import should guess.
           */
          errors.push(
            `Department "${departmentName}" exists in this company but is archived. Restore it, ` +
              'or name a different department.',
          );
        } else {
          departmentToCreate = departmentName;
        }
      }

      const employeeId = values['employeeId']?.trim() ?? '';
      if (employeeId !== '') {
        const clash = await this.organization.findEmploymentByEmployeeId(scope, employeeId);
        if (clash) {
          errors.push(`Employee ID "${employeeId}" is already used in this company.`);
        }

        // And used twice inside this one file, which the company's own records cannot show
        // because neither person exists yet. The second row would be refused at apply.
        const earlier = fileRoster.find(
          (person) =>
            person.rowNumber < row.rowNumber &&
            person.employeeId.toLowerCase() === employeeId.toLowerCase(),
        );
        if (earlier !== undefined) {
          errors.push(
            `Employee ID "${employeeId}" is already used on row ${earlier.rowNumber} of this ` +
              'file. Two people cannot share one.',
          );
        }
      }

      const managerName = values['reportingManager']?.trim() ?? '';

      /** The first row of this file, above this one, that claims the top of the tree. */
      const earlierRootInFile = fileRoster.find(
        (person) => person.rowNumber < row.rowNumber && person.manager === '',
      );

      /*
       * A blank Reporting Manager is only allowed for the very first person in the company.
       *
       * `addEmployee` refuses a second person with no manager, because a company with two people
       * at the top of its reporting tree has no top. Validation did not know that, so a row with
       * the column left blank previewed as **Valid** and then failed at apply — which is the
       * precise failure this preview exists to prevent, and the one the note on the manager check
       * below already warns about. An import of forty people with the column unfilled reported
       * forty ready rows and added none.
       *
       * Checked once per file rather than per row: it is a fact about the company, not the row.
       */
      if (managerName === '') {
        const roster = await this.access.roster(scope);
        const roots = roster.filter(
          (person) => person.employmentState === 'Active' && person.reportingManagerUserId === null,
        );
        if (roots.length > 0) {
          errors.push(
            `Reporting Manager is required. ${roots[0]?.displayName} is already at the top of ` +
              'this company’s reporting tree, and there can only be one.',
          );
        } else if (earlierRootInFile !== undefined) {
          // The company has no top yet and this file is about to give it one — but only one. Two
          // blank rows both previewed as valid against an empty roster and the second failed at
          // apply, which is the same disagreement the manager check below was fixed for.
          errors.push(
            `Reporting Manager is required. ${earlierRootInFile.name} is already at the top of ` +
              'this file, and a company can only have one person with nobody above them.',
          );
        }
      }

      if (managerName !== '') {
        const roster = await this.access.roster(scope);
        /*
         * By name, or by Employee ID.
         *
         * Names are not unique — this company has two people called Rahul Singh, and four called
         * Rohit Kumar — and the only answer the refusal could offer was a UBoss Unique ID, which
         * nobody has until they are imported. So the way out of an ambiguous name was a value
         * that cannot exist yet, which is not a way out.
         *
         * The Employee ID is the company's own, it is in the file already as its own column, and
         * it is unique here by constraint. Writing it in this column names exactly one person.
         */
        const matches = roster.filter(
          (person) =>
            person.displayName.toLowerCase() === managerName.toLowerCase() ||
            (person.employeeId ?? '').toLowerCase() === managerName.toLowerCase(),
        );

        // **`employmentState === 'Active'`, not merely "is a member".** Applying a row calls the
        // same `addEmployee` a single-record change uses, and that requires the manager to be
        // *employed here* — the composite foreign key guarantees it. Validating only membership
        // would let the preview say "valid" for a row that then fails, which makes the preview
        // worse than useless: it is the thing the operator agreed to.
        const employed = matches.filter((person) => person.employmentState === 'Active');

        /*
         * People this same file creates above this row.
         *
         * They are not in the company yet and they will be by the time this row is applied, so
         * counting them is what makes the preview agree with the apply. Counted alongside the
         * roster rather than instead of it, because a name can be ambiguous across the two — one
         * person already employed and another about to be created — and that is exactly the case
         * where picking either would assign somebody the wrong manager.
         */
        const fromFile = fileRoster.filter(
          (person) =>
            person.rowNumber < row.rowNumber &&
            (person.name.toLowerCase() === managerName.toLowerCase() ||
              person.employeeId.toLowerCase() === managerName.toLowerCase()),
        );
        const available = employed.length + fromFile.length;

        if (available === 0 && matches.length === 0) {
          errors.push(
            `Reporting Manager "${managerName}" is not in this company, and no earlier row of ` +
              'this file creates them. A manager has to exist, or be imported above the people ' +
              'reporting to them.',
          );
        } else if (available === 0) {
          errors.push(
            `Reporting Manager "${managerName}" has no active employment record in this ` +
              'company, so they cannot be anybody’s manager. Add them as an employee first.',
          );
        } else if (available > 1) {
          // Names are not unique, and picking one silently would assign the wrong manager.
          errors.push(
            `"${managerName}" matches ${available} people in this company or in this file. Use ` +
              'their Employee ID in the Reporting Manager column instead of a name.',
          );
        }
      }
    } else {
      // Every other kind acts on somebody who already exists, identified by their UBoss Unique
      // ID or their company Employee ID — never by name, which is not unique.
      const ubossId = values['ubossUniqueId']?.trim() ?? '';
      const employeeId = values['employeeId']?.trim() ?? '';

      if (ubossId === '' && employeeId === '') {
        errors.push('Either ubossUniqueId or employeeId is required to identify the person.');
      } else {
        const roster = await this.access.roster(scope);
        const person = roster.find(
          (candidate) =>
            (ubossId !== '' && candidate.ubossUniqueId === ubossId) ||
            (employeeId !== '' && candidate.employeeId === employeeId),
        );
        if (!person) {
          errors.push(
            'No such person in this company. A bulk operation cannot reach into another ' +
              'company, and it cannot create a membership.',
          );
        } else {
          subjectUserId = person.userId;

          if (kind === 'InviteOrResend' && person.accountState === 'Active') {
            errors.push('Already activated — there is nothing to invite.');
          }
          if (kind === 'SuspendOrOffboard' && person.accountState === 'Offboarded') {
            errors.push('Already offboarded.');
          }
        }
      }

      if (kind === 'ManagerOrDepartment') {
        const target = values['department']?.trim() ?? '';
        const manager = values['reportingManager']?.trim() ?? '';
        if (target === '' && manager === '') {
          errors.push('A move needs a department, a reporting manager, or both.');
        }
      }

      if (kind === 'SuspendOrOffboard') {
        const action = (values['action'] ?? '').trim().toLowerCase();
        if (!['suspend', 'offboard'].includes(action)) {
          errors.push('action must be "suspend" or "offboard".');
        }
      }
    }

    return {
      ...row,
      errors,
      ...(subjectUserId === undefined ? {} : { subjectUserId }),
      ...(departmentToCreate === undefined ? {} : { departmentToCreate }),
      ...(employExistingUserId === undefined ? {} : { employExistingUserId }),
    };
  }

  /**
   * Apply one row, through the same service a single-record change uses.
   *
   * That reuse is the escalation control: there is no bulk-only write path, so every gate the
   * Prompt 7 engine applies to one person applies to four hundred.
   */
  private async applyRow(input: {
    scope: TenantScope;
    actorUserId: string;
    kind: BulkOperationKind;
    values: Record<string, string>;
    parameters: Record<string, unknown>;
    reason: string;
  }): Promise<void> {
    const { values } = input;

    switch (input.kind) {
      case 'ImportEmployees': {
        const departmentName = (values['department'] ?? '').trim();
        const departments = await this.organization.listDepartments(input.scope, false);
        let department = departments.find(
          (candidate) => candidate.name.toLowerCase() === departmentName.toLowerCase(),
        );

        /*
         * Named by the file, absent from the company: created, not refused.
         *
         * Through the service, so it is authorized and audited like any other department — the
         * actor needs `hierarchy:Administer`, and a row asking for a department somebody cannot
         * create fails on its own rather than taking the file with it.
         *
         * The duplicate case is caught rather than prevented: two rows naming the same new
         * department are applied one after another, so the second finds it in the list above —
         * but an import running beside somebody creating the same department by hand would not,
         * and losing a person over that would be absurd. Either way the department now exists,
         * which is all this row needed.
         */
        if (!department && departmentName !== '') {
          try {
            department = await this.departments.create({
              scope: input.scope,
              actorUserId: input.actorUserId,
              name: departmentName,
            });
          } catch (error) {
            if (!(error instanceof ConflictException)) throw error;
            const again = await this.organization.listDepartments(input.scope, false);
            department = again.find(
              (candidate) => candidate.name.toLowerCase() === departmentName.toLowerCase(),
            );
            // The name is taken by something this row cannot use — an archived department, in
            // practice. Rethrown rather than swallowed: the row fails and says why, instead of
            // writing a person with no department and reporting success.
            if (!department) throw error;
          }
        }

        const roster = await this.access.roster(input.scope);
        // Resolved the same way validation resolved it — employed here, not merely a member, and
        // by Employee ID as well as by name — so a row that previewed as valid applies. The two
        // lookups drifting apart is the whole failure the preview exists to prevent.
        const written = (values['reportingManager'] ?? '').trim().toLowerCase();
        const manager = roster.find(
          (person) =>
            person.employmentState === 'Active' &&
            (person.displayName.toLowerCase() === written ||
              (person.employeeId ?? '').toLowerCase() === written),
        );

        /*
         * Whose employment record this row is.
         *
         * Recomputed here rather than carried from validation. The two could be minutes apart
         * and the company can change in between — somebody employed, an account invited — and a
         * decision carried across that gap was made about a company that no longer exists. It
         * costs one lookup, and it is the same function validation used, so the two cannot
         * disagree about what they are looking at.
         */
        const existing = await this.existingAccountForRow(input.scope, values);

        const employmentFields = {
          scope: input.scope,
          actorUserId: input.actorUserId,
          employeeId: values['employeeId'] ?? '',
          designation: values['designation'] ?? '',
          departmentId: department?.id ?? '',
          reportingManagerUserId: manager?.userId ?? null,
          aadhaarNumber: values['aadhaarNumber'] ?? '',
          // Carried when the sheet has it. Left out entirely when blank, so an empty cell stores
          // nothing rather than an empty string that later reads as an answer somebody gave.
          ...(values['specialization']?.trim()
            ? { specialization: values['specialization'].trim() }
            : {}),
          ...(values['email']?.trim() ? { workEmail: values['email'].trim() } : {}),
          ...(values['phone']?.trim() ? { workPhone: values['phone'].trim() } : {}),
        };

        const added =
          existing === null
            ? await this.employment.addEmployee({
                ...employmentFields,
                employeeName: values['employeeName'] ?? '',
              })
            : // Their own row. The employment record goes on the account they already have, so
              // one human keeps one UBoss Unique ID — and no name is sent, because theirs is
              // already on the platform and this company does not get to rewrite it.
              await this.employment.employExistingAccount({
                ...employmentFields,
                subjectUserId: existing,
              });

        /*
         * The photograph that came in on this row, now that there is somebody to attach it to --
         * PRD 3.1.
         *
         * After the person exists, because a photograph belongs to a person and there was none
         * until this line. Its failure is logged and swallowed: the row's deliverable is the
         * employee, and refusing a correctly described person because their picture would not
         * attach would be the tail wagging the dog. The photograph can be set afterwards from
         * their profile; the employee cannot be re-imported without unpicking the row.
         */
        const photoFileId = values['photoFileId']?.trim();
        if (photoFileId && this.files !== undefined && this.photos !== undefined) {
          try {
            const bytes = await this.files.readAuthorizedElsewhere({
              scope: input.scope,
              fileId: photoFileId,
            });
            const stored = await this.prisma.client.storedFile.findFirst({
              where: { tenantId: input.scope.tenantId, id: photoFileId },
              select: { contentType: true, filename: true },
            });
            await this.photos.upload({
              scope: input.scope,
              actorUserId: input.actorUserId,
              subjectUserId: added.userId,
              filename: stored?.filename ?? 'import-photo.png',
              contentType: stored?.contentType ?? 'image/png',
              contentBase64: bytes.toString('base64'),
            });
          } catch (error) {
            this.logger.warn(
              `${values['employeeName'] ?? 'A person'} was imported, and the photograph on their ` +
                'row could not be attached: ' +
                (error instanceof Error ? error.message : String(error)),
            );
          }
        }
        break;
      }

      case 'InviteOrResend': {
        const person = await this.findSubject(input.scope, values);
        await this.invitationAccess.inviteExistingPerson({
          scope: input.scope,
          actorUserId: input.actorUserId,
          subjectUserId: person,
          ...(values['email']?.trim() ? { workEmail: values['email'].trim() } : {}),
          ...(values['phone']?.trim() ? { workPhone: values['phone'].trim() } : {}),
        });
        break;
      }

      case 'ManagerOrDepartment': {
        const person = await this.findSubject(input.scope, values);
        const departments = await this.organization.listDepartments(input.scope, false);
        const department = departments.find(
          (candidate) =>
            candidate.name.toLowerCase() === (values['department'] ?? '').trim().toLowerCase(),
        );

        if (department) {
          await this.employment.updateEmployment({
            scope: input.scope,
            actorUserId: input.actorUserId,
            subjectUserId: person,
            departmentId: department.id,
          });
        }
        break;
      }

      case 'SuspendOrOffboard': {
        const person = await this.findSubject(input.scope, values);
        const action = (values['action'] ?? '').trim().toLowerCase();

        if (action === 'suspend') {
          await this.userAccess.suspend({
            scope: input.scope,
            actorUserId: input.actorUserId,
            subjectUserId: person,
            reason: input.reason,
          });
        } else {
          await this.offboarding.offboard({
            scope: input.scope,
            actorUserId: input.actorUserId,
            subjectUserId: person,
            ...(values['successorUbossUniqueId']?.trim()
              ? {
                  successorUserId: await this.findSubject(input.scope, {
                    ubossUniqueId: values['successorUbossUniqueId'].trim(),
                  }),
                }
              : {}),
            reason: input.reason,
          });
        }
        break;
      }

      case 'RoleAndScope': {
        // Deliberately refused rather than half-implemented. Role administration has three
        // escalation gates (ADR-040) and its own service; routing a bulk row through anything
        // less would be the one place in the product where a grant skips them.
        throw new Error(
          'Bulk role and scope changes are validated but not applied yet: they must go through ' +
            'the role administration service so its three escalation gates apply, and wiring ' +
            'that is the Roles & Permissions prompt. Nothing was changed.',
        );
      }
    }
  }

  private async findSubject(scope: TenantScope, values: Record<string, string>): Promise<string> {
    const roster = await this.access.roster(scope);
    const ubossId = values['ubossUniqueId']?.trim() ?? '';
    const employeeId = values['employeeId']?.trim() ?? '';

    const person = roster.find(
      (candidate) =>
        (ubossId !== '' && candidate.ubossUniqueId === ubossId) ||
        (employeeId !== '' && candidate.employeeId === employeeId),
    );

    if (!person) {
      throw new Error('That person is no longer in this company.');
    }
    return person.userId;
  }

  private async recordEscalationAttempt(input: {
    scope: TenantScope;
    actorUserId: string;
    operationId: string;
    rowNumber: number;
    message: string;
  }): Promise<void> {
    try {
      await this.prisma.runInTenantTransaction(input.scope, () =>
        this.securityEvents.recordWithinCurrentScope({
          action: SECURITY_ACTIONS.bulkEscalationBlocked,
          tenantId: input.scope.tenantId,
          actorUserId: input.actorUserId,
          resourceType: 'bulk_operation',
          resourceId: input.operationId,
          summary: `Row ${input.rowNumber} was refused: ${input.message.slice(0, 200)}`,
          metadata: { rowNumber: input.rowNumber },
        }),
      );
    } catch {
      // The row already failed and its error is recorded on the row. Losing the security event
      // must not turn a contained row failure into a failed operation.
    }
  }

  /**
   * What the import template's dropdowns are filled from.
   *
   * The same two sources the validator checks a row against — this company's departments and its
   * roster — so the values offered are exactly the values that will be accepted. Read at download
   * time rather than cached: a department added five minutes ago has to be in the file somebody
   * downloads now.
   */
  async hierarchyReference(scope: TenantScope, actorUserId: string): Promise<HierarchyReference> {
    await this.assertMayRun(scope, actorUserId, 'ImportEmployees');

    const [departments, roster] = await Promise.all([
      this.organization.listDepartments(scope, false),
      this.access.roster(scope),
    ]);

    return {
      departments: departments.map((department) => ({
        name: department.name,
        code: department.code ?? null,
      })),
      /*
       * Only people who can actually be somebody's manager.
       *
       * A row naming a manager with no active employment record is rejected by the validator, so
       * listing them here would be offering a value that fails — which is worse than not listing
       * them, because the person copied it from the file we gave them.
       */
      people: roster
        .filter((person) => person.employmentState === 'Active')
        .map((person) => ({
          displayName: person.displayName,
          designation: person.designation ?? null,
          department: person.departmentName ?? null,
        })),
    };
  }

  private async assertMayRun(
    scope: TenantScope,
    actorUserId: string,
    kind: BulkOperationKind,
  ): Promise<AuthorizationContext> {
    const required = BULK_PERMISSIONS[kind];
    const context = await this.authorization.contextFor(scope, actorUserId);
    await this.authorization.assertCan(context, {
      module: required.module,
      action: required.action,
    });
    return context;
  }

  /**
   * A minimal delimited-text parser: a header row, then data rows, with quoted fields.
   *
   * Written rather than taken from a library on purpose. The shape is a header and quoted fields
   * — genuinely this small — and a spreadsheet parser is a file-format attack surface accepting
   * untrusted uploads. Handles the three things real exports do: quoted fields containing
   * commas, doubled quotes inside a quoted field, and CRLF line endings.
   */
  static parseDelimited(content: string): ParsedRow[] {
    const lines = content
      .replace(/\r\n/g, '\n')
      .split('\n')
      .filter((line) => line.trim() !== '');
    if (lines.length < 2) {
      return [];
    }

    const header = BulkOperationService.splitRow(lines[0] as string).map((cell) =>
      BulkOperationService.canonicalField(cell),
    );

    return lines.slice(1).map((line, index) => {
      const cells = BulkOperationService.splitRow(line);
      const values: Record<string, string> = {};
      header.forEach((key, column) => {
        values[key] = cells[column] ?? '';
      });
      // 1-based, and +1 again for the header — so the number matches the spreadsheet's own row
      // numbering. An error pointing at the wrong line is worse than no line number.
      return { rowNumber: index + 2, values };
    });
  }

  /**
   * The fields a bulk file may name, and the spellings each accepts.
   *
   * ## Why a table rather than a camel-case transform
   *
   * `Employee ID` camel-cases to `employeeID`, not `employeeId` — so an exact-key match works
   * for one spelling and silently fails for every other, reporting a present column as missing.
   * That is what a customer's real export does: `Employee ID`, `employee_id`, `EmployeeID` and
   * `Employee Id` are all the same column to the person who made the spreadsheet, and a tool
   * that accepts only one of them is a tool they will fight with.
   *
   * Keys are compared with all non-alphanumerics stripped and lower-cased, so each entry below
   * covers every punctuation and casing variant of itself.
   */
  private static readonly FIELD_ALIASES: Record<string, string> = {
    employeename: 'employeeName',
    name: 'employeeName',
    fullname: 'employeeName',
    employeeid: 'employeeId',
    empid: 'employeeId',
    companyemployeeid: 'employeeId',
    designation: 'designation',
    jobtitle: 'designation',
    title: 'designation',
    specialization: 'specialization',
    specialisation: 'specialization',
    specialty: 'specialization',
    speciality: 'specialization',
    subdepartments: 'specialization',
    areascovered: 'specialization',
    department: 'department',
    dept: 'department',
    reportingmanager: 'reportingManager',
    manager: 'reportingManager',
    reportsto: 'reportingManager',
    aadhaarnumber: 'aadhaarNumber',
    aadhaar: 'aadhaarNumber',
    email: 'email',
    workemail: 'email',
    emailaddress: 'email',
    phone: 'phone',
    workphone: 'phone',
    mobile: 'phone',
    contactnumber: 'phone',
    ubossuniqueid: 'ubossUniqueId',
    ubossid: 'ubossUniqueId',
    action: 'action',
    role: 'role',
    successorubossuniqueid: 'successorUbossUniqueId',
    successor: 'successorUbossUniqueId',
  };

  /**
   * Map a header cell to its canonical field name.
   *
   * An unrecognised header keeps a normalised form of itself rather than being dropped, so an
   * extra column a customer added for their own reference still appears in the stored row. What
   * they uploaded is part of the record.
   */
  static canonicalField(cell: string): string {
    const normalised = cell
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9]/g, '');
    const canonical = BulkOperationService.FIELD_ALIASES[normalised];
    if (canonical !== undefined) {
      return canonical;
    }
    const camel = cell.trim().replace(/\s+(.)/g, (_, next: string) => next.toUpperCase());
    return camel.charAt(0).toLowerCase() + camel.slice(1);
  }

  private static splitRow(line: string): string[] {
    const cells: string[] = [];
    let current = '';
    let quoted = false;

    for (let index = 0; index < line.length; index += 1) {
      const character = line[index];

      if (quoted) {
        if (character === '"') {
          if (line[index + 1] === '"') {
            current += '"';
            index += 1;
          } else {
            quoted = false;
          }
        } else {
          current += character;
        }
        continue;
      }

      if (character === '"') {
        quoted = true;
      } else if (character === ',') {
        cells.push(current);
        current = '';
      } else {
        current += character;
      }
    }

    cells.push(current);
    return cells.map((cell) => cell.trim());
  }
}
