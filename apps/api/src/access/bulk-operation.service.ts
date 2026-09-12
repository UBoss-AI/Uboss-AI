import { BadRequestException, ConflictException, Injectable, Logger } from '@nestjs/common';

import { AuditEventService } from '../audit/audit-event.service.js';
import { SECURITY_ACTIONS, SecurityEventPublisher } from '../auth/security-event.publisher.js';
import {
  AuthorizationService,
  type AuthorizationContext,
} from '../authorization/authorization.service.js';
import type { BulkOperation, BulkOperationKind } from '../generated/prisma/client.js';
import { normaliseAadhaar } from '../organization/aadhaar.js';
import { EmploymentService } from '../organization/employment.service.js';
import { AccessRepository } from '../persistence/access.repository.js';
import { OrganizationRepository } from '../persistence/organization.repository.js';
import { PrismaService } from '../persistence/prisma.service.js';
import type { TenantScope } from '../persistence/tenant-context.js';
import { InvitationAccessService } from './invitation-access.service.js';
import { OffboardingService } from './offboarding.service.js';
import { UserAccessService } from './user-access.service.js';

/** A hard ceiling on rows per operation. */
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
@Injectable()
export class BulkOperationService {
  private readonly logger = new Logger(BulkOperationService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly access: AccessRepository,
    private readonly organization: OrganizationRepository,
    private readonly employment: EmploymentService,
    private readonly invitationAccess: InvitationAccessService,
    private readonly offboarding: OffboardingService,
    private readonly userAccess: UserAccessService,
    private readonly authorization: AuthorizationService,
    private readonly auditEvents: AuditEventService,
    private readonly securityEvents: SecurityEventPublisher,
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

    const validated = await Promise.all(
      parsed.map((row) => this.validateRow(input.scope, input.kind, row, context)),
    );

    const validRows = validated.filter((row) => row.errors.length === 0).length;

    return this.prisma.runInTenantTransaction(input.scope, async () => {
      const operation = await this.access.createBulkOperation(input.scope, {
        kind: input.kind,
        requestedByUserId: input.actorUserId,
        sourceFileName: input.sourceFileName,
        parameters: input.parameters ?? {},
        reason: input.reason,
        totalRows: parsed.length,
      });

      await this.access.createBulkRowsWithinCurrentScope(
        validated.map((row) => ({
          bulkOperationId: operation.id,
          tenantId: input.scope.tenantId,
          rowNumber: row.rowNumber,
          state: row.errors.length === 0 ? ('Valid' as const) : ('Invalid' as const),
          input: row.values,
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
          'something you cannot grant fails on its own rather than taking the file with it.',
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

  private async validateRow(
    scope: TenantScope,
    kind: BulkOperationKind,
    row: ParsedRow,
    _context: AuthorizationContext,
  ): Promise<ParsedRow & { errors: string[]; subjectUserId?: string }> {
    const errors: string[] = [];
    const values = row.values;
    let subjectUserId: string | undefined;

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
      const departmentName = require('department', 'Department');
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
        const departments = await this.organization.listDepartments(scope, false);
        const match = departments.find(
          (department) => department.name.toLowerCase() === departmentName.toLowerCase(),
        );
        if (!match) {
          errors.push(
            `Department "${departmentName}" does not exist in this company. Create it first, or ` +
              'correct the spelling.',
          );
        }
      }

      const employeeId = values['employeeId']?.trim() ?? '';
      if (employeeId !== '') {
        const clash = await this.organization.findEmploymentByEmployeeId(scope, employeeId);
        if (clash) {
          errors.push(`Employee ID "${employeeId}" is already used in this company.`);
        }
      }

      const managerName = values['reportingManager']?.trim() ?? '';
      if (managerName !== '') {
        const roster = await this.access.roster(scope);
        const matches = roster.filter(
          (person) => person.displayName.toLowerCase() === managerName.toLowerCase(),
        );

        // **`employmentState === 'Active'`, not merely "is a member".** Applying a row calls the
        // same `addEmployee` a single-record change uses, and that requires the manager to be
        // *employed here* — the composite foreign key guarantees it. Validating only membership
        // would let the preview say "valid" for a row that then fails, which makes the preview
        // worse than useless: it is the thing the operator agreed to.
        const employed = matches.filter((person) => person.employmentState === 'Active');

        if (matches.length === 0) {
          errors.push(
            `Reporting Manager "${managerName}" is not in this company. A manager from another ` +
              'company is impossible, not merely refused.',
          );
        } else if (employed.length === 0) {
          errors.push(
            `Reporting Manager "${managerName}" has no active employment record in this ` +
              'company, so they cannot be anybody’s manager. Add them as an employee first.',
          );
        } else if (employed.length > 1) {
          // Names are not unique, and picking one silently would assign the wrong manager.
          errors.push(
            `"${managerName}" matches ${employed.length} people in this company. Use their ` +
              'UBoss Unique ID in a "uboss unique id" column instead of a name.',
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

    return { ...row, errors, ...(subjectUserId === undefined ? {} : { subjectUserId }) };
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
        const departments = await this.organization.listDepartments(input.scope, false);
        const department = departments.find(
          (candidate) =>
            candidate.name.toLowerCase() === (values['department'] ?? '').trim().toLowerCase(),
        );
        const roster = await this.access.roster(input.scope);
        // Resolved the same way validation resolved it — employed here, not merely a member —
        // so a row that previewed as valid applies.
        const manager = roster.find(
          (person) =>
            person.employmentState === 'Active' &&
            person.displayName.toLowerCase() ===
              (values['reportingManager'] ?? '').trim().toLowerCase(),
        );

        await this.employment.addEmployee({
          scope: input.scope,
          actorUserId: input.actorUserId,
          employeeName: values['employeeName'] ?? '',
          employeeId: values['employeeId'] ?? '',
          designation: values['designation'] ?? '',
          departmentId: department?.id ?? '',
          reportingManagerUserId: manager?.userId ?? null,
          aadhaarNumber: values['aadhaarNumber'] ?? '',
          ...(values['email']?.trim() ? { workEmail: values['email'].trim() } : {}),
        });
        break;
      }

      case 'InviteOrResend': {
        const person = await this.findSubject(input.scope, values);
        await this.invitationAccess.inviteExistingPerson({
          scope: input.scope,
          actorUserId: input.actorUserId,
          subjectUserId: person,
          ...(values['email']?.trim() ? { workEmail: values['email'].trim() } : {}),
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
