'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useEffect, useState } from 'react';

import {
  Banner,
  Button,
  FormField,
  LoginPresentation,
  NoPublicSignupNotice,
  SkeletonText,
  ProviderButton,
} from '@uboss/ui';

import { rememberWorkspace } from '../lib/active-workspace';
import {
  ApiError,
  authApi,
  type SignInMethods,
  type SsoConnectionSummary,
  type Workspace,
} from '../lib/api-client';

type Step =
  | { kind: 'credentials' }
  | { kind: 'submitting' }
  | { kind: 'error'; message: string; retryAfterSeconds?: number }
  /** Password accepted; the company requires a second factor. No session exists yet. */
  | { kind: 'second-factor'; message: string; recoveryCodesAccepted: boolean }
  /** Password accepted; the company requires MFA and this person has not enrolled. */
  | {
      kind: 'enrol';
      message: string;
      graceUntil: string | null;
      enrolment?: { factorId: string; secret: string; otpauthUri: string };
    }
  /** Enrolled mid-sign-in: the recovery codes are shown once, before continuing. */
  | { kind: 'recovery-codes'; codes: string[]; displayName: string; workspaces: Workspace[] }
  | { kind: 'sso-only'; tenantName: string; connections: SsoConnectionSummary[]; message: string }
  | {
      kind: 'signed-in';
      displayName: string;
      workspaces: Workspace[];
      newDevice: boolean;
      /**
       * Platform staff have no company workspace and are not supposed to. Without this the screen
       * told them to ask an administrator for access they do not need, and offered no way into the
       * Master Console they actually run.
       */
      isPlatformActor: boolean;
    };

/**
 * Sign in.
 *
 * ## Shape of the flow
 *
 * Email first. The screen asks the server which methods that address's **domain** allows, then
 * shows only those: a password field, enterprise SSO buttons, or both. That is the "allowed
 * sign-in methods per company" requirement, and it keeps someone at an SSO-only company from
 * typing a password that was never going to be accepted.
 *
 * After a correct password there are three possible answers, and the screen renders each one
 * rather than treating any of them as an error: signed in, second factor needed, or "this company
 * requires SSO". Only the first has a session.
 *
 * ## What this screen never does
 *
 * No password field carries a default value. Nothing stores a token — the session and the MFA
 * challenge are both HttpOnly cookies the browser holds and this code cannot read. Recovery
 * codes are rendered from the one response that contains them and are never written to storage:
 * only hashes exist on the server, so there is no endpoint that could show them again.
 *
 * There is **no public company signup** anywhere.
 */
export interface SignInFlowProps {
  /**
   * Which plane this front door leads to.
   *
   * It changes two things and nothing else: which presentation wraps the card, and what happens
   * once the password has been accepted. Every step before that — the methods lookup, the
   * password, MFA, enrolment, recovery codes, the SSO-only answer — is identical, because it is
   * the same authentication and a second copy of it would be a second thing to keep correct.
   */
  plane: 'company' | 'platform';
}

