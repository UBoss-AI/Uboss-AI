import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';

import { AuditEventService } from '../audit/audit-event.service.js';
import { AuthorizationService } from '../authorization/authorization.service.js';
import { SeatService } from '../commercial/seat.service.js';
import { OrganizationRepository } from '../persistence/organization.repository.js';
import { PrismaService } from '../persistence/prisma.service.js';
import type { TenantScope } from '../persistence/tenant-context.js';
import { PersonRegistryService } from './person-registry.service.js';

/**
 * The six mandatory Add Employee fields, in the client's order.
 *
 * Held as data so the API and the UI cannot disagree about which fields carry an asterisk. The
 * client is explicit in both directions: these six are required, and **every other profile field
 * is optional and must not show `*`**.
 */
export const MANDATORY_EMPLOYEE_FIELDS = [
  { key: 'employeeName', label: 'Employee Name' },
  { key: 'employeeId', label: 'Employee ID' },
  { key: 'designation', label: 'Designation' },
  { key: 'departmentId', label: 'Department' },
  { key: 'reportingManagerUserId', label: 'Reporting Manager' },
  { key: 'aadhaarNumber', label: 'Aadhaar Number' },
] as const;

export interface AddEmployeeResult {
  userId: string;
  /** The permanent identifier, shown on the result panel. */
  ubossUniqueId: string;
  /** True when an existing UBoss person was recognised rather than created. */
  matchedExistingPerson: boolean;
  employeeId: string;
  /** `XXXX XXXX 5510`. The number is not stored anywhere. */
  aadhaarMasked: string | null;
  /** Always `EnteredOnly`. There is no verified state in the system. */
  aadhaarAssurance: 'EnteredOnly';
  /** The seat position after this person was added. */
  seats: { used: number; ceiling: number | null; available: number | null };
  /**
   * Deliberately absent: no invitation was sent and no password exists. Stated as a field so the
   * screen can say so rather than leaving the reader to assume.
   */
  invitationSent: false;
}

/**
 * Adding, editing and ending employment.
 *
 * ## One transaction, five things
 *
 * Add Employee resolves or creates a global person, attaches their entered identifier, claims a
 * seat, creates the tenant membership and creates the employment record. All of it commits
 * together. A person created without an employment record would be a permanent UBoss identity
 * belonging to nobody; a membership without a seat claim would put the company over its
 * contracted ceiling silently.
 *
 * ## The reporting manager is mandatory, with exactly one exception
 *
 * The client lists Reporting Manager among the six required fields. The exception is structural
 * rather than a relaxation: the **first** person in a company has nobody to report to, so the
 * top of the tree is allowed to have none. The API says which case it is rather than accepting a
 * blank silently, and a second root requires it to be explicit.
 *
 * ## No Invite button here
 *
 * Adding somebody to the hierarchy does **not** invite them. The client's rule: the invitation
 * source is Settings → Users & Access, and a hierarchy node must not carry the primary Invite
 * button. So this creates a membership in `NotInvited` — a person the company knows about who
 * cannot sign in — and the result says `invitationSent: false` out loud.
 *
 * ## Seats are claimed, not assumed
 *
 * `SeatService.claimSeat` runs inside the same transaction under its per-tenant advisory lock
 * (ADR-060). Under the default counting rule a `NotInvited` membership costs nothing, so adding
 * people to the org chart is free and *inviting* them is what consumes a seat — which is the
 * behaviour a company building its structure before onboarding actually wants. The claim is made
 * anyway so a company whose rule counts differently is enforced correctly.
 */
