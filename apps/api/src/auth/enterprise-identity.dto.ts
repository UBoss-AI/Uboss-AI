import {
  IsBoolean,
  IsEmail,
  IsIn,
  IsISO8601,
  IsOptional,
  IsString,
  IsUrl,
  IsUUID,
  Matches,
  MaxLength,
  MinLength,
} from 'class-validator';

/**
 * Request shapes for the enterprise-identity endpoints.
 *
 * The application's global `ValidationPipe` runs with `whitelist` and `forbidNonWhitelisted`, so
 * an undeclared field is a 400 rather than being silently dropped. That matters most on the
 * connection endpoints: a typo in `clientSecret` must not result in a connection that quietly
 * has no secret.
 */

/** A TOTP code, or a recovery code. One field, because the caller must not be told which it was. */
export class VerifyMfaDto {
  @IsString()
  @MinLength(6, { message: 'Enter the code from your authenticator app, or a recovery code.' })
  @MaxLength(64)
  code!: string;
}

export class StartMfaEnrolmentDto {
  @IsOptional()
  @IsString()
  @MaxLength(80)
  label?: string;
}

export class ConfirmMfaEnrolmentDto {
  @IsUUID('7', { message: 'factorId must be a UUID.' })
  factorId!: string;

  @IsString()
  @Matches(/^[\d\s-]{6,12}$/, { message: 'Enter the 6-digit code from your authenticator app.' })
  code!: string;
}

export class SignInMethodsQueryDto {
  @IsEmail({}, { message: 'Enter a valid work email address.' })
  @MaxLength(320)
  email!: string;
}

export class UpdateAuthPolicyDto {
  @IsBoolean()
  requireMfa!: boolean;

  @IsBoolean()
  requireSso!: boolean;

  /**
   * When MFA becomes required, members with no enrolled factor may still sign in until this
   * instant. Optional, and omitting it means "immediately" — which is a legitimate choice for a
   * company where everyone is already enrolled, and a lockout for one where they are not. The
   * screen says so; the API does not guess.
   */
  @IsOptional()
  @IsISO8601({}, { message: 'mfaGraceUntil must be an ISO-8601 timestamp.' })
  mfaGraceUntil?: string;
}

export class CreateSsoConnectionDto {
  @IsIn(['Oidc', 'Saml'], { message: 'protocol must be Oidc or Saml.' })
  protocol!: 'Oidc' | 'Saml';

  @IsString()
  @MinLength(1)
  @MaxLength(120)
  displayName!: string;

  // ---- OIDC ----
  @IsOptional()
  @IsUrl({ require_tld: false, protocols: ['http', 'https'] }, { message: 'issuer must be a URL.' })
  @MaxLength(255)
  issuer?: string;

  @IsOptional()
  @IsUrl(
    { require_tld: false, protocols: ['http', 'https'] },
    { message: 'discoveryUrl must be a URL.' },
  )
  @MaxLength(500)
  discoveryUrl?: string;

  @IsOptional()
  @IsString()
  @MaxLength(255)
  clientId?: string;

  /**
   * The OIDC client secret. Accepted here, encrypted immediately, and **never returned** by any
   * endpoint afterwards — the same one-way contract as an invitation token, except that this one
   * has to be decryptable by the server because it is replayed to the token endpoint.
   */
  @IsOptional()
  @IsString()
  @MinLength(8)
  @MaxLength(400)
  clientSecret?: string;

  @IsOptional()
  @IsString()
  @MaxLength(255)
  scopes?: string;

  // ---- SAML ----
  @IsOptional()
  @IsString()
  @MaxLength(255)
  entityId?: string;

  @IsOptional()
  @IsUrl({ require_tld: false, protocols: ['http', 'https'] })
  @MaxLength(500)
  ssoUrl?: string;

  @IsOptional()
  @IsUrl({ require_tld: false, protocols: ['http', 'https'] })
  @MaxLength(500)
  sloUrl?: string;

  @IsOptional()
  @IsString()
  @MaxLength(8000)
  signingCertificate?: string;
}

export class UpdateSsoConnectionDto {
  @IsOptional()
  @IsString()
  @MinLength(1)
  @MaxLength(120)
  displayName?: string;

  @IsOptional()
  @IsBoolean()
  enabled?: boolean;

  @IsOptional()
  @IsUrl({ require_tld: false, protocols: ['http', 'https'] })
  @MaxLength(255)
  issuer?: string;

  @IsOptional()
  @IsUrl({ require_tld: false, protocols: ['http', 'https'] })
  @MaxLength(500)
  discoveryUrl?: string;

  @IsOptional()
  @IsString()
  @MaxLength(255)
  clientId?: string;

  @IsOptional()
  @IsString()
  @MinLength(8)
  @MaxLength(400)
  clientSecret?: string;

  @IsOptional()
  @IsString()
  @MaxLength(255)
  scopes?: string;
}

export class ClaimDomainDto {
  /** Validated further by `normaliseDomain`, which rejects schemes, ports and wildcards. */
  @IsString()
  @MinLength(4)
  @MaxLength(253)
  domain!: string;
}

export class CreateScimClientDto {
  @IsString()
  @MinLength(1)
  @MaxLength(120)
  displayName!: string;
}

export class StartSsoDto {
  @IsUUID('7', { message: 'connectionId must be a UUID.' })
  connectionId!: string;

  /**
   * Where to send the browser afterwards. Constrained to the configured web origin before use —
   * an authentication callback that honours an arbitrary URL is an open redirect on the most
   * useful possible domain.
   */
  @IsOptional()
  @IsString()
  @MaxLength(500)
  redirectAfter?: string;
}

export class BackchannelLogoutDto {
  @IsString()
  @MinLength(20)
  @MaxLength(8000)
  logout_token!: string;
}
