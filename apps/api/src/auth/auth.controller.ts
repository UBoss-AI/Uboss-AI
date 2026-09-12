import {
  BadRequestException,
  Body,
  Controller,
  Delete,
  ForbiddenException,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Post,
  Query,
  Req,
  Res,
  UnauthorizedException,
} from '@nestjs/common';
import type { Request, Response } from 'express';

import {
  actorUserId,
  isPlatformActor,
  isTenantActor,
} from '../request-context/authenticated-actor.js';
import { getActor } from '../request-context/request-context.js';
import { AllowAnonymous, Authenticated, PlatformOnly } from '../tenancy/tenancy.decorators.js';
import { TenantContextService } from '../tenancy/tenant-context.service.js';
import {
  ActivateInvitationDto,
  ConfirmPasswordResetDto,
  LoginDto,
  PreviewInvitationDto,
  RequestPasswordResetDto,
} from './auth.dto.js';
import {
  BackchannelLogoutDto,
  ConfirmMfaEnrolmentDto,
  SignInMethodsQueryDto,
  StartMfaEnrolmentDto,
  StartSsoDto,
  VerifyMfaDto,
} from './enterprise-identity.dto.js';
import { AuthenticationPolicyService } from './authentication-policy.service.js';
import { InvitationService } from './invitation.service.js';
import { LoginService } from './login.service.js';
import { MfaLoginService } from './mfa-login.service.js';
import { MfaService } from './mfa.service.js';
import { PasswordResetService } from './password-reset.service.js';
import { SessionService } from './session.service.js';
import { SsoService } from './sso/sso.service.js';

/**
 * The current actor's user id, or a 401.
 *
 * Accepts every authenticated kind — platform, tenant and the workspace-less `user` — because
 * these are person-level operations. Someone must be able to review and revoke their sessions
 * without first choosing a company.
 */
function requireUserId(): string {
  const userId = actorUserId(getActor());
  if (!userId) {
    throw new UnauthorizedException('Authentication is required.');
  }
  return userId;
}

/** The MFA challenge token from its cookie, if the browser sent one. */
function challengeTokenFrom(request: Request, cookieName: string): string | undefined {
  return (request as Request & { cookies?: Record<string, string> }).cookies?.[cookieName];
}

function originFrom(request: Request) {
  return {
    userAgent: request.headers['user-agent'],
    // `request.ip` respects Express's trust-proxy setting. It is reduced to a coarse hint
    // before storage — see `clientHintFrom`.
    ipAddress: request.ip,
  };
}

/**
 * Authentication endpoints.
 *
 * The routes that *establish* authentication are `@AllowAnonymous`. The person-level session
 * routes are `@Authenticated`: they need a signed-in identity but no workspace, because someone
 * must be able to review and revoke their sessions without first choosing a company.
 *
 * **There is no signup endpoint.** Nothing here creates a company or a membership.
 */
@Controller('auth')
export class AuthController {
  constructor(
    private readonly logins: LoginService,
    private readonly sessions: SessionService,
    private readonly invitations: InvitationService,
    private readonly passwordResets: PasswordResetService,
    private readonly tenantContext: TenantContextService,
    private readonly mfa: MfaService,
    private readonly mfaLogins: MfaLoginService,
    private readonly policies: AuthenticationPolicyService,
    private readonly sso: SsoService,
  ) {}

