import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { OperatorAgentView, OperatorRunView } from '../lib/api-client';

/**
 * The operator screen — Prompt 40A (CR-03) §5.
 *
 * The api-client is mocked rather than the global `fetch`, because what these tests are about is
 * **which endpoints this screen is allowed to read**. A `fetch` mock would let the component reach
 * the builder's routes and still pass as long as the shape came back right; mocking the module
 * means an endpoint that is not on this list does not exist at all during the test.
 */
// `DiscussButton` renders inside the history rows and calls `useRouter`, which throws in
// jsdom without an app router mounted. Mocked rather than avoided: the button belongs on a run,
// and a test that removed it would stop covering the row it is attached to.
vi.mock('next/navigation', () => ({ useRouter: () => ({ push: vi.fn() }) }));

const mine = vi.fn();
const meta = vi.fn();
const myRuns = vi.fn();
const run = vi.fn();
const submitFeedback = vi.fn();

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
  agentOperatorApi: {
    mine: (...args: unknown[]) => mine(...args),
    meta: (...args: unknown[]) => meta(...args),
    myRuns: (...args: unknown[]) => myRuns(...args),
    run: (...args: unknown[]) => run(...args),
  },
  feedbackApi: { submit: (...args: unknown[]) => submitFeedback(...args) },
  organizationApi: { hierarchy: vi.fn(async () => ({ list: [] })) },
  chatApi: { start: vi.fn(), addContext: vi.fn(), send: vi.fn() },
}));

const { MyEngineAgents } = await import('./MyEngineAgents');

const AGENT: OperatorAgentView = {
  agentId: 'agent-1',
  agentName: 'Invoice chaser',
  linkedObjectiveName: 'Reduce late payments',
  assignedWorkTitle: 'Chase overdue invoices',
  status: 'Active',
  lastRunAt: '2026-09-01T09:00:00.000Z',
  nextRunAt: null,
  canRun: true,
  cannotRunBecause: null,
};

const RUN: OperatorRunView = {
  runId: 'run-1',
  state: 'Completed',
  trigger: 'Manual',
  startedAt: '2026-09-01T09:00:00.000Z',
  finishedAt: '2026-09-01T09:01:00.000Z',
  resultText: 'Eleven invoices chased.',
  failureReason: null,
};

beforeEach(() => {
  vi.clearAllMocks();
  mine.mockResolvedValue({ agents: [AGENT] });
  meta.mockResolvedValue({ runPreconditions: [], operatorStance: 'A share grants nothing else.' });
  myRuns.mockResolvedValue({ runs: [RUN] });
  run.mockResolvedValue({ id: 'run-2', state: 'Queued' });
  submitFeedback.mockResolvedValue({ id: 'feedback-1' });
});

