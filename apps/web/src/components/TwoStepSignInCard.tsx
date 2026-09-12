'use client';

import { useCallback, useEffect, useState } from 'react';

import {
  Banner,
  Button,
  Card,
  CardBody,
  CardHeader,
  ConfirmDialog,
  FormField,
  SkeletonText,
  StatusBadge,
} from '@uboss/ui';

import { ApiError, authApi, type EnrolmentStart, type MfaFactor } from '../lib/api-client';

type Enrolling =
  | { kind: 'idle' }
  | { kind: 'starting' }
  | { kind: 'confirming'; enrolment: EnrolmentStart; error?: string };

/**
 * Two-step sign-in management, for the Login & Security screen.
 *
 * Everything here is about the **person**, not a company: one UBoss identity keeps one set of
 * second factors across every employer, so this card is the same whichever workspace it is
 * reached from.
 *
 * Two things it deliberately cannot do:
 *
 *   * **Show an existing secret or an old recovery code.** The server holds an encrypted TOTP
 *     secret it will never return, and only hashes of the recovery codes. A "show my codes again"
 *     button is impossible by construction, which is the point — so the copy says so plainly
 *     rather than leaving someone hunting for it.
 *   * **Remove the last factor when a company requires MFA.** The server refuses that, and the
 *     error explains to enrol a replacement first.
 */
