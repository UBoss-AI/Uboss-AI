import {
  Body,
  Controller,
  Get,
  Param,
  ParseUUIDPipe,
  Post,
  Put,
  Query,
  Res,
  UnauthorizedException,
} from '@nestjs/common';
import type { Response } from 'express';
import { Type } from 'class-transformer';
import {
  IsBoolean,
  IsInt,
  IsISO8601,
  IsOptional,
  IsString,
  IsUUID,
  Matches,
  Max,
  MaxLength,
  Min,
  MinLength,
} from 'class-validator';

import { RequirePermission } from '../authorization/authorization.decorators.js';
import { actorUserId } from '../request-context/authenticated-actor.js';
import { getActor } from '../request-context/request-context.js';
import { TenantScoped } from '../tenancy/tenancy.decorators.js';
import { TenantContextService } from '../tenancy/tenant-context.service.js';
import { DepartmentService } from './department.service.js';
import { EmploymentService, MANDATORY_EMPLOYEE_FIELDS } from './employment.service.js';
import { HierarchyService } from './hierarchy.service.js';

export class CreateDepartmentDto {
  @IsString()
  @MinLength(2)
  @MaxLength(160)
  name!: string;

  @IsOptional()
  @IsString()
  @MaxLength(20)
  code?: string;

  @IsOptional()
  @IsUUID()
  parentDepartmentId?: string;

  @IsOptional()
  @IsUUID()
  headUserId?: string;

  @IsOptional()
  @IsString()
  @MaxLength(500)
  description?: string;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  @Max(10_000)
  sortOrder?: number;
}

export class UpdateDepartmentDto {
  @IsOptional()
  @IsString()
  @MinLength(2)
  @MaxLength(160)
  name?: string;

  @IsOptional()
  @IsString()
  @MaxLength(20)
  code?: string;

  @IsOptional()
  @IsUUID()
  parentDepartmentId?: string;

  @IsOptional()
  @IsUUID()
  headUserId?: string;

  @IsOptional()
  @IsString()
  @MaxLength(500)
  description?: string;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  @Max(10_000)
  sortOrder?: number;
}

export class ArchiveDepartmentDto {
  @IsString()
  @MinLength(5, { message: 'reason must say why this department is being archived.' })
  @MaxLength(500)
  reason!: string;
}

/**
 * Add Employee — the client's mandatory fields, then the optional ones.
 *
 * They are required in the DTO with no default and no fallback, so a payload missing any of
 * them is a 400 rather than a partially-created employee. The optional fields are optional in
 * the DTO **and** unmarked in the UI, which is the other half of the client's rule.
 *
 * `aadhaarNumber` is accepted as typed, with or without separators, and is **never stored**: the
 * service normalises it, derives a keyed match hash and the last four digits, and discards the
 * rest. There is no column it could be written to.
 */
export class AddEmployeeDto {
  @IsString()
  @MinLength(2)
  @MaxLength(200)
  employeeName!: string;

  @IsString()
  @MinLength(1)
  @MaxLength(40)
  employeeId!: string;

  @IsString()
  @MinLength(2)
  @MaxLength(160)
  designation!: string;

  @IsUUID()
  departmentId!: string;

  /**
   * Required by the client's field list. `null` is accepted **only** for the first person in a
   * company, who has nobody to report to; the service refuses a second root.
   */
  @IsOptional()
  @IsUUID()
  reportingManagerUserId?: string | null;

  /** Twelve digits, separators allowed. Format-checked, never verified, never stored. */
  @IsString()
  @Matches(/^[0-9\s-]{12,20}$/, {
    message: 'Aadhaar Number must be twelve digits; spaces and dashes are allowed.',
  })
  aadhaarNumber!: string;

  /*
   * A way to reach the person. Required from CR-04, so they sit with the other mandatory fields
   * rather than under the optional heading below: the DTO refuses a payload without them, which
   * is the check a screen cannot skip.
   */
  @IsString()
  @MinLength(3)
  @MaxLength(320)
  workEmail!: string;

  @IsString()
  @MinLength(7)
  @MaxLength(40)
  workPhone!: string;

  // ---- Optional. No asterisk in the UI. ----

  @IsOptional()
  @IsISO8601()
  joinedOn?: string;

  @IsOptional()
  @IsString()
  @MaxLength(60)
  employmentType?: string;