  @Post('login')
  @AllowAnonymous()
  @HttpCode(HttpStatus.OK)
  async login(
    @Body() body: LoginDto,
    @Req() request: Request,
    @Res({ passthrough: true }) response: Response,
  ) {
    const result = await this.logins.login(body.email, body.password, originFrom(request));

    if (result.outcome === 'locked') {
      response.setHeader('Retry-After', String(result.retryAfterSeconds));
      throw new UnauthorizedException(
        'This account is temporarily locked after repeated failed sign-ins. ' +
          'Try again later, or use Access Help to reset your password.',
      );
    }

    if (result.outcome === 'invalid-credentials') {
      // One message for every failure mode, so the endpoint cannot be used to discover which
      // email addresses have UBoss accounts.
      throw new UnauthorizedException('That email address and password do not match.');
    }

    if (result.outcome === 'sso-required') {
      // 200, not 401: the credentials were fine, and the answer is "use the other door". A 401
      // would make the browser show a credential error for something the person cannot fix by
      // retyping their password.
      return {
        ssoRequired: true as const,
        tenantName: result.tenantName,
        ssoConnections: result.connections,
        message: `${result.tenantName} requires you to sign in through its identity provider.`,
      };
    }

    if (result.outcome === 'mfa-required') {
      // The challenge cookie is the only thing that can finish this sign-in. No session cookie
      // is set, so nothing about this response grants access on its own.
      this.mfa.setChallengeCookie(response, result.challengeToken, result.challengeExpiresAt);

      return {
        mfaRequired: true as const,
        enrolmentRequired: result.enrolmentRequired,
        expiresAt: result.challengeExpiresAt.toISOString(),
        graceUntil: result.graceUntil?.toISOString() ?? null,
        recoveryCodesAccepted: !result.enrolmentRequired,
        message: result.enrolmentRequired
          ? 'Your company requires two-step sign-in. Set up an authenticator app to continue.'
          : 'Enter the code from your authenticator app.',
      };
    }

    this.sessions.setSessionCookie(response, result.sessionToken, result.absoluteExpiresAt);

    const workspaces = await this.tenantContext.listMemberships(result.userId);

    return {
      user: {
        ubossUniqueId: result.ubossUniqueId,
        displayName: result.displayName,
        isPlatformActor: result.isPlatformActor,
      },
      // Which companies this person may open. The workspace is still verified per request by
      // the tenant guard; this list is only for the workspace picker.
      workspaces,
      newDevice: result.newDevice,
    };
  }

  @Post('logout')
  @AllowAnonymous()
  @HttpCode(HttpStatus.NO_CONTENT)
  async logout(@Req() request: Request, @Res({ passthrough: true }) response: Response) {
    const token = (request as Request & { cookies?: Record<string, string> }).cookies?.[
      this.sessions.cookieName
    ];

    // Always clear the cookie, even if the session was already gone: "log out" must leave the
    // browser signed out regardless of server state.
    this.sessions.clearSessionCookie(response);

    // Deliberately `@AllowAnonymous` and driven by the cookie rather than the resolved actor:
    // signing out must work — and must still clear the cookie — even when the session has
    // already expired, which is exactly when the actor would be anonymous.
    if (token) {
      const validation = await this.sessions.validate(token);
      if (validation.outcome === 'valid') {
        await this.sessions.revokeCurrent(validation.userId, validation.sessionId);
      }
    }
  }

  /** The signed-in person and the workspaces they may open. */
  @Get('me')
  @Authenticated()
  async me() {
    const actor = getActor();

    if (actor.kind === 'anonymous') {
      throw new UnauthorizedException('Not signed in.');
    }

    const workspaces = await this.tenantContext.listMemberships(actor.userId);

    return {
      user: { ubossUniqueId: actor.ubossUniqueId, isPlatformActor: actor.kind === 'platform' },
      workspaces,
      activeWorkspaceId: isTenantActor(actor) ? actor.tenantId : null,
    };
  }

  /** The caller's own active sessions. */
  @Get('sessions')
  @Authenticated()
  async listSessions(@Req() request: Request) {
    const userId = requireUserId();
    const currentToken = (request as Request & { cookies?: Record<string, string> }).cookies?.[
      this.sessions.cookieName
    ];
    const current = await this.sessions.validate(currentToken);
    const currentSessionId = current.outcome === 'valid' ? current.sessionId : null;

    const sessions = await this.sessions.listForUser(userId);

    return {
      sessions: sessions.map((session) => ({
        id: session.id,
        deviceLabel: session.deviceLabel,
        // A coarse hint, never the full client address.
        clientHint: session.clientHint,
        createdAt: session.createdAt.toISOString(),
        lastSeenAt: session.lastSeenAt.toISOString(),
        absoluteExpiresAt: session.absoluteExpiresAt.toISOString(),
        isCurrent: session.id === currentSessionId,
      })),
    };
  }

  /** Revoke one of the caller's own sessions. */
  @Delete('sessions/:sessionId')
  @Authenticated()
  @HttpCode(HttpStatus.NO_CONTENT)
  async revokeSession(@Param('sessionId') sessionId: string) {
    const userId = requireUserId();
    const revoked = await this.sessions.revokeOwn(userId, sessionId);

    if (!revoked) {
      // Identical to "no such session", so a caller cannot probe for other people's session ids.
      throw new ForbiddenException('That session could not be revoked.');
    }
  }

