import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { ImportOutcomeView } from '../lib/api-client';

/**
 * Download the form, fill it in offline, upload it back — Prompt 40A (CR-03) §4 and §5.
 *
 * Three properties are load-bearing and each has a test here:
 *
 *   * **Download needs no builder access.** The person who knows how the work is done is often
 *     exactly the person who cannot open Agent Builder, so a disabled Upload must leave Download
 *     working — and must say why it is disabled rather than leaving a grey button.
 *   * **An upload never saves silently.** It produces a review: what matched, how many steps, and
 *     every problem by kind.
 *   * **An import cannot put an agent into production.** The review offers Cancel and Review Job
 *     Method. There is no Test and no Activate on this panel at all, and a spreadsheet must never
 *     be able to reach them.
 */
const meta = vi.fn();
const downloadWorkbook = vi.fn();
const importWorkbook = vi.fn();

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
  jobMethodApi: {
    meta: (...args: unknown[]) => meta(...args),
    downloadWorkbook: (...args: unknown[]) => downloadWorkbook(...args),
    importWorkbook: (...args: unknown[]) => importWorkbook(...args),
  },
}));

const { JobMethodImportExport } = await import('./JobMethodImportExport');

const PROPS = {
  tenantId: 'tenant-1',
  assignmentId: 'assignment-1',
  assignmentTitle: 'Chase overdue invoices',
  objectiveName: 'Reduce late payments',
  assignedToLabel: 'Anita Prasad',
};

const ACCEPTED: ImportOutcomeView = {
  accepted: true,
  stage: 'Saved',
  problems: [],
  rows: [{ step: 1 }, { step: 2 }, { step: 3 }],
  refusedBecause: null,
  agentSuggestion: null,
};

/** A completed form, as far as the browser is concerned. */
const workbook = () =>
  new File(['binary'], 'job-method.xlsx', {
    type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  });

beforeEach(() => {
  vi.clearAllMocks();
  meta.mockResolvedValue({
    automationStance: 'An import saves a draft. It never tests and never activates.',
  });
  downloadWorkbook.mockResolvedValue(undefined);
  importWorkbook.mockResolvedValue(ACCEPTED);
});

