import {
  Body,
  Controller,
  Get,
  Param,
  ParseUUIDPipe,
  Post,
  Query,
  UnauthorizedException,
} from '@nestjs/common';
import { Type } from 'class-transformer';
import {
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  IsUUID,
  Max,
  MaxLength,
  Min,
  MinLength,
  ValidateNested,
} from 'class-validator';

import {
  isLogicalModelProfile,
  MAX_PROVIDER_TIMEOUT_MS,
  MIN_PROVIDER_TIMEOUT_MS,
  PROVIDER_AUTH_TYPES,
  PROVIDER_KINDS,
  PROVIDER_LIFECYCLE_STATES,
  PROVIDER_MODES,
  type ProviderAuthType,
  type ProviderKind,
  type ProviderLifecycleState,
  type ProviderMode,
} from '@uboss/types';

import { RequirePermission } from '../authorization/authorization.decorators.js';
import { actorUserId } from '../request-context/authenticated-actor.js';
import { getActor } from '../request-context/request-context.js';
import { PlatformOnly } from '../tenancy/tenancy.decorators.js';
import { ProviderService } from './provider.service.js';

class UsageMappingDto {
  @IsString() @MinLength(1) @MaxLength(200) inputPath!: string;
  @IsString() @MinLength(1) @MaxLength(200) outputPath!: string;
  @IsOptional() @IsString() @MaxLength(200) cachedInputPath?: string;
}

export class CreateProviderProfileDto {
  /** Null or omitted for a platform profile. */
  @IsOptional() @IsUUID() tenantId?: string;

  @IsIn(PROVIDER_KINDS as readonly string[]) kind!: ProviderKind;
  @IsIn(PROVIDER_MODES as readonly string[]) mode!: ProviderMode;
  @IsString() @MinLength(1) @MaxLength(120) label!: string;

  // ---- Custom Enterprise Provider only ----
  @IsOptional() @IsString() @MaxLength(500) baseUrl?: string;
  @IsOptional() @IsIn(PROVIDER_AUTH_TYPES as readonly string[]) authType?: ProviderAuthType;
  @IsOptional() @IsString() @MaxLength(120) authHeaderName?: string;
  /**
   * The plaintext credential, once, on the way in.
   *
   * Stored in the vault immediately and never returned. No endpoint anywhere reads it back — a
   * credential that has been shown once is a credential in a browser's memory.
   */
  @IsOptional() @IsString() @MinLength(1) @MaxLength(4000) secret?: string;
  @IsOptional()
  @IsInt()
  @Min(MIN_PROVIDER_TIMEOUT_MS)
  @Max(MAX_PROVIDER_TIMEOUT_MS)
  timeoutMs?: number;
  @IsOptional() @ValidateNested() @Type(() => UsageMappingDto) usageMapping?: UsageMappingDto;
  @IsOptional() @IsString() @MaxLength(200) requestIdPath?: string;
}

class PricingDto {
  @IsString() @MinLength(3) @MaxLength(3) currency!: string;
  @IsInt() @Min(0) inputPerMillionMinorUnits!: number;
  @IsInt() @Min(0) outputPerMillionMinorUnits!: number;
  @IsOptional() @IsInt() @Min(0) cachedInputPerMillionMinorUnits?: number;
}

export class AddProviderModelDto {
  @IsString() @MinLength(1) @MaxLength(200) providerModelRef!: string;
  @IsString() @MinLength(1) @MaxLength(80) capability!: string;
  @IsOptional() @ValidateNested() @Type(() => PricingDto) pricing?: PricingDto;
  /** Prompt 40: the provider's stated requests-per-minute for this model, when it is known. */
  @IsOptional() @IsInt() @Min(1) quotaRequestsPerMinute?: number;
}

export class PublishPricingDto {
  @IsString() @MinLength(3) @MaxLength(3) currency!: string;
  @IsInt() @Min(0) inputPerMillionMinorUnits!: number;
  @IsInt() @Min(0) outputPerMillionMinorUnits!: number;
  @IsOptional() @IsInt() @Min(0) cachedInputPerMillionMinorUnits?: number;
}

export class SetLifecycleDto {
  @IsIn(PROVIDER_LIFECYCLE_STATES as readonly string[]) lifecycle!: ProviderLifecycleState;
  /** Required: a deprecation nobody explained is one nobody can act on. */
  @IsString() @MinLength(1) @MaxLength(500) note!: string;
}

export class SetRouteDto {
  @IsOptional() @IsUUID() tenantId?: string;
  @IsString() profile!: string;
  @IsUUID() providerModelId!: string;
  @IsInt() @Min(0) preference!: number;
}

/**
 * Providers & Models — the Master Console's half of the Model Gateway (Prompt 29).
 *
 * ## Why every route here is platform-only
 *
 * §19 of the approved functional document: **"employees do not manage provider keys"**, and a
 * company chooses a *mode* under its contract rather than choosing a model. So there is
 * deliberately **no company-facing provider endpoint at all** — not a read-only one either,
 * because a company that could enumerate provider profiles could tell which vendor answers its
 * work, and Technical Architecture §18 says provider names stay behind the gateway.
 *
 * A company's BYOK credential is registered here, by platform staff, against that company's
 * tenant id. That is the shape §19 describes: the customer supplies an approved account, and
 * UBoss still meters and governs it.
 *
 * `@PlatformOnly` establishes the caller is platform staff; `@RequirePermission` on the
 * `providers` platform module establishes they are the *right* platform staff. The pairing
 * matters — a support engineer should be able to read a routing table and not repoint it.
 *
 * ## What no route does
 *
 * Nothing reads a secret back. Nothing edits a published price — `POST pricing` supersedes.
 * Nothing reports a Test Connection as successful without saying whether a provider actually
 * answered.
 */