  /** Log out everywhere. Keeps the current session by default. */
  @Post('logout-all')
  @Authenticated()
  @HttpCode(HttpStatus.OK)
  async logoutAll(@Req() request: Request, @Res({ passthrough: true }) response: Response) {
    const userId = requireUserId();
    const token = (request as Request & { cookies?: Record<string, string> }).cookies?.[
      this.sessions.cookieName
    ];
    const current = await this.sessions.validate(token);
    const keepSessionId = current.outcome === 'valid' ? current.sessionId : undefined;

    const revoked = await this.sessions.revokeAll(userId, {
      ...(keepSessionId === undefined ? {} : { keepSessionId }),
    });

    // If the current session was not kept (it had already expired), leave the browser signed out.
    if (keepSessionId === undefined) {
      this.sessions.clearSessionCookie(response);
    }

    return { revoked, keptCurrentSession: keepSessionId !== undefined };
  }

  // ---- Invitation activation (pre-authentication) ----

  /**
   * Describe an invitation so the activation screen can show who it is for, without activating
   * it. Every failure answers identically, so a token cannot be probed.
   */
  @Post('invitations/preview')
  @AllowAnonymous()
  @HttpCode(HttpStatus.OK)
  async previewInvitation(@Body() body: PreviewInvitationDto) {
    const preview = await this.invitations.preview(body.token);

    if (preview.outcome === 'invalid') {
      return { valid: false as const };
    }

    return {
      valid: true as const,
      displayName: preview.displayName,
      email: preview.email,
      tenantName: preview.tenantName,
      /** When true, the UI must not ask for a new password. */
      hasExistingPassword: preview.hasExistingPassword,
    };
  }

  @Post('invitations/activate')
  @AllowAnonymous()
  @HttpCode(HttpStatus.OK)
  async activateInvitation(
    @Body() body: ActivateInvitationDto,
    @Req() request: Request,
    @Res({ passthrough: true }) response: Response,
  ) {
    const result = await this.invitations.activate(body.token, body.password, originFrom(request));

    if (result.outcome === 'invalid') {
      throw new UnauthorizedException(
        'This activation link is not valid. It may have expired, been cancelled, or already ' +
          'been used. Ask your administrator to resend the invitation.',
      );
    }

    this.sessions.setSessionCookie(response, result.sessionToken, result.absoluteExpiresAt);

    return { activated: true, activeWorkspaceId: result.tenantId };
  }

  // ---- Password reset (Access Help) ----

  /**
   * Request a reset.
   *
   * Always answers 202 with the same body, whether or not an account exists — otherwise the
   * endpoint becomes an account-existence oracle. **The token is never returned here**; it is
   * handed to the notifications module for delivery. In development it is written to the server
   * log so the flow can be exercised without a mail server.
   */
  @Post('password-reset/request')
  @AllowAnonymous()
  @HttpCode(HttpStatus.ACCEPTED)
  async requestPasswordReset(@Body() body: RequestPasswordResetDto, @Req() request: Request) {
    await this.passwordResets.request(body.email, request.ip);

    return {
      accepted: true,
      message: 'If that address has a UBoss account, a password reset link has been sent to it.',
    };
  }

  @Post('password-reset/confirm')
  @AllowAnonymous()
  @HttpCode(HttpStatus.OK)
  async confirmPasswordReset(
    @Body() body: ConfirmPasswordResetDto,
    @Res({ passthrough: true }) response: Response,
  ) {
    const result = await this.passwordResets.confirm(body.token, body.password);

    if (result.outcome === 'invalid') {
      throw new UnauthorizedException(
        'This reset link is not valid. It may have expired or already been used. ' +
          'Request a new one from Access Help.',
      );
    }

    // The reset revoked every session, including any this browser held.
    this.sessions.clearSessionCookie(response);

    return {
      reset: true,
      sessionsRevoked: result.sessionsRevoked,
      message: 'Your password has been changed and you have been signed out everywhere.',
    };
  }

  // ---- Administrative session revoke ----

