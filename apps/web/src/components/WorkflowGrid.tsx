import {
  FORM2_WORKFLOW_COLUMNS,
  STEP_APPROVAL_KINDS,
  STEP_APPROVAL_LABELS,
  STEP_ENGINE_KINDS,
  STEP_ENGINE_LABELS,
  type Form2WorkflowStep,
  type WorkflowColumnDefinition,
} from '@uboss/types';

import { cn } from '@uboss/ui';

export interface WorkflowGridProps {
  steps: readonly Form2WorkflowStep[];
  /** Called with the whole grid. The parent owns the rows; this component owns the editing. */
  onChange: (steps: Form2WorkflowStep[]) => void;
  /** Read-only for a live version, whose grid the database will refuse to change anyway. */
  readOnly?: boolean;
  className?: string;
}

/** A blank row. `Human` and `Not required` are the reference's defaults for a new step. */
export function blankWorkflowStep(position: number): Form2WorkflowStep {
  return {
    position,
    whoPersonName: null,
    whoDesignation: null,
    whoEngine: 'Human',
    whenTrigger: null,
    whenFrequency: null,
    whatExactWork: '',
    inputWhatIsUsed: null,
    inputReceivedFrom: null,
    whereWorkIsDone: null,
    outputWhatIsProduced: null,
    outputSentTo: null,
    timeTaken: null,
    currentProblem: null,
    approval: 'NotRequired',
  };
}

/** Renumber after a reorder, insert or delete, so `position` is always 1..n with no gaps. */
function renumber(steps: readonly Form2WorkflowStep[]): Form2WorkflowStep[] {
  return steps.map((step, index) => ({ ...step, position: index + 1 }));
}

/**
 * The Form 2 workflow grid — the approved reference's `.wfg`.
 *
 * ## Why it lives here and not in `packages/ui`
 *
 * The design system is deliberately domain-free: not one of its primitives imports
 * `@uboss/types`, so tokens and layout can be reused by anything. This grid is the opposite —
 * its whole value is that it renders *the client's fifteen columns*, from the shared array. Its
 * styling is in `packages/ui` where the tokens are; its knowledge of Form 2 is here, alongside
 * the other domain composites.
 *
 * ## Why the columns are not written out here
 *
 * They come from `FORM2_WORKFLOW_COLUMNS`, the same array the API validates against and the
 * migration was written from. The client's locked instruction is that the grid keeps every source
 * column, and a component with its own hand-written column list is a second place for that to
 * stop being true. Adding a column to the shared array adds it here; there is no way to render
 * fourteen.
 *
 * ## Grouped sticky headers and a sticky Step column
 *
 * Both are in the reference and both are load-bearing rather than decorative: fifteen columns
 * means horizontal scrolling, and scrolling a fifteen-column grid with no fixed Step column and
 * no visible WHO / WHEN / WHAT banner leaves you reading cells you cannot place. The CSS does the
 * sticking; this component's job is to emit the two header rows in the shape the CSS expects.
 *
 * ## The row count is not fixed
 *
 * Per-row Insert, Duplicate, Delete and Reorder, and Add Row above. The only floor is one row —
 * deleting the last one would leave a grid with no way to start typing again, so Delete is
 * disabled at a single row rather than silently refusing.
 */
