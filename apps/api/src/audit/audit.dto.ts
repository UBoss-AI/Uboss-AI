import {
  ArrayMaxSize,
  ArrayMinSize,
  IsArray,
  IsIn,
  IsISO8601,
  IsInt,
  IsOptional,
  IsString,
  IsUUID,
  Max,
  MaxLength,
  Min,
  MinLength,
} from 'class-validator';
import { Type } from 'class-transformer';

import { ACTIONS, COMPANY_MODULES, type Action } from '@uboss/types';

import { MAX_BREAK_GLASS_MINUTES } from './break-glass.service.js';
import { MAX_EXPORT_ROWS } from './audit-query.service.js';

/**
 * Request shapes for the audit, security and break-glass endpoints.
 *
 * The global `ValidationPipe` runs with `forbidNonWhitelisted`, so an undeclared field is a 400.
 * That matters more here than elsewhere: a mistyped filter field that was silently ignored would
 * return a **wider** result set than the caller asked for, and on an audit export "wider than
 * asked for" is a disclosure rather than a bug.
 */

const SECURITY_CATEGORIES = ['Login', 'Session', 'Risk', 'Support', 'Access'] as const;
const SECURITY_SEVERITIES = ['Info', 'Notice', 'Warning', 'Critical'] as const;
const SECURITY_OUTCOMES = ['Succeeded', 'Failed', 'Blocked'] as const;
const BREAK_GLASS_STATES = [
  'Requested',
  'IdentityVerified',
  'Approved',
  'Denied',
  'Active',
  'Expired',
  'Revoked',
] as const;

/** A time window shared by both trail filters. */
class TrailWindowDto {
  @IsOptional()
  @IsISO8601({}, { message: 'from must be an ISO 8601 timestamp.' })
  from?: string;

  @IsOptional()
  @IsISO8601({}, { message: 'to must be an ISO 8601 timestamp.' })
  to?: string;

  /** Keyset cursor from a previous page's `nextCursor`. */
  @IsOptional()
  @IsISO8601()
  before?: string;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(MAX_EXPORT_ROWS)
  limit?: number;
}

export class AuditFilterDto extends TrailWindowDto {
  /** An exact action key. Mutually exclusive with `actionPrefix`. */
  @IsOptional()
  @IsString()
  @MaxLength(120)
  action?: string;

  /**
   * A prefix, e.g. `break_glass.` for every break-glass step.
   *
   * Rejected together with `action` in the controller rather than silently letting one win —
   * a filter that quietly ignores half of what it was given returns the wrong rows.
   */
  @IsOptional()
  @IsString()
  @MaxLength(120)
  actionPrefix?: string;

  @IsOptional()
  @IsUUID()
  actorUserId?: string;

  @IsOptional()
  @IsString()
  @MaxLength(60)
  resourceType?: string;

  @IsOptional()
  @IsString()
  @MaxLength(64)
  resourceId?: string;
}

export class SecurityFilterDto extends TrailWindowDto {
  @IsOptional()
  @IsIn(SECURITY_CATEGORIES, {
    message: `category must be one of: ${SECURITY_CATEGORIES.join(', ')}.`,
  })
  category?: (typeof SECURITY_CATEGORIES)[number];

  @IsOptional()
  @IsIn(SECURITY_SEVERITIES, {
    message: `severity must be one of: ${SECURITY_SEVERITIES.join(', ')}.`,
  })
  severity?: (typeof SECURITY_SEVERITIES)[number];

  @IsOptional()
  @IsIn(SECURITY_OUTCOMES, { message: `outcome must be one of: ${SECURITY_OUTCOMES.join(', ')}.` })
  outcome?: (typeof SECURITY_OUTCOMES)[number];

  @IsOptional()
  @IsString()
  @MaxLength(120)
  action?: string;

  @IsOptional()
  @IsUUID()
  actorUserId?: string;

  @IsOptional()
  @IsUUID()
  subjectUserId?: string;
}

export class SealCheckpointDto {
  @IsIn(['audit', 'security'], { message: 'trail must be "audit" or "security".' })
  trail!: 'audit' | 'security';

