'use client';

import { motion } from 'motion/react';

import type { ChatConversationSummary } from '../lib/api-client';
import { initials, StatusBadge, transition } from '@uboss/ui';
import { avatarTint } from '../lib/avatar-tint';
import { formatElapsedHours } from '../lib/when';

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
  active,
  onOpen,
  onOpenWorkshop,
}: {
  conversations: ChatConversationSummary[];
  /** Every department this person may open a workshop for, named. */
  departments: { id: string; name: string }[];
  openId: string | null;
  meUserId: string | null;
  /**
   * Colleagues the server has seen in the last few minutes.
   *
   * Not presence and not a socket — see the note where it is fetched. The rail uses it only to
   * mark a row as having somebody at the other end of it right now.
   */
  active?: ReadonlySet<string> | undefined;
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
            subtitle={subtitleFor(row)}
            unread={row.unread}
            open={row.id === openId}
            activeHere={activeIn(row, meUserId, active)}
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
            subtitle={subtitleFor(row)}
            unread={row.unread}
            open={row.id === openId}
            activeHere={activeIn(row, meUserId, active)}
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
            subtitle={subtitleFor(row)}
            unread={row.unread}
            open={row.id === openId}
            activeHere={activeIn(row, meUserId, active)}
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
                {/* Same shape as a room that exists, because it is the same room — it just has
                    not been opened yet. A row half the height of the ones around it would read as
                    a different kind of thing. */}
                <span
                  className="uboss-avatar uboss-avatar--sm"
                  style={{ background: avatarTint(department.name) }}
                  aria-hidden="true"
                >
                  {initials(department.name)}
                </span>
                <span className="chat-item-text">
                  <span className="chat-item-name">{department.name} Workshop</span>
                  <span className="chat-item-sub">Not opened yet</span>
                </span>
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

/**
 * One conversation in the rail: a face, a name, and when it last moved.
 *
 * It was a single line of text per row, so six conversations were six identical grey lines and
 * the only way to find one was to read all of them. The circle is what makes the list scannable —
 * the same colour for the same person everywhere in the product — and the second line answers the
 * question somebody actually opens this list with, which is whether anything has happened.
 */
/**
 * How many people in this conversation, other than the reader, were seen in the last few
 * minutes.
 *
 * Excluding the reader on purpose: a row that says "1 active" because you are looking at it is
 * noise on every row you own. What is worth marking is somebody at the *other* end.
 */
function activeIn(
  row: ChatConversationSummary,
  meUserId: string | null,
  active: ReadonlySet<string> | undefined,
): number {
  if (active === undefined) return 0;
  return (row.participantUserIds ?? []).filter(
    (userId) => userId !== meUserId && active.has(userId),
  ).length;
}

function Row({
  id,
  label,
  subtitle,
  unread,
  open,
  activeHere,
  onOpen,
}: {
  id: string;
  label: string;
  subtitle: string;
  unread: number;
  open: boolean;
  /** Somebody other than the reader has been working in the last few minutes. */
  activeHere?: number | undefined;
  onOpen: (conversationId: string) => void;
}): React.JSX.Element {
  return (
    <li>
      <button
        type="button"
        className={open ? 'chat-item chat-item-open' : 'chat-item'}
        onClick={() => onOpen(id)}
      >
        {/*
          The circle, with a mark when somebody at the other end has been working lately.

          Deliberately not a green "online" dot. Nothing here knows who is online; what the
          server knows is when each person's session was last seen. The mark is described in
          words for anybody who cannot see it, and those words say exactly that.
        */}
        <span className="chat-item-avatar">
          <span
            className="uboss-avatar uboss-avatar--sm"
            style={{ background: avatarTint(label) }}
            aria-hidden="true"
          >
            {initials(label)}
          </span>
          {activeHere !== undefined && activeHere > 0 ? (
            <span
              className="chat-item-active"
              title={`${activeHere} ${activeHere === 1 ? 'person' : 'people'} here seen working in the last few minutes`}
            >
              <span className="uboss-sr-only">
                {activeHere} seen working in the last few minutes
              </span>
            </span>
          ) : null}
        </span>

        <span className="chat-item-text">
          <span className="chat-item-name">{label}</span>
          <span className="chat-item-sub">{subtitle}</span>
        </span>

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
 * The second line: when it last moved, and for a room, how many people are in it.
 *
 * "No messages yet" rather than an empty line or a dash. A department workshop exists because the
 * department does, so an empty one is the normal case on a first visit and saying so is the
 * difference between a quiet room and a row that failed to load.
 */
function subtitleFor(row: ChatConversationSummary): string {
  const elapsed =
    row.lastMessageAt === null || row.lastMessageAt === undefined
      ? null
      : formatElapsedHours((Date.now() - new Date(row.lastMessageAt).getTime()) / 3_600_000);

  const moved = elapsed === null ? 'No messages yet' : `${elapsed} ago`;
  if (row.kind === 'Direct') return moved;

  /*
   * Counted from whichever list is there, and left out when neither is.
   *
   * `participants` is declared as required and is not always sent: reading `.length` from it
   * threw, and because the rail renders all three sections in one pass, one group without it took
   * down every conversation on the screen rather than one row. Caught by the page's own tests.
   *
   * A room with no count still gets a second line — when it last moved is the useful half anyway.
   */
  const people = row.participants?.length ?? row.participantUserIds?.length ?? 0;
  if (people === 0) return moved;
  return `${people} ${people === 1 ? 'person' : 'people'} · ${moved}`;
}

/**
 * Who a direct conversation is with.
 *
 * The other person, by name. Falling back to the title and then to a plain word rather than to a
 * user id: an id in a conversation list is not a person, and a reader cannot act on one.
 */
function directLabel(row: ChatConversationSummary, meUserId: string | null): string {
  // Optional for the same reason as in `subtitleFor`: the field is declared required and is not
  // always sent, and one row without it must not take the whole rail down.
  const other = row.participants?.find((person) => person.userId !== meUserId);
  return other?.displayName ?? row.title ?? 'Direct message';
}
