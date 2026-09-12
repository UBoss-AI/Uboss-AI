import { IsEmail, IsOptional, IsString, IsUUID, MaxLength, MinLength } from 'class-validator';

/**
 * Request bodies for the auth endpoints.
 *
 * The global `ValidationPipe` runs with `whitelist` and `forbidNonWhitelisted`, so a body
 * carrying anything not declared here is **rejected**, not silently ignored. That is what stops
 * a future field being smuggled in — for example a `userId` or `isPlatformActor` that a handler
 * might one day trust.
 *
 * Password length is validated again in `PasswordService`, because policy belongs with the
 * hashing, not only at the edge.
 */

export class LoginDto {
  @IsEmail({}, { message: 'Enter a valid work email address.' })
  @MaxLength(320)
  email!: string;

  // Only bounded here; strength policy lives in PasswordService so it applies to every path
  // that sets a password.
  @IsString()
  @MinLength(1, { message: 'Enter your password.' })
  @MaxLength(256)
  password!: string;
}

export class ActivateInvitationDto {
  @IsString()
  @MinLength(1)
  @MaxLength(200)
  token!: string;

  /**
   * Omitted when the person already has a UBoss password from another company — one identity,
   * one password across companies.
   */
  @IsOptional()
  @IsString()
  @MaxLength(256)
  password?: string;
}

export class PreviewInvitationDto {
  @IsString()
  @MinLength(1)
  @MaxLength(200)
  token!: string;
}

export class RequestPasswordResetDto {
  @IsEmail({}, { message: 'Enter a valid work email address.' })
  @MaxLength(320)
  email!: string;
}

export class ConfirmPasswordResetDto {
  @IsString()
  @MinLength(1)
  @MaxLength(200)
  token!: string;

  @IsString()
  @MaxLength(256)
  password!: string;
}

export class CreateInvitationDto {
  @IsUUID('7', { message: 'tenantId must be a UUID.' })
  tenantId!: string;

  @IsEmail({}, { message: 'Enter a valid work email address.' })
  @MaxLength(320)
  email!: string;

  @IsString()
  @MinLength(1)
  @MaxLength(200)
  displayName!: string;
}

export class CancelInvitationDto {
  @IsUUID('7')
  tenantId!: string;
}
