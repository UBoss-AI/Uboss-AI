'use client';

import Link from 'next/link';
import { useEffect, useState } from 'react';

import { Banner, Button, FormField, LoginPresentation, PasswordInput } from '@uboss/ui';

import { ApiError, authApi } from '../../lib/api-client';

type RequestState =
  | { kind: 'idle' }
  | { kind: 'submitting' }
  | { kind: 'accepted'; message: string }
  | { kind: 'error'; message: string };

type ResetState =
  | { kind: 'idle' }
  | { kind: 'submitting' }
  | { kind: 'done'; message: string; sessionsRevoked: number }
  | { kind: 'error'; message: string };

/**
 * Access Help — request a password reset, or complete one from a reset link.
 *
 * Two modes in one screen because they are two halves of one task, and someone arriving from a
 * reset email should not have to work out which page they need.
 *
 * The request half **always** reports the same outcome, whether or not the address has an
 * account. That is deliberate: a different answer would turn this into a way to discover which
 * addresses have UBoss accounts.
 */
export default function AccessHelpPage() {
  const [email, setEmail] = useState('');
  const [requestState, setRequestState] = useState<RequestState>({ kind: 'idle' });

  const [resetToken, setResetToken] = useState<string | null>(null);
  const [password, setPassword] = useState('');
  const [confirmation, setConfirmation] = useState('');
  const [resetState, setResetState] = useState<ResetState>({ kind: 'idle' });

  useEffect(() => {
    const token = new URLSearchParams(window.location.search).get('token');
    if (token) {
      setResetToken(token);
    }
  }, []);

  const handleRequest = async (event: React.FormEvent) => {
    event.preventDefault();
    setRequestState({ kind: 'submitting' });

    try {
      const result = await authApi.requestPasswordReset(email);
      setRequestState({ kind: 'accepted', message: result.message });
    } catch (error) {
      setRequestState({
        kind: 'error',
        message:
          error instanceof ApiError ? error.message : 'Something went wrong. Please try again.',
      });
    }
  };

  const handleReset = async (event: React.FormEvent) => {
    event.preventDefault();
    if (!resetToken) {
      return;
    }
    if (password !== confirmation) {
      setResetState({ kind: 'error', message: 'The two passwords do not match.' });
      return;
    }

    setResetState({ kind: 'submitting' });

    try {
      const result = await authApi.confirmPasswordReset(resetToken, password);
      setResetState({
        kind: 'done',
        message: result.message,
        sessionsRevoked: result.sessionsRevoked,
      });
    } catch (error) {
      setResetState({
        kind: 'error',
        message: error instanceof ApiError ? error.message : 'The reset could not be completed.',
      });
    }
  };

  // ---- Completing a reset from a link ----
  if (resetToken) {
    if (resetState.kind === 'done') {
      return (
        <LoginPresentation>
          <h1>Password changed</h1>
          <p className="uboss-login-card-sub">{resetState.message}</p>
          <Banner tone="ok">
            {resetState.sessionsRevoked} session(s) were signed out. That is deliberate: if someone
            else had your password, leaving their session alive would defeat the reset.
          </Banner>
          <div style={{ marginTop: 18 }}>
            <Link href="/login">
              <Button variant="primary" block>
                Sign in with your new password
              </Button>
            </Link>
          </div>
        </LoginPresentation>
      );
    }

    return (
      <LoginPresentation>
        <form onSubmit={handleReset} noValidate>
          <h1>Choose a new password</h1>
          <p className="uboss-login-card-sub">
            This link works once and expires shortly after it was sent.
          </p>

          {resetState.kind === 'error' ? (
            <div style={{ marginBottom: 16 }}>
              <Banner tone="danger">{resetState.message}</Banner>
            </div>
          ) : null}

          <FormField
            label="New password"
            required
            hint="At least 12 characters. A long phrase is stronger than a short complex one."
          >
            {(props) => (
              <PasswordInput
                {...props}
                autoComplete="new-password"
                value={password}
                onChange={(event) => setPassword(event.target.value)}
                disabled={resetState.kind === 'submitting'}
              />
            )}
          </FormField>

          <FormField label="Confirm new password" required>
            {(props) => (
              <PasswordInput
                {...props}
                autoComplete="new-password"
                value={confirmation}
                onChange={(event) => setConfirmation(event.target.value)}
                disabled={resetState.kind === 'submitting'}
              />
            )}
          </FormField>

          <Button type="submit" variant="primary" block disabled={resetState.kind === 'submitting'}>
            {resetState.kind === 'submitting' ? 'Changing password…' : 'Change password'}
          </Button>

          <div className="uboss-auth-links">
            <Link href="/login" className="uboss-link">
              Back to login
            </Link>
          </div>
        </form>
      </LoginPresentation>
    );
  }

  // ---- Requesting a reset ----
  return (
    <LoginPresentation>
      <form onSubmit={handleRequest} noValidate>
        <h1>Forgot password</h1>
        <p className="uboss-login-card-sub">
          Enter your work email and we will send a password reset link.
        </p>

        {requestState.kind === 'accepted' ? (
          <div style={{ marginBottom: 16 }}>
            {/* Identical whether or not the address has an account — see the file comment. */}
            <Banner tone="ok">{requestState.message}</Banner>
          </div>
        ) : null}

        {requestState.kind === 'error' ? (
          <div style={{ marginBottom: 16 }}>
            <Banner tone="danger">{requestState.message}</Banner>
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
              disabled={requestState.kind === 'submitting'}
              placeholder="you@company.com"
            />
          )}
        </FormField>

        <Button type="submit" variant="primary" block disabled={requestState.kind === 'submitting'}>
          {requestState.kind === 'submitting' ? 'Sending…' : 'Send reset link'}
        </Button>

        {/*
          One question, one answer, one way back.

          This carried a list of three other problems — never activated, invitation expired,
          account locked — and the provisioning notice. All of it was true and none of it was what
          somebody who clicked "Forgot password" came here for; a page that answers four questions
          answers the asked one less clearly. /activate is unchanged and reachable, and an
          invitation email carries its own link, which is how anybody activating actually arrives.
        */}
        <div className="uboss-auth-links">
          <Link href="/login" className="uboss-link">
            Back to login
          </Link>
        </div>
      </form>
    </LoginPresentation>
  );
}
