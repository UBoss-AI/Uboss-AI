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
 * The mandatory Add Employee fields, in the client's order.
 *
 * Held as data so the API and the UI cannot disagree about which fields carry an asterisk. The
 * client is explicit in both directions: these are required, and **every other profile field
 * is optional and must not show `*`**.
 */
export const MANDATORY_EMPLOYEE_FIELDS = [
  { key: 'employeeName', label: 'Employee Name' },
  { key: 'employeeId', label: 'Employee ID' },
  { key: 'designation', label: 'Designation' },
  { key: 'departmentId', label: 'Department' },
  { key: 'reportingManagerUserId', label: 'Reporting Manager' },
  /*
   * A way to reach the person, required from CR-04.
   *
   * They were optional, and the consequence was a hierarchy full of people nobody could contact:
   * work is handed over by email and chased by phone, and a record that names neither describes
   * an employee the company cannot actually reach.
   *
   * **Where each is enforced is no longer the same**, and this list is what the single-employee
   * route promises, so both belong here. `workPhone` is refused by `addEmployee` itself, so every
   * path including a bulk import must carry one. `workEmail` is refused by `AddEmployeeDto` — the
   * door this list describes — and not by the service, because the client asked that a company
   * importing its existing roster not have the whole file refused for the addresses it does not
   * have yet. A spreadsheet reaches the service without passing that DTO, which is why the two
   * can differ without either being a lie.
   */
  { key: 'workEmail', label: 'Work Email' },
  { key: 'workPhone', label: 'Work Phone' },
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
 * The client lists Reporting Manager among the required fields. The exception is structural
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
    /**
     * What this person covers, beyond their job title.
     *
     * The Add Employee form asks for it and marks it required; it is optional here because the
     * importer does not demand it and a record created before the column existed does not have
     * one. The surface that asks is the surface that enforces.
     */
    specialization?: string | undefined;
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

    /*
     * A work phone is required. A work email is taken when given.
     *
     * Both were required until the client asked otherwise: a company importing its existing
     * roster often has no work address for everybody, and refusing those rows refuses the whole
     * import. The rule it leaves behind is still the one that mattered — a company must be able
     * to reach an employee — and a phone number satisfies it.
     *
     * Relaxed **here** rather than only in the importer, deliberately. Every bulk row is applied
     * through this method, which is what stops a bulk path from becoming a way around the gates;
     * a flag that let an import skip a rule the form still enforced would be exactly that way
     * around, and the next rule would follow it.
     *
     * The Add Employee form still asks for an email and will not submit without one. That is the
     * form's own rule, and honest: its asterisk means "this screen needs it", which is true.
     *
     * Checked for shape rather than validated hard: an address is proven by sending to it and a
     * number by calling it, and neither happens here. What this refuses is the obviously-not-one,
     * which is the difference between a record somebody can act on and a record that merely has
     * the field filled.
     */
    const workEmail = (input.workEmail ?? '').trim();
    const workPhone = (input.workPhone ?? '').trim();
    if (!workPhone) {
      throw new BadRequestException(
        'Work Phone is required. Work is chased by phone, and an employee the company cannot ' +
          'reach is not a record worth keeping.',
      );
    }
    // Only when one was given. Without the guard, dropping the blank check above would leave the
    // shape check refusing every blank anyway — the rule removed in one line and kept in the next.
    if (
      workEmail !== '' &&
      (!workEmail.includes('@') || workEmail.startsWith('@') || workEmail.endsWith('@'))
    ) {
      throw new BadRequestException('That does not look like an email address.');
    }
    if (workPhone.replace(/[^0-9]/g, '').length < 7) {
      throw new BadRequestException('That does not look like a phone number.');
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

    await this.assertReportingManager(input.scope, input.reportingManagerUserId);

    return this.prisma.runInTenantTransaction(input.scope, async () => {
      // 1. The global person: match an existing UBoss identity or create a new one.
      const person = await this.people.matchOrCreateWithinCurrentScope({
        tenantId: input.scope.tenantId,
        actorUserId: input.actorUserId,
        employeeName,
        aadhaarNumber: input.aadhaarNumber,
        workEmail: input.workEmail,
      });

      return this.writeEmployment({
        scope: input.scope,
        actorUserId: input.actorUserId,
        person,
        employeeName,
        employeeId,
        designation,
        departmentName: department.name,
        departmentId: input.departmentId,
        reportingManagerUserId: input.reportingManagerUserId,
        ...(input.specialization === undefined ? {} : { specialization: input.specialization }),
        ...(input.workEmail === undefined ? {} : { workEmail: input.workEmail }),
        ...(input.workPhone === undefined ? {} : { workPhone: input.workPhone }),
        ...(input.joinedOn === undefined ? {} : { joinedOn: input.joinedOn }),
        ...(input.employmentType === undefined ? {} : { employmentType: input.employmentType }),
      });
    });
  }

  /**
   * Who this person reports to — and the one case where nobody is the right answer.
   *
   * The client lists Reporting Manager among the required fields. The exception is structural
   * rather than a relaxation: the **first** person in a company has nobody to report to. A
   * second root is refused, because a chart with two disconnected tops is not a hierarchy.
   */
  private async assertReportingManager(
    scope: TenantScope,
    reportingManagerUserId: string | null,
  ): Promise<void> {
    if (reportingManagerUserId !== null) {
      const manager = await this.organization.findEmployment(scope, reportingManagerUserId);
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
      return;
    }

    // Checked rather than assumed: a company that already has a root does not get a second one
    // by leaving the field blank.
    const existing = await this.organization.listHierarchy(scope);
    const roots = existing.filter((row) => row.reportingManagerUserId === null);
    if (roots.length > 0) {
      throw new BadRequestException(
        'Reporting Manager is required. This company already has somebody at the top of the ' +
          `reporting tree (${roots[0]?.displayName}), so a second person with no manager ` +
          'would leave the chart with two disconnected roots.',
      );
    }
  }

  /**
   * The part that is the same however the person was found: seat, membership, record, audit.
   *
   * Runs inside the caller's tenant transaction. Shared by Add Employee and by employing an
   * existing account, because the difference between those two is **only** how the person is
   * resolved — and a second copy of this is how one path quietly stops claiming a seat.
   */
  private async writeEmployment(input: {
    scope: TenantScope;
    actorUserId: string;
    person: {
      userId: string;
      ubossUniqueId: string;
      matched: boolean;
      aadhaarMasked: string | null;
    };
    employeeName: string;
    employeeId: string;
    designation: string;
    departmentName: string;
    departmentId: string;
    reportingManagerUserId: string | null;
    specialization?: string | undefined;
    workEmail?: string | undefined;
    workPhone?: string | undefined;
    joinedOn?: Date | undefined;
    employmentType?: string | undefined;
  }): Promise<AddEmployeeResult> {
    const { person } = input;
    {
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
        employeeId: input.employeeId,
        designation: input.designation,
        ...(input.specialization === undefined
          ? {}
          : { specialization: input.specialization.trim() }),
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
        resourceRef: input.employeeId,
        actorUserId: input.actorUserId,
        summary: `Added ${input.employeeName} as ${input.designation} in ${input.departmentName}.`,
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
        employeeId: input.employeeId,
        aadhaarMasked: person.aadhaarMasked,
        aadhaarAssurance: 'EnteredOnly' as const,
        seats: { used: seats.used, ceiling: seats.ceiling, available: seats.available },
        invitationSent: false as const,
      };
    }
  }

  /**
   * Employ somebody who already has an account in this company.
   *
   * ## Why this exists
   *
   * An administrator is invited before the org chart exists — that is the normal order, and it
   * leaves them a member of the company with no employment record. When the roster is imported
   * later, their own row is refused, and so is every row naming them as a manager, because the
   * import will not quietly reuse an account it found by matching a typed address. The refusal
   * told the operator to "employ that account from the Users screen", and **there was no such
   * action anywhere in the product**: `addEmployee` was the only way to create an employment
   * record, and it always creates a person. So the only way out was to import the same human a
   * second time under a blanked address — two UBoss identities for one person, permanently.
   *
   * ## Why it is safe where matching on an address is not
   *
   * The operator names the **person**, by id, chosen from the people this company already has.
   * Nothing is inferred from a string somebody typed, so a mistyped address cannot attach this
   * row's identifier to a colleague. That is the whole distinction, and it is why this is a
   * separate deliberate act rather than a fallback inside Add Employee.
   *
   * Everything after that is `addEmployee`'s own work and is not repeated here: the seat claim,
   * the employment record, the audit event, and the rule that a second root must be explicit.
   */
  async employExistingAccount(input: {
    scope: TenantScope;
    actorUserId: string;
    /** Somebody who is already a member of this company and has no employment record. */
    subjectUserId: string;
    employeeId: string;
    designation: string;
    departmentId: string;
    reportingManagerUserId: string | null;
    aadhaarNumber: string;
    specialization?: string | undefined;
    workEmail?: string | undefined;
    workPhone?: string | undefined;
    joinedOn?: Date | undefined;
    employmentType?: string | undefined;
  }): Promise<AddEmployeeResult> {
    const context = await this.authorization.contextFor(input.scope, input.actorUserId);
    await this.authorization.assertCan(context, { module: 'hierarchy', action: 'Administer' });

    const subject = await this.prisma.runInTenantTransaction(input.scope, async () => {
      const membership = await this.prisma.client.tenantMembership.findFirst({
        where: { tenantId: input.scope.tenantId, userId: input.subjectUserId },
        select: { id: true },
      });
      if (!membership) return null;

      return this.prisma.client.user.findUnique({
        where: { id: input.subjectUserId },
        select: { id: true, displayName: true, email: true },
      });
    });

    if (!subject) {
      throw new NotFoundException(
        'That person does not have an account in this company, so there is nothing to employ. ' +
          'Use Add Employee instead.',
      );
    }

    const alreadyEmployed = await this.organization.findEmployment(
      input.scope,
      input.subjectUserId,
    );
    if (alreadyEmployed) {
      throw new ConflictException(
        `${subject.displayName} already has an employment record in this company. Edit it ` +
          'instead — one person has one employment record per company.',
      );
    }

    /*
     * Their own address, when the caller did not send one.
     *
     * The person already has a login handle and it is almost always the work address the
     * operator would type anyway. Defaulting to it means the employment record carries a way to
     * reach them rather than a blank, and it cannot collide with anything, because it is
     * already theirs.
     */
    const workEmail = input.workEmail?.trim() || subject.email;
    const workPhone = (input.workPhone ?? '').trim();
    if (!workPhone) {
      throw new BadRequestException(
        'Work Phone is required. Work is chased by phone, and an employee the company cannot ' +
          'reach is not a record worth keeping.',
      );
    }

    const employeeId = input.employeeId.trim();
    const designation = input.designation.trim();
    if (!employeeId || !designation) {
      throw new BadRequestException(
        'Employee ID and Designation are required and cannot be blank.',
      );
    }

    const department = await this.organization.findDepartment(input.scope, input.departmentId);
    if (!department || department.archivedAt !== null) {
      throw new BadRequestException(
        'That department does not exist in this company, or is archived.',
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

    // The same reporting rule as Add Employee, and for the same reason: a manager who is not
    // employed here cannot be one, and a second root has to be asked for rather than left blank.
    await this.assertReportingManager(input.scope, input.reportingManagerUserId);

    return this.prisma.runInTenantTransaction(input.scope, async () => {
      const identifier = await this.people.attachIdentifierToKnownPersonWithinCurrentScope({
        tenantId: input.scope.tenantId,
        actorUserId: input.actorUserId,
        userId: subject.id,
        aadhaarNumber: input.aadhaarNumber,
      });

      return this.writeEmployment({
        scope: input.scope,
        actorUserId: input.actorUserId,
        person: {
          userId: subject.id,
          // Read back inside the transaction rather than carried: the permanent id is the one
          // thing here that must be the person's own and not a value assembled on the way in.
          ubossUniqueId:
            (
              await this.prisma.client.user.findUnique({
                where: { id: subject.id },
                select: { ubossUniqueId: true },
              })
            )?.ubossUniqueId ?? '',
          matched: true,
          aadhaarMasked: identifier.aadhaarMasked,
        },
        employeeName: subject.displayName,
        employeeId,
        designation,
        departmentName: department.name,
        departmentId: input.departmentId,
        reportingManagerUserId: input.reportingManagerUserId,
        ...(input.specialization === undefined ? {} : { specialization: input.specialization }),
        workEmail,
        workPhone,
        ...(input.joinedOn === undefined ? {} : { joinedOn: input.joinedOn }),
        ...(input.employmentType === undefined ? {} : { employmentType: input.employmentType }),
      });
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
    /**
     * Their name, corrected.
     *
     * This is the one field here that is **not** employment. A person has one name across every
     * company they work in — `User.displayName` is global, like their UBoss ID — so correcting
     * a misspelling here corrects it everywhere, and there is no other honest way to do it: a
     * per-company name would mean the same human appearing under two spellings and no way to
     * tell which is right.
     *
     * It is still an administrator's act in this company, gated on the same `hierarchy:Administer`
     * as the rest, and it is audited. What it is not is a way to rename somebody into somebody
     * else: the UBoss ID, the employment history and the audit trail all stay attached.
     */
    displayName?: string | undefined;
    employeeId?: string | undefined;
    designation?: string | undefined;
    departmentId?: string | undefined;
    specialization?: string | undefined;
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

    /*
     * The name is written to the person, not to the employment.
     *
     * Separately from the employment update below and before it, so a failure to write the name
     * does not leave a half-applied correction — and because they are genuinely two records: one
     * describes a human, the other describes a job.
     */
    if (input.displayName !== undefined) {
      const name = input.displayName.trim();
      if (name.length < 2) {
        throw new BadRequestException('A name needs at least two characters.');
      }
      await this.prisma.client.user.update({
        where: { id: input.subjectUserId },
        data: { displayName: name, version: { increment: 1 } },
      });
    }

    const data: Record<string, unknown> = {};
    for (const [key, value] of [
      ['employeeId', input.employeeId?.trim()],
      ['designation', input.designation?.trim()],
      ['departmentId', input.departmentId],
      ['specialization', input.specialization?.trim()],
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

    /*
     * Your own record is yours; somebody else's needs the Hierarchy module.
     *
     * This asserted `hierarchy:View` for every profile including the caller's own, which was
     * harmless while every role template carried that grant. CR-03 §9 took it away from a standard
     * Employee — they get Dashboard, To-do, their agents, Approvals, Chat and Settings — and the
     * effect was that an Employee could no longer open **their own** profile, which §11 gives them
     * as My Profile. The verification gate caught it; a targeted test run had not.
     *
     * So the grant is required for reading about other people, which is what it is for, and the
     * self case is allowed on identity. Nothing else about the response changes: the masked
     * identifier is still withheld from anybody who is neither the subject nor an administrator.
     */
    const isSelf = input.subjectUserId === input.actorUserId;
    if (!isSelf) {
      await this.authorization.assertCan(context, { module: 'hierarchy', action: 'View' });
    }

    // The same scoping rule as the hierarchy list: the employment identity is directory
    // information, the entered identifier is not. Withheld by omission, so a screen cannot show
    // a blank and imply there is nothing on record.
    const maySeeIdentifier =
      isSelf ||
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
      specialization: employment?.specialization ?? null,
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
