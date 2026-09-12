'use client';

import { useEffect, useState } from 'react';

import { Banner } from './ErrorState';
import { Button } from './Button';
import { FormField } from './FormField';
import { Modal } from './Modal';

export interface ImpactLine {
  label: string;
  value: string;
}

export interface ConfirmDialogProps {
  open: boolean;
  onCancel: () => void;
  /** Called with the typed reason when a reason is required, otherwise with `undefined`. */
  onConfirm: (reason?: string) => void;
  title: string;
  /** What the action will do, in plain language. */
  description: string;
  /**
   * Impact preview: the concrete blast radius, e.g. "Employees affected: 4".
   * Locked rule G — a dangerous action must show its impact before it is taken.
   */
  impact?: ImpactLine[];
  /** Require a typed reason before confirming. Used for destructive/audited actions. */
  requireReason?: boolean;
  reasonLabel?: string;
  /** Require the user to type this exact word (e.g. the record name) to confirm. */
  confirmPhrase?: string;
  confirmLabel?: string;
  cancelLabel?: string;
  /** Style the confirm action as destructive. */
  destructive?: boolean;
}

/**
 * Confirmation gate for dangerous actions.
 *
 * Working rule G: dangerous actions need confirmation, an impact preview and a reason where
 * required, plus an audit event. This component covers the first three; the audit event is
 * raised server-side by the operation itself, never by the UI.
 */
export function ConfirmDialog({
  open,
  onCancel,
  onConfirm,
  title,
  description,
  impact,
  requireReason = false,
  reasonLabel = 'Reason (recorded in the audit trail)',
  confirmPhrase,
  confirmLabel = 'Confirm',
  cancelLabel = 'Cancel',
  destructive = false,
}: ConfirmDialogProps) {
  const [reason, setReason] = useState('');
  const [phrase, setPhrase] = useState('');
  const [touched, setTouched] = useState(false);

  // Reset the gate every time the dialog opens, so a previous attempt cannot pre-satisfy it.
  useEffect(() => {
    if (open) {
      setReason('');
      setPhrase('');
      setTouched(false);
    }
  }, [open]);

  const reasonMissing = requireReason && reason.trim().length === 0;
  const phraseMismatch = confirmPhrase !== undefined && phrase !== confirmPhrase;
  const blocked = reasonMissing || phraseMismatch;

  const handleConfirm = () => {
    setTouched(true);
    if (blocked) {
      return;
    }
    onConfirm(requireReason ? reason.trim() : undefined);
  };

  return (
    <Modal
      open={open}
      onClose={onCancel}
      title={title}
      footer={
        <>
          <Button onClick={onCancel}>{cancelLabel}</Button>
          <Button
            variant={destructive ? 'danger' : 'primary'}
            onClick={handleConfirm}
            disabled={blocked && touched}
          >
            {confirmLabel}
          </Button>
        </>
      }
    >
      <Banner tone={destructive ? 'danger' : 'warn'}>{description}</Banner>

      {impact && impact.length > 0 ? (
        <>
          <div className="uboss-section-label">Impact preview</div>
          {impact.map((line) => (
            <div key={line.label} className="uboss-kv">
              <span className="uboss-kv-key">{line.label}</span>
              <span className="uboss-kv-value">{line.value}</span>
            </div>
          ))}
        </>
      ) : null}

      {confirmPhrase !== undefined ? (
        <div style={{ marginTop: 18 }}>
          <FormField
            label={`Type "${confirmPhrase}" to confirm`}
            required
            error={touched && phraseMismatch ? 'The text does not match.' : undefined}
          >
            {(props) => (
              <input
                {...props}
                value={phrase}
                onChange={(event) => setPhrase(event.target.value)}
                autoComplete="off"
              />
            )}
          </FormField>
        </div>
      ) : null}

      {requireReason ? (
        <FormField
          label={reasonLabel}
          required
          hint="Recorded against your account and visible in Audit & Activity."
          error={touched && reasonMissing ? 'A reason is required for this action.' : undefined}
        >
          {(props) => (
            <textarea
              {...props}
              value={reason}
              onChange={(event) => setReason(event.target.value)}
            />
          )}
        </FormField>
      ) : null}
    </Modal>
  );
}
