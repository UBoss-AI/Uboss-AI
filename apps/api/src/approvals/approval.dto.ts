import { IsArray, IsIn, IsISO8601, IsOptional, IsString, IsUUID, MaxLength } from 'class-validator';

import {
  APPROVAL_DECISIONS,
  APPROVAL_REQUEST_STATUSES,
  APPROVAL_REQUEST_TYPES,
  CHANGE_REQUEST_KINDS,
  MAX_CHANGE_REQUEST_REASON,
  type ApprovalDecision,
  type ApprovalRequestType,
  type ChangeRequestKind,
} from '@uboss/types';

/**
 * Ask for a change.
 *
 * The reason's *floor* is the service's business, not this DTO's: "somebody has to be able to
 * decide this" is a rule about the request, and it has to hold for every caller rather than only
 * for the ones arriving over HTTP. The ceiling is here because it is about what the column holds.
 */
export class RequestChangeDto {
  @IsIn(CHANGE_REQUEST_KINDS as readonly string[])
  kind!: ChangeRequestKind;

  @IsString()
  @MaxLength(MAX_CHANGE_REQUEST_REASON)
  reason!: string;

  /** The conversation it was raised from, when it was raised from one. */
  @IsOptional()
  @IsUUID()
  conversationId?: string;
}

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
