import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  ParseUUIDPipe,
  Post,
  UnauthorizedException,
} from '@nestjs/common';
import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  ArrayMinSize,
  IsArray,
  IsEmail,
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  IsUUID,
  Max,
  MaxLength,
  Min,
  MinLength,
} from 'class-validator';

import { CAPABILITY_KEYS, type CapabilityKey } from '@uboss/types';

import { RequirePermission } from '../authorization/authorization.decorators.js';
import { actorUserId } from '../request-context/authenticated-actor.js';
import { getActor } from '../request-context/request-context.js';
import { TenantScoped } from '../tenancy/tenancy.decorators.js';
import { TenantContextService } from '../tenancy/tenant-context.service.js';
import { CapabilityService } from './capability.service.js';
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

@Controller('tenants/:tenantId/access')
@TenantScoped()
export class AccessController {
  constructor(
    private readonly users: UserAccessService,
    private readonly invitations: InvitationAccessService,
    private readonly offboardings: OffboardingService,
    private readonly bulk: BulkOperationService,
    private readonly capabilities: CapabilityService,
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

  private currentUserId(): string {
    const userId = actorUserId(getActor());
    if (!userId) {
      throw new UnauthorizedException('This requires an identified user.');
    }
    return userId;
  }
}
