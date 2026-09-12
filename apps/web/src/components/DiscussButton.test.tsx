import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Discuss — the entry point from a piece of work into Workspace Chat (Prompt 40A / CR-03 §6).
 *
 * The property worth protecting is that a conversation carries a **reference**, not a copy. The
 * title of an Objective is resolved per viewer when somebody opens the conversation; copying it in
 * at creation time would leak it permanently to everyone in the conversation, including people who
 * may not see that Objective. So these tests assert on what is *sent*: a type and an id.
 */
const push = vi.fn();
vi.mock('next/navigation', () => ({ useRouter: () => ({ push }) }));

const hierarchy = vi.fn();
const start = vi.fn();
const addContext = vi.fn();
const send = vi.fn();

vi.mock('../lib/api-client', () => ({
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
  organizationApi: { hierarchy: (...args: unknown[]) => hierarchy(...args) },
  // The picker shows a face per colleague, read in one request (CR-03 §3, "selectors").
  photosApi: { viewMany: vi.fn(async () => ({ photos: [] })) },
  chatApi: {
    start: (...args: unknown[]) => start(...args),
    addContext: (...args: unknown[]) => addContext(...args),
    send: (...args: unknown[]) => send(...args),
  },
}));

const { DiscussButton } = await import('./DiscussButton');

beforeEach(() => {
  vi.clearAllMocks();
  hierarchy.mockResolvedValue({
    list: [
      { userId: 'user-1', displayName: 'Anita Prasad', employmentState: 'Active' },
      { userId: 'user-2', displayName: 'Ravi Menon', employmentState: 'Active' },
      { userId: 'user-3', displayName: 'Someone Gone', employmentState: 'Offboarded' },
    ],
  });
  start.mockResolvedValue({ id: 'conversation-1', created: true });
  addContext.mockResolvedValue({ added: true });
  send.mockResolvedValue({ id: 'message-1', mentionedUserIds: [], ignoredMentions: [] });
});

describe('DiscussButton', () => {
  it('renders nothing without a workspace', () => {
    render(<DiscussButton tenantId={null} contextType="Objective" resourceId="objective-1" />);
    expect(screen.queryByTestId('discuss-button')).not.toBeInTheDocument();
  });

  it('names the kind of work in the dialog', async () => {
    render(
      <DiscussButton
        tenantId="tenant-1"
        contextType="ExecutorException"
        resourceId="exception-1"
      />,
    );

    await userEvent.click(screen.getByTestId('discuss-button'));

    expect(await screen.findByText('Discuss this exception')).toBeInTheDocument();
  });

  it('offers only people who are currently employed', async () => {
    render(<DiscussButton tenantId="tenant-1" contextType="Objective" resourceId="objective-1" />);
    await userEvent.click(screen.getByTestId('discuss-button'));

    expect(await screen.findByText('Anita Prasad')).toBeInTheDocument();
    expect(screen.getByText('Ravi Menon')).toBeInTheDocument();
    expect(screen.queryByText('Someone Gone')).not.toBeInTheDocument();
  });

  it('cannot start a conversation with nobody in it', async () => {
    render(<DiscussButton tenantId="tenant-1" contextType="Objective" resourceId="objective-1" />);
    await userEvent.click(screen.getByTestId('discuss-button'));

    expect(await screen.findByTestId('discuss-start')).toBeDisabled();
  });

  it('starts a Direct conversation for one colleague', async () => {
    render(<DiscussButton tenantId="tenant-1" contextType="Objective" resourceId="objective-1" />);
    await userEvent.click(screen.getByTestId('discuss-button'));
    await userEvent.click(await screen.findByText('Anita Prasad'));
    await userEvent.click(screen.getByTestId('discuss-start'));

    await waitFor(() =>
      expect(start).toHaveBeenCalledWith('tenant-1', {
        kind: 'Direct',
        participantUserIds: ['user-1'],
      }),
    );
  });

  it('starts a Group conversation for several, with a title', async () => {
    render(<DiscussButton tenantId="tenant-1" contextType="Objective" resourceId="objective-1" />);
    await userEvent.click(screen.getByTestId('discuss-button'));
    await userEvent.click(await screen.findByText('Anita Prasad'));
    await userEvent.click(screen.getByText('Ravi Menon'));
    await userEvent.click(screen.getByTestId('discuss-start'));

    await waitFor(() =>
      expect(start).toHaveBeenCalledWith('tenant-1', {
        kind: 'Group',
        participantUserIds: ['user-1', 'user-2'],
        title: 'Objective discussion',
      }),
    );
  });

  it('attaches a reference and never a copy of the work', async () => {
    render(<DiscussButton tenantId="tenant-1" contextType="AgentRun" resourceId="run-7" />);
    await userEvent.click(screen.getByTestId('discuss-button'));
    await userEvent.click(await screen.findByText('Anita Prasad'));
    await userEvent.click(screen.getByTestId('discuss-start'));

    // A type and an id. No title, no status, no summary — those are resolved per viewer.
    await waitFor(() =>
      expect(addContext).toHaveBeenCalledWith('tenant-1', 'conversation-1', {
        contextType: 'AgentRun',
        resourceId: 'run-7',
      }),
    );
  });

  it('sends a first message when one was written', async () => {
    render(<DiscussButton tenantId="tenant-1" contextType="HumanTask" resourceId="task-1" />);
    await userEvent.click(screen.getByTestId('discuss-button'));
    await userEvent.click(await screen.findByText('Anita Prasad'));
    await userEvent.type(screen.getByTestId('discuss-first-message'), 'Can you look at this?');
    await userEvent.click(screen.getByTestId('discuss-start'));

    await waitFor(() =>
      expect(send).toHaveBeenCalledWith('tenant-1', 'conversation-1', {
        body: 'Can you look at this?',
      }),
    );
  });

  it('sends nothing when the first message was left empty', async () => {
    render(<DiscussButton tenantId="tenant-1" contextType="HumanTask" resourceId="task-1" />);
    await userEvent.click(screen.getByTestId('discuss-button'));
    await userEvent.click(await screen.findByText('Anita Prasad'));
    await userEvent.click(screen.getByTestId('discuss-start'));

    await waitFor(() => expect(addContext).toHaveBeenCalled());
    expect(send).not.toHaveBeenCalled();
  });

  it('navigates to the one screen that owns chat, with the conversation open', async () => {
    render(<DiscussButton tenantId="tenant-1" contextType="Objective" resourceId="objective-1" />);
    await userEvent.click(screen.getByTestId('discuss-button'));
    await userEvent.click(await screen.findByText('Anita Prasad'));
    await userEvent.click(screen.getByTestId('discuss-start'));

    // Continuing it in a popover here would be a second chat UI with its own unread state.
    await waitFor(() => expect(push).toHaveBeenCalledWith('/chat?conversation=conversation-1'));
  });

  it("shows the server's refusal and stays open so the choice is not lost", async () => {
    const { ApiError } = await import('../lib/api-client');
    start.mockRejectedValue(new ApiError('You may not message that person.', 403));

    render(<DiscussButton tenantId="tenant-1" contextType="Objective" resourceId="objective-1" />);
    await userEvent.click(screen.getByTestId('discuss-button'));
    await userEvent.click(await screen.findByText('Anita Prasad'));
    await userEvent.click(screen.getByTestId('discuss-start'));

    expect(await screen.findByText('You may not message that person.')).toBeInTheDocument();
    expect(screen.getByTestId('discuss-start')).toBeInTheDocument();
    expect(push).not.toHaveBeenCalled();
  });
});
