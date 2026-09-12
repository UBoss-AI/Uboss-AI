import { IsArray, IsIn, IsISO8601, IsOptional, IsString, IsUUID, MaxLength } from 'class-validator';

import {
  APPROVAL_DECISIONS,
  APPROVAL_REQUEST_STATUSES,
  APPROVAL_REQUEST_TYPES,
  type ApprovalDecision,
  type ApprovalRequestType,
} from '@uboss/types';

/**
 * Record a decision on one request.
 *
 * `note` is validated as present-but-possibly-empty here and required by the service for a
 * refusal, because "a rejection needs a reason" is a rule about the decision, not about the
 * request body — and it has to hold for every caller, not only the ones that come through HTTP.
 */
export class DecideApprovalDto {
  @IsIn(APPROVAL_DECISIONS as readonly string[])
  decision!: ApprovalDecision;

  @IsString()
  @MaxLength(4000)
  note = '';
}

export class ListApprovalsDto {
  @IsOptional()
  @IsIn(APPROVAL_REQUEST_STATUSES as readonly string[])
  status?: string;

  @IsOptional()
  @IsIn(APPROVAL_REQUEST_TYPES as readonly string[])
  type?: ApprovalRequestType;

  /** `"true"` narrows to what this actor is named on, or is a delegate for. */
  @IsOptional()
  @IsIn(['true', 'false'])
  mineOnly?: string;
}

/**
 * Create an out-of-office delegation.
 *
 * `fromUserId` is optional and defaults to the caller. Naming somebody else is the administrative
 * case and needs `approvals:ManageAccess`; the service enforces that, and also refuses the one
 * shape that would be a self-promotion — arranging for another person to delegate to you.
 */
export class CreateDelegationDto {
  @IsOptional()
  @IsUUID()
  fromUserId?: string;

  @IsUUID()
  toUserId!: string;

  /** Empty means every type. */
  @IsArray()
  @IsIn(APPROVAL_REQUEST_TYPES as readonly string[], { each: true })
  types: ApprovalRequestType[] = [];

  @IsISO8601()
  startsAt!: string;

  @IsISO8601()
  endsAt!: string;

  @IsString()
  @MaxLength(300)
  reason!: string;
}
