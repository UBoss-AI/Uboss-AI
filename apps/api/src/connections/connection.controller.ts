import { Body, Controller, Delete, Get, Param, Post, UnauthorizedException } from '@nestjs/common';
import {
  IsArray,
  IsIn,
  IsISO8601,
  IsOptional,
  IsString,
  IsUUID,
  MaxLength,
  MinLength,
} from 'class-validator';

import {
  CONNECTION_ENVIRONMENTS,
  CONNECTION_SCOPES,
  CONNECTOR_DEFINITIONS,
  TOOL_ACTION_CATEGORIES,
  TOOL_CATEGORY_DESCRIPTIONS,
  TOOL_CATEGORY_LABELS,
  HIGH_RISK_TOOL_CATEGORIES,
  type ConnectionEnvironment,
  type ConnectionScope,
  type ToolActionCategory,
} from '@uboss/types';

import { RequirePermission } from '../authorization/authorization.decorators.js';
import { actorUserId } from '../request-context/authenticated-actor.js';
import { getActor } from '../request-context/request-context.js';
import { TenantScoped } from '../tenancy/tenancy.decorators.js';
import { TenantContextService } from '../tenancy/tenant-context.service.js';
import { ConnectionService } from './connection.service.js';

export class CreateConnectionDto {
  @IsIn(CONNECTION_SCOPES) scopeKind!: ConnectionScope;

  @IsString() @MaxLength(60) connectorKind!: string;

  @IsString() @MinLength(2) @MaxLength(120) label!: string;

  @IsOptional() @IsUUID() ownerUserId?: string;

  @IsOptional() @IsIn(CONNECTION_ENVIRONMENTS) environment?: ConnectionEnvironment;

  /**
   * The credential. **Write-only, at every layer.**
   *
   * It goes straight to the vault and is never returned by any route in this module. A DTO field
   * is the last place it exists in this process, which is why the service hands it to
   * `SecretsVault.put` before anything else happens.
   */
  @IsString() @MinLength(1) @MaxLength(8000) secret!: string;

  @IsOptional() @IsArray() @IsUUID('all', { each: true }) allowedDepartmentIds?: string[];
}

export class RotateSecretDto {
  @IsString() @MinLength(1) @MaxLength(8000) secret!: string;
  @IsOptional() @IsISO8601() credentialExpiresAt?: string;
}

export class ReauthorizeDto {
  @IsOptional() @IsString() @MinLength(1) @MaxLength(8000) secret?: string;
}

export class ReasonDto {
  @IsString() @MinLength(5, { message: 'A reason is required.' }) @MaxLength(500) reason!: string;
}

export class TransferOwnerDto {
  @IsUUID() newOwnerUserId!: string;
  @IsString() @MinLength(5) @MaxLength(500) reason!: string;
}

export class GrantToolPermissionDto {
  @IsUUID() agentId!: string;
  @IsIn(TOOL_ACTION_CATEGORIES) category!: ToolActionCategory;
  /** Required for a high-risk category. The service and the database both insist. */
  @IsOptional() @IsString() @MinLength(5) @MaxLength(1000) reason?: string;
}

/**
 * Integrations & Connections.
 *
 * ## No route returns a credential
 *
 * Not one. Every response carries the `secretRef` handle and `hasSecret`, and the only path to
 * plaintext is `SecretsVault.reveal`, called by the service at the moment of use and handed
 * straight to a connector adapter. A credential that has been shown once is a credential in a
 * browser's memory and in whatever logged the response.
 *
 * ## The permission here is the human one; tool grants are the other kind
 *
 * `settings:View` to see connections and to manage **your own** personal one;
 * `settings:Administer` for anything belonging to the company. The route decorators are the
 * **floor** — the lifecycle routes are all `View` and the service decides per row, because
 * whether `Administer` is required depends on who owns the connection, which a guard cannot know
 * before the row is loaded. That is the Prompt 7 two-phase shape, not a relaxation. Those govern
 * what a **person** may do in this module. What an **Engine Agent** may do through a connection is a
 * `ConnectionToolGrant`, and holding `settings:Administer` grants none of it — the client's rule,
 * and the reason the two vocabularies are separate files.
 */
@Controller('tenants/:tenantId/connections')
@TenantScoped()
export class ConnectionController {
  constructor(
    private readonly connections: ConnectionService,
    private readonly tenantContext: TenantContextService,
  ) {}

  /** The connectors that exist, and the tool categories with their risk. */
  @Get('catalogue')
  @RequirePermission({ module: 'settings', action: 'View' })
  catalogue(): unknown {
    return {
      connectors: CONNECTOR_DEFINITIONS,
      toolCategories: TOOL_ACTION_CATEGORIES.map((category) => ({
        category,
        label: TOOL_CATEGORY_LABELS[category],
        description: TOOL_CATEGORY_DESCRIPTIONS[category],
        highRisk: HIGH_RISK_TOOL_CATEGORIES.includes(category),
      })),
      note:
        'Only connectors with an adapter behind them are listed. A catalogue naming vendors with ' +
        'nothing to talk to would fail in a way that looks like a credential problem. Tool ' +
        'categories are what an Engine Agent may do — separate from any human permission.',
    };
  }

