'use client';

import { useRouter } from 'next/navigation';
import { useCallback, useEffect, useState } from 'react';

import { CHAT_CONTEXT_LABELS, type ChatContextType } from '@uboss/types';
import { Banner, Button, Icon, Modal } from '@uboss/ui';

import { ApiError, chatApi, organizationApi, photosApi, type PhotoView } from '../lib/api-client';

import { EmployeePhoto } from './EmployeePhoto';

export interface DiscussButtonProps {
  tenantId: string | null;
  /** Which kind of work this is about. The server resolves the preview per viewer. */
  contextType: ChatContextType;
  resourceId: string;
  /** Optional label override. Defaults to "Discuss". */
  label?: string;
}

/**
 * "Discuss" — the entry point from a piece of work into Workspace Chat (Prompt 40A / CR-03 §6).
 *
 * ## Why the conversation carries a reference and not a copy
 *
 * Starting a conversation *about* an Objective attaches `{ type, id }` and nothing else. The title,
 * the status and the link are resolved for **each viewer** when they open the conversation, so
 * somebody who may not see that Objective is told so rather than reading its name out of a chat
 * message. Copying a title into the conversation at creation time would have leaked it permanently
 * and invisibly — the escalation this design exists to prevent.
 *
 * ## Why it asks who, and nothing else
 *
 * A picker and a first message. No channels, no threads, no reactions, no presence: CR-03 says
 * explicitly not to build a Slack clone, and every one of those is a feature somebody would then
 * expect to work. Discussing a piece of work with named colleagues is the whole requirement.
 *
 * ## Why it navigates away
 *
 * The conversation lives on the Chat screen. Continuing it in a popover on an Objective page would
 * be a second chat UI with its own unread state, which is precisely how two of them end up
 * disagreeing about what has been read.
 */
export function DiscussButton({ tenantId, contextType, resourceId, label }: DiscussButtonProps) {
  const router = useRouter();

  const [open, setOpen] = useState(false);
  const [people, setPeople] = useState<{ userId: string; displayName: string }[]>([]);
  const [photos, setPhotos] = useState<Record<string, PhotoView | null>>({});
  const [chosen, setChosen] = useState<string[]>([]);
  const [first, setFirst] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const loadPeople = useCallback(async () => {
    if (tenantId === null) return;
    try {
      const view = await organizationApi.hierarchy(tenantId);
      const active = view.list.filter((row) => row.employmentState === 'Active');
      setPeople(active.map((row) => ({ userId: row.userId, displayName: row.displayName })));

      // One request for every face in the picker. Its failure is swallowed: initials are a
      // correct rendering of "no picture", and a picker that refused to open because the
      // photos would not load would be a worse picker.
      try {
        const result = await photosApi.viewMany(
          tenantId,
          active.map((row) => row.userId),
        );
        const byUser: Record<string, PhotoView | null> = {};
        for (const row of active) byUser[row.userId] = null;
        for (const photo of result.photos) byUser[photo.userId] = photo;
        setPhotos(byUser);
      } catch {
        /* initials it is */
      }
    } catch (caught) {
      setError(caught instanceof ApiError ? caught.message : 'Colleagues could not be loaded.');
    }
  }, [tenantId]);

  useEffect(() => {
    if (open) void loadPeople();
  }, [open, loadPeople]);

  const start = async () => {
    if (tenantId === null || chosen.length === 0) return;
    setBusy(true);
    setError(null);
    try {
      // Direct when it is one colleague, a group when it is several — the server's own two kinds.
      const conversation = await chatApi.start(tenantId, {
        kind: chosen.length === 1 ? 'Direct' : 'Group',
        participantUserIds: chosen,
        ...(chosen.length === 1 ? {} : { title: `${CHAT_CONTEXT_LABELS[contextType]} discussion` }),
      });

      await chatApi.addContext(tenantId, conversation.id, { contextType, resourceId });

      if (first.trim() !== '') {
        await chatApi.send(tenantId, conversation.id, { body: first.trim() });
      }

      setOpen(false);
      setChosen([]);
      setFirst('');
      router.push(`/chat?conversation=${encodeURIComponent(conversation.id)}`);
    } catch (caught) {
      setError(caught instanceof ApiError ? caught.message : 'That conversation could not start.');
    } finally {
      setBusy(false);
    }
  };

  const toggle = (userId: string) => {
    setChosen((current) =>
      current.includes(userId) ? current.filter((entry) => entry !== userId) : [...current, userId],
    );
  };

  if (tenantId === null) return null;

  return (
    <>
      <Button variant="ghost" size="sm" onClick={() => setOpen(true)} data-testid="discuss-button">
        <Icon name="chat" size={16} />
        {label ?? 'Discuss'}
      </Button>

      <Modal
        open={open}
        onClose={() => setOpen(false)}
        title={`Discuss this ${CHAT_CONTEXT_LABELS[contextType].toLowerCase()}`}
        footer={
          <>
            <Button onClick={() => setOpen(false)}>Cancel</Button>
            <Button
              variant="primary"
              disabled={busy || chosen.length === 0}
              onClick={() => void start()}
              data-testid="discuss-start"
            >
              Start conversation
            </Button>
          </>
        }
      >
        {error === null ? null : <Banner tone="danger">{error}</Banner>}

        <p className="chat-muted">
          The conversation will link to this {CHAT_CONTEXT_LABELS[contextType].toLowerCase()}.
          Everybody sees the link; each person sees only as much of it as their own access allows.
        </p>

        <div className="discuss-people">
          {people.map((person) => (
            <label key={person.userId} className="discuss-person">
              <input
                type="checkbox"
                checked={chosen.includes(person.userId)}
                onChange={() => toggle(person.userId)}
              />
              {/*
                CR-03 §3 names selectors alongside Hierarchy and profile. Fed from the one bulk
                read above, so a picker of forty colleagues still makes one request.
              */}
              <EmployeePhoto
                tenantId={tenantId}
                userId={person.userId}
                displayName={person.displayName}
                size="sm"
                prefetched={photos[person.userId] ?? null}
              />
              {person.displayName}
            </label>
          ))}
        </div>

        <label className="operator-field">
          <span>First message (optional)</span>
          <textarea
            rows={3}
            value={first}
            onChange={(event) => setFirst(event.target.value)}
            data-testid="discuss-first-message"
          />
        </label>
      </Modal>
    </>
  );
}
