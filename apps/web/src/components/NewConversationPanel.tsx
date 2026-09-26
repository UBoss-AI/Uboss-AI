'use client';

import { useState } from 'react';

import { Banner, Button, Card, CardBody, Icon } from '@uboss/ui';

import { ApiError, chatApi } from '../lib/api-client';

/**
 * Starting a conversation: a direct one with a colleague, or a group an administrator assembles.
 *
 * ## Two different acts behind one button
 *
 * A direct message is two colleagues talking, and anybody may start one. A Group is an official
 * company structure whose membership an administrator decides — the server refuses a group from
 * anybody without `users:ManageAccess`, and this panel simply does not offer it to them rather
 * than letting them fill a form in and be turned down at the end.
 *
 * That is not the screen deciding the permission. The server decides, and the refusal it gives is
 * shown verbatim if somebody reaches the route another way.
 *
 * ## Nobody types a user id
 *
 * People are chosen by name from the people this person may already see. The id exists and is
 * what gets sent; it never appears on screen, because an admin asked to identify a colleague by
 * UUID will pick the wrong one eventually.
 */
export function NewConversationPanel({
  tenantId,
  people,
  mayCreateGroup,
  onOpened,
  onCancel,
}: {
  tenantId: string;
  /** The colleagues this person may start something with, named. */
  people: { userId: string; displayName: string }[];
  /** Whether the server will accept a group from this person. */
  mayCreateGroup: boolean;
  onOpened: (conversationId: string) => void;
  onCancel: () => void;
}): React.JSX.Element {
  const [mode, setMode] = useState<'Direct' | 'Group'>('Direct');
  const [search, setSearch] = useState('');
  const [chosen, setChosen] = useState<string[]>([]);
  const [title, setTitle] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const matching = people.filter((person) =>
    person.displayName.toLowerCase().includes(search.trim().toLowerCase()),
  );

  const toggle = (userId: string): void => {
    setChosen((current) =>
      mode === 'Direct'
        ? // A direct conversation is with one person, so choosing another replaces the first
          // rather than adding to it.
          current[0] === userId
          ? []
          : [userId]
        : current.includes(userId)
          ? current.filter((id) => id !== userId)
          : [...current, userId],
    );
  };

  const problems: string[] = [];
  if (chosen.length === 0) problems.push('Choose somebody.');
  if (mode === 'Group' && title.trim() === '') problems.push('A group needs a name.');
  if (mode === 'Group' && chosen.length < 2) problems.push('A group needs at least two people.');

  const create = async (): Promise<void> => {
    setBusy(true);
    setError(null);
    try {
      const outcome = await chatApi.start(tenantId, {
        kind: mode,
        participantUserIds: chosen,
        ...(mode === 'Group' ? { title: title.trim() } : {}),
      });
      onOpened(outcome.id);
    } catch (caught) {
      // The server's own sentence. A refusal rewritten by the screen is a second policy, and it
      // will eventually say something the server does not mean.
      setError(caught instanceof ApiError ? caught.message : 'That conversation could not start.');
    } finally {
      setBusy(false);
    }
  };

  return (
    <Card>
      <CardBody>
        <div className="chat-new-head">
          <h3 className="chat-subhead">New conversation</h3>
          <Button variant="ghost" size="sm" onClick={onCancel}>
            Cancel
          </Button>
        </div>

        {error === null ? null : <Banner tone="danger">{error}</Banner>}

        <div className="chat-new-modes">
          <Button
            size="sm"
            variant={mode === 'Direct' ? 'primary' : 'default'}
            onClick={() => {
              setMode('Direct');
              setChosen([]);
            }}
          >
            Direct message
          </Button>
          {mayCreateGroup ? (
            <Button
              size="sm"
              variant={mode === 'Group' ? 'primary' : 'default'}
              onClick={() => {
                setMode('Group');
                setChosen([]);
              }}
              data-testid="new-group"
            >
              Create group
            </Button>
          ) : null}
        </div>

        {mode === 'Group' ? (
          <label className="uboss-field">
            <span className="uboss-field-label">Group name *</span>
            <input
              className="uboss-input"
              value={title}
              placeholder="What is this group for?"
              onChange={(event) => setTitle(event.target.value)}
            />
          </label>
        ) : null}

        <label className="uboss-field">
          <span className="uboss-field-label">
            {mode === 'Direct' ? 'Who do you want to message? *' : 'Members *'}
          </span>
          <input
            className="uboss-input"
            value={search}
            placeholder="Search by name"
            onChange={(event) => setSearch(event.target.value)}
          />
        </label>

        <ul className="chat-people" data-testid="chat-people">
          {matching.length === 0 ? (
            <li className="chat-muted">Nobody matches that.</li>
          ) : (
            matching.slice(0, 40).map((person) => (
              <li key={person.userId}>
                <button
                  type="button"
                  className={
                    chosen.includes(person.userId) ? 'chat-person chat-person-on' : 'chat-person'
                  }
                  onClick={() => toggle(person.userId)}
                >
                  <span>{person.displayName}</span>
                  {chosen.includes(person.userId) ? <Icon name="check" size={16} /> : null}
                </button>
              </li>
            ))
          )}
        </ul>

        {problems.length > 0 && (chosen.length > 0 || title.trim() !== '') ? (
          <Banner tone="warn">{problems.join(' ')}</Banner>
        ) : null}

        <Button
          variant="primary"
          disabled={busy || problems.length > 0}
          onClick={() => void create()}
          data-testid="start-conversation"
        >
          {mode === 'Direct' ? 'Open chat' : 'Create group'}
        </Button>
      </CardBody>
    </Card>
  );
}