  /**
   * What they cover, beyond the title — sub-departments, areas, disciplines.
   *
   * `@IsOptional()` although the form marks it required. The form is where a person is asked and
   * is therefore where the asking is enforced; the importer does not demand it, and a record
   * written before this column existed has none. A DTO that refused the field's absence would
   * break both.
   */
  @IsOptional()
  @IsString()
  @MaxLength(300)
  specialization?: string;
}

export class UpdateEmploymentDto {
  /**
   * Their name, corrected.
   *
   * The one field here that is not employment: a person has one name across every company they
   * work in, so this corrects it everywhere. A misspelling has to be fixable, and a per-company
   * name would mean the same human under two spellings with no way to tell which is right.
   */
  @IsOptional()
  @IsString()
  @MinLength(2)
  @MaxLength(200)
  displayName?: string;

  @IsOptional()
  @IsString()
  @MinLength(1)
  @MaxLength(40)
  employeeId?: string;

  @IsOptional()
  @IsString()
  @MinLength(2)
  @MaxLength(160)
  designation?: string;

  @IsOptional()
  @IsUUID()
  departmentId?: string;

  @IsOptional()
  @IsString()
  @MaxLength(320)
  workEmail?: string;

  @IsOptional()
  @IsString()
  @MaxLength(40)
  workPhone?: string;

  @IsOptional()
  @IsISO8601()
  joinedOn?: string;

  @IsOptional()
  @IsString()
  @MaxLength(60)
  employmentType?: string;

  /**
   * What they cover, beyond the title — sub-departments, areas, disciplines.
   *
   * `@IsOptional()` although the form marks it required. The form is where a person is asked and
   * is therefore where the asking is enforced; the importer does not demand it, and a record
   * written before this column existed has none. A DTO that refused the field's absence would
   * break both.
   */
  @IsOptional()
  @IsString()
  @MaxLength(300)
  specialization?: string;
}

export class ChangeReportingManagerDto {
  /**
   * Omit or send `null` to detach the person, making them a root of their department.
   *
   * Optional rather than nullable-required because a detach is a deliberate act and the reason
   * field carries the explanation.
   */
  @IsOptional()
  @IsUUID()
  newManagerUserId?: string | null;

  @IsOptional()
  @IsString()
  @MaxLength(500)
  reason?: string;
}

/** A picture for the company Vision or Mission -- PRD 2.3. Base64, like every upload here. */
export class UploadCompanyImageDto {
  @IsString() @MaxLength(260) filename!: string;
  @IsString() @MaxLength(100) contentType!: string;
  @IsString() contentBase64!: string;
}

/**
 * The Vision and Mission, as formatted text.
 *
 * ## Two limits, measuring two different things
 *
 * `@MaxLength` here is the ceiling on the **document**, and it is generous because markup is
 * mostly markup: one coloured, sized span costs about fifty characters before a word is typed.
 * It is a guard against somebody posting a megabyte, not a limit anybody writing a Vision will
 * meet.
 *
 * The limit that a person can perceive is on the **words**, and it is checked in the service
 * after the tags have been removed — because a Vision of forty words is forty words whether it
 * is plain or set in three faces, and refusing the formatted one would be refusing the
 * formatting rather than the length.
 *
 * Neither is a security control. What makes this safe to put back on a page is
 * `sanitiseRichText`, which the service runs before anything is stored.
 */
export class UpdateCompanyIdentityDto {
  @IsOptional()
  @IsString()
  @MaxLength(20_000)
  vision?: string;

  @IsOptional()
  @IsString()
  @MaxLength(20_000)
  mission?: string;
}

export class HierarchyQueryDto {
  @IsOptional()
  @Type(() => Boolean)
  @IsBoolean()
  includeArchived?: boolean;
}

/**
 * The Organization Hierarchy — departments, reporting relationships and employment records.
 *
 * Every route is `@TenantScoped` with a `@RequirePermission`, so the tenant comes from verified
 * membership and the permission is checked server-side. Reading the hierarchy needs
 * `hierarchy:View`, which every company role holds; changing it needs `hierarchy:Administer`,
 * because a reporting-line change alters what a `TeamSubtree`-scoped manager can reach.
 *
 * **There is deliberately no invite route here.** The client's rule is that the invitation source
 * is Settings → Users & Access and a hierarchy node must not carry the primary Invite button.
 * Adding an employee creates a person the company knows about who cannot sign in.
 */
@Controller('tenants/:tenantId/organization')
@TenantScoped()
export class OrganizationController {
  constructor(
    private readonly hierarchy: HierarchyService,
    private readonly departments: DepartmentService,
    private readonly employment: EmploymentService,
    private readonly tenantContext: TenantContextService,
  ) {}

