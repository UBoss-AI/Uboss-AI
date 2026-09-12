import { fireEvent, render, screen, within } from '@testing-library/react';
import { useState } from 'react';
import { describe, expect, it } from 'vitest';

import {
  FORM2_WORKFLOW_COLUMNS,
  WORKFLOW_COLUMN_GROUPS,
  type Form2WorkflowStep,
} from '@uboss/types';

import { blankWorkflowStep, WorkflowGrid } from './WorkflowGrid';

/** A harness that owns the rows, the way the form page does. */
function Harness({ initial }: { initial?: Form2WorkflowStep[] }) {
  const [steps, setSteps] = useState<Form2WorkflowStep[]>(
    initial ?? [blankWorkflowStep(1), blankWorkflowStep(2)],
  );
  return <WorkflowGrid steps={steps} onChange={setSteps} />;
}

describe('WorkflowGrid', () => {
  it('renders every source column header, in the source order', () => {
    // The locked rule made testable: the header row is derived from the shared array, so a
    // dropped column fails here rather than shipping.
    render(<Harness />);

    const headers = screen
      .getAllByRole('columnheader')
      .map((cell) => cell.textContent?.trim() ?? '');

    for (const column of FORM2_WORKFLOW_COLUMNS) {
      expect(headers).toContain(column.label);
    }
  });

  it('renders the six grouped banners', () => {
    render(<Harness />);
    const headers = screen
      .getAllByRole('columnheader')
      .map((cell) => cell.textContent?.trim() ?? '');
    for (const group of WORKFLOW_COLUMN_GROUPS) {
      expect(headers).toContain(group);
    }
  });

  it('renders one row per step, numbered from one', () => {
    render(
      <Harness initial={[blankWorkflowStep(1), blankWorkflowStep(2), blankWorkflowStep(3)]} />,
    );
    const body = screen.getAllByRole('row').slice(2); // two header rows
    expect(body).toHaveLength(3);
    expect(within(body[0] as HTMLElement).getByText('1')).toBeTruthy();
    expect(within(body[2] as HTMLElement).getByText('3')).toBeTruthy();
  });

  it('edits a cell through the shared field name', () => {
    render(<Harness initial={[blankWorkflowStep(1)]} />);

    const work = screen.getByLabelText('Step 1 Exact Work');
    fireEvent.change(work, { target: { value: 'Collect DHF' } });
    expect((work as HTMLTextAreaElement).value).toBe('Collect DHF');
  });

  it('offers Human plus the three machine kinds on the engine column', () => {
    render(<Harness initial={[blankWorkflowStep(1)]} />);
    const select = screen.getByLabelText('Step 1 Engine / Sub-Engine / Executor');
    const options = within(select as HTMLElement)
      .getAllByRole('option')
      .map((option) => option.textContent);
    expect(options).toEqual(['Human', 'Engine', 'Sub-Engine', 'Executor']);
  });

  it('offers the four approval kinds', () => {
    render(<Harness initial={[blankWorkflowStep(1)]} />);
    const select = screen.getByLabelText('Step 1 Approval');
    const options = within(select as HTMLElement)
      .getAllByRole('option')
      .map((option) => option.textContent);
    expect(options).toEqual(['Not required', 'Manager', 'Head', 'Four-eyes']);
  });

  it('inserts a row below and renumbers', () => {
    render(<Harness initial={[blankWorkflowStep(1), blankWorkflowStep(2)]} />);

    fireEvent.click(screen.getAllByTitle('Insert below')[0] as HTMLElement);
    const body = screen.getAllByRole('row').slice(2);
    expect(body).toHaveLength(3);
    // Positions stay 1..n with no gaps, which is what the API refuses otherwise.
    expect(within(body[2] as HTMLElement).getByText('3')).toBeTruthy();
  });

  it('duplicates a row, carrying its content', () => {
    render(<Harness initial={[{ ...blankWorkflowStep(1), whatExactWork: 'Collect evidence' }]} />);

    fireEvent.click(screen.getByTitle('Duplicate'));
    expect((screen.getByLabelText('Step 2 Exact Work') as HTMLTextAreaElement).value).toBe(
      'Collect evidence',
    );
  });

  it('deletes a row and renumbers the rest', () => {
    render(
      <Harness
        initial={[
          { ...blankWorkflowStep(1), whatExactWork: 'First' },
          { ...blankWorkflowStep(2), whatExactWork: 'Second' },
        ]}
      />,
    );

    fireEvent.click(screen.getAllByTitle('Delete')[0] as HTMLElement);
    expect((screen.getByLabelText('Step 1 Exact Work') as HTMLTextAreaElement).value).toBe(
      'Second',
    );
  });

  it('will not delete the last remaining row', () => {
    // Deleting it would leave a grid with nowhere to start typing. Disabled rather than silently
    // refused, so the reason is visible.
    render(<Harness initial={[blankWorkflowStep(1)]} />);
    expect((screen.getByTitle('Delete') as HTMLButtonElement).disabled).toBe(true);
  });

  it('reorders rows and keeps the numbering contiguous', () => {
    render(
      <Harness
        initial={[
          { ...blankWorkflowStep(1), whatExactWork: 'First' },
          { ...blankWorkflowStep(2), whatExactWork: 'Second' },
        ]}
      />,
    );

    fireEvent.click(screen.getAllByTitle('Move up')[1] as HTMLElement);
    expect((screen.getByLabelText('Step 1 Exact Work') as HTMLTextAreaElement).value).toBe(
      'Second',
    );
    expect((screen.getByLabelText('Step 2 Exact Work') as HTMLTextAreaElement).value).toBe('First');
  });

  it('disables Move up on the first row and Move down on the last', () => {
    render(<Harness initial={[blankWorkflowStep(1), blankWorkflowStep(2)]} />);
    expect((screen.getAllByTitle('Move up')[0] as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getAllByTitle('Move down')[1] as HTMLButtonElement).disabled).toBe(true);
  });

  it('does not cap the number of rows', () => {
    const many = Array.from({ length: 40 }, (_unused, index) => blankWorkflowStep(index + 1));
    render(<Harness initial={many} />);
    expect(screen.getAllByRole('row').slice(2)).toHaveLength(40);
  });

  it('locks every control when read-only', () => {
    // A live version's grid: the database refuses a change anyway, and the screen should not
    // offer one.
    render(<WorkflowGrid steps={[blankWorkflowStep(1)]} onChange={() => undefined} readOnly />);
    expect((screen.getByLabelText('Step 1 Exact Work') as HTMLTextAreaElement).readOnly).toBe(true);
    expect((screen.getByTitle('Insert below') as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByTitle('Duplicate') as HTMLButtonElement).disabled).toBe(true);
  });
});
