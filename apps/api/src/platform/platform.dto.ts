import { Type } from 'class-transformer';
import {
  Allow,
  ArrayMaxSize,
  ArrayMinSize,
  IsArray,
  IsBoolean,
  IsIn,
  IsISO8601,
  IsInt,
  IsOptional,
  IsString,
  IsUUID,
  Matches,
  Max,
  MaxLength,
  Min,
  MinLength,
} from 'class-validator';

import { COMPANY_MODULES, PLATFORM_ROLE_KINDS, type PlatformRoleKind } from '@uboss/types';

/**
 * Request shapes for the Master Console.
 *
 * Every enum is validated against `@uboss/types` or the Prisma enum rather than a copy, so there
 * is one definition of a plan tier or a platform role. The global `ValidationPipe` runs with
 * `forbidNonWhitelisted`, which matters here in a specific way: several of these endpoints change
 * what a **customer** is entitled to or what ships to every company at once, and a mistyped field
 * that was silently ignored would leave an operator believing they had made a change they had
 * not.
 */

const PLAN_TIERS = ['Starter', 'Growth', 'Enterprise', 'Pilot'] as const;
const SUBSCRIPTION_STATES = ['Pending', 'Active', 'Suspended', 'Expired', 'Cancelled'] as const;
const BILLING_STATES = ['Current', 'Grace', 'Overdue'] as const;
const ATTENTION_FLAGS = ['None', 'Billing', 'Budget', 'Security', 'Seats', 'Renewal'] as const;
const FEATURE_STAGES = ['Dev', 'Staging', 'Uat', 'Prod'] as const;
const FEATURE_STATES = ['Paused', 'InReview', 'Active', 'Retired'] as const;

/** A stable machine key: lowercase, digits and hyphens. Referenced by configuration. */
const MACHINE_KEY = /^[a-z0-9][a-z0-9-]{1,78}[a-z0-9]$/;

export class GrantPlatformRoleDto {
  @IsUUID()
  userId!: string;

  @IsIn(PLATFORM_ROLE_KINDS, {
    message: `role must be one of: ${PLATFORM_ROLE_KINDS.join(', ')}.`,
  })
  role!: PlatformRoleKind;

  /**
   * Why this person needs this authority.
   *
   * Not technically required by the column, and required here: platform authority is the widest
   * grant in the product, and an access review three months from now is the reader.
   */
  @IsString()
  @MinLength(10, {
    message: 'justification must explain why this person needs this platform authority.',
  })
  @MaxLength(500)
  justification!: string;

  /** Omit for a standing grant. Use it for a contractor or an on-call rotation. */
  @IsOptional()
  @IsISO8601()
  expiresAt?: string;
}

export class RevokePlatformRoleDto {
  @IsOptional()
  @IsString()
  @MaxLength(500)
  reason?: string;
}

export class CreatePlanDto {
  @Matches(MACHINE_KEY, {
    message:
      'code must be lowercase letters, digits and hyphens — it is referenced by configuration.',
  })
  @MaxLength(40)
  code!: string;

  @IsIn(PLAN_TIERS, { message: `tier must be one of: ${PLAN_TIERS.join(', ')}.` })
  tier!: (typeof PLAN_TIERS)[number];

  @IsString()
  @MinLength(2)
  @MaxLength(120)
  name!: string;

  @IsOptional()
  @IsString()
  @MaxLength(500)
  description?: string;

  /** Omit for a negotiated seat count, which the reference shows as "Custom". */
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(100_000)
  seatLimit?: number;

  @IsArray()
  @ArrayMinSize(1, { message: 'A plan must entitle at least one module.' })
  @ArrayMaxSize(COMPANY_MODULES.length)
  @IsIn(COMPANY_MODULES, {
    each: true,
    message: `entitledModules must contain only company modules: ${COMPANY_MODULES.join(', ')}.`,
  })
  entitledModules!: string[];

  /** Minor units. Integers only — money in a float is how rounding becomes a dispute. */
  @IsOptional()
  @Type(() => Number)
  @IsInt({ message: 'aiAllowanceMinor must be an integer number of minor units.' })
  @Min(0)
  aiAllowanceMinor?: number;

  @IsOptional()
  @Type(() => Number)
  @IsInt({ message: 'priceMinor must be an integer number of minor units.' })
  @Min(0)
  priceMinor?: number;

  @IsOptional()
  @Matches(/^[A-Z]{3}$/, { message: 'currency must be a three-letter ISO 4217 code.' })
  currency?: string;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  sortOrder?: number;
}

export class UpdatePlanDto {
  @IsOptional()
  @IsString()
  @MinLength(2)
  @MaxLength(120)
  name?: string;

  @IsOptional()
  @IsString()
  @MaxLength(500)
  description?: string;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(100_000)
  seatLimit?: number;

