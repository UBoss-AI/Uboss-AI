'use client';

import { useCallback, useEffect, useState } from 'react';

import { Banner, Button, StatusBadge } from '@uboss/ui';

import { NOTIFICATION_DIGESTS } from '@uboss/types';

import { ApiError, notificationsApi, type NotificationPreferenceRow } from '../lib/api-client';

export interface NotificationPreferencesProps {
  tenantId: string;
}

/**
 * One person's own notification preferences, per kind.
 *
 * ## Why this sits inside the company Settings category rather than on its own screen
 *
 * The reference puts a Digest control and an Acknowledgement control in **Notifications &
 * Escalations**, alongside the company's alert and escalation-chain configuration. So personal
 * preferences live in the same panel: somebody looking for "how often do I hear about this" looks
 * where the alerts are described, not in a second place.
 *
 * ## A control that cannot be changed is disabled and says why
 *
 * Security alerts are immutable, and the server refuses a change to them. The screen asks the
 * **same** function the engine asks (`mutable`, computed from `isMandatoryNotification`), so the
 * two can never disagree — a checkbox offering to mute something the engine will send anyway
 * would be a lie told by the UI.
 *
 * ## Each kind says whether anything produces it yet
 *
 * Three of the six sources arrive with later prompts. A preference control for something nothing
 * raises is not wrong — it will work the moment that module ships — but implying it is live would
 * be, so each row states it.
 */
export function NotificationPreferences({ tenantId }: NotificationPreferencesProps) {
  const [rows, setRows] = useState<NotificationPreferenceRow[] | null>(null);
  const [note, setNote] = useState<string>('');
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState<string | null>(null);

  const load = useCallback(() => {
    setError(null);
    void notificationsApi
      .preferences(tenantId)
      .then((view) => {
        setRows(view.preferences);
        setNote(view.note);
      })
      .catch((caught: unknown) =>
        setError(caught instanceof ApiError ? caught.message : 'Could not load your preferences.'),
      );
  }, [tenantId]);

  useEffect(load, [load]);

  /**
   * Saved on change, one kind at a time.
   *
   * No Save button, deliberately: each row is one independent choice, and a single Save across
   * six kinds would make the unsaved-change warning the company settings panel already carries
   * ambiguous about which half was dirty.
   */
  const update = useCallback(
    (row: NotificationPreferenceRow, patch: Partial<NotificationPreferenceRow>) => {
      const next = { ...row, ...patch };
      setRows((current) => (current ?? []).map((item) => (item.kind === row.kind ? next : item)));

      void notificationsApi
        .setPreference(tenantId, {
          kind: next.kind,
          inAppEnabled: next.inAppEnabled,
          emailEnabled: next.emailEnabled,
          digest: next.digest,
        })
        .then((result) => {
          setSaved(result.note);
          load();
        })
        .catch((caught: unknown) => {
          setError(caught instanceof ApiError ? caught.message : 'Could not save that.');
          // Reload rather than keeping the optimistic value: the server refused, so the screen
          // must show what is actually stored.
          load();
        });
    },
    [load, tenantId],
  );

  if (rows === null) {
    return error === null ? <p className="uboss-muted-3">Loading your preferences…</p> : null;
  }

  return (
    <>
      <div className="uboss-section-label">My notification preferences</div>

      {error ? <Banner tone="danger">{error}</Banner> : null}
      {saved ? <Banner tone="ok">{saved}</Banner> : null}

      {rows.map((row) => (
        <div key={row.kind} style={{ marginBottom: 16 }}>
          <div className="uboss-actions" style={{ justifyContent: 'space-between' }}>
            <b>{row.label}</b>
            <span className="uboss-actions">
              {row.mutable ? null : <StatusBadge status="Mandatory" tone="danger" dot={false} />}
              <StatusBadge
                status={row.source === 'chosen' ? 'Your choice' : 'Default'}
                tone={row.source === 'chosen' ? 'blue' : 'grey'}
                dot={false}
              />
            </span>
          </div>

          <p className="uboss-muted-3" style={{ margin: '2px 0 6px' }}>
            {row.description}
          </p>

          <div className="uboss-actions">
            <label className="uboss-checkbox">
              <input
                type="checkbox"
                checked={row.inAppEnabled}
                disabled={!row.mutable}
                onChange={(event) => update(row, { inAppEnabled: event.target.checked })}
              />
              In the app
            </label>

            <label className="uboss-checkbox">
              <input
                type="checkbox"
                checked={row.emailEnabled}
                disabled={!row.mutable}
                onChange={(event) => update(row, { emailEnabled: event.target.checked })}
              />
              By email
            </label>

            <label className="uboss-checkbox">
              Email digest
              <select
                className="uboss-input"
                value={row.digest}
                disabled={!row.mutable || !row.emailEnabled}
                onChange={(event) =>
                  update(row, { digest: event.target.value as NotificationPreferenceRow['digest'] })
                }
              >
                {NOTIFICATION_DIGESTS.map((option) => (
                  <option key={option} value={option}>
                    {option === 'Off' ? 'Each one as it happens' : option}
                  </option>
                ))}
              </select>
            </label>
          </div>

          {row.producedBy.startsWith('live') ? null : (
            <p className="uboss-muted-3" style={{ fontSize: 12, marginTop: 4 }}>
              Nothing raises these yet — they arrive with {row.producedBy}. This choice is stored
              and will apply then.
            </p>
          )}
        </div>
      ))}

      <p className="uboss-notice">{note}</p>

      <div className="uboss-actions">
        <Button variant="ghost" onClick={load}>
          Reload
        </Button>
      </div>
    </>
  );
}