export function TwoStepSignInCard() {
  const [factors, setFactors] = useState<MfaFactor[] | null>(null);
  const [remainingCodes, setRemainingCodes] = useState(0);
  const [batchSize, setBatchSize] = useState(10);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const [enrolling, setEnrolling] = useState<Enrolling>({ kind: 'idle' });
  const [code, setCode] = useState('');
  const [freshCodes, setFreshCodes] = useState<string[] | null>(null);
  const [confirmRemove, setConfirmRemove] = useState<MfaFactor | null>(null);
  const [confirmRegenerate, setConfirmRegenerate] = useState(false);
  const [busyId, setBusyId] = useState<string | null>(null);

  const load = useCallback(async () => {
    setError(null);
    try {
      const result = await authApi.mfaFactors();
      setFactors(result.factors);
      setRemainingCodes(result.remainingRecoveryCodes);
      setBatchSize(result.recoveryCodeBatchSize);
    } catch (cause) {
      setError(
        cause instanceof ApiError ? cause.message : 'Your second factors could not be loaded.',
      );
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const active = (factors ?? []).filter((factor) => factor.state === 'Active');

  const startEnrolment = async () => {
    setEnrolling({ kind: 'starting' });
    setNotice(null);
    try {
      const enrolment = await authApi.startEnrolment();
      setEnrolling({ kind: 'confirming', enrolment });
    } catch (cause) {
      setEnrolling({ kind: 'idle' });
      setError(cause instanceof ApiError ? cause.message : 'Setup could not be started.');
    }
  };

  const confirmEnrolment = async (event: React.FormEvent, factorId: string) => {
    event.preventDefault();
    try {
      const result = await authApi.confirmEnrolment(factorId, code);
      setCode('');
      setEnrolling({ kind: 'idle' });
      // Present only for the first factor. Regenerating on every enrolment would silently
      // invalidate codes the person has already printed.
      setFreshCodes(result.recoveryCodes);
      setNotice('Authenticator app added.');
      await load();
    } catch (cause) {
      const message = cause instanceof ApiError ? cause.message : 'That code did not match.';
      setEnrolling((current) =>
        current.kind === 'confirming' ? { ...current, error: message } : current,
      );
      setCode('');
    }
  };

  const removeFactor = async (factor: MfaFactor) => {
    setConfirmRemove(null);
    setBusyId(factor.id);
    setNotice(null);
    try {
      await authApi.revokeFactor(factor.id);
      setNotice('That factor was removed.');
      await load();
    } catch (cause) {
      setError(cause instanceof ApiError ? cause.message : 'That factor could not be removed.');
    } finally {
      setBusyId(null);
    }
  };

  const regenerate = async () => {
    setConfirmRegenerate(false);
    setNotice(null);
    try {
      const result = await authApi.regenerateRecoveryCodes();
      setFreshCodes(result.codes);
      setNotice(result.message);
      await load();
    } catch (cause) {
      setError(
        cause instanceof ApiError ? cause.message : 'New recovery codes could not be generated.',
      );
    }
  };

  return (
    <Card>
      <CardHeader
        title="Two-step sign-in"
        aside={
          active.length > 0 ? (
            <StatusBadge status="Active" />
          ) : (
            <StatusBadge status="Not set up" tone="grey" />
          )
        }
      />
      <CardBody>
        {error ? (
          <div style={{ marginBottom: 12 }}>
            <Banner tone="danger">{error}</Banner>
          </div>
        ) : null}

        {notice ? (
          <div style={{ marginBottom: 12 }}>
            <Banner tone="ok">{notice}</Banner>
          </div>
        ) : null}

        {freshCodes ? (
          <div style={{ marginBottom: 16 }}>
            <Banner tone="warn">
              Save these recovery codes now. Each works once, and they are shown only here — the
              server keeps hashes, not codes, so they cannot be displayed again. A new batch
              replaces every earlier code.
            </Banner>
            <ul className="uboss-recovery-codes">
              {freshCodes.map((recoveryCode) => (
                <li key={recoveryCode}>{recoveryCode}</li>
              ))}
            </ul>
            <div style={{ marginTop: 10 }}>
              <Button size="sm" onClick={() => setFreshCodes(null)}>
                I have saved them
              </Button>
            </div>
          </div>
        ) : null}

        {factors === null && error === null ? <SkeletonText lines={3} /> : null}

        {factors !== null && factors.length === 0 ? (
          <p className="uboss-notice">
            No second factor is set up. Adding one means a stolen password is not enough to sign in
            as you.
          </p>
        ) : null}

        {(factors ?? []).map((factor) => (
          <div key={factor.id} className="uboss-factor-row">
            <span className="uboss-factor-row-main">
              <b>{factor.label ?? 'Authenticator app'}</b>
              <small>
                {factor.state === 'Active'
                  ? factor.lastUsedAt
                    ? `Last used ${new Date(factor.lastUsedAt).toLocaleString()}`
                    : 'Never used'
                  : 'Setup not completed'}
              </small>
            </span>
            <span className="uboss-factor-row-actions">
              <Button
                size="sm"
                variant="danger"
                onClick={() => setConfirmRemove(factor)}
                disabled={busyId === factor.id}
              >
                {busyId === factor.id ? 'Removing…' : 'Remove'}
              </Button>
            </span>
          </div>
        ))}

        {enrolling.kind === 'confirming' ? (
          <form
            onSubmit={(event) => void confirmEnrolment(event, enrolling.enrolment.factorId)}
            noValidate
          >
            <div className="uboss-section-label">1. Add UBoss to your authenticator app</div>
            <p className="uboss-notice">
              Enter this key, or open the setup link. It is shown only once.
            </p>
            <code className="uboss-totp-secret">{enrolling.enrolment.secret}</code>
            <p className="uboss-notice">
              <a className="uboss-link" href={enrolling.enrolment.otpauthUri}>
                Open in your authenticator app
              </a>{' '}
              · {enrolling.enrolment.accountName}
            </p>

            <div className="uboss-section-label">2. Enter the code it shows</div>

            {enrolling.error ? (
              <div style={{ marginBottom: 12 }}>
                <Banner tone="danger">{enrolling.error}</Banner>
              </div>
            ) : null}

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
                />
              )}
            </FormField>

            <div style={{ display: 'flex', gap: 8 }}>
              <Button type="submit" variant="primary">
                Confirm
              </Button>
              <Button
                type="button"
                onClick={() => {
                  setCode('');
                  setEnrolling({ kind: 'idle' });
                }}
              >
                Cancel
              </Button>
            </div>
          </form>
        ) : (
          <div style={{ display: 'flex', gap: 8, marginTop: 14, flexWrap: 'wrap' }}>
            <Button
              variant="primary"
              onClick={() => void startEnrolment()}
              disabled={enrolling.kind === 'starting'}
            >
              {enrolling.kind === 'starting'
                ? 'Preparing…'
                : active.length > 0
                  ? 'Add another authenticator'
                  : 'Set up an authenticator app'}
            </Button>

            {active.length > 0 ? (
              <Button onClick={() => setConfirmRegenerate(true)}>
                Generate new recovery codes
              </Button>
            ) : null}
          </div>
        )}

        {active.length > 0 ? (
          <p className="uboss-notice" style={{ marginTop: 14 }}>
            {remainingCodes} of {batchSize} recovery codes remain unused. Each one signs you in once
            if your authenticator is unavailable.
          </p>
        ) : null}
      </CardBody>

      <ConfirmDialog
        open={confirmRemove !== null}
        onCancel={() => setConfirmRemove(null)}
        onConfirm={() => confirmRemove && void removeFactor(confirmRemove)}
        title="Remove this second factor?"
        description="You will no longer be asked for a code from this app when signing in."
        impact={[
          { label: 'Factors remaining', value: String(Math.max(active.length - 1, 0)) },
          {
            label: 'If this is your last one',
            value: 'A company that requires two-step sign-in will refuse the removal',
          },
        ]}
        confirmLabel="Remove factor"
        destructive
      />

      <ConfirmDialog
        open={confirmRegenerate}
        onCancel={() => setConfirmRegenerate(false)}
        onConfirm={() => void regenerate()}
        title="Generate new recovery codes?"
        description="Every existing recovery code stops working immediately, including any you have printed or stored."
        impact={[
          { label: 'Codes invalidated', value: String(remainingCodes) },
          { label: 'New codes', value: String(batchSize) },
          { label: 'Shown', value: 'Once — they cannot be displayed again' },
        ]}
        confirmLabel="Generate new codes"
        destructive
      />
    </Card>
  );
}
