import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { ChatConversationView } from '../../lib/api-client';

/**
 * Workspace Chat — Prompt 40A (CR-03) §7.
 *
 * Two things this screen has to get right, and both are here:
 *
 *   * **A context preview is rendered from what the server returned, and the two shapes are
 *     different components.** Accessible shows a title and a link; refused shows the stated reason.
 *     Never a placeholder, never a greyed-out title — an empty box reads as a bug and invites
 *     somebody to go looking for what it did not show them. Two people in the same conversation
 *     seeing different previews of the same reference is correct, not an inconsistency to reconcile.
 *   * **It never claims to be live.** No typing indicator, no presence dot, no "live" badge. The
 *     server's own sentence about the transport is printed verbatim at the foot.
 */
const searchParams = { get: vi.fn(() => null as string | null) };
vi.mock('next/navigation', () => ({
  useSearchParams: () => searchParams,
  useRouter: () => ({ push: vi.fn() }),
}));

const me = vi.fn();
const logout = vi.fn();
const chatMeta = vi.fn();
const conversations = vi.fn();
const readConversation = vi.fn();
const markRead = vi.fn();
const send = vi.fn();
const search = vi.fn();
const myAccess = vi.fn();
const notificationCounts = vi.fn();
// The page reads the hierarchy to offer department workshops. Stubbed because an unstubbed
// property is not a refused call but a TypeError, which is a failure mode the real client
// cannot produce and would hide the ones it can.
const hierarchy = vi.fn();

vi.mock('../../lib/api-client', () => ({
  ApiError: class ApiError extends Error {
    // The real one carries a status. Mirrored here so a test cannot construct a refusal the
    // client could never produce.
    constructor(
      message: string,
      readonly statusCode = 500,
    ) {
      super(message);
    }
  },
  authApi: { me: (...a: unknown[]) => me(...a), logout: (...a: unknown[]) => logout(...a) },
  chatApi: {
    meta: (...a: unknown[]) => chatMeta(...a),
    conversations: (...a: unknown[]) => conversations(...a),
    read: (...a: unknown[]) => readConversation(...a),
    markRead: (...a: unknown[]) => markRead(...a),
    send: (...a: unknown[]) => send(...a),
    search: (...a: unknown[]) => search(...a),
  },
  myAccessApi: { mine: (...a: unknown[]) => myAccess(...a) },
  notificationsApi: { counts: (...a: unknown[]) => notificationCounts(...a) },
  organizationApi: { hierarchy: (...a: unknown[]) => hierarchy(...a) },
}));

vi.mock('../../lib/use-notification-bell', () => ({
  useNotificationBell: () => ({ counts: null, shellProps: {} }),
}));

const { default: WorkspaceChatPage } = await import('./page');

const CONVERSATION: ChatConversationView = {
  id: 'conversation-1',
  kind: 'Group',
  title: 'Late payments',
  participantUserIds: ['user-1', 'user-2'],
  context: [],
  messages: [
    {
      id: 'message-1',
      authorUserId: 'user-000001',
      authorName: 'Priya Nair',
      body: 'Can you look at step three?',
      deleted: false,
      mentionedUserIds: [],
      attachments: [],
      sentAt: '2026-09-01T09:00:00.000Z',
    },
  ],
};

beforeEach(() => {
  vi.clearAllMocks();
  searchParams.get.mockReturnValue(null);
  me.mockResolvedValue({
    user: { ubossUniqueId: 'UB-1' },
    activeWorkspaceId: 'tenant-1',
    workspaces: [{ tenantId: 'tenant-1', tenantName: 'Acme' }],
  });
  myAccess.mockResolvedValue({
    userId: 'user-1',
    userType: 'InternalUser',
    assignedScope: 'OwnWork',
    visibleModules: ['dashboard', 'chat', 'agents'],
    granted: { chat: ['View'] },
    note: '',
  });
  hierarchy.mockResolvedValue({ departments: [] });
  chatMeta.mockResolvedValue({
    contextStance: 'Being in a conversation does not grant access to what it refers to.',
    realtimeStance: 'Messages arrive when the screen refreshes. Nothing here is a live socket.',
    searchStance: 'Search covers conversations you are in.',
  });
  conversations.mockResolvedValue({
    conversations: [
      {
        id: 'conversation-1',
        kind: 'Group',
        title: 'Late payments',
        participantUserIds: ['user-1', 'user-2'],
        lastMessageAt: '2026-09-01T09:00:00.000Z',
        unread: 2,
      },
    ],
  });
  readConversation.mockResolvedValue(CONVERSATION);
  markRead.mockResolvedValue({ read: true });
  send.mockResolvedValue({ id: 'message-2', mentionedUserIds: [], ignoredMentions: [] });
  search.mockResolvedValue({ messages: [], stance: 'Search covers conversations you are in.' });
});

