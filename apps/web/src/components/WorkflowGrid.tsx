import {
  FORM2_WORKFLOW_COLUMNS,
  STEP_APPROVAL_KINDS,
  STEP_APPROVAL_LABELS,
  STEP_ENGINE_KINDS,
  STEP_ENGINE_LABELS,
  type Form2WorkflowStep,
  type WorkflowColumnDefinition,
} from '@uboss/types';

import { cn, Icon, stagger, transition } from '@uboss/ui';
import { motion } from 'motion/react';
import { useRef, useState } from 'react';

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

  /*
   * Row identity, kept here rather than on the step.
   *
   * A step is identified by its position, and reordering changes exactly that — so keying rows by
   * position tells React that row 2 became row 3's contents, and it rewrites both rows in place.
   * Nothing moves, so nothing can be followed: two rows swap their text and the eye has to
   * re-read the grid to work out what happened. That is the whole cost of a reorder you cannot see.
   *
   * These ids belong to the editing session, not to the data. They are assigned on first render
   * and carried through each operation the same way the steps are, which is what lets the rows
   * animate to their new places instead of being redrawn. Nothing persists them and nothing else
   * reads them: a step's identity in the saved draft is still its position.
   */
  const nextId = useRef(0);
  const mint = () => {
    nextId.current += 1;
    return `row-${nextId.current}`;
  };
  const [rowIds, setRowIds] = useState<string[]>(() => steps.map(() => mint()));

  // The data can change from outside (a draft loads, or the analysis writes a plan). Match the
  // length without disturbing the ids that are already carrying rows.
  if (rowIds.length !== steps.length) {
    const corrected = steps.map((_, index) => rowIds[index] ?? mint());
    setRowIds(corrected);
  }

  /*
   * The row a change just touched, so the motion says *what* changed rather than only that
   * something did. Cleared by the animation ending, not by a timer, so it cannot get out of step
   * with what is on screen.
   */
  const [touched, setTouched] = useState<string | null>(null);

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
    const index = steps.findIndex((step) => step.position === position);
    if (index !== -1) setTouched(rowIds[index] ?? null);
    onChange(steps.map((step) => (step.position === position ? { ...step, ...patch } : step)));
  };

  const rowOp = (position: number, op: 'up' | 'down' | 'insert' | 'duplicate' | 'delete') => {
    const index = steps.findIndex((step) => step.position === position);
    if (index === -1) return;
    const next = [...steps];
    // The ids move exactly as the steps do, so a row keeps its identity across the operation.
    const ids = [...rowIds];

    if (op === 'up' && index > 0) {
      [next[index - 1], next[index]] = [
        next[index] as Form2WorkflowStep,
        next[index - 1] as Form2WorkflowStep,
      ];
      [ids[index - 1], ids[index]] = [ids[index] as string, ids[index - 1] as string];
    }
    if (op === 'down' && index < next.length - 1) {
      [next[index + 1], next[index]] = [
        next[index] as Form2WorkflowStep,
        next[index + 1] as Form2WorkflowStep,
      ];
      [ids[index + 1], ids[index]] = [ids[index] as string, ids[index + 1] as string];
    }
    if (op === 'insert') {
      next.splice(index + 1, 0, blankWorkflowStep(0));
      const born = mint();
      ids.splice(index + 1, 0, born);
      setTouched(born);
    }
    if (op === 'duplicate') {
      next.splice(index + 1, 0, { ...(next[index] as Form2WorkflowStep) });
      const born = mint();
      ids.splice(index + 1, 0, born);
      setTouched(born);
    }
    if (op === 'delete' && next.length > 1) {
      next.splice(index, 1);
      ids.splice(index, 1);
    }
    if (op === 'up' || op === 'down') setTouched(ids[op === 'up' ? index - 1 : index + 1] ?? null);

    setRowIds(ids);
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
          {steps.map((step, index) => (
            /*
             * Keyed by session identity, not position, and laid out by Motion — so moving a step
             * is a move. `layout` animates the row to its new place, and the rows it displaces
             * move with it, which is what makes a reorder legible.
             *
             * Removal is deliberately not animated. An exit animation keeps the row in the
             * document — and so in the accessibility tree, still carrying its old step number —
             * for as long as it takes to collapse. A row that has been deleted must not be
             * readable, and what happened is already said by the rows below closing the gap.
             */
            <motion.tr
              key={rowIds[index] ?? `fallback-${step.position}`}
              layout
              transition={{ ...transition('panel', 'standard'), delay: stagger(index, steps.length) }}
              className={touched === rowIds[index] ? 'uboss-wfg-row--touched' : undefined}
              onAnimationComplete={() => {
                // Cleared by the animation, not a timer, so the mark cannot outlive what it marks.
                if (touched === rowIds[index]) setTouched(null);
              }}
              // The first reveal: steps arrive a beat apart, so the order is visible in the way
              // they appear. stagger() caps the sequence and returns 0 under reduced motion, so
              // there is no second rule to keep in step.
              initial={{ opacity: 0, y: 4 }}
              animate={{ opacity: 1, y: 0 }}
            >
              {columns.map((column) => cellFor(step, column))}
              <td>
                <div className="uboss-wfg-rowops">
                  <button
                    type="button"
                    title="Move up"
                    aria-label={`Move step ${step.position} up`}
                    disabled={readOnly || step.position === 1}
                    onClick={() => rowOp(step.position, 'up')}
                  >
                    <Icon name="arrow-up" size={14} />
                  </button>
                  <button
                    type="button"
                    title="Move down"
                    aria-label={`Move step ${step.position} down`}
                    disabled={readOnly || step.position === steps.length}
                    onClick={() => rowOp(step.position, 'down')}
                  >
                    <Icon name="arrow-down" size={14} />
                  </button>
                  <button
                    type="button"
                    title="Insert below"
                    aria-label={`Insert a step below step ${step.position}`}
                    disabled={readOnly}
                    onClick={() => rowOp(step.position, 'insert')}
                  >
                    <Icon name="plus" size={14} />
                  </button>
                  <button
                    type="button"
                    title="Duplicate"
                    aria-label={`Duplicate step ${step.position}`}
                    disabled={readOnly}
                    onClick={() => rowOp(step.position, 'duplicate')}
                  >
                    <Icon name="file" size={14} />
                  </button>
                  <button
                    type="button"
                    title="Delete"
                    aria-label={`Delete step ${step.position}`}
                    disabled={readOnly || steps.length === 1}
                    onClick={() => rowOp(step.position, 'delete')}
                  >
                    <Icon name="close" size={14} />
                  </button>
                </div>
              </td>
            </motion.tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
