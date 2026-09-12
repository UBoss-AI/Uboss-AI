'use client';

import Link from 'next/link';
import { useEffect, useState } from 'react';

import {
  Banner,
  Button,
  FormField,
  LoginPresentation,
  NoPublicSignupNotice,
  SkeletonText,
} from '@uboss/ui';

import {
  ApiError,
  authApi,
  type SignInMethods,
  type SsoConnectionSummary,
  type Workspace,
} from '../../lib/api-client';

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
  | { kind: 'signed-in'; displayName: string; workspaces: Workspace[]; newDevice: boolean };

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
export default function LoginPage() {
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

  // ---- signed in ----
  if (step.kind === 'signed-in' || step.kind === 'recovery-codes') {
    const workspaces = step.kind === 'signed-in' ? step.workspaces : step.workspaces;

    return (
      <LoginPresentation>
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

        <div className="uboss-section-label">Choose a workspace</div>

        {workspaces.length === 0 ? (
          <Banner tone="info">
            You are signed in, but no company workspace is available to you yet. If you are
            expecting access, ask your administrator to activate your account.
          </Banner>
        ) : (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
            {workspaces.map((workspace) => (
              <Button key={workspace.tenantId} variant="primary" block>
                {workspace.tenantName}
              </Button>
            ))}
            <p className="uboss-notice">
              The workspace shells are built and previewable in the design system; wiring a chosen
              workspace into them arrives with the dashboard prompts.
            </p>
          </div>
        )}
      </LoginPresentation>
    );
  }

  // ---- second factor ----
  if (step.kind === 'second-factor') {
    return (
      <LoginPresentation>
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
      <LoginPresentation>
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
      <LoginPresentation>
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
  const showPassword = methods === null || methods.allowPassword;

  return (
    <LoginPresentation>
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

        {showPassword && ssoConnections.length > 0 ? <div className="uboss-or">or</div> : null}

        {ssoConnections.length > 0 ? (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
            {ssoConnections.map((connection) => (
              <Button
                key={connection.id}
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
