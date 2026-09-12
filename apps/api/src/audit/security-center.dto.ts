import {
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

import { SECURITY_TIME_RANGES, type SecurityTimeRange } from '@uboss/types';

/**
 * Request shapes for the Security Center — Prompt 32.
 *
 * The global `ValidationPipe` runs with `forbidNonWhitelisted`, and that matters more here than
 * almost anywhere: a mistyped filter field that was silently ignored would return a **wider**
 * result than the caller asked for, and on security evidence "wider than asked for" is a
 * disclosure rather than a bug. The same reasoning the audit DTOs already state.
 */

const SECURITY_SEVERITIES = ['Info', 'Notice', 'Warning', 'Critical'] as const;
const SECURITY_OUTCOMES = ['Succeeded', 'Failed', 'Blocked'] as const;

/**
 * The longest horizon a "guests expiring soon" question can be asked over.
 *
 * A year, because a guest engagement can legitimately run that long and a company reviewing
 * access wants to see the whole of it. Longer than that and "expiring soon" has stopped meaning
 * anything.
 */
const MAX_GUEST_HORIZON_DAYS = 365;

export class SecurityPostureDto {
  @IsOptional()
  @IsIn(SECURITY_TIME_RANGES as readonly string[], {
    message: `range must be one of: ${SECURITY_TIME_RANGES.join(', ')}.`,
  })
  range?: SecurityTimeRange;

  /**
   * How far ahead to look for guest access that is about to end.
   *
   * Defaults to the company's own `guestExpiryDays` rather than to a number chosen here — §23
   * requires guest access to be "expiry-capable" and states no review period, so the company's
   * configured default is the only non-invented answer.
   */
  @IsOptional()
  @Type(() => Number)
  @IsInt({ message: 'guestHorizonDays must be a whole number of days.' })
  @Min(1)
  @Max(MAX_GUEST_HORIZON_DAYS)
  guestHorizonDays?: number;
}

export class SecurityCenterViewDto extends SecurityPostureDto {
  /** Narrow to one person's activity — the second question every investigation asks. */
  @IsOptional()
  @IsUUID(7, { message: 'actorUserId must be a UBoss user id.' })
  actorUserId?: string;

  /**
   * The request that produced an event, which is how two trails are joined together.
   *
   * Only the event-backed views carry one; `vocabulary` says which, so a client does not offer
   * this filter on a view whose rows are state.
   */
  @IsOptional()
  @IsString()
  @MinLength(1)
  @MaxLength(64)
  correlationId?: string;

  @IsOptional()
  @IsIn(SECURITY_SEVERITIES as readonly string[], {
    message: `severity must be one of: ${SECURITY_SEVERITIES.join(', ')}.`,
  })
  severity?: (typeof SECURITY_SEVERITIES)[number];

  @IsOptional()
  @IsIn(SECURITY_OUTCOMES as readonly string[], {
    message: `outcome must be one of: ${SECURITY_OUTCOMES.join(', ')}.`,
  })
  outcome?: (typeof SECURITY_OUTCOMES)[number];

  /** Continue a page. The cursor is the last row's timestamp, as the trail endpoints use. */
  @IsOptional()
  @IsISO8601({}, { message: 'before must be an ISO 8601 timestamp.' })
  before?: string;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(100)
  limit?: number;
}

export class RevokeSessionDto {
  /**
   * Why. Mandatory, and not defaulted.
   *
   * Signing somebody out is a security act, and an unexplained one cannot be reviewed — the
   * person it happened to is entitled to an answer, and "admin_revoke" is not one. The minimum
   * length is deliberately more than a keystroke.
   */
  @IsString()
  @MinLength(4, { message: 'Say why the session is being revoked.' })
  @MaxLength(500)
  reason!: string;
}