  /**
   * Revoke any session, as a platform administrator.
   *
   * `@PlatformOnly` is the interim authority: company-admin session revoke needs the role model,
   * which arrives at Prompt 7. Doing it now would mean either granting every company member the
   * power to revoke colleagues' sessions, or inventing a role check that Prompt 7 would replace.
   */
  @Delete('admin/sessions/:sessionId')
  @PlatformOnly()
  @HttpCode(HttpStatus.NO_CONTENT)
  async adminRevokeSession(@Param('sessionId') sessionId: string) {
    const actor = getActor();
    if (!isPlatformActor(actor)) {
      throw new ForbiddenException('Platform administrator access is required.');
    }

    const revoked = await this.sessions.revokeByAdmin(sessionId, actor.userId);
    if (!revoked) {
      throw new ForbiddenException('That session could not be revoked.');
    }
  }

  // =========================================================================
  // Prompt 6 — which sign-in methods a company offers
  // =========================================================================

  /**
   * The sign-in methods available for an email address.
   *
   * Called by the login screen before a password is typed, so it can show only what will work.
   *
   * The answer is derived from the address's **domain**, never from whether the address has an
   * account — see `AuthenticationPolicyService.signInMethodsForEmail`. That keeps this endpoint
   * from becoming an account-enumeration oracle: an unclaimed domain and a non-existent address
   * give byte-identical answers.
   */
  @Get('sign-in-methods')
  @AllowAnonymous()
  async signInMethods(@Query() query: SignInMethodsQueryDto) {
    const methods = await this.policies.signInMethodsForEmail(query.email);

    return {
      allowPassword: methods.allowPassword,
      requireSso: methods.requireSso,
      // Only what the screen must render: a name and an id to start the flow with. No issuer, no
      // client id, no discovery URL.
      ssoConnections: methods.ssoConnections,
      // Advertised so the screen can warn "you will be asked for a code", never so it can skip
      // the check — the server decides that again after the password.
      mfaExpected: methods.requireMfa,
    };
  }

  // =========================================================================
  // Prompt 6 — completing a sign-in with a second factor
  // =========================================================================

  /**
   * Finish a sign-in with a code from an authenticator app, or a recovery code.
   *
   * `@AllowAnonymous` and driven by the challenge cookie, following the same pattern as
   * `logout`: the credential is the cookie this handler reads itself, and there is no session
   * yet by definition.
   */
  @Post('mfa/verify')
  @AllowAnonymous()
  @HttpCode(HttpStatus.OK)
  async verifyMfa(
    @Body() body: VerifyMfaDto,
    @Req() request: Request,
    @Res({ passthrough: true }) response: Response,
  ) {
    const result = await this.mfaLogins.completeWithCode(
      challengeTokenFrom(request, this.mfa.challengeCookieName),
      body.code,
    );

    if (result.outcome === 'expired') {
      this.mfa.clearChallengeCookie(response);
      throw new UnauthorizedException(
        'That sign-in has expired. Please enter your email and password again.',
      );
    }

    if (result.outcome === 'too-many-attempts') {
      this.mfa.clearChallengeCookie(response);
      throw new UnauthorizedException(
        'Too many incorrect codes. Please enter your email and password again.',
      );
    }

    if (result.outcome === 'invalid') {
      // One message whether a TOTP code or a recovery code was presented: telling them apart
      // would confirm which kind of credential the caller is holding.
      throw new UnauthorizedException('That code is not correct.');
    }

    this.mfa.clearChallengeCookie(response);
    this.sessions.setSessionCookie(
      response,
      result.login.sessionToken,
      result.login.absoluteExpiresAt,
    );

    const workspaces = await this.tenantContext.listMemberships(result.login.userId);

    return {
      user: {
        ubossUniqueId: result.login.ubossUniqueId,
        displayName: result.login.displayName,
        isPlatformActor: result.login.isPlatformActor,
      },
      workspaces,
      newDevice: result.login.newDevice,
      secondFactor: result.login.method,
      ...(result.login.remainingRecoveryCodes === undefined
        ? {}
        : { remainingRecoveryCodes: result.login.remainingRecoveryCodes }),
    };
  }