  @IsOptional()
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(COMPANY_MODULES.length)
  @IsIn(COMPANY_MODULES, { each: true })
  entitledModules?: string[];

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  aiAllowanceMinor?: number;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  priceMinor?: number;

  /** `false` retires the plan. Refused while companies are still on it. */
  @IsOptional()
  @IsBoolean()
  active?: boolean;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  sortOrder?: number;
}

export class SetSubscriptionDto {
  @Matches(MACHINE_KEY)
  @MaxLength(40)
  planCode!: string;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(100_000)
  seatsLicensed?: number;

  @IsOptional()
  @IsIn(SUBSCRIPTION_STATES, {
    message: `state must be one of: ${SUBSCRIPTION_STATES.join(', ')}.`,
  })
  state?: (typeof SUBSCRIPTION_STATES)[number];

  @IsOptional()
  @IsIn(BILLING_STATES, { message: `billingState must be one of: ${BILLING_STATES.join(', ')}.` })
  billingState?: (typeof BILLING_STATES)[number];

  @IsOptional()
  @IsISO8601()
  renewsAt?: string;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  aiAllowanceMinor?: number;

  /** Modules this company gets on top of its plan. The reference's "Master extras". */
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(COMPANY_MODULES.length)
  @IsIn(COMPANY_MODULES, { each: true })
  extraModules?: string[];

  /** Modules withheld despite the plan including them. Wins over `extraModules`. */
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(COMPANY_MODULES.length)
  @IsIn(COMPANY_MODULES, { each: true })
  removedModules?: string[];

  @IsOptional()
  @IsIn(ATTENTION_FLAGS, { message: `pinnedFlag must be one of: ${ATTENTION_FLAGS.join(', ')}.` })
  pinnedFlag?: (typeof ATTENTION_FLAGS)[number];

  @IsOptional()
  @IsString()
  @MaxLength(1000)
  notes?: string;

  /** Mandatory: this is the record the customer may later ask about. */
  @IsString()
  @MinLength(5, { message: 'reason must say why the commercial terms are changing.' })
  @MaxLength(500)
  reason!: string;
}

export class CreateFeatureFlagDto {
  @Matches(MACHINE_KEY, { message: 'key must be lowercase letters, digits and hyphens.' })
  @MaxLength(80)
  key!: string;

  @IsOptional()
  @IsString()
  @MaxLength(500)
  description?: string;

  @IsOptional()
  @IsString()
  @MaxLength(120)
  audience?: string;

  /**
   * What removing this flag would mean.
   *
   * A flag with no stated purpose is the one nobody dares delete, and a codebase full of those
   * is a codebase nobody can reason about — so it is asked for at creation, when the answer is
   * still known.
   */
  @IsOptional()
  @IsString()
  @MaxLength(1000)
  rationale?: string;
}

export class UpdateFeatureFlagDto {
  @IsOptional()
  @IsIn(FEATURE_STAGES, { message: `stage must be one of: ${FEATURE_STAGES.join(', ')}.` })
  stage?: (typeof FEATURE_STAGES)[number];

  @IsOptional()
  @IsIn(FEATURE_STATES, { message: `state must be one of: ${FEATURE_STATES.join(', ')}.` })
  state?: (typeof FEATURE_STATES)[number];

  @IsOptional()
  @IsString()
  @MaxLength(120)
  audience?: string;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  @Max(100, { message: 'rolloutPercent is a percentage: 0 to 100.' })
  rolloutPercent?: number;

  @IsOptional()
  @IsArray()
  @ArrayMaxSize(500)
  @IsUUID('all', { each: true })
  enabledTenantIds?: string[];

  @IsOptional()
  @IsString()
  @MaxLength(1000)
  rationale?: string;

  @IsString()
  @MinLength(5, { message: 'reason must say why this rollout is changing.' })
  @MaxLength(500)
  reason!: string;
}

export class UpdatePlatformSettingDto {
  /**
   * The new value, as JSON.
   *
   * Deliberately untyped, and `@Allow()` is load-bearing rather than decorative: the global
   * `ValidationPipe` runs with `whitelist: true`, which **strips every property that has no
   * validation decorator**, and `forbidNonWhitelisted` then rejects the request. Without it
   * every settings write was a 400 — caught by a test, not by inspection.
   *
   * Untyped because a settings table whose values are heterogeneous cannot have one DTO shape,
   * and inventing a discriminated union over eight settings would break the moment a ninth is
   * added by an insert rather than a migration. The setting itself is the authority on its own
   * shape.
   */
  @Allow()
  value!: unknown;

  @IsString()
  @MinLength(5, { message: 'reason must say why this global setting is changing.' })
  @MaxLength(500)
  reason!: string;
}

export class ResolveServiceAlertDto {
  @IsString()
  @MinLength(5, { message: 'resolution must say what was done.' })
  @MaxLength(1000)
  resolution!: string;
}
