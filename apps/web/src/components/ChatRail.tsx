'use client';

import { motion } from 'motion/react';

import type { ChatConversationSummary } from '../lib/api-client';
import { StatusBadge, transition } from '@uboss/ui';

/**
 * The conversation rail, grouped the way people think about it.
 *
 * ## Why three sections rather than one list
 *
 * A flat list ordered by recency is right for a mailbox and wrong here. The three kinds answer
 * different questions — *who am I talking to*, *which team am I in*, *what is my department
 * saying* — and a workshop that has been quiet for a week sinking below six direct messages is a
 * workshop nobody opens. Grouping keeps each one findable by what it is rather than by when it
 * last moved.
 *
 * Within a section, most recent first, because that part of a mailbox's habit is right.
 *
 * ## A department workshop with no messages is still listed
 *
 * It exists because the department does, not because somebody started it. The rail therefore
 * lists every department this person may open, including ones with nothing in them yet — an empty
 * workshop is a room with no conversation in it, not a room that is missing.
 */
export function ChatRail({
  conversations,
  departments,
  openId,
  meUserId,
  onOpen,
  onOpenWorkshop,
}: {
  conversations: ChatConversationSummary[];
  /** Every department this person may open a workshop for, named. */
  departments: { id: string; name: string }[];
  openId: string | null;
  meUserId: string | null;
  onOpen: (conversationId: string) => void;
  onOpenWorkshop: (departmentId: string) => void;
}): React.JSX.Element {
  const direct = conversations.filter((row) => row.kind === 'Direct');
  const groups = conversations.filter((row) => row.kind === 'Group');
  const workshops = conversations.filter((row) => row.kind === 'DepartmentWorkshop');

  // A workshop that has been opened appears under its department; one that has not is still
  // listed, and opening it is what creates it.
  const openedDepartments = new Set(
    workshops.map((row) => row.departmentId).filter((id): id is string => id !== null),
  );

  return (
    <div className="chat-rail" data-testid="chat-conversations">
      <Section title="Direct messages" empty="No direct conversations yet.">
        {direct.map((row) => (
          <Row
            key={row.id}
            id={row.id}
            label={directLabel(row, meUserId)}
            unread={row.unread}
            open={row.id === openId}
            onOpen={onOpen}
          />
        ))}
      </Section>

      <Section title="Groups" empty="You are not in a group yet.">
        {groups.map((row) => (
          <Row
            key={row.id}
            id={row.id}
            label={row.title ?? 'Untitled group'}
            unread={row.unread}
            open={row.id === openId}
            onOpen={onOpen}
          />
        ))}
      </Section>

      <Section title="Department workshops" empty="No department workshop is open to you.">
        {workshops.map((row) => (
          <Row
            key={row.id}
            id={row.id}
            label={row.title ?? 'Workshop'}
            unread={row.unread}
            open={row.id === openId}
            onOpen={onOpen}
          />
        ))}
        {departments
          .filter((department) => !openedDepartments.has(department.id))
          .map((department) => (
            <li key={department.id}>
              <button
                type="button"
                className="chat-item chat-item-unopened"
                onClick={() => onOpenWorkshop(department.id)}
              >
                <span className="chat-item-name">{department.name} Workshop</span>
              </button>
            </li>
          ))}
      </Section>
    </div>
  );
}

function Section({
  title,
  empty,
  children,
}: {
  title: string;
  empty: string;
  children: React.ReactNode;
}): React.JSX.Element {
  const rows = Array.isArray(children) ? children.flat() : [children];
  const anything = rows.some((row) => row !== null && row !== undefined && row !== false);

  return (
    <section className="chat-rail-section">
      <h3 className="chat-rail-heading">{title}</h3>
      {anything ? (
        <ul className="chat-list">{children}</ul>
      ) : (
        // Said rather than left blank. An empty heading reads as something that failed to load.
        <p className="chat-muted">{empty}</p>
      )}
    </section>
  );
}

function Row({
  id,
  label,
  unread,
  open,
  onOpen,
}: {
  id: string;
  label: string;
  unread: number;
  open: boolean;
  onOpen: (conversationId: string) => void;
}): React.JSX.Element {
  return (
    <li>
      <button
        type="button"
        className={open ? 'chat-item chat-item-open' : 'chat-item'}
        onClick={() => onOpen(id)}
      >
        <span className="chat-item-name">{label}</span>
        {unread > 0 ? (
          // A badge, not a concatenated label — the locked rule for counts. Keyed by the count,
          // so it moves when the count really changes rather than on every render.
          <motion.span
            key={unread}
            initial={{ opacity: 0, scale: 0.85 }}
            animate={{ opacity: 1, scale: 1 }}
            transition={transition('small', 'emphasized')}
            style={{ display: 'inline-block' }}
          >
            <StatusBadge status={String(unread)} tone="blue" />
          </motion.span>
        ) : null}
      </button>
    </li>
  );
}

/**
 * Who a direct conversation is with.
 *
 * The other person, by name. Falling back to the title and then to a plain word rather than to a
 * user id: an id in a conversation list is not a person, and a reader cannot act on one.
 */
function directLabel(row: ChatConversationSummary, meUserId: string | null): string {
  const other = row.participants.find((person) => person.userId !== meUserId);
  return other?.displayName ?? row.title ?? 'Direct message';
}