  /**
   * Begin first-time enrolment **during** a sign-in that requires MFA.
   *
   * Separate from `mfa/enroll/start` on purpose: this one's credential is the challenge cookie,
   * that one's is a session. Keeping them apart means neither handler has to work out which kind
   * of caller it is talking to, and neither can accidentally accept the wrong one.
   */
  @Post('mfa/challenge/enroll/start')
  @AllowAnonymous()
  @HttpCode(HttpStatus.OK)
  async startEnrolmentDuringSignIn(@Req() request: Request) {
    const holder = await this.mfaLogins.challengeHolder(
      challengeTokenFrom(request, this.mfa.challengeCookieName),
    );

    if (!holder) {
      throw new UnauthorizedException(
        'That sign-in has expired. Please enter your email and password again.',
      );
    }

    const enrolment = await this.mfa.startTotpEnrolment(holder.userId, holder.email);

    return {
      factorId: enrolment.factorId,
      // Both contain the shared secret, and both are returned exactly once, over the request
      // that asked for them. Neither is logged or persisted in plaintext.
      secret: enrolment.secret,
      otpauthUri: enrolment.otpauthUri,
      accountName: holder.email,
    };
  }

  /** Complete first-time enrolment and finish the sign-in in one step. */
  @Post('mfa/challenge/enroll/confirm')
  @AllowAnonymous()
  @HttpCode(HttpStatus.OK)
  async confirmEnrolmentDuringSignIn(
    @Body() body: ConfirmMfaEnrolmentDto,
    @Req() request: Request,
    @Res({ passthrough: true }) response: Response,
  ) {
    const result = await this.mfaLogins.completeWithEnrolment(
      challengeTokenFrom(request, this.mfa.challengeCookieName),
      body.factorId,
      body.code,
    );

    if (result.outcome === 'expired' || result.outcome === 'too-many-attempts') {
      this.mfa.clearChallengeCookie(response);
      throw new UnauthorizedException(
        'That sign-in has expired. Please enter your email and password again.',
      );
    }

    if (result.outcome === 'invalid') {
      throw new UnauthorizedException(
        'That code did not match. Check your authenticator app is showing the current code.',
      );
    }

    this.mfa.clearChallengeCookie(response);
    this.sessions.setSessionCookie(
      response,
      result.login.sessionToken,
      result.login.absoluteExpiresAt,
    );

    const workspaces = await this.tenantContext.listMemberships(result.login.userId);

    return {
      user: {
        ubossUniqueId: result.login.ubossUniqueId,
        displayName: result.login.displayName,
        isPlatformActor: result.login.isPlatformActor,
      },
      workspaces,
      newDevice: result.login.newDevice,
      secondFactor: 'Totp' as const,
      // Shown **once**. Only hashes are stored, so there is no endpoint that can show them again.
      recoveryCodes: result.recoveryCodes?.codes ?? [],
    };
  }

  // =========================================================================
  // Prompt 6 — managing your own second factors
  // =========================================================================

  @Get('mfa/factors')
  @Authenticated()
  async listFactors() {
    const userId = requireUserId();

    return {
      factors: await this.mfa.listFactors(userId),
      remainingRecoveryCodes: await this.mfa.countRemainingRecoveryCodes(userId),
      recoveryCodeBatchSize: this.mfa.recoveryCodeBatchSize,
    };
  }

  @Post('mfa/enroll/start')
  @Authenticated()
  @HttpCode(HttpStatus.OK)
  async startEnrolment(@Body() body: StartMfaEnrolmentDto) {
    const actor = getActor();
    const userId = requireUserId();

    const me = await this.tenantContext.describeUser(userId);
    const enrolment = await this.mfa.startTotpEnrolment(userId, me.email, body.label);

    return {
      factorId: enrolment.factorId,
      secret: enrolment.secret,
      otpauthUri: enrolment.otpauthUri,
      accountName: me.email,
      isPlatformActor: isPlatformActor(actor),
    };
  }

  @Post('mfa/enroll/confirm')
  @Authenticated()
  @HttpCode(HttpStatus.OK)
  async confirmEnrolment(@Body() body: ConfirmMfaEnrolmentDto) {
    const userId = requireUserId();
    const result = await this.mfa.confirmTotpEnrolment(userId, body.factorId, body.code);

    return {
      confirmed: true as const,
      // Present only on the **first** factor. Regenerating on every enrolment would silently
      // invalidate codes the person has already printed.
      recoveryCodes: result.recoveryCodes?.codes ?? null,
    };
  }