  @Get()
  @RequirePermission({ module: 'settings', action: 'View' })
  async list(): Promise<unknown> {
    return this.connections.list({
      scope: this.tenantContext.requireScope(),
      actorUserId: this.currentUserId(),
    });
  }

  @Get(':id')
  @RequirePermission({ module: 'settings', action: 'View' })
  async view(@Param('id') id: string): Promise<unknown> {
    return this.connections.view({
      scope: this.tenantContext.requireScope(),
      actorUserId: this.currentUserId(),
      connectionId: id,
    });
  }

  @Post()
  @RequirePermission({ module: 'settings', action: 'View' })
  async create(@Body() body: CreateConnectionDto): Promise<unknown> {
    return this.connections.create({
      scope: this.tenantContext.requireScope(),
      actorUserId: this.currentUserId(),
      scopeKind: body.scopeKind,
      connectorKind: body.connectorKind,
      label: body.label,
      ...(body.ownerUserId === undefined ? {} : { ownerUserId: body.ownerUserId }),
      ...(body.environment === undefined ? {} : { environment: body.environment }),
      secret: body.secret,
      ...(body.allowedDepartmentIds === undefined
        ? {}
        : { allowedDepartmentIds: body.allowedDepartmentIds }),
    });
  }

  /** *Test Connection*. Resolves the credential, uses it once, returns no part of it. */
  @Post(':id/check')
  @RequirePermission({ module: 'settings', action: 'View' })
  async check(@Param('id') id: string): Promise<unknown> {
    return this.connections.check({
      scope: this.tenantContext.requireScope(),
      actorUserId: this.currentUserId(),
      connectionId: id,
    });
  }

  /** Replace the credential. The handle is kept, so every tool grant survives. */
  @Post(':id/rotate-secret')
  @RequirePermission({ module: 'settings', action: 'View' })
  async rotate(@Param('id') id: string, @Body() body: RotateSecretDto): Promise<unknown> {
    return this.connections.rotateSecret({
      scope: this.tenantContext.requireScope(),
      actorUserId: this.currentUserId(),
      connectionId: id,
      secret: body.secret,
      ...(body.credentialExpiresAt === undefined
        ? {}
        : { credentialExpiresAt: new Date(body.credentialExpiresAt) }),
    });
  }

  @Post(':id/reauthorize')
  @RequirePermission({ module: 'settings', action: 'View' })
  async reauthorize(@Param('id') id: string, @Body() body: ReauthorizeDto): Promise<unknown> {
    return this.connections.reauthorize({
      scope: this.tenantContext.requireScope(),
      actorUserId: this.currentUserId(),
      connectionId: id,
      ...(body.secret === undefined ? {} : { secret: body.secret }),
    });
  }

  @Post(':id/disable')
  @RequirePermission({ module: 'settings', action: 'View' })
  async disable(@Param('id') id: string, @Body() body: ReasonDto): Promise<unknown> {
    return this.connections.disable({
      scope: this.tenantContext.requireScope(),
      actorUserId: this.currentUserId(),
      connectionId: id,
      reason: body.reason,
    });
  }

  @Post(':id/enable')
  @RequirePermission({ module: 'settings', action: 'View' })
  async enable(@Param('id') id: string): Promise<unknown> {
    return this.connections.enable({
      scope: this.tenantContext.requireScope(),
      actorUserId: this.currentUserId(),
      connectionId: id,
    });
  }

  @Post(':id/transfer-owner')
  @RequirePermission({ module: 'settings', action: 'Administer' })
  async transferOwner(@Param('id') id: string, @Body() body: TransferOwnerDto): Promise<unknown> {
    return this.connections.transferOwner({
      scope: this.tenantContext.requireScope(),
      actorUserId: this.currentUserId(),
      connectionId: id,
      newOwnerUserId: body.newOwnerUserId,
      reason: body.reason,
    });
  }

  /** Grant one Engine Agent one category. A high-risk category needs a reason. */
  @Post(':id/tool-permissions')
  @RequirePermission({ module: 'settings', action: 'Administer' })
  async grant(@Param('id') id: string, @Body() body: GrantToolPermissionDto): Promise<unknown> {
    return this.connections.grantToolPermission({
      scope: this.tenantContext.requireScope(),
      actorUserId: this.currentUserId(),
      connectionId: id,
      agentId: body.agentId,
      category: body.category,
      ...(body.reason === undefined ? {} : { reason: body.reason }),
    });
  }

  /** Revoke a grant. Kept as a row: "who could do this in March" must stay answerable. */
  @Delete('tool-permissions/:grantId')
  @RequirePermission({ module: 'settings', action: 'Administer' })
  async revoke(@Param('grantId') grantId: string, @Body() body: ReasonDto): Promise<unknown> {
    return this.connections.revokeToolPermission({
      scope: this.tenantContext.requireScope(),
      actorUserId: this.currentUserId(),
      grantId,
      reason: body.reason,
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