describe('JobMethodImportExport', () => {
  it('offers both controls the amendment asks for', async () => {
    render(<JobMethodImportExport {...PROPS} canImport />);

    expect(
      await screen.findByRole('button', { name: /Download Job Method Form/ }),
    ).toBeInTheDocument();
    expect(screen.getByTestId('upload-job-method')).toBeInTheDocument();
  });

  it('downloads a real file rather than showing JSON', async () => {
    render(<JobMethodImportExport {...PROPS} canImport />);

    await userEvent.click(await screen.findByRole('button', { name: /Download Job Method Form/ }));

    // `downloadWorkbook` fetches the `.xlsx` route and saves a blob; nothing on this screen ever
    // renders the Job Method as JSON.
    await waitFor(() => expect(downloadWorkbook).toHaveBeenCalledWith('tenant-1', 'assignment-1'));
    expect(await screen.findByText(/form has been downloaded/i)).toBeInTheDocument();
  });

  it('leaves Download working for somebody who cannot import, and says why Upload is off', async () => {
    render(<JobMethodImportExport {...PROPS} canImport={false} />);

    expect(await screen.findByRole('button', { name: /Download Job Method Form/ })).toBeEnabled();
    expect(screen.getByTestId('upload-job-method')).toBeDisabled();
    expect(screen.getByTestId('jm-cannot-import')).toHaveTextContent('needs Agent Builder access');
  });

  it('shows the review after an upload, naming the objective, the work and the person', async () => {
    render(<JobMethodImportExport {...PROPS} canImport />);
    await screen.findByTestId('upload-job-method');

    await userEvent.upload(
      screen.getByLabelText('Choose a completed Job Method form'),
      workbook(),
    );

    const review = await screen.findByTestId('jm-review');
    expect(screen.getByTestId('jm-objective')).toHaveTextContent('Reduce late payments');
    expect(review).toHaveTextContent('Chase overdue invoices');
    expect(review).toHaveTextContent('Anita Prasad');
    expect(screen.getByTestId('jm-step-count')).toHaveTextContent('3');
  });

  it('sends the file as base64 under its own name', async () => {
    render(<JobMethodImportExport {...PROPS} canImport />);
    await screen.findByTestId('upload-job-method');

    await userEvent.upload(
      screen.getByLabelText('Choose a completed Job Method form'),
      workbook(),
    );

    await waitFor(() => expect(importWorkbook).toHaveBeenCalledTimes(1));
    expect(importWorkbook.mock.calls[0]?.[2]).toMatchObject({ filename: 'job-method.xlsx' });
  });

  it('never offers Test or Activate from an import', async () => {
    render(<JobMethodImportExport {...PROPS} canImport />);
    await screen.findByTestId('upload-job-method');
    await userEvent.upload(
      screen.getByLabelText('Choose a completed Job Method form'),
      workbook(),
    );
    await screen.findByTestId('jm-review');

    // The rule is structural: a spreadsheet must not be able to put an agent into production.
    expect(screen.queryByRole('button', { name: /test/i })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /activate/i })).not.toBeInTheDocument();
  });

  it('offers Cancel Import and Review Job Method, and nothing else that writes', async () => {
    render(<JobMethodImportExport {...PROPS} canImport />);
    await screen.findByTestId('upload-job-method');
    await userEvent.upload(
      screen.getByLabelText('Choose a completed Job Method form'),
      workbook(),
    );
    await screen.findByTestId('jm-review');

    expect(screen.getByTestId('jm-cancel')).toBeInTheDocument();
    expect(screen.getByTestId('jm-review-method')).toBeInTheDocument();
  });

  it('says plainly that nothing was tested and nothing was activated', async () => {
    render(<JobMethodImportExport {...PROPS} canImport />);
    await screen.findByTestId('upload-job-method');
    await userEvent.upload(
      screen.getByLabelText('Choose a completed Job Method form'),
      workbook(),
    );

    expect(await screen.findByText(/Nothing has been tested and nothing has been activated/))
      .toBeInTheDocument();
    expect(screen.getByTestId('jm-automation-stance')).toHaveTextContent(
      'An import saves a draft. It never tests and never activates.',
    );
  });

  it('groups problems by kind and shows every one', async () => {
    importWorkbook.mockResolvedValue({
      ...ACCEPTED,
      accepted: false,
      refusedBecause: 'Three rows could not be read.',
      problems: [
        { kind: 'Missing', row: 2, detail: 'No description of what happens.' },
        { kind: 'Invalid', row: 3, detail: 'The approval column says "maybe".' },
        { kind: 'Ambiguous', row: 4, detail: 'Two systems named in one cell.' },
        { kind: 'Unmapped', row: null, detail: 'A column called "Notes" is not part of the form.' },
      ],
    });

    render(<JobMethodImportExport {...PROPS} canImport />);
    await screen.findByTestId('upload-job-method');
    await userEvent.upload(
      screen.getByLabelText('Choose a completed Job Method form'),
      workbook(),
    );

    await screen.findByTestId('jm-review');
    for (const kind of ['Missing', 'Invalid', 'Ambiguous', 'Unmapped']) {
      expect(screen.getByTestId(`jm-problems-${kind}`)).toBeInTheDocument();
    }
    // Queried by role rather than by a test id: Banner renders role="alert" for a danger tone
    // and forwards nothing else, so a data-testid on it would be silently dropped.
    expect(screen.getByRole('alert')).toHaveTextContent('Three rows could not be read.');
  });

  it('offers no way forward from a refused import', async () => {
    importWorkbook.mockResolvedValue({
      ...ACCEPTED,
      accepted: false,
      refusedBecause: 'Nothing was saved.',
    });

    render(<JobMethodImportExport {...PROPS} canImport />);
    await screen.findByTestId('upload-job-method');
    await userEvent.upload(
      screen.getByLabelText('Choose a completed Job Method form'),
      workbook(),
    );

    await screen.findByTestId('jm-review');
    expect(screen.getByTestId('jm-cancel')).toBeInTheDocument();
    expect(screen.queryByTestId('jm-review-method')).not.toBeInTheDocument();
  });

  it('shows the agent boundary suggestion when the server has one', async () => {
    importWorkbook.mockResolvedValue({
      ...ACCEPTED,
      agentSuggestion: {
        groups: [
          { key: 'a', steps: [1, 2], because: 'Both read the same mailbox.' },
          { key: 'b', steps: [3], because: 'This one needs a person to approve it.' },
        ],
      },
    });

    render(<JobMethodImportExport {...PROPS} canImport />);
    await screen.findByTestId('upload-job-method');
    await userEvent.upload(
      screen.getByLabelText('Choose a completed Job Method form'),
      workbook(),
    );

    const suggestion = await screen.findByTestId('jm-suggestion');
    expect(suggestion).toHaveTextContent('2 Engine Agents');
    expect(suggestion).toHaveTextContent('Both read the same mailbox.');
  });

  it('discards the review on Cancel Import without telling anybody it saved', async () => {
    const onImported = vi.fn();
    render(<JobMethodImportExport {...PROPS} canImport onImported={onImported} />);
    await screen.findByTestId('upload-job-method');
    await userEvent.upload(
      screen.getByLabelText('Choose a completed Job Method form'),
      workbook(),
    );
    await screen.findByTestId('jm-review');

    await userEvent.click(screen.getByTestId('jm-cancel'));

    expect(screen.queryByTestId('jm-review')).not.toBeInTheDocument();
    expect(onImported).not.toHaveBeenCalled();
  });

  it("shows the server's refusal when the file itself is rejected", async () => {
    const { ApiError } = await import('../lib/api-client');
    importWorkbook.mockRejectedValue(new ApiError('That is not a Job Method form.', 400));

    render(<JobMethodImportExport {...PROPS} canImport />);
    await screen.findByTestId('upload-job-method');
    await userEvent.upload(
      screen.getByLabelText('Choose a completed Job Method form'),
      workbook(),
    );

    expect(await screen.findByText('That is not a Job Method form.')).toBeInTheDocument();
    expect(screen.queryByTestId('jm-review')).not.toBeInTheDocument();
  });
});