  /**
   * Remove a second factor.
   *
   * Refused when it is the last active factor and one of the person's companies requires MFA:
   * they would lock themselves out, and the error tells them to enrol a replacement first —
   * which is something they can act on, unlike finding out at the next sign-in.
   */
  @Delete('mfa/factors/:factorId')
  @Authenticated()
  @HttpCode(HttpStatus.NO_CONTENT)
  async revokeFactor(@Param('factorId') factorId: string) {
    const userId = requireUserId();
    const memberships = await this.tenantContext.listMemberships(userId);

    if (await this.policies.wouldBreakMfaRequirement(userId, memberships)) {
      throw new BadRequestException(
        'One of your companies requires two-step sign-in, and this is your only second factor. ' +
          'Set up a replacement before removing this one.',
      );
    }

    const revoked = await this.mfa.revokeFactor(userId, factorId);
    if (!revoked) {
      throw new ForbiddenException('That factor could not be removed.');
    }
  }

  /** Issue a fresh batch of recovery codes, retiring every previous one. */
  @Post('mfa/recovery-codes')
  @Authenticated()
  @HttpCode(HttpStatus.OK)
  async regenerateRecoveryCodes() {
    const userId = requireUserId();
    const batch = await this.mfa.regenerateRecoveryCodes(userId);

    return {
      codes: batch.codes,
      generatedAt: batch.generatedAt.toISOString(),
      message:
        'Store these somewhere safe. They are shown once — only hashes are kept, so they cannot ' +
        'be displayed again. Generating a new batch invalidates every earlier code.',
    };
  }

  // =========================================================================
  // Prompt 6 — enterprise single sign-on
  // =========================================================================

  /**
   * Begin a federated sign-in.
   *
   * Returns the authorization URL rather than issuing a redirect, so the browser navigation
   * happens from the login screen's own code. A 302 from an XHR would be followed by the fetch
   * layer and the identity provider's page would arrive as an opaque response body.
   */
  @Post('sso/start')
  @AllowAnonymous()
  @HttpCode(HttpStatus.OK)
  async startSso(@Body() body: StartSsoDto) {
    const start = await this.sso.begin(body.connectionId, body.redirectAfter);
    return { authorizationUrl: start.authorizationUrl };
  }

  /**
   * The identity provider's callback.
   *
   * A `GET` that ends in a redirect, because that is what the browser arrives with. On success
   * the session cookie is set and the browser goes to the web application; on failure it goes to
   * the login screen with a short reason, and **never** to a URL taken from the request.
   */
  @Get('sso/callback')
  @AllowAnonymous()
  async ssoCallback(
    @Query('code') code: string | undefined,
    @Query('state') state: string | undefined,
    @Query('error') error: string | undefined,
    @Req() request: Request,
    @Res() response: Response,
  ) {
    const result = await this.sso.complete({
      code,
      state,
      ...(error === undefined ? {} : { error }),
    });

    if (result.outcome === 'failed') {
      response.redirect(this.sso.loginFailureUrl(result.reason));
      return;
    }

    const session = await this.sessions.establish(result.userId, originFrom(request), {
      primaryAuthMethod: 'Oidc',
      ssoConnectionId: result.connectionId,
      ...(result.providerSessionId === undefined
        ? {}
        : { providerSessionId: result.providerSessionId }),
      // A federated sign-in satisfies the company's MFA requirement when the identity provider
      // enforced it. UBoss cannot verify that it did, so this records *when* the assertion was
      // accepted rather than claiming a factor was checked here — and the policy for an
      // SSO-required company is satisfied by the SSO itself.
      mfaSatisfiedAt: new Date(),
    });

    this.sessions.setSessionCookie(response, session.token, session.absoluteExpiresAt);
    response.redirect(result.redirectAfter);
  }

  /**
   * Provider-initiated (back-channel) logout.
   *
   * Unauthenticated by necessity — the identity provider calls it server-to-server with no UBoss
   * session — but the `logout_token` is verified against the provider's signing keys exactly like
   * an ID token, so a caller cannot end anyone's session by guessing a `sid`.
   */
  @Post('sso/:connectionId/backchannel-logout')
  @AllowAnonymous()
  @HttpCode(HttpStatus.OK)
  async backchannelLogout(
    @Param('connectionId') connectionId: string,
    @Body() body: BackchannelLogoutDto,
  ) {
    const result = await this.sso.handleBackchannelLogout(connectionId, body.logout_token);
    return { revoked: result.revoked };
  }
}
