'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useCallback, useEffect, useState } from 'react';

import {
  Banner,
  Button,
  FormField,
  LoginPresentation,
  Modal,
  NoPublicSignupNotice,
  SkeletonText,
  ProviderButton,
} from '@uboss/ui';

import { rememberWorkspace } from '../lib/active-workspace';
import { TermsSummary } from './TermsSummary';
import {
  ApiError,
  authApi,
  myAccessApi,
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
 * **Nobody adds themselves to a company that already exists.** A person is invited and then
 * activates; there is no route on any of these screens that creates an identity inside somebody
 * else's workspace.
 *
 * A company starting its *own* workspace is a different door and it does exist — `/start`, where
 * a work address and control of a domain are both proved before anything is created. This file
 * used to claim there was no signup anywhere, which stopped being true the day that shipped.
 */
/**
 * The three providers, in a fixed order.
 *
 * Listed here rather than driven by what the server returns, so the row is the same shape
 * whatever is configured — buttons that appear and disappear as credentials are added would move
 * the sign-in control under somebody's cursor.
 */
const SOCIAL_PROVIDERS = [
  { kind: 'google', label: 'Continue with Google' },
  { kind: 'apple', label: 'Continue with Apple' },
  { kind: 'microsoft', label: 'Continue with Microsoft' },
] as const;

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

  /*
   * The deployment's social providers, fetched once on arrival.
   *
   * Not taken from `methods`, which needs an email: the three buttons are on screen before
   * anybody types one, and reading them from an email-shaped answer meant they rendered disabled
   * saying "not set up for this deployment yet" about a provider that was set up. Somebody who
   * reached for the Google button precisely so they would not have to type their address was
   * told the feature did not exist.
   *
   * Null while it is in flight, so "not yet known" and "none configured" stay apart.
   */
  const [deploymentProviders, setDeploymentProviders] = useState<
    { kind: 'google' | 'microsoft' | 'apple'; displayName: string }[] | null
  >(null);
  const [ssoError, setSsoError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  /*
   * The terms tick and the verification question.
   *
   * The tick is always here and always required. It is an acknowledgement at the door, which is
   * what the client asked for — and it is honest about being a screen control: the API does not
   * require it, so nothing here should be read as a legal record of acceptance. Recording that
   * per sign-in is a schema change and a separate decision.
   *
   * The captcha is the opposite: the question and the answer are both the server's, and the
   * server refuses a sign-in whose answer is wrong. It appears only when the deployment has
   * turned it on, which is why `captcha` starts as `null` and the screen renders nothing until
   * the first answer comes back.
   */
  const [acceptedTerms, setAcceptedTerms] = useState(false);
  const [showTerms, setShowTerms] = useState(false);

  const [captcha, setCaptcha] = useState<{ token: string; question: string } | null>(null);
  const [captchaAnswer, setCaptchaAnswer] = useState('');

  /** Ask once whether this deployment wants a question, and for the first one if it does. */
  const refreshCaptcha = useCallback(async () => {
    try {
      const issued = await authApi.captcha();
      setCaptcha(
        issued.enabled && issued.token !== undefined && issued.question !== undefined
          ? { token: issued.token, question: issued.question }
          : null,
      );
      setCaptchaAnswer('');
    } catch {
      // A failure here must not block sign-in: if the question cannot be fetched, the server is
      // the thing that decides whether one was needed, and it will say so on the attempt.
      setCaptcha(null);
    }
  }, []);

  useEffect(() => {
    void refreshCaptcha();
  }, [refreshCaptcha]);

  // A failed federated sign-in comes back as a redirect carrying a short reason.
  useEffect(() => {
    const reason = new URLSearchParams(window.location.search).get('ssoError');
    if (reason) {
      setSsoError(reason);
    }
  }, []);

  /*
   * Which providers this deployment offers, asked once and not again.
   *
   * A failure leaves the list empty rather than showing an error: the three buttons then read
   * "not set up", which is what an unreachable server means here anyway, and a red banner about
   * provider discovery above a perfectly usable password box would be noise.
   */
  useEffect(() => {
    let live = true;
    authApi
      .socialProviders()
      .then((result) => {
        if (live) setDeploymentProviders(result.socialProviders);
      })
      .catch(() => {
        if (live) setDeploymentProviders([]);
      });
    return () => {
      live = false;
    };
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
      const outcome = await authApi.login(
        email,
        password,
        captcha === null ? undefined : { token: captcha.token, answer: captchaAnswer },
      );

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
      /*
       * A new question on every failure, and that is not politeness.
       *
       * The token carries its own answer, so one that has been sent once has been seen once. If a
       * wrong password left the same question up, an attacker would solve it once and reuse the
       * token for every attempt afterwards — the captcha would cost them a single answer for an
       * unlimited run. Replacing it makes each attempt cost one.
       */
      void refreshCaptcha();

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

                      /*
                       * Where somebody lands depends on what they are here to do.
                       *
                       * A person who defines work — hierarchy, objectives, agents — lands on the
                       * orchestration Dashboard. A person who only performs work lands on Operations,
                       * which for them is the whole application; sending them to a Dashboard of
                       * counts for modules they cannot open is a screen that answers nothing.
                       *
                       * The decision is made from the server's own answer about this person, not from
                       * a role name. A failure to get that answer lands them on the Dashboard, which
                       * every company role can open.
                       */
                      void myAccessApi
                        .mine(workspace.tenantId)
                        .then((access) => {
                          const builds = ['hierarchy', 'objective', 'agent-builder'].some(
                            (module) => access.visibleModules.includes(module),
                          );
                          // Their To-do, which is where a person who does the work actually starts.
                          // It used to be an Operations landing page in front of it, and that page
                          // showed the same list one click later.
                          router.push(builds ? '/dashboard' : '/todo');
                        })
                        .catch(() => router.push('/dashboard'));
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
   *
   * The email-shaped answer wins once there is one, because it is the fresher read of the same
   * list; before that, the list fetched on arrival stands in for it.
   */
  const socialProviders = methods?.socialProviders ?? deploymentProviders ?? [];
  const showPassword = methods === null || methods.allowPassword;

  return (
    <LoginPresentation variant={plane === 'platform' ? 'platform' : 'customer'}>
      <form onSubmit={handlePassword} noValidate>
        <h1>Welcome back</h1>
        <p className="uboss-login-card-sub">Sign in to Chief Agent, powered by UBoss AI.</p>

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
          <FormField
            label="Password"
            required
            /*
              Opposite the Password label, because that is where somebody who cannot get in is
              already looking. It used to sit below the form as "Forgot password / Access help" —
              two destinations in one link, under the thing they had already given up on.
            */
            labelAside={
              <Link href="/access-help" className="uboss-link uboss-field-aside">
                Forgot password
              </Link>
            }
          >
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

        {/*
          The verification question, when this deployment asks one.

          Both the question and the answer are the server's: it signs the question, and it refuses
          the sign-in if the answer is wrong. Nothing here decides whether the answer was right,
          which is why there is no tick or cross beside the field — a captcha whose verdict the
          browser renders is a captcha the browser could be told to pass.

          Arithmetic rather than a distorted image, so a screen reader can read it out and nobody
          needs a mouse to solve it.
        */}
        {showPassword && captcha !== null ? (
          <FormField
            label="Verification"
            required
            hint="A short check that a person is signing in."
          >
            {(props) => (
              <div className="uboss-captcha">
                <span className="uboss-captcha-question" aria-hidden="false">
                  {captcha.question}
                </span>
                <input
                  {...props}
                  type="text"
                  inputMode="numeric"
                  autoComplete="off"
                  value={captchaAnswer}
                  placeholder="Answer"
                  onChange={(event) => setCaptchaAnswer(event.target.value)}
                  disabled={submitting}
                />
                <button
                  type="button"
                  className="uboss-link"
                  onClick={() => void refreshCaptcha()}
                  disabled={submitting}
                >
                  New question
                </button>
              </div>
            )}
          </FormField>
        ) : null}

        {/*
          The terms tick.

          Above the button and never pre-ticked: a box that arrives already checked is not an
          acknowledgement of anything. The label carries the link, so reading the terms does not
          mean losing what has been typed — the dialog opens over this screen.
        */}
        {showPassword ? (
          <label className="uboss-consent">
            <input
              type="checkbox"
              checked={acceptedTerms}
              disabled={submitting}
              onChange={(event) => setAcceptedTerms(event.target.checked)}
            />
            <span>
              I agree to the{' '}
              <button type="button" className="uboss-link" onClick={() => setShowTerms(true)}>
                Terms &amp; Conditions
              </button>{' '}
              and the acceptable-use policy.
            </span>
          </label>
        ) : null}

        {showPassword ? (
          <Button
            type="submit"
            variant="primary"
            block
            disabled={submitting || !acceptedTerms}
            /*
              Why the button is disabled rather than the tick being checked on submit: a person
              who presses a live button and is then told off has been misled by the button. One
              that is plainly not ready, next to the thing that makes it ready, is information.
            */
            title={acceptedTerms ? undefined : 'Accept the Terms & Conditions to sign in'}
          >
            {submitting ? 'Signing in…' : 'Sign In'}
          </Button>
        ) : null}

        {methods?.mfaExpected && showPassword ? (
          <p className="uboss-notice">
            Your company uses two-step sign-in, so you will be asked for a code next.
          </p>
        ) : null}

        {showPassword ? <div className="uboss-or">or</div> : null}

        {showPassword ? (
          /*
           * Google, Microsoft and Apple, always offered.
           *
           * A provider this deployment holds credentials for is live: pressing it starts the real
           * authorization redirect. One it does not is **visibly disabled and says why** — the
           * same treatment the enterprise SSO button already had here, and the distinction that
           * matters: a control that looks ready and is not is a lie, while one that is plainly
           * greyed out with a reason is information.
           *
           * None of them ever creates an account. There is no public signup in UBoss, and that
           * does not stop being true because the identity arrived from Google — the returned
           * address must already belong to an invited, active person or the sign-in is refused.
           * Anyone can obtain a Google account, and that must not be a way into someone's company.
           */
          <div className="uboss-provider-row">
            {SOCIAL_PROVIDERS.map(({ kind, label }) => {
              const configured = socialProviders.find((provider) => provider.kind === kind);
              // Until the list has arrived, the honest state is "not known yet" — not "not set
              // up", which is an answer, and for the first moments of every visit the wrong one.
              const known = methods !== null || deploymentProviders !== null;
              return (
                <ProviderButton
                  key={kind}
                  kind={kind}
                  label={configured?.displayName ?? label}
                  disabled={busy || configured === undefined}
                  {...(configured === undefined && known
                    ? {
                        title: `${label.replace('Continue with ', '')} sign-in is not set up for this deployment yet.`,
                      }
                    : {})}
                  {...(configured === undefined ? {} : { onClick: () => void startSocial(kind) })}
                />
              );
            })}
          </div>
        ) : null}

        {/* A company's own enterprise connection, when it has one, beneath the three. */}
        {ssoConnections.length > 0 ? (
          <div className="uboss-provider-row">
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
        ) : null}

        {/*
          The way in for a company that has no workspace yet.

          This space held nothing, under a note explaining that "nobody can sign themselves up".
          That stopped being true: self-serve registration is built, tested and live — a company
          proves its work address and its domain and the workspace is created, on the Pilot plan,
          with nobody to approve it. The flow simply had no door, and a visitor who had read the
          pricing page could reach it only with a tool like curl.

          Under the form rather than beside the heading: somebody arriving here almost always has
          an account, and the one who does not is looking for exactly this sentence.

          It does not say "free trial" or name a price. What a signup gets is the Pilot plan, and
          the server decides that — a screen that promised anything else would be promising on the
          server's behalf.
        */}
        <p className="uboss-auth-switch">
          No workspace yet? <Link href="/start">Start one for your company</Link>
        </p>
      </form>

      {/*
        The terms, over the sign-in card rather than away from it.

        A link that navigated would discard a typed email and password, and somebody who read the
        terms would be punished for it. The dialog also means the tick and the thing it refers to
        are on the same screen, which is the only way the tick means anything.

        The text lives in `TermsSummary` because `/start` asks for the same acknowledgement, and
        two copies would drift the first time one was edited.
      */}
      <Modal open={showTerms} onClose={() => setShowTerms(false)} title="Terms &amp; Conditions">
        <TermsSummary context="sign-in" />
        <div className="uboss-actions" style={{ marginTop: 14 }}>
          <Button
            variant="primary"
            onClick={() => {
              setAcceptedTerms(true);
              setShowTerms(false);
            }}
          >
            I agree
          </Button>
          <Button onClick={() => setShowTerms(false)}>Close</Button>
        </div>
      </Modal>
    </LoginPresentation>
  );
}