export function SignInFlow({ plane }: SignInFlowProps) {
  const router = useRouter();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [code, setCode] = useState('');
  const [step, setStep] = useState<Step>({ kind: 'credentials' });

  const [methods, setMethods] = useState<SignInMethods | null>(null);
  const [methodsFor, setMethodsFor] = useState<string | null>(null);
  const [ssoError, setSsoError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  // A failed federated sign-in comes back as a redirect carrying a short reason.
  useEffect(() => {
    const reason = new URLSearchParams(window.location.search).get('ssoError');
    if (reason) {
      setSsoError(reason);
    }
  }, []);

  /**
   * Look up the methods for this address once it looks like an email.
   *
   * Debounced, and keyed on the address so a slow response for an earlier value cannot overwrite
   * a newer one. The answer depends only on the domain, so it is safe to ask before a password
   * has been typed.
   */
  useEffect(() => {
    const candidate = email.trim().toLowerCase();
    if (!candidate.includes('@') || candidate.endsWith('@')) {
      setMethods(null);
      setMethodsFor(null);
      return;
    }
    if (candidate === methodsFor) {
      return;
    }

    const timer = setTimeout(() => {
      void authApi
        .signInMethods(candidate)
        .then((result) => {
          setMethods(result);
          setMethodsFor(candidate);
        })
        // A failure here must not block sign-in: fall back to showing the password field, which
        // the server will accept or refuse on its own terms.
        .catch(() => {
          setMethods(null);
          setMethodsFor(candidate);
        });
    }, 350);

    return () => clearTimeout(timer);
  }, [email, methodsFor]);

  const handlePassword = async (event: React.FormEvent) => {
    event.preventDefault();
    setSsoError(null);
    setStep({ kind: 'submitting' });

    try {
      const outcome = await authApi.login(email, password);

      if (outcome.kind === 'signed-in') {
        setStep({
          kind: 'signed-in',
          displayName: outcome.user.displayName,
          workspaces: outcome.workspaces,
          newDevice: outcome.newDevice,
          isPlatformActor: outcome.user.isPlatformActor,
        });
        return;
      }

      if (outcome.kind === 'sso-required') {
        setStep({
          kind: 'sso-only',
          tenantName: outcome.tenantName,
          connections: outcome.ssoConnections,
          message: outcome.message,
        });
        return;
      }

      // The password is no longer needed and must not sit in memory through the next step.
      setPassword('');

      setStep(
        outcome.enrolmentRequired
          ? { kind: 'enrol', message: outcome.message, graceUntil: outcome.graceUntil }
          : {
              kind: 'second-factor',
              message: outcome.message,
              recoveryCodesAccepted: outcome.recoveryCodesAccepted,
            },
      );
    } catch (error) {
      // The API answers identically for a wrong password and an unknown address, so this message
      // is shown as received rather than being second-guessed here.
      setStep({
        kind: 'error',
        message:
          error instanceof ApiError ? error.message : 'Something went wrong. Please try again.',
        ...(error instanceof ApiError && error.retryAfterSeconds !== undefined
          ? { retryAfterSeconds: error.retryAfterSeconds }
          : {}),
      });
    }
  };

  const handleSecondFactor = async (event: React.FormEvent) => {
    event.preventDefault();
    setBusy(true);

    try {
      const result = await authApi.verifyMfa(code);
      setCode('');
      setStep({
        kind: 'signed-in',
        displayName: result.user.displayName,
        workspaces: result.workspaces,
        newDevice: result.newDevice,
        isPlatformActor: result.user.isPlatformActor,
      });
    } catch (error) {
      const message = error instanceof ApiError ? error.message : 'That code could not be checked.';

      // A 401 here means the challenge itself is gone (expired, or too many attempts), so the
      // sign-in has to start again rather than leaving the code field up.
      if (error instanceof ApiError && /expired|Too many/i.test(error.message)) {
        setStep({ kind: 'error', message });
      } else {
        setStep((current) =>
          current.kind === 'second-factor' ? { ...current, message } : current,
        );
      }
      setCode('');
    } finally {
      setBusy(false);
    }
  };

  const beginEnrolment = async () => {
    setBusy(true);
    try {
      const enrolment = await authApi.startEnrolmentDuringSignIn();
      setStep((current) => (current.kind === 'enrol' ? { ...current, enrolment } : current));
    } catch (error) {
      setStep({
        kind: 'error',
        message:
          error instanceof ApiError
            ? error.message
            : 'Two-step setup could not be started. Please sign in again.',
      });
    } finally {
      setBusy(false);
    }
  };

  const completeEnrolment = async (event: React.FormEvent, factorId: string) => {
    event.preventDefault();
    setBusy(true);

    try {
      const result = await authApi.confirmEnrolmentDuringSignIn(factorId, code);
      setCode('');
      setStep({
        kind: 'recovery-codes',
        codes: result.recoveryCodes,
        displayName: result.user.displayName,
        workspaces: result.workspaces,
      });
    } catch (error) {
      const message = error instanceof ApiError ? error.message : 'That code did not match.';
      setStep((current) => (current.kind === 'enrol' ? { ...current, message } : current));
      setCode('');
    } finally {
      setBusy(false);
    }
  };

  /**
   * Begin a Google, Microsoft or Apple sign-in.
   *
   * The same shape as an enterprise connection: the server answers with an authorization URL and
   * the browser leaves for the provider. A full navigation rather than a fetch, because the
   * identity provider has to own the next page.
   */
  const startSocial = async (kind: 'google' | 'microsoft' | 'apple') => {
    setBusy(true);
    setSsoError(null);
    try {
      const { authorizationUrl } = await authApi.startSocial(kind);
      window.location.assign(authorizationUrl);
    } catch (error) {
      setSsoError(
        error instanceof ApiError ? error.message : 'That sign-in method is not available.',
      );
      setBusy(false);
    }
  };

  const startSso = async (connectionId: string) => {
    setBusy(true);
    try {
      const { authorizationUrl } = await authApi.startSso(connectionId);
      // A full navigation, not a fetch: the identity provider needs to own the next page.
      window.location.assign(authorizationUrl);
    } catch (error) {
      setSsoError(
        error instanceof ApiError ? error.message : 'That sign-in method is not available.',
      );
      setBusy(false);
    }
  };

  /*
   * A customer identity that reached the console door is signed out immediately.
   *
   * Not on the button press: the refusal has already been decided by then, and a session left open
   * while somebody reads a message is a customer session sitting behind the internal door. The
   * screen still explains what happened — being signed out is not the same as being told nothing.
   */
  useEffect(() => {
    if (plane !== 'platform') return;
    if (step.kind !== 'signed-in' || step.isPlatformActor) return;
    void authApi.logout().catch(() => undefined);
  }, [plane, step]);

  // ---- signed in ----
  if (step.kind === 'signed-in' || step.kind === 'recovery-codes') {
    const workspaces = step.kind === 'signed-in' ? step.workspaces : step.workspaces;

    return (
      <LoginPresentation variant={plane === 'platform' ? 'platform' : 'customer'}>
        <h1>Welcome back</h1>
        <p className="uboss-login-card-sub">Signed in as {step.displayName}.</p>

        {step.kind === 'recovery-codes' ? (
          <div style={{ marginBottom: 16 }}>
            <Banner tone="warn">
              Save these recovery codes now. Each one works once, and they are shown only here —
              only hashes are stored, so they cannot be displayed again.
            </Banner>
            <ul className="uboss-recovery-codes">
              {step.codes.map((recoveryCode) => (
                <li key={recoveryCode}>{recoveryCode}</li>
              ))}
            </ul>
          </div>
        ) : null}

        {step.kind === 'signed-in' && step.newDevice ? (
          <div style={{ marginBottom: 16 }}>
            <Banner tone="warn">
              This is the first sign-in from this device or location. If it was not you, change your
              password from Access Help.
            </Banner>
          </div>
        ) : null}

        <div className="uboss-auth-links">
          <Link href="/sessions" className="uboss-link">
            Review active sessions
          </Link>
        </div>

        {/*
          The one place the two front doors differ.

          Everything above this point is the same authentication. What changes here is which
          question is being answered: "which company am I working in" or "may this identity enter
          the platform console at all".
        */}
        {plane === 'platform' ? (
          step.kind === 'signed-in' && step.isPlatformActor ? (
            <>
              <div className="uboss-section-label">Platform &amp; Development Console</div>
              <Button variant="primary" block onClick={() => router.push('/master/dashboard')}>
                Continue to the Console
              </Button>
            </>
          ) : (
            /*
             * A real identity with no platform authority.
             *
             * The password was right, so this is not a sign-in failure and must not read like one.
             * It is a boundary, and the boundary is the server's: `isPlatformActor` is what the
             * API says, and every /master route enforces the same answer again on its own. Nothing
             * here grants anything — arriving through this page cannot make anyone internal.
             *
             * The session is then ended, because it was opened to enter a console this identity
             * cannot enter. Leaving it open would put a customer session behind the internal door.
             */
            <>
              <Banner tone="warn">
                Your account does not have access to the UBoss Platform &amp; Development Console.
              </Banner>
              <p className="uboss-notice">
                You have been signed out of this console. If you are a company user, sign in from
                your company&rsquo;s login page instead.
              </p>
              <Button
                variant="primary"
                block
                onClick={() => {
                  void authApi.logout().finally(() => window.location.assign('/internal/login'));
                }}
              >
                Back to the console sign-in
              </Button>
            </>
          )
        ) : null}

        {plane === 'company' ? (
          <>
            {workspaces.length === 0 ? null : (
              <div className="uboss-section-label">Choose a workspace</div>
            )}

            {workspaces.length === 0 ? (
              /*
               * No workspace, and nothing here says why beyond what a customer needs to know. A
               * platform account signing in on the customer page lands here too, and is told the
               * same thing — this page does not mention the console, does not link to it, and does
               * not hint that another door exists.
               */
              <Banner tone="info">
                You are signed in, but no company workspace is available to you yet. If you are
                expecting access, ask your administrator to activate your account.
              </Banner>
            ) : (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
            {workspaces.map((workspace) => (
              <Button
                key={workspace.tenantId}
                variant="primary"
                block
                onClick={() => {
                  // Until this was wired, signing in led nowhere: the button had no handler and
                  // the only way into the product was to type a URL. Recording the choice here is
                  // what makes every later screen agree on which company it is showing.
                  rememberWorkspace(workspace.tenantId);
                  router.push('/dashboard');
                }}
              >
                {workspace.tenantName}
              </Button>
            ))}
          </div>
            )}
          </>
        ) : null}
      </LoginPresentation>
    );
  }

  // ---- second factor ----
  if (step.kind === 'second-factor') {
    return (
      <LoginPresentation variant={plane === 'platform' ? 'platform' : 'customer'}>
        <form onSubmit={handleSecondFactor} noValidate>
          <h1>Two-step sign-in</h1>
          <p className="uboss-login-card-sub">{step.message}</p>

          <FormField
            label="Authentication code"
            required
            hint={
              step.recoveryCodesAccepted
                ? 'Six digits from your authenticator app, or one of your recovery codes.'
                : 'Six digits from your authenticator app.'
            }
          >
            {(props) => (
              <input
                {...props}
                type="text"
                inputMode="numeric"
                autoComplete="one-time-code"
                autoFocus
                value={code}
                onChange={(event) => setCode(event.target.value)}
                disabled={busy}
              />
            )}
          </FormField>

          <Button type="submit" variant="primary" block disabled={busy}>
            {busy ? 'Checking…' : 'Verify and sign in'}
          </Button>

          <div className="uboss-auth-links">
            <button
              type="button"
              className="uboss-link uboss-link-button"
              onClick={() => {
                setCode('');
                setStep({ kind: 'credentials' });
              }}
            >
              Start again
            </button>
            <Link href="/access-help" className="uboss-link">
              Access help
            </Link>
          </div>
        </form>
      </LoginPresentation>
    );
  }

  // ---- first-time enrolment, mid-sign-in ----
  if (step.kind === 'enrol') {
    return (
      <LoginPresentation variant={plane === 'platform' ? 'platform' : 'customer'}>
        <h1>Set up two-step sign-in</h1>
        <p className="uboss-login-card-sub">{step.message}</p>

        {step.graceUntil ? (
          <div style={{ marginBottom: 16 }}>
            <Banner tone="info">
              Your company allows sign-in without this until{' '}
              {new Date(step.graceUntil).toLocaleString()}.
            </Banner>
          </div>
        ) : null}

        {step.enrolment === undefined ? (
          <>
            <p className="uboss-notice">
              You will need an authenticator app — Google Authenticator, Microsoft Authenticator,
              1Password, Authy or any other TOTP app.
            </p>
            <div style={{ marginTop: 16 }}>
              <Button variant="primary" block onClick={() => void beginEnrolment()} disabled={busy}>
                {busy ? 'Preparing…' : 'Start setup'}
              </Button>
            </div>
            {busy ? <SkeletonText lines={2} /> : null}
          </>
        ) : (
          <form
            onSubmit={(event) => void completeEnrolment(event, step.enrolment!.factorId)}
            noValidate
          >
            <div className="uboss-section-label">1. Add UBoss to your app</div>
            <p className="uboss-notice">
              Scan the setup link below, or enter this key by hand. It is shown only once.
            </p>
            <code className="uboss-totp-secret">{step.enrolment.secret}</code>
            <p className="uboss-notice">
              <a className="uboss-link" href={step.enrolment.otpauthUri}>
                Open in your authenticator app
              </a>
            </p>

            <div className="uboss-section-label">2. Enter the code it shows</div>
            <FormField label="Six-digit code" required>
              {(props) => (
                <input
                  {...props}
                  type="text"
                  inputMode="numeric"
                  autoComplete="one-time-code"
                  autoFocus
                  value={code}
                  onChange={(event) => setCode(event.target.value)}
                  disabled={busy}
                />
              )}
            </FormField>

            <Button type="submit" variant="primary" block disabled={busy}>
              {busy ? 'Confirming…' : 'Confirm and sign in'}
            </Button>
          </form>
        )}

        <div className="uboss-auth-links">
          <button
            type="button"
            className="uboss-link uboss-link-button"
            onClick={() => {
              setCode('');
              setStep({ kind: 'credentials' });
            }}
          >
            Start again
          </button>
          <Link href="/access-help" className="uboss-link">
            Access help
          </Link>
        </div>
      </LoginPresentation>
    );
  }

  // ---- SSO only ----
  if (step.kind === 'sso-only') {
    return (
      <LoginPresentation variant={plane === 'platform' ? 'platform' : 'customer'}>
        <h1>Sign in with {step.tenantName}</h1>
        <p className="uboss-login-card-sub">{step.message}</p>

        <div style={{ display: 'flex', flexDirection: 'column', gap: 8, marginTop: 18 }}>
          {step.connections.map((connection) => (
            <Button
              key={connection.id}
              variant="primary"
              block
              icon="shield"
              onClick={() => void startSso(connection.id)}
              disabled={busy || connection.protocol === 'Saml'}
              {...(connection.protocol === 'Saml'
                ? { title: 'SAML sign-in is not available yet. Use an OIDC connection.' }
                : {})}
            >
              {connection.displayName}
            </Button>
          ))}
        </div>

        <div className="uboss-auth-links">
          <button
            type="button"
            className="uboss-link uboss-link-button"
            onClick={() => setStep({ kind: 'credentials' })}
          >
            Use a different email
          </button>
          <Link href="/access-help" className="uboss-link">
            Access help
          </Link>
        </div>

        <NoPublicSignupNotice />
      </LoginPresentation>
    );
  }

  // ---- credentials ----
  const submitting = step.kind === 'submitting';
  const ssoConnections = methods?.ssoConnections ?? [];
  /*
   * UBoss's own Google, Microsoft and Apple applications, as opposed to a company's enterprise
   * connection. The server lists only the ones this deployment holds credentials for, so an
   * unconfigured provider is absent rather than present-and-broken.
   */
  const socialProviders = methods?.socialProviders ?? [];
  const showPassword = methods === null || methods.allowPassword;

  return (
    <LoginPresentation variant={plane === 'platform' ? 'platform' : 'customer'}>
      <form onSubmit={handlePassword} noValidate>
        <h1>Welcome back</h1>
        <p className="uboss-login-card-sub">Sign in to your UBoss workspace.</p>

        {step.kind === 'error' ? (
          <div style={{ marginBottom: 16 }}>
            <Banner tone="danger">
              {step.message}
              {step.retryAfterSeconds !== undefined
                ? ` You can try again in about ${Math.ceil(step.retryAfterSeconds / 60)} minute(s).`
                : ''}
            </Banner>
          </div>
        ) : null}

        {ssoError ? (
          <div style={{ marginBottom: 16 }}>
            <Banner tone="danger">{ssoError}</Banner>
          </div>
        ) : null}

        <FormField label="Work email" required>
          {(props) => (
            <input
              {...props}
              type="email"
              autoComplete="username"
              value={email}
              onChange={(event) => setEmail(event.target.value)}
              disabled={submitting}
              placeholder="you@company.com"
            />
          )}
        </FormField>

        {showPassword ? (
          <FormField label="Password" required>
            {/* No default value: a password field must never carry a prefilled credential. */}
            {(props) => (
              <input
                {...props}
                type="password"
                autoComplete="current-password"
                value={password}
                onChange={(event) => setPassword(event.target.value)}
                disabled={submitting}
              />
            )}
          </FormField>
        ) : (
          <div style={{ marginBottom: 16 }}>
            <Banner tone="info">
              Your company signs in through its own identity provider. Use the button below.
            </Banner>
          </div>
        )}

        {showPassword ? (
          <Button type="submit" variant="primary" block disabled={submitting}>
            {submitting ? 'Signing in…' : 'Sign In'}
          </Button>
        ) : null}

        {methods?.mfaExpected && showPassword ? (
          <p className="uboss-notice">
            Your company uses two-step sign-in, so you will be asked for a code next.
          </p>
        ) : null}

        {showPassword && (ssoConnections.length > 0 || socialProviders.length > 0) ? (
          <div className="uboss-or">or</div>
        ) : null}

        {socialProviders.length > 0 ? (
          /*
           * One button per provider this deployment can actually complete a sign-in with.
           *
           * Pressing one starts the real authorization redirect. It never creates an account:
           * there is no public signup in UBoss, and an address arriving from Google still has to
           * belong to an invited, active identity or the sign-in is refused. Anyone can obtain a
           * Google account, and that must not be a way into somebody's company.
           */
          <div className="uboss-provider-row">
            {socialProviders.map((provider) => (
              <ProviderButton
                key={provider.kind}
                kind={provider.kind}
                label={provider.displayName}
                onClick={() => void startSocial(provider.kind)}
                disabled={busy}
              />
            ))}
          </div>
        ) : null}

        {ssoConnections.length > 0 ? (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
            {ssoConnections.map((connection) => (
              /*
               * One button per connection the company has actually configured, wearing that
               * provider's mark.
               *
               * Nothing here is decorative. A Google, Microsoft or Apple button appears because an
               * enabled OIDC connection for that provider exists, and pressing it starts the same
               * real authorization redirect any other connection starts. Three marks sitting on a
               * login page that cannot use them would be worse than none: somebody clicks, is
               * refused, and concludes their account is broken rather than that the company has
               * not set it up.
               */
              <ProviderButton
                key={connection.id}
                kind={connection.providerKind ?? 'generic'}
                label={connection.displayName}
                onClick={() => void startSso(connection.id)}
                disabled={busy || connection.protocol === 'Saml'}
                {...(connection.protocol === 'Saml'
                  ? { title: 'SAML sign-in is not available yet. Use an OIDC connection.' }
                  : {})}
              />
            ))}
          </div>
        ) : (
          <>
            <div className="uboss-or">or</div>
            {/* Honestly disabled until this address's domain has an enabled connection: a button
                that looks like it authenticates and does not is worse than one that is greyed out. */}
            <Button
              block
              icon="shield"
              disabled
              title="Enterprise sign-in is configured per company"
            >
              Continue with enterprise SSO
            </Button>
          </>
        )}

        <div className="uboss-auth-links">
          <Link href="/access-help" className="uboss-link">
            Forgot password / Access help
          </Link>
          <Link href="/activate" className="uboss-link">
            Activate invitation
          </Link>
        </div>

        <NoPublicSignupNotice />
      </form>
    </LoginPresentation>
  );
}