  /** Vision, Mission, departments, the tree and the list — the whole screen in one call. */
  @Get('hierarchy')
  @RequirePermission({ module: 'hierarchy', action: 'View' })
  async hierarchyView(): Promise<unknown> {
    return this.hierarchy.viewFor(this.tenantContext.requireScope(), this.currentUserId());
  }

  /** The mandatory field keys and labels, served so the form cannot drift from the API. */
  @Get('employee-fields')
  @RequirePermission({ module: 'hierarchy', action: 'View' })
  mandatoryFields(): unknown {
    return {
      mandatory: MANDATORY_EMPLOYEE_FIELDS,
      note:
        'Exactly these fields are mandatory. Every other profile field is optional and must ' +
        'not be marked with an asterisk. Aadhaar Number is an entered-only matching input: ' +
        'there is no OTP, no verification, and no state in UBoss that can claim it is verified.',
    };
  }

  @Get('departments')
  @RequirePermission({ module: 'hierarchy', action: 'View' })
  async listDepartments(@Query() query: HierarchyQueryDto): Promise<unknown> {
    const departments = await this.departments.list(
      this.tenantContext.requireScope(),
      this.currentUserId(),
      query.includeArchived ?? false,
    );
    return { departments };
  }

  @Post('departments')
  @RequirePermission({ module: 'hierarchy', action: 'Administer' })
  async createDepartment(@Body() body: CreateDepartmentDto): Promise<unknown> {
    const department = await this.departments.create({
      scope: this.tenantContext.requireScope(),
      actorUserId: this.currentUserId(),
      name: body.name,
      code: body.code,
      parentDepartmentId: body.parentDepartmentId,
      headUserId: body.headUserId,
      description: body.description,
      sortOrder: body.sortOrder,
    });
    return { id: department.id, name: department.name };
  }

  @Put('departments/:departmentId')
  @RequirePermission({ module: 'hierarchy', action: 'Administer' })
  async updateDepartment(
    @Param('departmentId', new ParseUUIDPipe()) departmentId: string,
    @Body() body: UpdateDepartmentDto,
  ): Promise<unknown> {
    const department = await this.departments.update({
      scope: this.tenantContext.requireScope(),
      actorUserId: this.currentUserId(),
      departmentId,
      name: body.name,
      code: body.code,
      parentDepartmentId: body.parentDepartmentId,
      headUserId: body.headUserId,
      description: body.description,
      sortOrder: body.sortOrder,
    });
    return { id: department.id, name: department.name };
  }

  /** Archive, never delete. Historical employment keeps pointing at a department that exists. */
  @Post('departments/:departmentId/archive')
  @RequirePermission({ module: 'hierarchy', action: 'Administer' })
  async archiveDepartment(
    @Param('departmentId', new ParseUUIDPipe()) departmentId: string,
    @Body() body: ArchiveDepartmentDto,
  ): Promise<unknown> {
    await this.departments.archive({
      scope: this.tenantContext.requireScope(),
      actorUserId: this.currentUserId(),
      departmentId,
      reason: body.reason,
    });
    return { id: departmentId, archived: true, nothingDeleted: true };
  }

  /**
   * Add an employee. Six mandatory fields, one transaction, no invitation.
   *
   * The response carries the permanent UBoss Unique ID, whether an existing person was matched,
   * the masked identifier, and `invitationSent: false`.
   */
  @Post('employees')
  @RequirePermission({ module: 'hierarchy', action: 'Administer' })
  async addEmployee(@Body() body: AddEmployeeDto): Promise<unknown> {
    return this.employment.addEmployee({
      scope: this.tenantContext.requireScope(),
      actorUserId: this.currentUserId(),
      employeeName: body.employeeName,
      employeeId: body.employeeId,
      designation: body.designation,
      departmentId: body.departmentId,
      reportingManagerUserId: body.reportingManagerUserId ?? null,
      aadhaarNumber: body.aadhaarNumber,
      workEmail: body.workEmail,
      workPhone: body.workPhone,
      ...(body.joinedOn === undefined ? {} : { joinedOn: new Date(body.joinedOn) }),
      employmentType: body.employmentType,
      specialization: body.specialization,
    });
  }

  /** One person's profile, as this company may see it. Masked identifier only. */
  @Get('employees/:userId')
  @RequirePermission({ module: 'hierarchy', action: 'View' })
  async employeeProfile(@Param('userId', new ParseUUIDPipe()) userId: string): Promise<unknown> {
    return this.employment.profileFor({
      scope: this.tenantContext.requireScope(),
      actorUserId: this.currentUserId(),
      subjectUserId: userId,
    });
  }

