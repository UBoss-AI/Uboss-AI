import {
  ArrayMaxSize,
  IsArray,
  IsBoolean,
  IsIn,
  IsISO8601,
  IsObject,
  IsOptional,
  IsString,
  IsUUID,
  MaxLength,
  MinLength,
} from 'class-validator';

import {
  ACTIONS,
  MODULE_KEYS,
  POLICY_LAYERS,
  ROLE_KINDS,
  SCOPE_KINDS,
  SOD_RULES,
  USER_TYPES,
  type Action,
  type ModuleKey,
  type PolicyLayer,
  type RoleKind,
  type ScopeKind,
  type SodRule,
  type UserType,
} from '@uboss/types';

/**
 * Request shapes for the authorization endpoints.
 *
 * Every enum is validated against `@uboss/types` rather than against a copy, so there is exactly
 * one place a module key or action name is defined. The global `ValidationPipe` runs with
 * `forbidNonWhitelisted`, so an undeclared field is a 400 — which matters here more than usual: a
 * typo in `scopeKind` must not result in an assignment that silently carries the default.
 */

export class AssignRoleDto {
  @IsUUID('7', { message: 'userId must be a UUID.' })
  userId!: string;

  @IsIn(ROLE_KINDS, { message: `roleKind must be one of: ${ROLE_KINDS.join(', ')}.` })
  roleKind!: RoleKind;

  @IsOptional()
  @IsUUID('7')
  customRoleId?: string;

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

  /**
   * Why this grant exists.
   *
   * Optional in the API and recorded as present-or-absent in the audit trail, because an access
   * review's usual finding is that nobody wrote one — making it required would just produce
   * "because" in every field.
   */
  @IsOptional()
  @IsString()
  @MaxLength(500)
  justification?: string;
}

export class CreateCustomRoleDto {
  @IsString()
  @MinLength(2)
  @MaxLength(120)
  displayName!: string;

  @IsOptional()
  @IsString()
  @MaxLength(500)
  description?: string;

  /**
   * `{ "<moduleKey>": ["View", "EditDraft"] }`.
   *
   * Validated as an object here and then narrowed by `sanitisePermissionSet`, which drops
   * anything unrecognised. A per-key validator would need a dynamic schema for 29 modules; the
   * narrowing function is the single place that decides what a valid permission is.
   */
  @IsObject()
  permissions!: Record<string, string[]>;

  @IsIn(SCOPE_KINDS)
  maxScope!: ScopeKind;
}

export class CreatePolicyRuleDto {
  @IsIn(POLICY_LAYERS, { message: `layer must be one of: ${POLICY_LAYERS.join(', ')}.` })
  layer!: PolicyLayer;

  @IsOptional()
  @IsString()
  @MaxLength(64)
  departmentId?: string;

  @IsOptional()
  @IsString()
  @MaxLength(64)
  objectiveId?: string;

  @IsOptional()
  @IsString()
  @MaxLength(64)
  engineAgentId?: string;

  /** Omit for "every module" — how a broad control is expressed. */
  @IsOptional()
  @IsIn(MODULE_KEYS)
  module?: ModuleKey;

  /** Omit for "every action". */
  @IsOptional()
  @IsIn(ACTIONS)
  action?: Action;

  @IsIn(['Deny', 'Allow'])
  effect!: 'Deny' | 'Allow';

  /**
   * Sealed against lower layers.
   *
   * Only meaningful on a `Deny` — a mandatory `Allow` is refused by a database check constraint
   * as well as by the service, because a grant that lower layers cannot tighten is the one thing
   * the precedence rule forbids.
   */
  @IsBoolean()
  mandatory!: boolean;

  @IsOptional()
  @IsIn(SCOPE_KINDS)
  maxScope?: ScopeKind;

  /** Shown to the person who gets refused, so it has to be written for them. */
  @IsString()
  @MinLength(4)
  @MaxLength(300)
  reason!: string;
}

export class CreateSodPolicyDto {
  @IsOptional()
  @IsIn(POLICY_LAYERS)
  layer?: PolicyLayer;

  @IsOptional()
  @IsIn(MODULE_KEYS)
  module?: ModuleKey;

  @IsIn(ACTIONS)
  action!: Action;

  @IsIn(SOD_RULES, { message: `rule must be one of: ${SOD_RULES.join(', ')}.` })
  rule!: SodRule;

  @IsBoolean()
  mandatory!: boolean;

  @IsString()
  @MinLength(4)
  @MaxLength(300)
  reason!: string;
}

export class SetUserTypeDto {
  @IsIn(['InternalUser', 'ExternalGuest'], {
    message:
      'userType must be InternalUser or ExternalGuest. A company membership cannot be a ' +
      'Platform User — platform actors have no company membership.',
  })
  userType!: Exclude<UserType, 'PlatformUser'>;
}

/**
 * One row of the client's approved TCSiON reference.
 *
 * The external fields are free text on purpose: they hold the client's vocabulary verbatim, and
 * constraining them to an enum would mean inventing TCSiON definitions, which is forbidden. The
 * UBoss side is validated strictly, so a transcription error is caught at load time rather than
 * at somebody's first sign-in.
 */
export class LoadTcsionMappingDto {
  @IsString()
  @MinLength(1)
  @MaxLength(120)
  externalUserType!: string;

  @IsOptional()
  @IsString()
  @MaxLength(120)
  externalAllotment?: string;

  @IsIn(USER_TYPES)
  ubossUserType!: UserType;

  @IsIn(ROLE_KINDS)
  roleKind!: RoleKind;

  @IsOptional()
  @IsUUID('7')
  customRoleId?: string;

  @IsIn(SCOPE_KINDS)
  scopeKind!: ScopeKind;

  @IsOptional()
  @IsArray()
  @ArrayMaxSize(200)
  @IsString({ each: true })
  @MaxLength(64, { each: true })
  departmentIds?: string[];

  /** `{ "<moduleKey>": true|false }`. An absent module is not visible — fails closed. */
  @IsObject()
  moduleVisibility!: Record<string, boolean>;

  /** `{ "<moduleKey>": ["View"] }`. A restriction on the role, never an addition. */
  @IsObject()
  allowedActions!: Record<string, string[]>;

  /** Which client document and version this row came from. Mandatory. */
  @IsString()
  @MinLength(4)
  @MaxLength(300)
  approvedReference!: string;
}

/**
 * A permission question, for the internal test endpoint.
 *
 * The resource fields are supplied by the caller rather than loaded, because the point of the
 * endpoint is to answer "what would happen if" — including for a resource that does not exist yet.
 */
export class EvaluatePermissionDto {
  /** Whose permissions to evaluate. Omit for the caller's own. */
  @IsOptional()
  @IsUUID('7')
  userId?: string;

  @IsIn(MODULE_KEYS)
  module!: ModuleKey;

  @IsIn(ACTIONS)
  action!: Action;

  @IsOptional()
  @IsString()
  @MaxLength(64)
  resourceId?: string;

  @IsOptional()
  @IsUUID('7')
  resourceOwnerUserId?: string;

  @IsOptional()
  @IsUUID('7')
  resourceCreatedByUserId?: string;

  @IsOptional()
  @IsString()
  @MaxLength(64)
  resourceDepartmentId?: string;

  @IsOptional()
  @IsArray()
  @ArrayMaxSize(50)
  @IsUUID('7', { each: true })
  priorActorUserIds?: string[];

  /** Ask the question as an Engine Agent or the Executor Agent would. */
  @IsOptional()
  @IsBoolean()
  actingAsAgent?: boolean;
}
