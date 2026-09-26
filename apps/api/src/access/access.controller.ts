import {
  BadRequestException,
  Body,
  Controller,
  Delete,
  ForbiddenException,
  Get,
  NotFoundException,
  Param,
  ParseUUIDPipe,
  Post,
  Res,
  UnauthorizedException,
} from '@nestjs/common';
import { Type } from 'class-transformer';
import type { Response } from 'express';
import {
  ArrayMaxSize,
  ArrayMinSize,
  IsArray,
  IsEmail,
  IsIn,
  IsInt,
  IsISO8601,
  IsOptional,
  IsString,
  IsUUID,
  Max,
  MaxLength,
  Min,
  MinLength,
} from 'class-validator';

import {
  CAPABILITY_KEYS,
  ROLE_KINDS,
  SCOPE_KINDS,
  type CapabilityKey,
  type RoleKind,
  type ScopeKind,
} from '@uboss/types';

import { RequirePermission } from '../authorization/authorization.decorators.js';
import { actorUserId } from '../request-context/authenticated-actor.js';
import { getActor } from '../request-context/request-context.js';
import { TenantScoped } from '../tenancy/tenancy.decorators.js';
import { TenantContextService } from '../tenancy/tenant-context.service.js';
import { RoleAdministrationService } from '../authorization/role-administration.service.js';
import { CapabilityService } from './capability.service.js';
import {
  HIERARCHY_COLUMNS,
  HierarchyWorkbook,
} from '../organization/hierarchy-workbook.js';
import { BulkOperationService, MAX_BULK_ROWS } from './bulk-operation.service.js';
import { InvitationAccessService } from './invitation-access.service.js';
import { OffboardingService } from './offboarding.service.js';
import { MAX_GUEST_DAYS, UserAccessService } from './user-access.service.js';

const BULK_KINDS = [
  'ImportEmployees',
  'InviteOrResend',
  'RoleAndScope',
  'ManagerOrDepartment',
  'SuspendOrOffboard',
] as const;

export class InviteExistingDto {
  @IsUUID()
  subjectUserId!: string;

  /** Required when the person still has the synthesised placeholder address. */
  @IsOptional()
  @IsEmail()
  @MaxLength(320)
  workEmail?: string;
}

export class InviteGuestDto {
  @IsEmail()
  @MaxLength(320)
  email!: string;

  @IsString()
  @MinLength(2)
  @MaxLength(200)
  displayName!: string;

  /** At least one. An empty list would mean company-wide access. */
  @ArrayMinSize(1, { message: 'A guest invitation must name at least one resource.' })
  @ArrayMaxSize(200)
  @IsString({ each: true })
  resourceIds!: string[];

  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(MAX_GUEST_DAYS)
  accessDays!: number;

  @IsString()
  @MinLength(5, { message: 'reason must say why this guest needs access.' })
  @MaxLength(1000)
  reason!: string;
}

export class AccessReasonDto {
  @IsString()
  @MinLength(5, { message: 'reason must explain the change.' })
  @MaxLength(1000)
  reason!: string;
}

export class OffboardDto {
  @IsOptional()
  @IsUUID()
  successorUserId?: string;

  @IsString()
  @MinLength(5, { message: 'reason must explain why this person is leaving.' })
  @MaxLength(1000)
  reason!: string;
}

export class ValidateHierarchyWorkbookDto {
  /**
   * The workbook, base64-encoded.
   *
   * Base64 in a JSON body rather than multipart, because that is how every other upload in this
   * product already arrives and the size ceiling is enforced the same way. A hierarchy of four
   * hundred people is a few tens of kilobytes.
   */
  @IsString()
  @MinLength(8)
  @MaxLength(12_000_000)
  file!: string;

  @IsOptional()
  @IsString()
  @MaxLength(260)
  sourceFileName?: string;

  @IsOptional()
  @IsString()
  @MaxLength(1000)
  reason?: string;
}

export class ValidateBulkDto {
  @IsIn(BULK_KINDS, { message: `kind must be one of: ${BULK_KINDS.join(', ')}.` })
  kind!: (typeof BULK_KINDS)[number];