  /** Edit this company's employment fields. Cannot touch the person's portable identity. */
  @Put('employees/:userId')
  @RequirePermission({ module: 'hierarchy', action: 'Administer' })
  async updateEmployment(
    @Param('userId', new ParseUUIDPipe()) userId: string,
    @Body() body: UpdateEmploymentDto,
  ): Promise<unknown> {
    await this.employment.updateEmployment({
      scope: this.tenantContext.requireScope(),
      actorUserId: this.currentUserId(),
      subjectUserId: userId,
      displayName: body.displayName,
      employeeId: body.employeeId,
      designation: body.designation,
      departmentId: body.departmentId,
      workEmail: body.workEmail,
      workPhone: body.workPhone,
      ...(body.joinedOn === undefined ? {} : { joinedOn: new Date(body.joinedOn) }),
      employmentType: body.employmentType,
      specialization: body.specialization,
    });
    return { userId, updated: true };
  }

  /** Move somebody in the reporting tree. Cycles are refused with the reason named. */
  @Post('employees/:userId/reporting-manager')
  @RequirePermission({ module: 'hierarchy', action: 'Administer' })
  async changeReportingManager(
    @Param('userId', new ParseUUIDPipe()) userId: string,
    @Body() body: ChangeReportingManagerDto,
  ): Promise<unknown> {
    await this.hierarchy.changeReportingManager({
      scope: this.tenantContext.requireScope(),
      actorUserId: this.currentUserId(),
      subjectUserId: userId,
      newManagerUserId: body.newManagerUserId ?? null,
      reason: body.reason,
    });
    return { userId, reportingManagerUserId: body.newManagerUserId ?? null };
  }

  /**
   * The company's Vision and Mission, which the hierarchy screen displays above the tree.
   *
   * `settings:Administer`, not `hierarchy:Administer`: this is company identity rather than
   * structure. Settings → Organization will host the editing form at Prompt 14; the endpoint is
   * here because the hierarchy is the screen that displays it and an always-empty strip would be
   * indistinguishable from a broken one.
   */
  /**
   * Store a picture for the Vision or Mission -- PRD 2.3.
   *
   * `settings:Administer`, the same grant as editing the text it goes into. The service checks it
   * again and marks the file, which is what lets the next route serve it to everybody.
   */
  @Post('company-images')
  @RequirePermission({ module: 'settings', action: 'Administer' })
  async uploadCompanyImage(@Body() body: UploadCompanyImageDto): Promise<unknown> {
    return this.hierarchy.uploadIdentityImage({
      scope: this.tenantContext.requireScope(),
      actorUserId: this.currentUserId(),
      filename: body.filename,
      contentType: body.contentType,
      contentBase64: body.contentBase64,
    });
  }

  /**
   * Serve one, as bytes, to anybody who may open the Hierarchy.
   *
   * No `@RequirePermission`: the rule is `hierarchy:View` **and** the file carrying the identity
   * mark, and the second half is not something a route decorator can express. The service checks
   * both, and a file missing either is a 404 — the caller has no business learning the id exists.
   *
   * `@Res()` without `passthrough`, like the employee photo route: this handler owns the response
   * because it writes bytes and their content type rather than returning an object.
   */
  @Get('company-images/:fileId')
  async companyImage(
    @Param('fileId', new ParseUUIDPipe()) fileId: string,
    @Res() response: Response,
  ): Promise<void> {
    const found = await this.hierarchy.identityImageContent({
      scope: this.tenantContext.requireScope(),
      actorUserId: this.currentUserId(),
      fileId,
    });

    response.setHeader('Content-Type', found.contentType);
    // Private, because this is a company's own picture and a shared cache must not hold it.
    response.setHeader('Cache-Control', 'private, max-age=300');
    response.setHeader('Cross-Origin-Resource-Policy', 'same-site');
    response.send(found.bytes);
  }

  @Put('identity')
  @RequirePermission({ module: 'settings', action: 'Administer' })
  async updateIdentity(@Body() body: UpdateCompanyIdentityDto): Promise<unknown> {
    return this.hierarchy.updateCompanyIdentity({
      scope: this.tenantContext.requireScope(),
      actorUserId: this.currentUserId(),
      vision: body.vision,
      mission: body.mission,
    });
  }

  private currentUserId(): string {
    const userId = actorUserId(getActor());
    if (!userId) {
      throw new UnauthorizedException('This requires an identified user.');
    }
    return userId;
  }
}