@Controller('platform/providers')
@PlatformOnly()
export class ProviderController {
  constructor(private readonly providers: ProviderService) {}

  @Get('meta')
  @RequirePermission({ module: 'providers', action: 'View' })
  meta(): unknown {
    return this.providers.meta();
  }

  @Get('profiles')
  @RequirePermission({ module: 'providers', action: 'View' })
  async listProfiles(): Promise<unknown> {
    return this.providers.listProfiles();
  }

  /**
   * What each logical profile currently resolves to.
   *
   * `tenantId` optional: with it, the answer is what that company's calls would route to,
   * including its own overrides. Without it, the platform default.
   */
  @Get('routing')
  @RequirePermission({ module: 'providers', action: 'View' })
  async routing(@Query('tenantId') tenantId?: string): Promise<unknown> {
    return this.providers.listProfilesRouting(tenantId ?? null);
  }

  @Post('profiles')
  @RequirePermission({ module: 'providers', action: 'Administer' })
  async createProfile(@Body() body: CreateProviderProfileDto): Promise<unknown> {
    return this.providers.createProfile({
      actorUserId: this.currentUserId(),
      tenantId: body.tenantId ?? null,
      kind: body.kind,
      mode: body.mode,
      label: body.label,
      ...(body.kind === 'Custom'
        ? {
            custom: {
              baseUrl: body.baseUrl ?? '',
              authType: body.authType ?? 'None',
              authHeaderName: body.authHeaderName ?? null,
              timeoutMs: body.timeoutMs ?? MIN_PROVIDER_TIMEOUT_MS,
              usageMapping: {
                inputPath: body.usageMapping?.inputPath ?? '',
                outputPath: body.usageMapping?.outputPath ?? '',
                cachedInputPath: body.usageMapping?.cachedInputPath ?? null,
              },
              requestIdPath: body.requestIdPath ?? null,
              ...(body.secret === undefined ? {} : { secret: body.secret }),
            },
          }
        : {}),
    });
  }

  @Post('profiles/:profileId/models')
  @RequirePermission({ module: 'providers', action: 'Administer' })
  async addModel(
    @Param('profileId', ParseUUIDPipe) profileId: string,
    @Body() body: AddProviderModelDto,
  ): Promise<unknown> {
    return this.providers.addModel({
      actorUserId: this.currentUserId(),
      providerProfileId: profileId,
      providerModelRef: body.providerModelRef,
      capability: body.capability,
      ...(body.quotaRequestsPerMinute === undefined
        ? {}
        : { quotaRequestsPerMinute: body.quotaRequestsPerMinute }),
      ...(body.pricing === undefined
        ? {}
        : {
            pricing: {
              currency: body.pricing.currency,
              inputPerMillionMinorUnits: body.pricing.inputPerMillionMinorUnits,
              outputPerMillionMinorUnits: body.pricing.outputPerMillionMinorUnits,
              cachedInputPerMillionMinorUnits: body.pricing.cachedInputPerMillionMinorUnits ?? null,
            },
          }),
    });
  }

  /**
   * Publish a new price.
   *
   * There is no PUT. A published price is immutable — a gateway call cites the version that priced
   * it — so this supersedes the current version and writes a new one. A database trigger refuses
   * the edit, which means the absence of a PUT is enforced rather than merely intended.
   */
  @Post('models/:modelId/pricing')
  @RequirePermission({ module: 'providers', action: 'Administer' })
  async publishPricing(
    @Param('modelId', ParseUUIDPipe) modelId: string,
    @Body() body: PublishPricingDto,
  ): Promise<unknown> {
    return this.providers.publishPricing({
      actorUserId: this.currentUserId(),
      providerModelId: modelId,
      currency: body.currency,
      inputPerMillionMinorUnits: body.inputPerMillionMinorUnits,
      outputPerMillionMinorUnits: body.outputPerMillionMinorUnits,
      cachedInputPerMillionMinorUnits: body.cachedInputPerMillionMinorUnits ?? null,
    });
  }

  @Post('models/:modelId/lifecycle')
  @RequirePermission({ module: 'providers', action: 'Administer' })
  async setLifecycle(
    @Param('modelId', ParseUUIDPipe) modelId: string,
    @Body() body: SetLifecycleDto,
  ): Promise<unknown> {
    return this.providers.setModelLifecycle({
      actorUserId: this.currentUserId(),
      providerModelId: modelId,
      lifecycle: body.lifecycle,
      note: body.note,
    });
  }

  @Post('routing')
  @RequirePermission({ module: 'providers', action: 'Administer' })
  async setRoute(@Body() body: SetRouteDto): Promise<unknown> {
    if (!isLogicalModelProfile(body.profile)) {
      // Checked here as well as in the service so the 400 names the five, rather than a validator
      // repeating a list that would then exist in two places.
      throw new UnauthorizedException(
        `${body.profile} is not one of the five logical model profiles.`,
      );
    }
    return this.providers.setRoute({
      actorUserId: this.currentUserId(),
      tenantId: body.tenantId ?? null,
      profile: body.profile,
      providerModelId: body.providerModelId,
      preference: body.preference,
    });
  }

  /**
   * Test Connection.
   *
   * `Administer` rather than `View`: it sends a real request using a stored credential, which is
   * an action against a third party rather than a read of local configuration.
   */
  @Post('profiles/:profileId/test')
  @RequirePermission({ module: 'providers', action: 'Administer' })
  async testConnection(@Param('profileId', ParseUUIDPipe) profileId: string): Promise<unknown> {
    return this.providers.testConnection({
      actorUserId: this.currentUserId(),
      providerProfileId: profileId,
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