  /** CSV text. An XLS is exported to CSV in the browser before upload. */
  @IsString()
  @MinLength(2)
  @MaxLength(MAX_BULK_ROWS * 400)
  content!: string;

  @IsOptional()
  @IsString()
  @MaxLength(260)
  sourceFileName?: string;

  @IsOptional()
  @IsString()
  @MaxLength(1000)
  reason?: string;
}

/**
 * Settings → Users & Access: activation, account lifecycle and bulk administration.
 *
 * Every route is `@TenantScoped` with a `@RequirePermission`. The split matters:
 *
 *   * **`users:View`** to see the roster. A manager who cannot see who is activated cannot tell
 *     whether their new joiner can start.
 *   * **`users:ManageAccess`** to invite, suspend, reinstate or offboard. Its own action in the
 *     Prompt 7 vocabulary precisely so "may edit a person's details" and "may let a person into
 *     the company" are separable — and `ExternalGuest` is forbidden it outright by the user-type
 *     ceiling, so a guest can never let anybody in.
 *   * **the bulk kind's own permission**, from `BULK_PERMISSIONS`. Uploading a file is not a
 *     permission; each operation needs the permission its single-record equivalent needs.
 */
/**
 * The Access & Permissions step's payload — Prompt 40A (CR-03) §1.
 *
 * `CAPABILITY_KEYS` rather than a free string, so an unknown capability is a 400 from the
 * validation pipe rather than a silent no-op inside the service. A capability that expanded to
 * nothing would look to an administrator exactly like one that worked.
 */
class GrantCapabilitiesDto {
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(CAPABILITY_KEYS.length)
  @IsIn(CAPABILITY_KEYS as readonly string[], { each: true })
  capabilities!: CapabilityKey[];
}

/**
 * A role grant made from inside the company, by an administrator of that company.
 *
 * The same shape the platform plane's `AssignRoleDto` carries, because it drives the same service.
 * Two fields it does **not** have: a tenant (the route and `TenantScoped` decide that, so an
 * administrator cannot reach another company) and a custom role id (a company role screen grants
 * the built-in catalogue; authoring a custom role is a separate act on its own route).
 */
class GrantRoleDto {
  @IsIn(ROLE_KINDS, { message: `roleKind must be one of: ${ROLE_KINDS.join(', ')}.` })
  roleKind!: RoleKind;

  @IsIn(SCOPE_KINDS, { message: `scopeKind must be one of: ${SCOPE_KINDS.join(', ')}.` })
  scopeKind!: ScopeKind;

  @IsOptional()
  @IsArray()
  @ArrayMaxSize(200)
  @IsString({ each: true })
  @MaxLength(64, { each: true })
  departmentIds?: string[];

  @IsOptional()
  @IsArray()
  @ArrayMaxSize(500)
  @IsString({ each: true })
  @MaxLength(64, { each: true })
  selectedResourceIds?: string[];

  /** Time-boxed access, for a contractor or a temporary approver. */
  @IsOptional()
  @IsISO8601({}, { message: 'expiresAt must be an ISO-8601 timestamp.' })
  expiresAt?: string;

  @IsOptional()
  @IsString()
  @MaxLength(1000)
  justification?: string;
}

@Controller('tenants/:tenantId/access')
@TenantScoped()
export class AccessController {
  constructor(
    private readonly users: UserAccessService,
    private readonly invitations: InvitationAccessService,
    private readonly offboardings: OffboardingService,
    private readonly bulk: BulkOperationService,
    private readonly capabilities: CapabilityService,
    private readonly roles: RoleAdministrationService,
    private readonly tenantContext: TenantContextService,
  ) {}

  /** The three tabs, the seat position, and why each pending invitation is or is not ready. */
  @Get()
  @RequirePermission({ module: 'users', action: 'View' })
  async view(): Promise<unknown> {
    return this.users.viewFor(this.tenantContext.requireScope(), this.currentUserId());
  }

