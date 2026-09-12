import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  IsBoolean,
  IsEmail,
  IsIn,
  IsISO8601,
  IsInt,
  IsObject,
  IsOptional,
  IsString,
  Matches,
  Max,
  MaxLength,
  Min,
  MinLength,
  ValidateNested,
} from 'class-validator';

import { COMPANY_MODULES } from '@uboss/types';

/**
 * The Create Company wizard payload.
 *
 * ## One request, ten steps
 *
 * The wizard collects across ten screens and submits **once**. That is not a UI convenience — it
 * is what makes provisioning a single transaction. A step-by-step API would create a company
 * after step 1 and leave a half-provisioned tenant behind whenever somebody closed the tab at
 * step 4, and there is no way to recover such a company through the product.
 *
 * The nested objects mirror the wizard's own grouping so a validation error can be traced back
 * to the screen that produced it.
 *
 * ## What is deliberately absent
 *
 * **No password field, anywhere.** The initial administrator receives a secure activation
 * invitation; UBoss never generates, displays, emails or stores a password.
 *
 * **No provider credential field.** Step 5 accepts an AI *mode* and, for BYOK, a masked hint for
 * display — never a key. The credential is stored later through the Prompt 6 secret box by an
 * explicitly-authorised call, so a wizard payload cannot carry one even by mistake. The client's
 * locked rule is "no reusable provider credentials in normal UI/database fields", and a
 * `providerApiKey` here is exactly the field that rule forbids.
 */

const BILLING_CYCLES = ['Monthly', 'Quarterly', 'Annual'] as const;
const AI_MODES = ['UBossManaged', 'CompanyByok', 'CustomEnterpriseProvider'] as const;

class LogoMetadataDto {
  @IsString()
  @MaxLength(200)
  fileName!: string;

  @Matches(/^image\/(png|jpeg|svg\+xml|webp)$/, {
    message: 'A logo must be a PNG, JPEG, SVG or WebP image.',
  })
  mimeType!: string;

  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(2_000_000, { message: 'A logo above 2 MB is a logo nobody wants to load on every page.' })
  sizeBytes!: number;

  /** Where the bytes live. Metadata only in the database — see the `Tenant` logo comment. */
  @IsString()
  @MaxLength(300)
  storageKey!: string;
}

class InitialAdminDto {
  @IsString()
  @MinLength(2)
  @MaxLength(200)
  name!: string;

  /** The official work email. The activation invitation goes here and nowhere else. */
  @IsEmail({}, { message: 'The initial administrator needs a valid work email address.' })
  @MaxLength(320)
  workEmail!: string;

  @IsOptional()
  @IsString()
  @MaxLength(120)
  title?: string;

  @IsOptional()
  @IsString()
  @MaxLength(40)
  contactNumber?: string;
}

class AiBudgetDto {
  /** Minor units. Integers throughout — money in a float becomes an invoice dispute. */
  @Type(() => Number)
  @IsInt()
  @Min(0)
  monthlyAllowanceMinor!: number;

  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(100, { message: 'The warning threshold is a percentage: 1 to 100.' })
  warningPercent!: number;

  /** Above this, a spend needs human approval. Must not exceed the hard stop. */
  @Type(() => Number)
  @IsInt()
  @Min(0)
  approvalThresholdMinor!: number;

  /** Above this, nothing runs. */
  @Type(() => Number)
  @IsInt()
  @Min(0)
  hardStopMinor!: number;

  /** `{ "<departmentId>": <minor> }`. Optional; departments do not exist until Prompt 12. */
  @IsOptional()
  @IsObject()
  departmentAllocations?: Record<string, number>;
}

class SecurityDefaultsDto {
  /** Claimed, not verified. A domain grants nothing until its DNS record is checked. */
  @IsOptional()
  @Matches(/^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/i, {
    message: 'That is not a domain name.',
  })
  @MaxLength(253)
  primaryDomain?: string;

  @IsBoolean()
  requireMfa!: boolean;

  @IsBoolean()
  requireSso!: boolean;

  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(365, {
    message: 'A guest window beyond a year is a permanent external account. Choose a real expiry.',
  })
  guestExpiryDays!: number;

  /** `false` refuses platform support access to this company entirely, break-glass included. */
  @IsBoolean()
  supportAccessAllowed!: boolean;

  @IsBoolean()
  supportAccessRequiresCustomerApproval!: boolean;
}

export class ProvisionCompanyDto {
  // ---- Step 1: company identity ----
  @IsString()
  @MinLength(2)
  @MaxLength(200)
  legalName!: string;

  @IsString()
  @MinLength(2)
  @MaxLength(200)
  displayName!: string;

  /** Human-facing company code, e.g. `MEDNOVA`. Unique across the platform. */
  @Matches(/^[A-Z0-9][A-Z0-9-]{1,18}[A-Z0-9]$/, {
    message:
      'The company code is upper-case letters, digits and hyphens, 3 to 20 characters — it ' +
      'appears on invoices, so it has to be readable.',
  })
  code!: string;

  @Matches(/^[A-Z]{2}$/, { message: 'countryRegion is an ISO 3166-1 alpha-2 code, e.g. IN.' })
  countryRegion!: string;

