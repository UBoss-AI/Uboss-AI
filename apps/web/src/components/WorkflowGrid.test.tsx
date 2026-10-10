import { fireEvent, render, screen, within } from '@testing-library/react';
import { useState } from 'react';
import { describe, expect, it } from 'vitest';

import {
  FORM2_WORKFLOW_COLUMNS,
  WORKFLOW_COLUMN_GROUPS,
  type Form2WorkflowStep,
} from '@uboss/types';

import { blankWorkflowStep, WorkflowGrid, toEditableStep } from './WorkflowGrid';

/** A harness that owns the rows, the way the form page does. */
function Harness({ initial }: { initial?: Form2WorkflowStep[] }) {
  const [steps, setSteps] = useState<Form2WorkflowStep[]>(
    initial ?? [blankWorkflowStep(1), blankWorkflowStep(2)],
  );
  return <WorkflowGrid steps={steps} onChange={setSteps} />;
}

describe('WorkflowGrid', () => {
  /*
   * The expansion is a class on the wrapper and a rule in the stylesheet, so what this can hold
   * still is the contract between them: the class arrives only when asked for, and it lands on
   * the element the rule targets. The height itself is CSS and was measured in a browser — jsdom
   * computes no layout and would report the same number either way, which is the kind of check
   * that passes after the feature stops working.
   */
  it('carries the expanded class only when the caller asks for it', () => {
    const { container, rerender } = render(
      <WorkflowGrid steps={[blankWorkflowStep(1)]} onChange={() => {}} />,
    );

    const wrap = () => container.querySelector('.uboss-wfgrid-wrap');
    expect(wrap()?.classList.contains('uboss-wfgrid-wrap--tall')).toBe(false);

    rerender(<WorkflowGrid steps={[blankWorkflowStep(1)]} onChange={() => {}} expanded />);
    expect(wrap()?.classList.contains('uboss-wfgrid-wrap--tall')).toBe(true);

    rerender(<WorkflowGrid steps={[blankWorkflowStep(1)]} onChange={() => {}} expanded={false} />);
    expect(wrap()?.classList.contains('uboss-wfgrid-wrap--tall')).toBe(false);
  });

  /*
   * The half of the growth that makes it a spreadsheet: leaving the cell puts it back.
   *
   * jsdom computes no layout, so `scrollHeight` is 0 and the grown height cannot be asserted as a
   * number — that part was watched in a browser. What is checkable here is the thing that would
   * actually break: that entering a cell sets an inline height at all, and that leaving it
   * **removes** the inline height rather than writing another number. Removing it is what hands
   * the row height back to the stylesheet, and it is why "Expand long text" still works on a cell
   * somebody has typed in.
   */
  it('sizes a cell on the way in and hands the height back on the way out', () => {
    render(<Harness />);
    const cell = screen.getByLabelText('Step 1 Exact Work');

    fireEvent.focus(cell);
    expect(cell.style.height).not.toBe('');

    // A number, as a browser would have left it after measuring real content.
    cell.style.height = '84px';
    fireEvent.blur(cell);

    expect(cell.style.height).toBe('');
    expect(cell.style.overflowY).toBe('hidden');
  });

  it('renders every source column header except the approval gate', () => {
    // The locked rule made testable: the header row is derived from the shared array, so a
    // dropped column fails here rather than shipping.
    //
    // Approval is the one deliberate exception. The company this is built for has an
    // administrator who defines the work and an employee who does it, and no third role to stop
    // the work for — so a gate set here would wait for somebody who does not exist. The column
    // stays in the shared array because objectives published before this still carry values in
    // it, and their history has to keep reading correctly.
    render(<Harness />);

    const headers = screen
      .getAllByRole('columnheader')
      .map((cell) => cell.textContent?.trim() ?? '');

    for (const column of FORM2_WORKFLOW_COLUMNS) {
      if (column.key === 'approval') {
        expect(headers).not.toContain(column.label);
        continue;
      }
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

  /*
   * The three machine layers, and no `Human`.
   *
   * This asserted four options. The client's instruction is that somebody writing a step says
   * which machine layer it belongs to and the analysis works out which part of the work still
   * needs a person — asked here, before anybody knows what a model can do, the honest answer is
   * always "a person", which is how a workflow ends up with no AI in it.
   */
  it('offers only the three machine kinds on the engine column', () => {
    render(<Harness initial={[blankWorkflowStep(1)]} />);
    const select = screen.getByLabelText('Step 1 Engine / Sub-Engine / Executor');
    const options = within(select as HTMLElement)
      .getAllByRole('option')
      .map((option) => option.textContent);
    expect(options).toEqual(['Engine', 'Sub-Engine', 'Executor']);
  });

  it('starts a new step on Engine rather than on a value it does not offer', () => {
    // A select whose options exclude its own value renders blank, and the row then looks
    // unfilled and saves as something nobody chose.
    render(<Harness initial={[blankWorkflowStep(1)]} />);
    const select = screen.getByLabelText('Step 1 Engine / Sub-Engine / Executor');
    expect((select as HTMLSelectElement).value).toBe('Engine');
  });

  it('still shows Human on a step written before it was withdrawn', () => {
    /*
     * Objectives written earlier carry `whoEngine: 'Human'`, and a version history, an export and
     * an edit all have to keep reading them. Dropping the option from a row that holds it would
     * blank that row the moment somebody opened it.
     */
    render(<Harness initial={[{ ...blankWorkflowStep(1), whoEngine: 'Human' as const }]} />);
    const select = screen.getByLabelText('Step 1 Engine / Sub-Engine / Executor');
    expect((select as HTMLSelectElement).value).toBe('Human');

    const options = within(select as HTMLElement)
      .getAllByRole('option')
      .map((option) => option.textContent);
    expect(options).toEqual(['Human', 'Engine', 'Sub-Engine', 'Executor']);
  });

  it('offers no approval gate at all', () => {
    /*
     * This asserted the four kinds a step could be gated on. There is no gate now, and the
     * absence is the point: a "Manager sign-off" between two steps parks the work until somebody
     * holding that role decides, and this product has only administrators and employees. A gate
     * would be work waiting for nobody.
     *
     * A new step therefore carries `NotRequired`, and nothing on screen can change it.
     */
    render(<Harness initial={[blankWorkflowStep(1)]} />);
    expect(screen.queryByLabelText('Step 1 Approval')).toBeNull();
    expect(blankWorkflowStep(1).approval).toBe('NotRequired');
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

describe('toEditableStep — the shape the save accepts', () => {
  /*
   * The bug this closes: the objective view returns each saved step with an `id`, the form fed
   * those straight back on the next save, and the DTO refused them with
   * "steps.0.property id should not exist". A draft could be created and then never saved again.
   *
   * It stayed hidden because the first save has no ids to send — only the second one fails, and
   * only on a draft that had already been saved once.
   */
  it('drops fields the server did not ask for', () => {
    const fromTheServer = {
      ...blankWorkflowStep(1),
      whatExactWork: 'Reconcile the branch ledger',
      // Present on every step the view returns.
      id: '01a0ae6d-5668-770a-bba9-5f82441ab8c3',
      createdAt: '2026-09-17T00:00:00.000Z',
    } as unknown as Parameters<typeof toEditableStep>[0];

    const editable = toEditableStep(fromTheServer);

    expect(Object.keys(editable)).not.toContain('id');
    expect(Object.keys(editable)).not.toContain('createdAt');
  });

  it('keeps everything the step actually says', () => {
    const step = {
      ...blankWorkflowStep(3),
      whoPersonName: 'Neha Verma',
      whoDesignation: 'Operations Manager',
      whoEngine: 'Human' as const,
      whatExactWork: 'Check the exception queue',
      approval: 'Manager' as const,
      timeTaken: '30 minutes',
    };

    // Losing a field here would silently discard somebody's work on the next save, which is a
    // worse failure than the one this function exists to fix.
    expect(toEditableStep(step)).toEqual(step);
  });

  it('carries the position through, because that is the step\u2019s identity to the server', () => {
    expect(toEditableStep(blankWorkflowStep(7)).position).toBe(7);
  });
});