  /**
   * Invite somebody already in the hierarchy.
   *
   * Keyed on `subjectUserId`, never on email — the client's no-duplicate rule made structural.
   */
  @Post('invitations')
  @RequirePermission({ module: 'users', action: 'ManageAccess' })
  async invite(@Body() body: InviteExistingDto): Promise<unknown> {
    return this.invitations.inviteExistingPerson({
      scope: this.tenantContext.requireScope(),
      actorUserId: this.currentUserId(),
      subjectUserId: body.subjectUserId,
      workEmail: body.workEmail,
    });
  }

  /** Invite an External Guest: resource-scoped, expiry-capped, outside the hierarchy. */
  @Post('guests')
  @RequirePermission({ module: 'users', action: 'ManageAccess' })
  async inviteGuest(@Body() body: InviteGuestDto): Promise<unknown> {
    return this.invitations.inviteGuest({
      scope: this.tenantContext.requireScope(),
      actorUserId: this.currentUserId(),
      email: body.email,
      displayName: body.displayName,
      resourceIds: body.resourceIds,
      accessDays: body.accessDays,
      reason: body.reason,
    });
  }

  @Post('invitations/:invitationId/cancel')
  @RequirePermission({ module: 'users', action: 'ManageAccess' })
  async cancelInvitation(
    @Param('invitationId', new ParseUUIDPipe()) invitationId: string,
  ): Promise<unknown> {
    await this.invitations.cancelInvitation({
      scope: this.tenantContext.requireScope(),
      actorUserId: this.currentUserId(),
      invitationId,
    });
    return { invitationId, cancelled: true };
  }

  @Post('people/:userId/suspend')
  @RequirePermission({ module: 'users', action: 'ManageAccess' })
  async suspend(
    @Param('userId', new ParseUUIDPipe()) userId: string,
    @Body() body: AccessReasonDto,
  ): Promise<unknown> {
    await this.users.suspend({
      scope: this.tenantContext.requireScope(),
      actorUserId: this.currentUserId(),
      subjectUserId: userId,
      reason: body.reason,
    });
    return { userId, accountState: 'Suspended', nothingDeleted: true };
  }

  @Post('people/:userId/reinstate')
  @RequirePermission({ module: 'users', action: 'ManageAccess' })
  async reinstate(
    @Param('userId', new ParseUUIDPipe()) userId: string,
    @Body() body: AccessReasonDto,
  ): Promise<unknown> {
    await this.users.reinstate({
      scope: this.tenantContext.requireScope(),
      actorUserId: this.currentUserId(),
      subjectUserId: userId,
      reason: body.reason,
    });
    return { userId, accountState: 'Active' };
  }

  /** What an offboarding would move, asked before committing to it. */
  @Get('people/:userId/offboarding-impact')
  @RequirePermission({ module: 'users', action: 'ManageAccess' })
  async offboardingImpact(@Param('userId', new ParseUUIDPipe()) userId: string): Promise<unknown> {
    return this.offboardings.assess({
      scope: this.tenantContext.requireScope(),
      actorUserId: this.currentUserId(),
      subjectUserId: userId,
    });
  }

  @Post('people/:userId/offboard')
  @RequirePermission({ module: 'users', action: 'ManageAccess' })
  async offboard(
    @Param('userId', new ParseUUIDPipe()) userId: string,
    @Body() body: OffboardDto,
  ): Promise<unknown> {
    return this.offboardings.offboard({
      scope: this.tenantContext.requireScope(),
      actorUserId: this.currentUserId(),
      subjectUserId: userId,
      successorUserId: body.successorUserId,
      reason: body.reason,
    });
  }

  @Get('offboardings')
  @RequirePermission({ module: 'users', action: 'View' })
  async listOffboardings(): Promise<unknown> {
    const offboardings = await this.offboardings.list(
      this.tenantContext.requireScope(),
      this.currentUserId(),
    );
    return { offboardings };
  }

  // -------------------------------------------------------------------------
  // Bulk
  // -------------------------------------------------------------------------