  /**
   * IANA timezone. Every schedule and due date is computed against it, so it is company data
   * rather than a per-user preference — a Monday deadline means the company's Monday.
   */
  @IsString()
  @MaxLength(60)
  @Matches(/^[A-Za-z]+\/[A-Za-z_+-]+(\/[A-Za-z_+-]+)?$|^UTC$/, {
    message: 'timezone must be an IANA name such as Asia/Kolkata, or UTC.',
  })
  timezone!: string;

  @Matches(/^[A-Z]{3}$/, { message: 'currency is an ISO 4217 code, e.g. INR.' })
  currency!: string;

  @IsOptional()
  @ValidateNested()
  @Type(() => LogoMetadataDto)
  logo?: LogoMetadataDto;

  // ---- Step 2: initial Company Super Admin ----
  @ValidateNested()
  @Type(() => InitialAdminDto)
  admin!: InitialAdminDto;

  // ---- Step 3: commercial plan ----
  @Matches(/^[a-z0-9][a-z0-9-]*[a-z0-9]$/)
  @MaxLength(40)
  planCode!: string;

  @Type(() => Number)
  @IsInt()
  @Min(1, { message: 'A company needs at least one seat — its first administrator.' })
  @Max(100_000)
  seats!: number;

  @IsISO8601()
  startDate!: string;

  @IsISO8601()
  renewalDate!: string;

  @IsIn(BILLING_CYCLES, { message: `billingCycle must be one of: ${BILLING_CYCLES.join(', ')}.` })
  billingCycle!: (typeof BILLING_CYCLES)[number];

  @Type(() => Number)
  @IsInt()
  @Min(0)
  commercialAllowanceMinor!: number;

  // ---- Step 4: modules / entitlements ----
  //
  // Entitlement, **not** authorization. This decides what the company has bought; who inside it
  // may use a module is the Prompt 7 engine's separate question.
  @IsOptional()
  @ArrayMaxSize(COMPANY_MODULES.length)
  @IsIn(COMPANY_MODULES, {
    each: true,
    message: `extraModules must contain only company modules: ${COMPANY_MODULES.join(', ')}.`,
  })
  extraModules?: string[];

  @IsOptional()
  @ArrayMaxSize(COMPANY_MODULES.length)
  @IsIn(COMPANY_MODULES, { each: true })
  removedModules?: string[];

  // ---- Step 5: AI mode ----
  @IsIn(AI_MODES, { message: `aiMode must be one of: ${AI_MODES.join(', ')}.` })
  aiMode!: (typeof AI_MODES)[number];

  /**
   * Logical model profiles and fallback order.
   *
   * A **placeholder** by instruction — the prompt asks for "logical model-profile policy
   * placeholders only where appropriate". Left as free-form JSON because the real vocabulary
   * belongs to the model gateway, and a typed shape now would be guessing at a schema another
   * module owns.
   */
  @IsOptional()
  @IsObject()
  modelProfilePolicy?: Record<string, unknown>;

  /**
   * A masked hint for display, e.g. `sk-…4f2a`. **Never a credential.**
   *
   * Length-capped at 40 so a full API key cannot fit, which turns the rule into something the
   * validator enforces rather than something a reviewer has to notice.
   */
  @IsOptional()
  @IsString()
  @MaxLength(40)
  providerCredentialHint?: string;

  /** A hostname is configuration, not a secret. Required for a Custom Enterprise Provider. */
  @IsOptional()
  @IsString()
  @MaxLength(300)
  customProviderEndpoint?: string;

  // ---- Step 6: skill packs ----
  @IsOptional()
  @IsBoolean()
  universalPackEnabled?: boolean;

  /** Industry pack codes, e.g. `healthcare`. */
  @IsOptional()
  @ArrayMaxSize(20)
  @IsString({ each: true })
  @MaxLength(40, { each: true })
  industryPacks?: string[];

  /**
   * Whether the company may author its own skills. A capability flag, not a catalogue — and
   * explicitly **not** a Templates Library, which is out of scope for this baseline.
   */
  @IsOptional()
  @IsBoolean()
  customSkillCapability?: boolean;

  // ---- Step 7: AI budget policy ----
  @ValidateNested()
  @Type(() => AiBudgetDto)
  budget!: AiBudgetDto;

  // ---- Step 8: security defaults ----
  @ValidateNested()
  @Type(() => SecurityDefaultsDto)
  security!: SecurityDefaultsDto;

  /**
   * Retry safety.
   *
   * The wizard's final "Provision" button is exactly the button somebody double-clicks, and a
   * provisioning that runs twice creates two companies and two invitations. The client supplies
   * a key; the outbox's unique constraint on it makes the second attempt a no-op that returns
   * the first result.
   */
  @IsString()
  @MinLength(8)
  @MaxLength(200)
  idempotencyKey!: string;
}

export class UpdateSetupTaskDto {
  @IsIn(['NotStarted', 'InProgress', 'Done', 'Skipped'], {
    message: 'state must be NotStarted, InProgress, Done or Skipped.',
  })
  state!: 'NotStarted' | 'InProgress' | 'Done' | 'Skipped';

  /** Required when skipping. Enforced in the service and by a check constraint. */
  @IsOptional()
  @IsString()
  @MaxLength(500)
  skipReason?: string;
}
