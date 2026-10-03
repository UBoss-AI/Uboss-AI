'use client';

import { useCallback, useState } from 'react';

import {
  CHANGE_REQUEST_KIND_LABELS,
  CHANGE_REQUEST_KINDS,
  type ChangeRequestKind,
} from '@uboss/types';
import { Banner, Button, Icon, Modal } from '@uboss/ui';

import { ApiError, approvalsApi } from '../lib/api-client';

interface RequestChangePanelProps {
  tenantId: string;
  open: boolean;
  /** The conversation this was raised from, so an Admin can read what was being discussed. */
  conversationId?: string | undefined;
  onClose: () => void;
  onFiled: (message: string) => void;
}

/**
 * Asking for a change.
 *
 * ## What it does, and the thing it deliberately does not do
 *
 * It files a request. That is all it does, and that is the point: the client's rule is "do not
 * give the employee direct configuration power simply because they requested a change". So there
 * is no screen here that edits a hierarchy, moves work or grants access — those all live behind
 * the authority to do them, and this puts a question in front of somebody who holds it.
 *
 * The request is an ordinary approval, so it arrives in the Admin's existing queue with the
 * existing decision trail. Nothing here is a second notion of who may decide what.
 */
export function RequestChangePanel({
  tenantId,
  open,
  conversationId,
  onClose,
  onFiled,
}: RequestChangePanelProps) {
  const [kind, setKind] = useState<ChangeRequestKind>('Other');
  const [reason, setReason] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const file = useCallback(() => {
    setBusy(true);
    setError(null);

    void approvalsApi
      .requestChange(tenantId, {
        kind,
        reason,
        ...(conversationId === undefined ? {} : { conversationId }),
      })
      .then(() => {
        onFiled(
          'Your request has gone to the Admin. You will see their decision in your notifications.',
        );
        setReason('');
        setKind('Other');
        onClose();
      })
      .catch((caught: unknown) =>
        setError(caught instanceof ApiError ? caught.message : 'That request could not be filed.'),
      )
      .finally(() => setBusy(false));
  }, [conversationId, kind, onClose, onFiled, reason, tenantId]);

  return (
    <Modal
      open={open}
      title="Request a change"
      onClose={onClose}
      footer={
        <>
          <Button onClick={onClose} disabled={busy}>
            Cancel
          </Button>
          <Button
            variant="primary"
            onClick={file}
            disabled={busy || reason.trim().length < 10}
            title={reason.trim().length < 10 ? 'Say what needs changing and why.' : undefined}
          >
            <Icon name="arrow" size={16} />
            Send to the Admin
          </Button>
        </>
      }
    >
      {error === null ? null : <Banner tone="danger">{error}</Banner>}

      <div className="uboss-field">
        <label htmlFor="change-kind">What is this about?</label>
        <select
          id="change-kind"
          value={kind}
          onChange={(event) => setKind(event.target.value as ChangeRequestKind)}
        >
          {CHANGE_REQUEST_KINDS.map((option) => (
            <option key={option} value={option}>
              {CHANGE_REQUEST_KIND_LABELS[option]}
            </option>
          ))}
        </select>
      </div>

      <div className="uboss-field">
        <label htmlFor="change-reason">What needs changing, and why?</label>
        <textarea
          id="change-reason"
          rows={5}
          value={reason}
          onChange={(event) => setReason(event.target.value)}
          placeholder="e.g. I cannot open the Field Operations workshop, and I work in that department."
        />
        <span className="uboss-field-hint">
          Somebody has to decide this, and they can only decide what you tell them.
        </span>
      </div>

      <p className="uboss-notice-min">
        <Icon name="shield" size={14} />
        Asking does not change anything by itself. The Admin decides, and the decision is recorded.
      </p>
    </Modal>
  );
}
