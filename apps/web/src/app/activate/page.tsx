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

import { ApiError, authApi, type InvitationPreviewResponse } from '../../lib/api-client';

type State =
  | { kind: 'no-token' }
  | { kind: 'checking' }
  | { kind: 'invalid' }
  | { kind: 'ready'; preview: InvitationPreviewResponse }
  | { kind: 'submitting'; preview: InvitationPreviewResponse }
  | { kind: 'failed'; preview: InvitationPreviewResponse; message: string }
  | { kind: 'activated'; tenantName: string };

/**
 * Activate an invitation.
 *
 * "Activate" enables an identity a company has **already invited** — it is not a signup. It
 * cannot create a company, and it cannot create a membership; both must already exist.
 *
 * Two shapes, because a person can be invited by a second company after they already have a
 * UBoss password: when `hasExistingPassword` is true the screen must not ask for a new one, since
 * one identity keeps one password across companies.
 */
export default function ActivatePage() {
  const [token, setToken] = useState('');
  const [password, setPassword] = useState('');
  const [confirmation, setConfirmation] = useState('');
  const [state, setState] = useState<State>({ kind: 'no-token' });

  // Read the token from the link. Kept in state rather than the URL after use so it does not
  // linger in the address bar or in a shared screenshot.
  useEffect(() => {
    const fromUrl = new URLSearchParams(window.location.search).get('token');
    if (!fromUrl) {
      setState({ kind: 'no-token' });
      return;
    }
    setToken(fromUrl);
    setState({ kind: 'checking' });

    authApi
      .previewInvitation(fromUrl)
      .then((preview) => {
        setState(preview.valid ? { kind: 'ready', preview } : { kind: 'invalid' });
      })
      .catch(() => setState({ kind: 'invalid' }));
  }, []);

  const needsPassword = (preview: InvitationPreviewResponse) => !preview.hasExistingPassword;

  const handleSubmit = async (event: React.FormEvent, preview: InvitationPreviewResponse) => {
    event.preventDefault();

    if (needsPassword(preview) && password !== confirmation) {
      setState({ kind: 'failed', preview, message: 'The two passwords do not match.' });
      return;
    }

    setState({ kind: 'submitting', preview });

    try {
      await authApi.activateInvitation(token, needsPassword(preview) ? password : undefined);
      setState({ kind: 'activated', tenantName: preview.tenantName ?? 'your company' });
    } catch (error) {
      setState({
        kind: 'failed',
        preview,
        message: error instanceof ApiError ? error.message : 'Activation failed. Please try again.',
      });
    }
  };

  if (state.kind === 'no-token') {
    return (
      <LoginPresentation>
        <h1>Activation link required</h1>
        <p className="uboss-login-card-sub">
          Open the activation link your administrator sent you. It contains a one-time code, so it
          cannot be typed in by hand.
        </p>
        <Banner tone="info">
          Invitations expire. If yours has, ask your administrator to resend it — a resend issues a
          fresh link and retires the old one.
        </Banner>
        <div className="uboss-auth-links">
          <Link href="/login" className="uboss-link">
            Back to sign in
          </Link>
          <Link href="/access-help" className="uboss-link">
            Access help
          </Link>
        </div>
        <NoPublicSignupNotice />
      </LoginPresentation>
    );
  }

  if (state.kind === 'checking') {
    return (
      <LoginPresentation>
        <h1>Checking your invitation…</h1>
        <div style={{ marginTop: 20 }}>
          <SkeletonText lines={3} />
        </div>
      </LoginPresentation>
    );
  }

  if (state.kind === 'invalid') {
    return (
      <LoginPresentation>
        <h1>This link is not valid</h1>
        <p className="uboss-login-card-sub">
          It may have expired, been cancelled, or already been used.
        </p>
        {/* Deliberately one message for every cause: distinguishing them would let a link be
            probed for information. */}
        <Banner tone="warn">
          Ask your administrator to resend your invitation. If you already activated your account,
          sign in instead.
        </Banner>
        <div className="uboss-auth-links">
          <Link href="/login" className="uboss-link">
            Back to sign in
          </Link>
          <Link href="/access-help" className="uboss-link">
            Access help
          </Link>
        </div>
        <NoPublicSignupNotice />
      </LoginPresentation>
    );
  }

  if (state.kind === 'activated') {
    return (
      <LoginPresentation>
        <h1>Account activated</h1>
        <p className="uboss-login-card-sub">
          You are now signed in and your access to {state.tenantName} is active.
        </p>
        <Banner tone="ok">
          Your password is stored only as a one-way hash. Nobody — including your administrator —
          can read it.
        </Banner>
        <div style={{ marginTop: 18 }}>
          <Link href="/login">
            <Button variant="primary" block>
              Continue
            </Button>
          </Link>
        </div>
      </LoginPresentation>
    );
  }

  const preview = state.preview;
  const submitting = state.kind === 'submitting';
  const askForPassword = needsPassword(preview);

  return (
    <LoginPresentation>
      <form onSubmit={(event) => handleSubmit(event, preview)} noValidate>
        <h1>Activate your account</h1>
        <p className="uboss-login-card-sub">
          {preview.displayName} · {preview.tenantName}
        </p>

        {state.kind === 'failed' ? (
          <div style={{ marginBottom: 16 }}>
            <Banner tone="danger">{state.message}</Banner>
          </div>
        ) : null}

        <FormField label="Work email" hint="Set by your administrator and cannot be changed here.">
          {(props) => <input {...props} value={preview.email ?? ''} readOnly disabled />}
        </FormField>

        {askForPassword ? (
          <>
            <FormField
              label="Choose a password"
              required
              hint="At least 12 characters. A long phrase is stronger than a short complex one."
            >
              {(props) => (
                <input
                  {...props}
                  type="password"
                  autoComplete="new-password"
                  value={password}
                  onChange={(event) => setPassword(event.target.value)}
                  disabled={submitting}
                />
              )}
            </FormField>

            <FormField label="Confirm password" required>
              {(props) => (
                <input
                  {...props}
                  type="password"
                  autoComplete="new-password"
                  value={confirmation}
                  onChange={(event) => setConfirmation(event.target.value)}
                  disabled={submitting}
                />
              )}
            </FormField>
          </>
        ) : (
          <Banner tone="info">
            You already have a UBoss password from another company. Activating here joins{' '}
            {preview.tenantName} using your existing password — one identity, one password.
          </Banner>
        )}

        <div style={{ marginTop: 18 }}>
          <Button type="submit" variant="primary" block disabled={submitting}>
            {submitting ? 'Activating…' : 'Activate & Sign In'}
          </Button>
        </div>

        <div className="uboss-auth-links">
          <Link href="/login" className="uboss-link">
            Back to sign in
          </Link>
          <Link href="/access-help" className="uboss-link">
            Access help
          </Link>
        </div>

        <NoPublicSignupNotice />
      </form>
    </LoginPresentation>
  );
}