export function WorkflowGrid({ steps, onChange, readOnly = false, className }: WorkflowGridProps) {
  const columns = FORM2_WORKFLOW_COLUMNS;

  /** The grouped banner row: one `th` per group, spanning its columns. */
  const groupHeader: { key: string; label: string; span: number; grouped: boolean }[] = [];
  for (let index = 1; index < columns.length;) {
    const column = columns[index] as WorkflowColumnDefinition;
    if (column.group === null) {
      groupHeader.push({ key: column.key, label: column.label, span: 1, grouped: false });
      index += 1;
      continue;
    }
    let span = 0;
    while (
      index + span < columns.length &&
      (columns[index + span] as WorkflowColumnDefinition).group === column.group
    ) {
      span += 1;
    }
    groupHeader.push({ key: column.group, label: column.group, span, grouped: true });
    index += span;
  }

  const update = (position: number, patch: Partial<Form2WorkflowStep>) => {
    onChange(steps.map((step) => (step.position === position ? { ...step, ...patch } : step)));
  };

  const rowOp = (position: number, op: 'up' | 'down' | 'insert' | 'duplicate' | 'delete') => {
    const index = steps.findIndex((step) => step.position === position);
    if (index === -1) return;
    const next = [...steps];

    if (op === 'up' && index > 0) {
      [next[index - 1], next[index]] = [
        next[index] as Form2WorkflowStep,
        next[index - 1] as Form2WorkflowStep,
      ];
    }
    if (op === 'down' && index < next.length - 1) {
      [next[index + 1], next[index]] = [
        next[index] as Form2WorkflowStep,
        next[index + 1] as Form2WorkflowStep,
      ];
    }
    if (op === 'insert') next.splice(index + 1, 0, blankWorkflowStep(0));
    if (op === 'duplicate') next.splice(index + 1, 0, { ...(next[index] as Form2WorkflowStep) });
    if (op === 'delete' && next.length > 1) next.splice(index, 1);

    onChange(renumber(next));
  };

  const cellFor = (step: Form2WorkflowStep, column: WorkflowColumnDefinition) => {
    if (column.kind === 'step') {
      return (
        <td key={column.key} className="uboss-wfg-stepn uboss-wfg-stick">
          {step.position}
        </td>
      );
    }

    if (column.kind === 'engine') {
      return (
        <td key={column.key}>
          <select
            className="uboss-wfg-editable"
            aria-label={`Step ${step.position} ${column.label}`}
            value={step.whoEngine}
            disabled={readOnly}
            onChange={(event) =>
              update(step.position, {
                whoEngine: event.target.value as Form2WorkflowStep['whoEngine'],
              })
            }
          >
            {STEP_ENGINE_KINDS.map((kind) => (
              <option key={kind} value={kind}>
                {STEP_ENGINE_LABELS[kind]}
              </option>
            ))}
          </select>
        </td>
      );
    }

    if (column.kind === 'approval') {
      return (
        <td key={column.key}>
          <select
            className="uboss-wfg-editable"
            aria-label={`Step ${step.position} ${column.label}`}
            value={step.approval}
            disabled={readOnly}
            onChange={(event) =>
              update(step.position, {
                approval: event.target.value as Form2WorkflowStep['approval'],
              })
            }
          >
            {STEP_APPROVAL_KINDS.map((kind) => (
              <option key={kind} value={kind}>
                {STEP_APPROVAL_LABELS[kind]}
              </option>
            ))}
          </select>
        </td>
      );
    }

    const value = (step as unknown as Record<string, unknown>)[column.key];

    return (
      <td key={column.key}>
        <textarea
          rows={1}
          className={cn(
            'uboss-wfg-editable',
            'uboss-wfg-cell',
            column.width > 160 && 'uboss-wfg-cell--wide',
          )}
          aria-label={`Step ${step.position} ${column.label}`}
          value={typeof value === 'string' ? value : ''}
          readOnly={readOnly}
          maxLength={column.maxLength}
          onChange={(event) => {
            // Empty means "cleared", which for an optional column is null rather than "". Exact
            // Work is required, so it stays a string and the server refuses a blank one.
            const next = event.target.value;
            update(step.position, {
              [column.key]: column.key === 'whatExactWork' ? next : next === '' ? null : next,
            } as Partial<Form2WorkflowStep>);
          }}
        />
      </td>
    );
  };

  return (
    <div className={cn('uboss-wfgrid-wrap', className)}>
      <table className="uboss-wfg">
        <caption className="uboss-sr-only">
          Form 2 workflow steps — {columns.length} source columns
        </caption>
        <thead>
          <tr className="uboss-wfg-group">
            <th className="uboss-wfg-stick" aria-label="Step" />
            {groupHeader.map((group) => (
              <th key={group.key} colSpan={group.span} scope="colgroup">
                {group.grouped ? group.label : group.label}
              </th>
            ))}
            <th aria-label="Row actions" />
          </tr>
          <tr className="uboss-wfg-sub">
            <th className="uboss-wfg-stick" scope="col">
              Step
            </th>
            {columns.slice(1).map((column) => (
              <th key={column.key} scope="col" style={{ minWidth: `${column.width}px` }}>
                {column.label}
              </th>
            ))}
            <th scope="col">Row</th>
          </tr>
        </thead>
        <tbody>
          {steps.map((step) => (
            <tr key={step.position}>
              {columns.map((column) => cellFor(step, column))}
              <td>
                <div className="uboss-wfg-rowops">
                  <button
                    type="button"
                    title="Move up"
                    disabled={readOnly || step.position === 1}
                    onClick={() => rowOp(step.position, 'up')}
                  >
                    ↑
                  </button>
                  <button
                    type="button"
                    title="Move down"
                    disabled={readOnly || step.position === steps.length}
                    onClick={() => rowOp(step.position, 'down')}
                  >
                    ↓
                  </button>
                  <button
                    type="button"
                    title="Insert below"
                    disabled={readOnly}
                    onClick={() => rowOp(step.position, 'insert')}
                  >
                    +
                  </button>
                  <button
                    type="button"
                    title="Duplicate"
                    disabled={readOnly}
                    onClick={() => rowOp(step.position, 'duplicate')}
                  >
                    ⧉
                  </button>
                  <button
                    type="button"
                    title="Delete"
                    disabled={readOnly || steps.length === 1}
                    onClick={() => rowOp(step.position, 'delete')}
                  >
                    ✕
                  </button>
                </div>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