  /**
   * Validate a bulk operation. **Applies nothing.**
   *
   * The permission checked here is the *kind's* — see `BULK_PERMISSIONS`. The decorator names
   * `users:View` because Nest needs one at the route, and the service then asserts the stricter
   * one; a caller who passes the route guard and not the kind's permission gets a 403 from the
   * service. Stated because the decorator alone would read as the whole check and is not.
   */
  @Post('bulk/validate')
  @RequirePermission({ module: 'users', action: 'View' })
  async validateBulk(@Body() body: ValidateBulkDto): Promise<unknown> {
    return this.bulk.validate({
      scope: this.tenantContext.requireScope(),
      actorUserId: this.currentUserId(),
      kind: body.kind,
      content: body.content,
      sourceFileName: body.sourceFileName,
      reason: body.reason,
    });
  }

  /**
   * The hierarchy import template, as a real spreadsheet.
   *
   * ## Why the template is generated rather than a static file
   *
   * Two of its three sheets are this company's own departments and people. Those are exactly the
   * values a row is rejected for getting wrong — a department that does not exist, a manager's
   * name spelt differently — so the file a person fills in carries the correct spellings beside
   * the blank columns. A checked-in template could not do that, and would be stale the first time
   * somebody added a department.
   */
  @Get('bulk/hierarchy-template')
  @RequirePermission({ module: 'hierarchy', action: 'Administer' })
  async hierarchyTemplate(@Res() response: Response): Promise<void> {
    const scope = this.tenantContext.requireScope();
    const reference = await this.bulk.hierarchyReference(scope, this.currentUserId());
    const workbook = await HierarchyWorkbook.template(reference);

    response.setHeader(
      'Content-Type',
      'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    );
    response.setHeader(
      'Content-Disposition',
      'attachment; filename="UBoss hierarchy import template.xlsx"',
    );
    response.send(workbook);
  }

  /** The columns the template carries, so a screen can say what is required before the download. */
  @Get('bulk/hierarchy-template/columns')
  @RequirePermission({ module: 'hierarchy', action: 'View' })
  hierarchyTemplateColumns(): unknown {
    return {
      columns: HIERARCHY_COLUMNS.map((column) => ({
        heading: column.heading,
        required: column.required,
        note: column.note,
      })),
    };
  }

  /**
   * Validate a filled-in hierarchy workbook. **Applies nothing.**
   *
   * The workbook is turned into the delimited text the existing importer already reads, and then
   * handed to it. Every rule, every per-row message and every write stays where it was — a second
   * importer for spreadsheets would be a second place for "a manager must be actively employed
   * here" to be got right, and one of them would drift.
   *
   * Applying and cancelling are the existing `bulk/:operationId/apply` and `/cancel`.
   */
  @Post('bulk/hierarchy/validate')
  @RequirePermission({ module: 'hierarchy', action: 'View' })
  async validateHierarchyWorkbook(@Body() body: ValidateHierarchyWorkbookDto): Promise<unknown> {
    let content: string;
    try {
      content = await HierarchyWorkbook.toDelimited(Buffer.from(body.file, 'base64'));
    } catch (error) {
      // The workbook could not be read at all. A 400 with the reason, rather than a 500: the file
      // is the caller's and the message tells them what to fix.
      throw new BadRequestException(
        error instanceof Error ? error.message : 'That file could not be read as a spreadsheet.',
      );
    }

    return this.bulk.validate({
      scope: this.tenantContext.requireScope(),
      actorUserId: this.currentUserId(),
      kind: 'ImportEmployees',
      content,
      sourceFileName: body.sourceFileName,
      reason: body.reason,
    });
  }

  @Get('bulk/:operationId')
  @RequirePermission({ module: 'users', action: 'View' })
  async bulkOperation(
    @Param('operationId', new ParseUUIDPipe()) operationId: string,
  ): Promise<unknown> {
    return this.bulk
      .list(this.tenantContext.requireScope(), this.currentUserId())
      .then((operations) => operations.find((operation) => operation.id === operationId) ?? null);
  }

  @Post('bulk/:operationId/apply')
  @RequirePermission({ module: 'users', action: 'View' })
  async applyBulk(
    @Param('operationId', new ParseUUIDPipe()) operationId: string,
  ): Promise<unknown> {
    return this.bulk.apply({
      scope: this.tenantContext.requireScope(),
      actorUserId: this.currentUserId(),
      operationId,
    });
  }

  @Post('bulk/:operationId/cancel')
  @RequirePermission({ module: 'users', action: 'View' })
  async cancelBulk(
    @Param('operationId', new ParseUUIDPipe()) operationId: string,
  ): Promise<unknown> {
    await this.bulk.cancel({
      scope: this.tenantContext.requireScope(),
      actorUserId: this.currentUserId(),
      operationId,
    });
    return { operationId, cancelled: true };
  }

  @Get('bulk')
  @RequirePermission({ module: 'users', action: 'View' })
  async listBulk(): Promise<unknown> {
    const operations = await this.bulk.list(
      this.tenantContext.requireScope(),
      this.currentUserId(),
    );
    return { operations };
  }

  // =========================================================================
  // The Access & Permissions step — Prompt 40A (CR-03) §1
  // =========================================================================
  //
  // `users:ManageAccess` on all three, which only `Head` and `CompanyAdmin` hold. Reading the
  // step is gated as tightly as writing it, deliberately: the response says which capabilities the
  // *caller* may grant, which is a description of their own authority and not something a
  // colleague should be able to enumerate.

  /** What an administrator may offer this person, and what they already hold. */
  @Get('capabilities/:userId')
  @RequirePermission({ module: 'users', action: 'ManageAccess' })
  async capabilityStep(@Param('userId') userId: string): Promise<unknown> {
    return this.capabilities.stepFor({
      scope: this.tenantContext.requireScope(),
      actorUserId: this.currentUserId(),
      subjectUserId: userId,
    });
  }

  @Post('capabilities/:userId')
  @RequirePermission({ module: 'users', action: 'ManageAccess' })
  async grantCapabilities(
    @Param('userId') userId: string,
    @Body() body: GrantCapabilitiesDto,
  ): Promise<unknown> {
    return this.capabilities.grant({
      scope: this.tenantContext.requireScope(),
      actorUserId: this.currentUserId(),
      subjectUserId: userId,
      capabilities: body.capabilities,
    });
  }

  @Delete('capabilities/:userId/:capability')
  @RequirePermission({ module: 'users', action: 'ManageAccess' })
  async revokeCapability(
    @Param('userId') userId: string,
    @Param('capability') capability: string,
  ): Promise<unknown> {
    return this.capabilities.revoke({
      scope: this.tenantContext.requireScope(),
      actorUserId: this.currentUserId(),
      subjectUserId: userId,
      capability: capability as CapabilityKey,
    });
  }

  // =========================================================================
  // Roles & Permissions, on the company plane
  // =========================================================================
  //
  // Role administration lived only on `AuthorizationController`, which is `@PlatformOnly` — an
  // interim from Prompt 7 that `docs/IMPLEMENTATION_STATE.md` has recorded as outstanding ever
  // since ("the six route groups still wait"). The consequence in the product was concrete: a
  // Company Admin could invite, suspend, offboard and grant capabilities, but could not give
  // anybody a Role or a Scope without platform staff doing it for them.
  //
  // These routes re-home it. They run the **same** `RoleAdministrationService` the platform plane
  // runs — one implementation of "may this grant be made", not a company-flavoured copy — and add
  // exactly two things the platform plane does not need:
  //
  //   * the tenant comes from the route and `@TenantScoped`, never from a body, so an
  //     administrator cannot reach another company;
  //   * a **delegation ceiling**, so `users:ManageAccess` is not a licence to mint a Company Admin.
  //
  // Every privilege-escalation gate the platform path already enforces still applies underneath:
  // no self-assignment, no scope above the role's ceiling, nothing for a suspended or offboarded
  // account, and a security event on every grant and revocation.

  /** The role catalogue, and how far this administrator may delegate each entry. */
  @Get('roles')
  @RequirePermission({ module: 'users', action: 'ManageAccess' })
  async roleCatalogue(): Promise<unknown> {
    const scope = this.tenantContext.requireScope();
    const actor = this.currentUserId();
    const mine = (await this.roles.listAssignments(scope)).filter(
      (assignment) => assignment.userId === actor && !assignment.expired,
    );
    const granterRoles = mine.map((assignment) => ({
      roleKind: assignment.roleKind as RoleKind,
      scopeKind: assignment.scopeKind as ScopeKind,
    }));

    return {
      roles: this.roles.roleCatalogue().map((role) => {
        const problem = this.roles.delegationCeilingProblem({
          granterRoles,
          roleKind: role.kind,
          scopeKind: role.defaultScope,
        });
        return { ...role, youMayGrant: problem === null, whyNot: problem };
      }),
      note:
        'What you may grant is bounded by what you hold. A company administrator may grant any ' +
        'role in their own company and nothing outside it; nobody grants themselves anything.',
    };
  }

  /** One person's live roles in this company. */
  @Get('people/:userId/roles')
  @RequirePermission({ module: 'users', action: 'ManageAccess' })
  async rolesOf(@Param('userId', new ParseUUIDPipe()) userId: string): Promise<unknown> {
    const assignments = await this.roles.listAssignments(this.tenantContext.requireScope());
    return { assignments: assignments.filter((assignment) => assignment.userId === userId) };
  }

  /** Grant a role, at a scope, inside this company. */
  @Post('people/:userId/roles')
  @RequirePermission({ module: 'users', action: 'ManageAccess' })
  async grantRole(
    @Param('userId', new ParseUUIDPipe()) userId: string,
    @Body() body: GrantRoleDto,
  ): Promise<unknown> {
    const scope = this.tenantContext.requireScope();
    const actor = this.currentUserId();

    const mine = (await this.roles.listAssignments(scope)).filter(
      (assignment) => assignment.userId === actor && !assignment.expired,
    );
    const problem = this.roles.delegationCeilingProblem({
      granterRoles: mine.map((assignment) => ({
        roleKind: assignment.roleKind as RoleKind,
        scopeKind: assignment.scopeKind as ScopeKind,
      })),
      roleKind: body.roleKind,
      scopeKind: body.scopeKind,
    });
    if (problem !== null) {
      throw new ForbiddenException(problem);
    }

    const expiresAt = body.expiresAt === undefined ? undefined : new Date(body.expiresAt);
    if (expiresAt !== undefined && Number.isNaN(expiresAt.getTime())) {
      throw new BadRequestException('expiresAt is not a valid timestamp.');
    }
    if (expiresAt !== undefined && expiresAt <= new Date()) {
      throw new BadRequestException(
        'expiresAt is in the past, so the assignment would grant nothing.',
      );
    }

    return this.roles.assign(
      scope,
      {
        userId,
        roleKind: body.roleKind,
        scopeKind: body.scopeKind,
        ...(body.departmentIds === undefined ? {} : { departmentIds: body.departmentIds }),
        ...(body.selectedResourceIds === undefined
          ? {}
          : { selectedResourceIds: body.selectedResourceIds }),
        ...(expiresAt === undefined ? {} : { expiresAt }),
        ...(body.justification === undefined ? {} : { justification: body.justification }),
      },
      actor,
    );
  }

  /**
   * Revoke a role.
   *
   * The assignment is looked up inside this company's scope before anything is removed, so an id
   * from another company is a 404 rather than a cross-tenant deletion. `revoke` records the
   * security event.
   */
  @Delete('roles/:assignmentId')
  @RequirePermission({ module: 'users', action: 'ManageAccess' })
  async revokeRole(
    @Param('assignmentId', new ParseUUIDPipe()) assignmentId: string,
  ): Promise<unknown> {
    const scope = this.tenantContext.requireScope();
    const removed = await this.roles.revoke(scope, assignmentId, this.currentUserId());
    if (!removed) {
      throw new NotFoundException('No such role assignment in this company.');
    }
    return { revoked: true };
  }

  private currentUserId(): string {
    const userId = actorUserId(getActor());
    if (!userId) {
      throw new UnauthorizedException('This requires an identified user.');
    }
    return userId;
  }
}