describe('MyEngineAgents', () => {
  it('shows the agent, its objective and its assigned work', async () => {
    render(<MyEngineAgents tenantId="tenant-1" />);

    expect(await screen.findByTestId('operator-agent-name')).toHaveTextContent('Invoice chaser');
    expect(screen.getByTestId('operator-objective')).toHaveTextContent('Reduce late payments');
    expect(screen.getByText('Chase overdue invoices')).toBeInTheDocument();
  });

  it('never renders a prompt, a model name, a key or raw JSON', async () => {
    // The guarantee is structural — `OperatorRunView` has no field for any of it — so this test
    // pins the *screen's* half: it reads only the operator endpoints.
    render(<MyEngineAgents tenantId="tenant-1" />);
    await screen.findByTestId('operator-agent-name');

    const text = document.body.textContent ?? '';
    for (const forbidden of ['prompt', 'systemInstruction', 'apiKey', 'model', '{"']) {
      expect(text.toLowerCase()).not.toContain(forbidden.toLowerCase());
    }
  });

  it('disables Run and prints the server sentence when a precondition is unmet', async () => {
    mine.mockResolvedValue({
      agents: [
        {
          ...AGENT,
          canRun: false,
          cannotRunBecause: 'A connection this agent needs is missing.',
        },
      ],
    });

    render(<MyEngineAgents tenantId="tenant-1" />);

    expect(await screen.findByTestId('operator-run')).toBeDisabled();
    // Verbatim: rewording it here would risk saying more than the ordered list deliberately says.
    expect(screen.getByTestId('operator-cannot-run')).toHaveTextContent(
      'A connection this agent needs is missing.',
    );
  });

  it('still lists an agent that cannot run right now', async () => {
    mine.mockResolvedValue({
      agents: [{ ...AGENT, canRun: false, cannotRunBecause: 'Budget is exhausted.' }],
    });

    render(<MyEngineAgents tenantId="tenant-1" />);

    // Vanishing would tell the operator their work had been taken away.
    expect(await screen.findByTestId('operator-agent-name')).toHaveTextContent('Invoice chaser');
  });

  it('runs the agent through the run route and says the run started', async () => {
    render(<MyEngineAgents tenantId="tenant-1" />);
    await screen.findByTestId('operator-run');

    await userEvent.click(screen.getByTestId('operator-run'));

    await waitFor(() => expect(run).toHaveBeenCalledWith('tenant-1', 'agent-1'));
    // "Started", not "finished": a run is durable before it has a result.
    expect(await screen.findByText(/run has started/i)).toBeInTheDocument();
  });

  it('shows the latest result from the same list that backs History', async () => {
    render(<MyEngineAgents tenantId="tenant-1" />);
    await screen.findByTestId('operator-view-result');

    await userEvent.click(screen.getByTestId('operator-view-result'));

    expect(await screen.findByTestId('operator-result-panel')).toHaveTextContent(
      'Eleven invoices chased.',
    );
    expect(myRuns).toHaveBeenCalledWith('tenant-1', 'agent-1');
  });

  it('shows a failure reason rather than a result when the run failed', async () => {
    myRuns.mockResolvedValue({
      runs: [
        {
          ...RUN,
          state: 'Failed',
          resultText: null,
          failureReason: 'The source spreadsheet was empty.',
        },
      ],
    });

    render(<MyEngineAgents tenantId="tenant-1" />);
    await userEvent.click(await screen.findByTestId('operator-view-result'));

    expect(await screen.findByTestId('operator-result-panel')).toHaveTextContent(
      'The source spreadsheet was empty.',
    );
  });

  it('treats a run still in flight as no result yet', async () => {
    // `Running` is not terminal, and the terminal set is asked of the run state machine rather
    // than listed here — so a state added later cannot silently become "finished".
    myRuns.mockResolvedValue({ runs: [{ ...RUN, state: 'Running', finishedAt: null }] });

    render(<MyEngineAgents tenantId="tenant-1" />);
    await userEvent.click(await screen.findByTestId('operator-view-result'));

    expect(await screen.findByTestId('operator-result-panel')).toHaveTextContent(
      'has not finished a run yet',
    );
  });

  it('lists every run under History', async () => {
    myRuns.mockResolvedValue({
      runs: [RUN, { ...RUN, runId: 'run-0', trigger: 'Scheduled' }],
    });

    render(<MyEngineAgents tenantId="tenant-1" />);
    await userEvent.click(await screen.findByTestId('operator-history'));

    const panel = await screen.findByTestId('operator-history-panel');
    expect(panel.querySelectorAll('li')).toHaveLength(2);
  });

  it('refuses to send an issue until the correction is long enough to act on', async () => {
    render(<MyEngineAgents tenantId="tenant-1" />);
    await userEvent.click(await screen.findByTestId('operator-report-issue'));

    const send = await screen.findByTestId('operator-issue-send');
    expect(send).toBeDisabled();

    await userEvent.type(
      screen.getByTestId('operator-issue-correction'),
      'It chased the wrong customer entirely.',
    );
    expect(send).toBeEnabled();
  });

  it('records an issue against the most recent run', async () => {
    render(<MyEngineAgents tenantId="tenant-1" />);
    await userEvent.click(await screen.findByTestId('operator-report-issue'));
    await userEvent.type(
      await screen.findByTestId('operator-issue-correction'),
      'It chased the wrong customer entirely.',
    );
    await userEvent.click(screen.getByTestId('operator-issue-send'));

    await waitFor(() =>
      expect(submitFeedback).toHaveBeenCalledWith('tenant-1', 'run-1', {
        rating: 'Incorrect',
        correction: 'It chased the wrong customer entirely.',
      }),
    );
  });

  it('never offers "Correct" as a way to report an issue', async () => {
    render(<MyEngineAgents tenantId="tenant-1" />);
    await userEvent.click(await screen.findByTestId('operator-report-issue'));

    const options = Array.from(
      (await screen.findByTestId('operator-issue-rating')).querySelectorAll('option'),
    ).map((option) => option.textContent);

    expect(options).not.toContain('Correct');
  });

  it('explains an empty list when it is the whole screen, and stays silent when it is not', async () => {
    mine.mockResolvedValue({ agents: [] });

    const { unmount } = render(<MyEngineAgents tenantId="tenant-1" />);
    expect(await screen.findByText(/No agents have been shared with you yet/)).toBeInTheDocument();
    unmount();

    render(<MyEngineAgents tenantId="tenant-1" showEmptyState={false} />);
    await waitFor(() => expect(mine).toHaveBeenCalledTimes(2));
    expect(screen.queryByTestId('my-engine-agents')).not.toBeInTheDocument();
  });
});