@Injectable()
export class EmploymentService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly organization: OrganizationRepository,
    private readonly people: PersonRegistryService,
    private readonly seats: SeatService,
    private readonly authorization: AuthorizationService,
    private readonly auditEvents: AuditEventService,
  ) {}

  async addEmployee(input: {
    scope: TenantScope;
    actorUserId: string;
    employeeName: string;
    employeeId: string;
    designation: string;
    departmentId: string;
    /** Null only for the top of the tree — see the class comment. */
    reportingManagerUserId: string | null;
    aadhaarNumber: string;
    /** Optional, and unmarked in the UI. */
    workEmail?: string | undefined;
    workPhone?: string | undefined;
    joinedOn?: Date | undefined;
    employmentType?: string | undefined;
  }): Promise<AddEmployeeResult> {
    const context = await this.authorization.contextFor(input.scope, input.actorUserId);
    await this.authorization.assertCan(context, { module: 'hierarchy', action: 'Administer' });

    const employeeName = input.employeeName.trim();
    const employeeId = input.employeeId.trim();
    const designation = input.designation.trim();

    if (!employeeName || !employeeId || !designation) {
      throw new BadRequestException(
        'Employee Name, Employee ID and Designation are required and cannot be blank.',
      );
    }

    const department = await this.organization.findDepartment(input.scope, input.departmentId);
    if (!department) {
      throw new BadRequestException('That department does not exist in this company.');
    }
    if (department.archivedAt !== null) {
      throw new ConflictException(
        `"${department.name}" is archived, so nobody new can be assigned to it.`,
      );
    }

    const duplicateEmployeeId = await this.organization.findEmploymentByEmployeeId(
      input.scope,
      employeeId,
    );
    if (duplicateEmployeeId) {
      throw new ConflictException(
        `Employee ID "${employeeId}" is already used in this company. Company Employee IDs are ` +
          'unique within a company.',
      );
    }

    if (input.reportingManagerUserId !== null) {
      const manager = await this.organization.findEmployment(
        input.scope,
        input.reportingManagerUserId,
      );
      if (!manager) {
        throw new BadRequestException(
          'A reporting manager must already be employed by this company.',
        );
      }
      if (manager.state !== 'Active') {
        throw new ConflictException(
          'That person’s employment has ended, so they cannot be a reporting manager.',
        );
      }
    } else {
      // The one allowed exception, and it is checked rather than assumed: a company that already
      // has a root does not get a second one by leaving the field blank.
      const existing = await this.organization.listHierarchy(input.scope);
      const roots = existing.filter((row) => row.reportingManagerUserId === null);
      if (roots.length > 0) {
        throw new BadRequestException(
          'Reporting Manager is required. This company already has somebody at the top of the ' +
            `reporting tree (${roots[0]?.displayName}), so a second person with no manager ` +
            'would leave the chart with two disconnected roots.',
        );
      }
    }

    return this.prisma.runInTenantTransaction(input.scope, async () => {
      // 1. The global person: match an existing UBoss identity or create a new one.
      const person = await this.people.matchOrCreateWithinCurrentScope({
        tenantId: input.scope.tenantId,
        actorUserId: input.actorUserId,
        employeeName,
        aadhaarNumber: input.aadhaarNumber,
        workEmail: input.workEmail,
      });

      const alreadyEmployed = await this.prisma.client.employmentRecord.findFirst({
        where: { tenantId: input.scope.tenantId, userId: person.userId },
      });
      if (alreadyEmployed) {
        throw new ConflictException(
          person.matched
            ? 'That person already has an employment record in this company. Edit it instead of ' +
                'adding them again — one person has one employment record per company.'
            : 'That person already has an employment record in this company.',
        );
      }

      // 2. The seat claim, under the per-tenant advisory lock, before the membership is written.
      const membership = await this.prisma.client.tenantMembership.findFirst({
        where: { tenantId: input.scope.tenantId, userId: person.userId },
      });

      const seats = await this.seats.claimSeat({
        tenantId: input.scope.tenantId,
        targetState: 'NotInvited',
        alreadyCounted: membership !== null,
      });

      // 3. The membership, in `NotInvited`: known to the company, unable to sign in. No
      //    invitation is sent from here — that is Settings → Users & Access.
      if (!membership) {
        await this.prisma.client.tenantMembership.create({
          data: {
            tenantId: input.scope.tenantId,
            userId: person.userId,
            accountState: 'NotInvited',
          },
        });
      }

      // 4. The employment record.
      const employment = await this.organization.createEmployment(input.scope, {
        userId: person.userId,
        employeeId,
        designation,
        departmentId: input.departmentId,
        ...(input.reportingManagerUserId === null
          ? {}
          : { reportingManagerUserId: input.reportingManagerUserId }),
        ...(input.joinedOn === undefined ? {} : { joinedOn: input.joinedOn }),
        ...(input.employmentType === undefined
          ? {}
          : { employmentType: input.employmentType.trim() }),
        ...(input.workEmail === undefined ? {} : { workEmail: input.workEmail.trim() }),
        ...(input.workPhone === undefined ? {} : { workPhone: input.workPhone.trim() }),
      });

      // 5. The audit event, in the company's own trail.
      await this.auditEvents.appendWithinCurrentScope(input.scope.tenantId, {
        action: 'hierarchy.employee_added',
        resourceType: 'employment_record',
        resourceId: employment.id,
        resourceRef: employeeId,
        actorUserId: input.actorUserId,
        summary: `Added ${employeeName} as ${designation} in ${department.name}.`,
        metadata: {
          userId: person.userId,
          ubossUniqueId: person.ubossUniqueId,
          matchedExistingPerson: person.matched,
          departmentId: input.departmentId,
          reportingManagerUserId: input.reportingManagerUserId,
          // Both stated on the record, because both are questions somebody asks later.
          aadhaarAssurance: 'EnteredOnly',
          invitationSent: false,
        },
      });

      return {
        userId: person.userId,
        ubossUniqueId: person.ubossUniqueId,
        matchedExistingPerson: person.matched,
        employeeId,
        aadhaarMasked: person.aadhaarMasked,
        aadhaarAssurance: 'EnteredOnly' as const,
        seats: { used: seats.used, ceiling: seats.ceiling, available: seats.available },
        invitationSent: false as const,
      };
    });
  }

  /**
   * Edit the current company's fields on an employment record.
   *
   * Deliberately cannot touch the person's identity: not their name on the platform, not their
   * UBoss Unique ID, not their identifiers. One company must not be able to rewrite a person's
   * portable identity — and a second employer's data-entry mistake must not follow them.
   */
  async updateEmployment(input: {
    scope: TenantScope;
    actorUserId: string;
    subjectUserId: string;
    employeeId?: string | undefined;
    designation?: string | undefined;
    departmentId?: string | undefined;
    workEmail?: string | undefined;
    workPhone?: string | undefined;
    joinedOn?: Date | undefined;
    employmentType?: string | undefined;
  }): Promise<void> {
    const context = await this.authorization.contextFor(input.scope, input.actorUserId);
    await this.authorization.assertCan(context, { module: 'hierarchy', action: 'Administer' });

    const existing = await this.organization.findEmployment(input.scope, input.subjectUserId);
    if (!existing) {
      throw new NotFoundException('That person has no employment record in this company.');
    }

    if (input.departmentId !== undefined) {
      const department = await this.organization.findDepartment(input.scope, input.departmentId);
      if (!department || department.archivedAt !== null) {
        throw new BadRequestException(
          'That department does not exist in this company, or is archived.',
        );
      }
    }

    if (input.employeeId !== undefined && input.employeeId.trim() !== existing.employeeId) {
      const clash = await this.organization.findEmploymentByEmployeeId(
        input.scope,
        input.employeeId.trim(),
      );
      if (clash) {
        throw new ConflictException(
          `Employee ID "${input.employeeId.trim()}" is already used in this company.`,
        );
      }
    }

    const data: Record<string, unknown> = {};
    for (const [key, value] of [
      ['employeeId', input.employeeId?.trim()],
      ['designation', input.designation?.trim()],
      ['departmentId', input.departmentId],
      ['employmentType', input.employmentType?.trim()],
      ['workEmail', input.workEmail?.trim()],
      ['workPhone', input.workPhone?.trim()],
    ] as const) {
      if (value !== undefined) {
        data[key] = value === '' ? null : value;
      }
    }
    if (input.joinedOn !== undefined) {
      data['joinedOn'] = input.joinedOn;
    }

    if (Object.keys(data).length === 0) {
      return;
    }

    await this.prisma.runInTenantTransaction(input.scope, async () => {
      const changed = await this.organization.updateEmployment(
        input.scope,
        input.subjectUserId,
        data,
      );
      if (changed !== 1) {
        throw new ConflictException('That employment record changed while you were editing it.');
      }

      await this.auditEvents.appendWithinCurrentScope(input.scope.tenantId, {
        action: 'hierarchy.employment_updated',
        resourceType: 'employment_record',
        resourceId: existing.id,
        resourceRef: existing.employeeId,
        resourceVersion: existing.version,
        actorUserId: input.actorUserId,
        summary: 'Updated employment details for this company.',
        metadata: { fields: Object.keys(data).join(',') },
      });
    });
  }

  /**
   * One person's profile as this company may see it.
   *
   * The masked Aadhaar and nothing more of it. No other company's employment appears here — the
   * cross-company professional summary is the authorized UBoss Profile Search, keyed on the
   * UBoss Unique ID and never on Aadhaar, and it is a separate permission.
   */
  async profileFor(input: {
    scope: TenantScope;
    actorUserId: string;
    subjectUserId: string;
  }): Promise<Record<string, unknown>> {
    const context = await this.authorization.contextFor(input.scope, input.actorUserId);
    await this.authorization.assertCan(context, { module: 'hierarchy', action: 'View' });

    // The same scoping rule as the hierarchy list: the employment identity is directory
    // information, the entered identifier is not. Withheld by omission, so a screen cannot show
    // a blank and imply there is nothing on record.
    const maySeeIdentifier =
      input.subjectUserId === input.actorUserId ||
      (
        await this.authorization.authorize(context, {
          module: 'hierarchy',
          action: 'Administer',
        })
      ).allowed;

    const rows = await this.organization.listHierarchy(input.scope);
    const row = rows.find((candidate) => candidate.userId === input.subjectUserId);
    if (!row) {
      throw new NotFoundException('That person has no employment record in this company.');
    }

    const employment = await this.organization.findEmployment(input.scope, input.subjectUserId);

    return {
      userId: row.userId,
      displayName: row.displayName,
      ubossUniqueId: row.ubossUniqueId,
      employeeId: row.employeeId,
      designation: row.designation,
      departmentId: row.departmentId,
      departmentName: row.departmentName,
      reportingManagerUserId: row.reportingManagerUserId,
      reportingManagerName: row.reportingManagerName,
      employmentState: row.state,
      accountState: row.accountState,
      joinedOn: employment?.joinedOn?.toISOString() ?? null,
      employmentType: employment?.employmentType ?? null,
      workEmail: employment?.workEmail ?? null,
      workPhone: employment?.workPhone ?? null,
      ...(maySeeIdentifier
        ? {
            aadhaarMasked: row.aadhaarLastFour === null ? null : `XXXX XXXX ${row.aadhaarLastFour}`,
            // Never `Verified` — the enum has no such value, so no response can carry one.
            aadhaarAssurance: row.aadhaarLastFour === null ? null : 'EnteredOnly',
          }
        : {}),
      identifierVisible: maySeeIdentifier,
      identityNote:
        'The Company Employee ID belongs to this company; the UBoss Unique ID is permanent and ' +
        'portable. Aadhaar was entered for matching only and is not verified.',
    };
  }
}
