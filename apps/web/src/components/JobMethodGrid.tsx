'use client';

import { JOB_METHOD_CELL_MAX, type JobMethodRow } from '@uboss/types';
import { cn, Icon, stagger, transition } from '@uboss/ui';
import { motion } from 'motion/react';
import { useEffect, useRef, useState } from 'react';

/**
 * The job method's steps, as a spreadsheet.
 *
 * ## Why this is a second grid and not `WorkflowGrid`
 *
 * They share a design and not a data model. `WorkflowGrid` edits `Form2WorkflowStep` — seventeen
 * columns, two of them closed vocabularies with their own pickers, under grouped headers. A job
 * method is twelve free-text columns and nothing else, so most of that component is machinery this
 * one has no use for. Generalising it would mean a column-descriptor abstraction serving two
 * shapes, and the cost of that indirection lands on the component with eighteen tests protecting
 * the interactions people actually rely on.
 *
 * What they *do* share is the CSS, deliberately: the classes here are `WorkflowGrid`'s own, so the
 * two grids look and behave like one thing, which is what the client asked for.
 */

interface JobMethodColumn {
  key: Exclude<keyof JobMethodRow, 'step'>;
  label: string;
  /** Roughly how much room the answer needs. A method is a paragraph; a time is four characters. */
  width: number;
}

/**
 * The twelve columns, in the order the downloaded form has them.
 *
 * Same order on purpose. Somebody who filled the spreadsheet in and then opens this should find
 * the same questions in the same places — a different order would read as a different form.
 */
export const JOB_METHOD_COLUMNS: readonly JobMethodColumn[] = [
  { key: 'whatExactWork', label: 'WHAT — Exact Work', width: 260 },
  { key: 'inputExactInput', label: 'INPUT — Exact Input', width: 200 },
  { key: 'whereInputSource', label: 'WHERE — Input Is Found', width: 200 },
  { key: 'toolSystemWorkplace', label: 'Tool / System / Workplace', width: 200 },
  { key: 'howExactMethod', label: 'HOW — Exact Method', width: 300 },
  { key: 'ruleFormulaCheck', label: 'Rule / Formula / Check', width: 220 },
  { key: 'output', label: 'Output', width: 200 },
  { key: 'outputDestination', label: 'Output Destination', width: 200 },
  { key: 'approval', label: 'Approval', width: 160 },
  { key: 'agentMustNeverDo', label: 'The agent must never', width: 220 },
  { key: 'ifMissingOrWrong', label: 'If missing / wrong', width: 220 },
  { key: 'time', label: 'Time', width: 120 },
];

export interface JobMethodGridProps {
  rows: readonly JobMethodRow[];
  /** Called with the whole grid. The parent owns the rows; this owns the editing. */
  onChange: (rows: JobMethodRow[]) => void;
  readOnly?: boolean;
  /** Show every cell at its full height rather than one line. The objective grid's own toggle. */
  expanded?: boolean;
  className?: string;
}

/** A blank step. Numbered by the caller, because a row's number is its place in the method. */
export function blankJobMethodRow(step: number): JobMethodRow {
  return { step };
}