  /**
   * Where the checkpoint was copied to, outside this database.
   *
   * Optional, because sealing is useful without it — but a checkpoint with no anchor is
   * honestly reported as unanchored, and the verification result says what that costs.
   */
  @IsOptional()
  @IsString()
  @MaxLength(300)
  externalAnchorRef?: string;
}

export class RequestBreakGlassDto {
  @IsUUID()
  tenantId!: string;

  /**
   * Why. At least 20 characters, checked again in the service.
   *
   * The length floor is not bureaucracy: this is the field somebody reads during a review months
   * later, and "urgent" tells them nothing.
   */
  @IsString()
  @MinLength(20, {
    message:
      'reason must be at least 20 characters and explain what is wrong and why normal access ' +
      'is insufficient.',
  })
  @MaxLength(1000)
  reason!: string;

  /** A ticket or incident reference. */
  @IsOptional()
  @IsString()
  @MaxLength(300)
  externalReference?: string;

  @IsArray()
  @ArrayMinSize(1, { message: 'allowedModules must name at least one module.' })
  @ArrayMaxSize(COMPANY_MODULES.length)
  @IsIn(COMPANY_MODULES, {
    each: true,
    message: `allowedModules must contain only company modules: ${COMPANY_MODULES.join(', ')}.`,
  })
  allowedModules!: string[];

  @IsArray()
  @ArrayMinSize(1, { message: 'allowedActions must name at least one action.' })
  @ArrayMaxSize(ACTIONS.length)
  @IsIn(ACTIONS, { each: true, message: `allowedActions must be actions: ${ACTIONS.join(', ')}.` })
  allowedActions!: Action[];

  @IsOptional()
  @IsArray()
  @ArrayMaxSize(200)
  @IsString({ each: true })
  @MaxLength(64, { each: true })
  allowedResourceIds?: string[];
}

export class VerifyBreakGlassIdentityDto {
  @IsIn(['VerifiedByHuman', 'VerifiedBySecondFactor', 'Failed'], {
    message: 'result must be VerifiedByHuman, VerifiedBySecondFactor or Failed.',
  })
  result!: 'VerifiedByHuman' | 'VerifiedBySecondFactor' | 'Failed';

  /** How it was verified — the known number that was called, the factor that was used. */
  @IsOptional()
  @IsString()
  @MaxLength(500)
  note?: string;
}

export class ApproveBreakGlassDto {
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(MAX_BREAK_GLASS_MINUTES, {
    message:
      `minutes must be at most ${MAX_BREAK_GLASS_MINUTES}. A longer grant is ` +
      'indistinguishable from standing access.',
  })
  minutes?: number;

  @IsOptional()
  @IsString()
  @MaxLength(500)
  note?: string;
}

export class DenyBreakGlassDto {
  @IsString()
  @MinLength(1, { message: 'A denial requires a reason.' })
  @MaxLength(500)
  reason!: string;
}

export class RevokeBreakGlassDto {
  @IsString()
  @MinLength(1, { message: 'A revocation requires a reason.' })
  @MaxLength(500)
  reason!: string;
}

export class NotifyCustomerDto {
  @IsIn(['Sent', 'Failed', 'Suppressed'], {
    message: 'outcome must be Sent, Failed or Suppressed.',
  })
  outcome!: 'Sent' | 'Failed' | 'Suppressed';

  /** Required when the outcome is `Suppressed`. Enforced in the service and by the database. */
  @IsOptional()
  @IsString()
  @MaxLength(500)
  suppressionReason?: string;
}

export class ListBreakGlassDto {
  @IsOptional()
  @IsUUID()
  tenantId?: string;

  @IsOptional()
  @IsIn(BREAK_GLASS_STATES, { message: `state must be one of: ${BREAK_GLASS_STATES.join(', ')}.` })
  state?: (typeof BREAK_GLASS_STATES)[number];

  /** `true` to show only requests whose customer notification is still outstanding. */
  @IsOptional()
  @IsIn(['true', 'false'])
  notificationPending?: 'true' | 'false';

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(200)
  take?: number;
}
