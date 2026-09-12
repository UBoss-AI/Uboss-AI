/**
 * Authentication policy, resolved once from the environment.
 *
 * Every value has a deliberate default so a misconfigured deployment fails safe rather than
 * silently running with no timeout or no lockout.
 */

function positiveInt(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === '') {
    return fallback;
  }
  const value = Number(raw);
  if (!Number.isInteger(value) || value <= 0) {
    throw new Error(`${name} must be a positive integer, received "${raw}".`);
  }
  return value;
}

/**
 * A base URL, validated at startup.
 *
 * Checked here rather than at use time because both of these end up in a redirect or in a
 * redirect-URI comparison: a malformed value would surface as an identity provider rejecting the
 * sign-in with an opaque error, long after the mistake was made.
 */
function origin(name: string, fallback: string): string {
  const raw = process.env[name]?.trim();
  const value = raw === undefined || raw === '' ? fallback : raw;

  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new Error(`${name} must be an absolute URL, received "${value}".`);
  }

  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new Error(`${name} must be an http(s) URL, received "${value}".`);
  }
  if (process.env['NODE_ENV'] === 'production' && parsed.protocol !== 'https:') {
    throw new Error(
      `${name} must be https in production: an SSO redirect over plain HTTP exposes the ` +
        'authorization code in transit.',
    );
  }

  // Stored without a trailing slash so callers can concatenate a path unambiguously.
  return value.replace(/\/+$/, '');
}

export interface AuthConfig {
  /** Sliding window: a session dies this long after its last use. */
  idleTimeoutMinutes: number;
  /**
   * Hard ceiling, set when the session is created and never extended. A session cannot live
   * forever just by being used continuously.
   */
  absoluteTimeoutHours: number;
  /** Consecutive failures before the account is locked. */
  maxFailedAttempts: number;
  /** How long a lockout lasts. */
  lockoutMinutes: number;
  /** Invitation validity. */
  invitationExpiryHours: number;
  /** Password-reset token validity — deliberately much shorter than an invitation. */
  passwordResetExpiryMinutes: number;
  /** Minimum password length. */
  minPasswordLength: number;
  /**
   * Whether cookies carry the `Secure` attribute. Forced on outside development, because a
   * session cookie sent over plain HTTP is a session anyone on the path can steal.
   */
  secureCookies: boolean;
  /** Cookie name for the session token. */
  sessionCookieName: string;
  /**
   * How often `last_seen_at` is written. Updating on every request would mean a write per
   * request; this only refreshes once the value is meaningfully stale.
   */
  lastSeenRefreshSeconds: number;

  // ---- Prompt 6: enterprise identity ----

  /** Cookie holding the short-lived "password accepted, second factor pending" token. */
  mfaChallengeCookieName: string;
  /**
   * How long a second factor may be outstanding. Deliberately short: this window is the one
   * period in which a correct password alone has value to an attacker.
   */
  mfaChallengeMinutes: number;
  /** Failed second-factor attempts allowed against one challenge before it is destroyed. */
  mfaMaxAttempts: number;
  /**
   * TOTP steps of clock drift accepted either side of now. 1 gives a 90-second window at the
   * default 30-second period, which covers an unsynchronised phone without widening the window
   * an intercepted code is usable in.
   */
  totpWindowSteps: number;
  /** Issuer shown in the authenticator app. */
  totpIssuer: string;
  /** How long a company has to publish the DNS record proving it controls a domain. */
  domainVerificationExpiryHours: number;
  /**
   * How long an in-flight SSO authorization request stays valid. Long enough for a person to
   * type a password and satisfy MFA at their identity provider, short enough that a captured
   * `state` is useless by the time it is replayed.
   */
  ssoAuthRequestMinutes: number;
  /**
   * Public origin of this API, used to build the SSO redirect URI. An identity provider matches
   * the redirect URI exactly, so this has to be the externally reachable origin and cannot be
   * inferred from the request — a `Host` header is attacker-controlled.
   */
  publicApiBaseUrl: string;
  /**
   * Origin of the web application. The only place an SSO callback will send a browser, which is
   * what stops the callback becoming an open redirect.
   */
  webBaseUrl: string;
}

export function loadAuthConfig(): AuthConfig {
  const isProduction = process.env['NODE_ENV'] === 'production';

  return {
    idleTimeoutMinutes: positiveInt('AUTH_IDLE_TIMEOUT_MINUTES', 30),
    absoluteTimeoutHours: positiveInt('AUTH_ABSOLUTE_TIMEOUT_HOURS', 12),
    maxFailedAttempts: positiveInt('AUTH_MAX_FAILED_ATTEMPTS', 5),
    lockoutMinutes: positiveInt('AUTH_LOCKOUT_MINUTES', 15),
    invitationExpiryHours: positiveInt('AUTH_INVITATION_EXPIRY_HOURS', 72),
    passwordResetExpiryMinutes: positiveInt('AUTH_PASSWORD_RESET_EXPIRY_MINUTES', 30),
    minPasswordLength: positiveInt('AUTH_MIN_PASSWORD_LENGTH', 12),
    // Opt *out* only in development. Anything that is not development gets Secure cookies.
    secureCookies: isProduction || process.env['AUTH_SECURE_COOKIES'] === 'true',
    sessionCookieName: process.env['AUTH_SESSION_COOKIE_NAME'] ?? 'uboss_session',
    lastSeenRefreshSeconds: positiveInt('AUTH_LAST_SEEN_REFRESH_SECONDS', 60),

    mfaChallengeCookieName: process.env['AUTH_MFA_COOKIE_NAME'] ?? 'uboss_mfa',
    mfaChallengeMinutes: positiveInt('AUTH_MFA_CHALLENGE_MINUTES', 5),
    mfaMaxAttempts: positiveInt('AUTH_MFA_MAX_ATTEMPTS', 5),
    totpWindowSteps: positiveInt('AUTH_TOTP_WINDOW_STEPS', 1),
    totpIssuer: process.env['AUTH_TOTP_ISSUER'] ?? 'UBoss',
    domainVerificationExpiryHours: positiveInt('AUTH_DOMAIN_VERIFICATION_EXPIRY_HOURS', 168),
    ssoAuthRequestMinutes: positiveInt('AUTH_SSO_REQUEST_MINUTES', 10),
    publicApiBaseUrl: origin('AUTH_PUBLIC_API_BASE_URL', 'http://localhost:4000'),
    webBaseUrl: origin('AUTH_WEB_BASE_URL', 'http://localhost:3000'),
  };
}

export const AUTH_CONFIG = 'AUTH_CONFIG';