export function JobMethodGrid({
  rows,
  onChange,
  readOnly,
  expanded,
  className,
}: JobMethodGridProps) {
  /*
   * A stable identity per row for the whole session.
   *
   * Keying by step number would make a reorder look like every row's contents changing, and Motion
   * would animate it as one. Keyed this way, moving a row is a move.
   */
  const nextId = useRef(0);
  const [rowIds, setRowIds] = useState<string[]>(() => rows.map(() => `r${nextId.current++}`));
  const [dragging, setDragging] = useState<number | null>(null);
  const [over, setOver] = useState<number | null>(null);
  const [touched, setTouched] = useState<string | null>(null);
  const [menu, setMenu] = useState<{ index: number; x: number; y: number } | null>(null);

  useEffect(() => {
    setRowIds((current) => {
      if (current.length === rows.length) return current;
      if (current.length < rows.length) {
        const added = Array.from(
          { length: rows.length - current.length },
          () => `r${nextId.current++}`,
        );
        return [...current, ...added];
      }
      return current.slice(0, rows.length);
    });
  }, [rows.length]);

  useEffect(() => {
    if (menu === null) return;
    const dismiss = (event: Event) => {
      // A click inside the menu is a choice, not a dismissal. Without this the menu closes on
      // mousedown and the item never receives its click.
      const target = event.target;
      if (target instanceof Element && target.closest('.uboss-wfg-menu') !== null) return;
      setMenu(null);
    };
    document.addEventListener('mousedown', dismiss);
    return () => document.removeEventListener('mousedown', dismiss);
  }, [menu]);

  const renumber = (next: JobMethodRow[]): JobMethodRow[] =>
    next.map((row, index) => ({ ...row, step: index + 1 }));

  const setCell = (index: number, key: JobMethodColumn['key'], value: string) => {
    const next = rows.map((row, at) =>
      at === index ? { ...row, [key]: value === '' ? undefined : value } : row,
    );
    onChange(renumber(next));
  };

  const addRow = (at = rows.length) => {
    const next = [...rows];
    next.splice(at, 0, blankJobMethodRow(at + 1));
    const ids = [...rowIds];
    const id = `r${nextId.current++}`;
    ids.splice(at, 0, id);
    setRowIds(ids);
    setTouched(id);
    onChange(renumber(next));
    setMenu(null);
  };

  const duplicateRow = (index: number) => {
    const source = rows[index];
    if (source === undefined) return;
    const next = [...rows];
    next.splice(index + 1, 0, { ...source });
    const ids = [...rowIds];
    const id = `r${nextId.current++}`;
    ids.splice(index + 1, 0, id);
    setRowIds(ids);
    setTouched(id);
    onChange(renumber(next));
    setMenu(null);
  };

  const deleteRow = (index: number) => {
    const next = rows.filter((unused, at) => at !== index);
    setRowIds(rowIds.filter((unused, at) => at !== index));
    onChange(renumber(next));
    setMenu(null);
  };

  const moveRow = (from: number, to: number) => {
    if (from === to) return;
    const next = [...rows];
    const [moved] = next.splice(from, 1);
    if (moved === undefined) return;
    next.splice(to, 0, moved);

    const ids = [...rowIds];
    const [movedId] = ids.splice(from, 1);
    if (movedId !== undefined) ids.splice(to, 0, movedId);
    setRowIds(ids);
    setTouched(movedId ?? null);

    onChange(renumber(next));
  };

  return (
    <div
      className={cn('uboss-wfgrid-wrap', expanded === true && 'uboss-wfgrid-wrap--tall', className)}
    >
      <table className="uboss-wfg">
        <caption className="uboss-sr-only">
          The job method — {JOB_METHOD_COLUMNS.length} columns, one row per step
        </caption>
        <thead>
          {/*
            A plain row, deliberately not `uboss-wfg-sub`.

            That class carries `top: 30px`, which is the height of the grouped header the objective
            grid has above it. This grid has one header row and no group above it, so borrowing the
            class stuck the header 30px down the scroll box and the first row slid up behind the
            gap — the overlap that looked like a rendering bug and was a copied offset.
          */}
          <tr>
            <th className="uboss-wfg-stick" scope="col">
              Step
            </th>
            {JOB_METHOD_COLUMNS.map((column) => (
              <th key={column.key} scope="col" style={{ minWidth: `${column.width}px` }}>
                {column.label}
              </th>
            ))}
            <th scope="col">Row</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((row, index) => (
            <motion.tr
              key={rowIds[index] ?? `fallback-${row.step}`}
              layout
              transition={{
                ...transition('panel', 'standard'),
                delay: stagger(index, rows.length),
              }}
              className={cn(
                touched === rowIds[index] && 'uboss-wfg-row--touched',
                over === index && 'uboss-wfg-row--over',
              )}
              onAnimationComplete={() => {
                if (touched === rowIds[index]) setTouched(null);
              }}
              initial={{ opacity: 0, y: 4 }}
              animate={{ opacity: 1, y: 0 }}
              onDragOver={(event) => {
                if (readOnly === true || dragging === null) return;
                // Without this the drop is refused and the gesture ends where it started.
                event.preventDefault();
                event.dataTransfer.dropEffect = 'move';
                if (over !== index) setOver(index);
              }}
              onDrop={(event) => {
                if (readOnly === true || dragging === null) return;
                event.preventDefault();
                moveRow(dragging, index);
                setDragging(null);
                setOver(null);
              }}
              onContextMenu={(event) => {
                if (readOnly === true) return;
                event.preventDefault();
                // Clamped, so a right-click near the edge does not open a menu off screen.
                const width = 200;
                const height = 140;
                setMenu({
                  index,
                  x: Math.min(event.clientX, window.innerWidth - width),
                  y: Math.min(event.clientY, window.innerHeight - height),
                });
              }}
            >
              {/* Matched to the objective grid: the number alone, sticky, and nothing else. */}
              <td className="uboss-wfg-stepn uboss-wfg-stick">{row.step}</td>

              {JOB_METHOD_COLUMNS.map((column) => (
                /*
                 * The classes go on the control, not the cell.
                 *
                 * `uboss-wfg-cell` sizes the editable box — its padding, its minimum height, the
                 * way it grows. Putting it on the `td` instead left the textarea with no size of
                 * its own and the row collapsed to a sliver. Matched to WorkflowGrid exactly,
                 * because the two grids are meant to be indistinguishable.
                 */
                <td key={column.key}>
                  <textarea
                    rows={1}
                    className={cn(
                      'uboss-wfg-editable',
                      'uboss-wfg-cell',
                      column.width > 160 && 'uboss-wfg-cell--wide',
                    )}
                    maxLength={JOB_METHOD_CELL_MAX}
                    readOnly={readOnly === true}
                    aria-label={`${column.label}, step ${row.step}`}
                    value={row[column.key] ?? ''}
                    onChange={(event) => setCell(index, column.key, event.target.value)}
                  />
                </td>
              ))}

              <td>
                <div className="uboss-wfg-rowops">
                  {readOnly === true ? null : (
                    /*
                     * The handle is what is picked up, not the row.
                     *
                     * `motion.tr` owns `onDragStart` for its own gesture system, so the native one
                     * cannot live on the row — and a row that is draggable everywhere cannot have
                     * its text selected, which is the first thing anybody tries in a spreadsheet.
                     */
                    <span
                      className="uboss-wfg-grip"
                      draggable
                      role="button"
                      tabIndex={0}
                      aria-label={`Move step ${row.step}`}
                      onDragStart={(event) => {
                        event.dataTransfer.effectAllowed = 'move';
                        // Firefox starts no drag without a payload.
                        event.dataTransfer.setData('text/plain', String(index));
                        setDragging(index);
                      }}
                      onDragEnd={() => {
                        setDragging(null);
                        setOver(null);
                      }}
                      onKeyDown={(event) => {
                        // The same move from the keyboard, because a drag is not available to
                        // everybody and reordering is not a decorative feature.
                        if (event.key === 'ArrowUp' && index > 0) {
                          event.preventDefault();
                          moveRow(index, index - 1);
                        }
                        if (event.key === 'ArrowDown' && index < rows.length - 1) {
                          event.preventDefault();
                          moveRow(index, index + 1);
                        }
                      }}
                    >
                      <Icon name="grid" size={13} />
                    </span>
                  )}
                  {row.step}
                  {readOnly === true ? null : (
                    <button
                      type="button"
                      title="Delete"
                      aria-label={`Delete step ${row.step}`}
                      onClick={() => deleteRow(index)}
                    >
                      <Icon name="close" size={14} />
                    </button>
                  )}
                </div>
              </td>
            </motion.tr>
          ))}
        </tbody>
      </table>

      {readOnly === true ? null : (
        <div className="uboss-actions" style={{ marginTop: 10 }}>
          <button type="button" className="uboss-btn uboss-btn--sm" onClick={() => addRow()}>
            <Icon name="plus" size={16} />
            Add step
          </button>
          <small className="uboss-muted-3">
            Right-click a row to insert, duplicate or delete it. Drag the handle to reorder.
          </small>
        </div>
      )}

      {menu === null ? null : (
        <div className="uboss-wfg-menu" style={{ left: menu.x, top: menu.y }} role="menu">
          <button
            type="button"
            className="uboss-wfg-menu-item"
            role="menuitem"
            onClick={() => addRow(menu.index)}
          >
            Insert a step above
          </button>
          <button
            type="button"
            className="uboss-wfg-menu-item"
            role="menuitem"
            onClick={() => addRow(menu.index + 1)}
          >
            Insert a step below
          </button>
          <button
            type="button"
            className="uboss-wfg-menu-item"
            role="menuitem"
            onClick={() => duplicateRow(menu.index)}
          >
            Duplicate this step
          </button>
          <button
            type="button"
            className="uboss-wfg-menu-item uboss-wfg-menu-item--danger"
            role="menuitem"
            onClick={() => deleteRow(menu.index)}
          >
            Delete this step
          </button>
        </div>
      )}
    </div>
  );
}