describe('Workspace Chat', () => {
  it('lists conversations with an unread count as a badge', async () => {
    render(<WorkspaceChatPage />);

    const list = await screen.findByTestId('chat-conversations');
    expect(list).toHaveTextContent('Late payments');
    // A badge rather than "Late payments (2)" — the locked rule for counts.
    expect(list).toHaveTextContent('2');
  });

  it('opens a conversation and marks it read', async () => {
    render(<WorkspaceChatPage />);

    await waitFor(() =>
      expect(readConversation).toHaveBeenCalledWith('tenant-1', 'conversation-1'),
    );
    expect(markRead).toHaveBeenCalledWith('tenant-1', 'conversation-1');
    expect(await screen.findByTestId('chat-messages')).toHaveTextContent(
      'Can you look at step three?',
    );
  });

  it('opens the conversation named in the URL rather than the newest', async () => {
    // How Discuss arrives from an Objective or an Exception.
    searchParams.get.mockReturnValue('conversation-9');

    render(<WorkspaceChatPage />);

    await waitFor(() =>
      expect(readConversation).toHaveBeenCalledWith('tenant-1', 'conversation-9'),
    );
  });

  it('renders a permitted context reference as a link with its title', async () => {
    readConversation.mockResolvedValue({
      ...CONVERSATION,
      context: [
        {
          accessible: true,
          type: 'Objective',
          id: 'objective-1',
          title: 'Reduce late payments',
          status: 'Active',
          deepLink: '/objective/form?objectiveId=objective-1',
        },
      ],
    });

    render(<WorkspaceChatPage />);

    const link = await screen.findByTestId('chat-context-accessible');
    expect(link).toHaveTextContent('Reduce late payments');
    expect(link).toHaveAttribute('href', '/objective/form?objectiveId=objective-1');
  });

  it('renders a refused reference as a stated reason, never as a placeholder', async () => {
    readConversation.mockResolvedValue({
      ...CONVERSATION,
      context: [
        {
          accessible: false,
          type: 'Objective',
          id: 'objective-1',
          reason: 'You do not have access to the objective this conversation is about.',
        },
      ],
    });

    render(<WorkspaceChatPage />);

    const refused = await screen.findByTestId('chat-context-restricted');
    expect(refused).toHaveTextContent('You do not have access to the objective');
    // Not a link, not a greyed title, and no sign of the real one.
    expect(screen.queryByTestId('chat-context-accessible')).not.toBeInTheDocument();
    expect(document.body.textContent ?? '').not.toContain('Reduce late payments');
  });

  it('keeps a deleted message in place rather than removing the row', async () => {
    readConversation.mockResolvedValue({
      ...CONVERSATION,
      messages: [
        { ...CONVERSATION.messages[0], body: null, deleted: true },
        { ...CONVERSATION.messages[0], id: 'message-2', body: 'Yes, looking now.' },
      ],
    });

    render(<WorkspaceChatPage />);

    const messages = await screen.findByTestId('chat-messages');
    // The reply beneath it still has to make sense.
    expect(messages.querySelectorAll('li')).toHaveLength(2);
    expect(messages).toHaveTextContent('Message deleted');
  });

  it('shows an attachment that has not cleared its scan as attached and not openable', async () => {
    readConversation.mockResolvedValue({
      ...CONVERSATION,
      messages: [
        {
          ...CONVERSATION.messages[0],
          attachments: [{ storedFileId: 'file-1', filename: 'terms.pdf', downloadable: false }],
        },
      ],
    });

    render(<WorkspaceChatPage />);

    const messages = await screen.findByTestId('chat-messages');
    // Hiding it would make the conversation misleading; serving it would make chat the way
    // malware moves around a company.
    expect(messages).toHaveTextContent('terms.pdf');
    expect(messages).toHaveTextContent('Checking');
  });

  it('sends a message', async () => {
    render(<WorkspaceChatPage />);
    await screen.findByTestId('chat-messages');

    await userEvent.type(screen.getByLabelText('Message'), 'On it.');
    await userEvent.click(screen.getByRole('button', { name: 'Send' }));

    await waitFor(() =>
      expect(send).toHaveBeenCalledWith('tenant-1', 'conversation-1', { body: 'On it.' }),
    );
  });

  it('will not send an empty message', async () => {
    render(<WorkspaceChatPage />);
    await screen.findByTestId('chat-messages');

    expect(screen.getByRole('button', { name: 'Send' })).toBeDisabled();
  });

  /*
   * Enter.
   *
   * Reported from the live site: somebody typed a message, pressed Enter, and watched nothing
   * happen. The composer had a Send button and no key handling at all, which is not a neutral
   * choice — every chat anybody uses sends on Enter.
   */
  it('sends on Enter', async () => {
    render(<WorkspaceChatPage />);
    await screen.findByTestId('chat-messages');

    await userEvent.type(screen.getByLabelText('Message'), 'On it.{Enter}');

    await waitFor(() =>
      expect(send).toHaveBeenCalledWith('tenant-1', 'conversation-1', { body: 'On it.' }),
    );
  });

  it('makes a new line on Shift+Enter instead of sending', async () => {
    render(<WorkspaceChatPage />);
    await screen.findByTestId('chat-messages');

    const box = screen.getByLabelText('Message');
    await userEvent.type(box, 'first{Shift>}{Enter}{/Shift}second');

    expect(send).not.toHaveBeenCalled();
    expect(box).toHaveValue('first\nsecond');
  });

  it('does not send on Enter while the mention picker is open', async () => {
    /*
     * Enter belongs to whichever thing is in front of you. With the picker open it chooses the
     * person being typed; sending there would post a half-written handle to the conversation.
     */
    hierarchy.mockResolvedValue({
      departments: [],
      list: [{ userId: 'user-2', displayName: 'Aman Singh' }],
    });
    render(<WorkspaceChatPage />);
    await screen.findByTestId('chat-messages');

    const box = screen.getByLabelText('Message');
    await userEvent.type(box, 'ping @am{Enter}');

    expect(send).not.toHaveBeenCalled();
    expect(box).toHaveValue('ping @Aman.Singh ');
  });

  /*
   * A message from somebody else, with nobody touching the screen.
   *
   * There was no refresh of any kind: the conversation was fetched on open and never again, so a
   * reply simply did not arrive until the page was reloaded. Reported from the live site, where
   * one employee sent to another and it showed up only after a refresh.
   */
  it('shows a message that arrived while the screen was open', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      render(<WorkspaceChatPage />);
      await screen.findByTestId('chat-messages');
      expect(screen.queryByText('Hi Pranav')).toBeNull();

      readConversation.mockResolvedValue({
        ...CONVERSATION,
        messages: [
          ...CONVERSATION.messages,
          {
            id: 'message-9',
            authorUserId: 'user-000002',
            authorName: 'Nikhil Rao',
            body: 'Hi Pranav',
            deleted: false,
            mentionedUserIds: [],
            attachments: [],
            sentAt: '2026-09-01T09:05:00.000Z',
          },
        ],
      });

      await vi.advanceTimersByTimeAsync(6000);

      expect(await screen.findByText('Hi Pranav')).toBeInTheDocument();
    } finally {
      vi.useRealTimers();
    }
  });

  it('searches, and prints the stance about what search covers', async () => {
    render(<WorkspaceChatPage />);
    await screen.findByTestId('chat-conversations');

    /*
     * Enter, not a button.
     *
     * The search box had a "Search" button under it on its own line — the second widest thing in
     * the rail, for a box that already promises the key. It is a server search, so it still has
     * to be asked for rather than running on every keystroke; the box is a form and Enter submits
     * it, which is what this types.
     */
    await userEvent.type(
      screen.getByPlaceholderText('Search messages, then press Enter'),
      'invoice{Enter}',
    );

    await waitFor(() => expect(search).toHaveBeenCalledWith('tenant-1', 'invoice'));
    expect(await screen.findByTestId('chat-search-results')).toHaveTextContent(
      'Search covers conversations you are in.',
    );
  });

  it('never claims to be live, and says so in the server’s own words', async () => {
    render(<WorkspaceChatPage />);

    expect(await screen.findByTestId('chat-realtime-stance')).toHaveTextContent(
      'Nothing here is a live socket.',
    );

    const text = document.body.textContent ?? '';
    for (const claim of ['is typing', 'online now', 'Live']) {
      expect(text).not.toContain(claim);
    }
  });

  it('prints the context stance verbatim', async () => {
    render(<WorkspaceChatPage />);

    expect(await screen.findByTestId('chat-context-stance')).toHaveTextContent(
      'Being in a conversation does not grant access to what it refers to.',
    );
  });

  it('shows only the modules this person actually holds in the sidebar', async () => {
    render(<WorkspaceChatPage />);
    await screen.findByTestId('chat-conversations');

    // Grants, never a role label: `objective` is absent from `visibleModules`.
    expect(screen.queryByText('Objective Optimization')).not.toBeInTheDocument();
    expect(screen.queryByText('Agent Builder')).not.toBeInTheDocument();
    expect(screen.getAllByText('Workspace Chat').length).toBeGreaterThan(0);
  });
});
