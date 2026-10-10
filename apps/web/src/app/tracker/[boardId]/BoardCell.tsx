'use client';

import { useEffect, useRef, useState } from 'react';

import { StatusBadge } from '@uboss/ui';

import type { BoardColumnView } from '../../../lib/api-client';
import { DocCell, DropdownCell, PeopleCell, TimelineCell } from './BoardCellKinds';

/**
 * One cell, rendered and edited by its column's kind.
 *
 * ## Why this is a switch and not eight components spread across the screen
 *
 * A column kind is four things that have to agree: how a value is shown, how it is changed, what
 * counts as a value, and what an empty one looks like. Keeping them in one place per kind is what
 * makes the ninth kind a case rather than an archaeology exercise — which is the whole reason the
 * model stores a kind as a string and a value as JSON rather than making each one a table.
 *
 * ## Empty is a value too
 *
 * Every kind renders an em dash when there is nothing, and every editor can get back to nothing.
 * A cell somebody cannot clear is a cell that lies the first time they fill it by accident.
 */
export function BoardCell({
  column,
  value,
  people,
  mayEdit,
  onWrite,
}: {
  column: BoardColumnView;
  value: unknown;
  /** Who a People cell may name: the board's own members. */
  people: readonly { userId: string; name: string }[];
  mayEdit: boolean;
  onWrite: (value: unknown) => void;
}) {
  switch (column.kind) {
    case 'Status':
      return <StatusCell column={column} value={value} mayEdit={mayEdit} onWrite={onWrite} />;
    case 'Text':
      return <TextCell value={value} mayEdit={mayEdit} onWrite={onWrite} />;
    case 'Number':
      return <NumberCell value={value} mayEdit={mayEdit} onWrite={onWrite} />;
    case 'Date':
      return <DateCell value={value} mayEdit={mayEdit} onWrite={onWrite} />;
    case 'Checkbox':
      return <CheckboxCell value={value} mayEdit={mayEdit} onWrite={onWrite} />;
    case 'People':
      return <PeopleCell value={value} people={people} mayEdit={mayEdit} onWrite={onWrite} />;
    case 'Dropdown':
      return <DropdownCell column={column} value={value} mayEdit={mayEdit} onWrite={onWrite} />;
    case 'Timeline':
      return <TimelineCell value={value} mayEdit={mayEdit} onWrite={onWrite} />;
    case 'Doc':
      return <DocCell value={value} mayEdit={mayEdit} onWrite={onWrite} name={column.title} />;
    default:
      /*
       * A kind the server accepted and this screen cannot draw.
       *
       * Should not happen — both lists come from `BOARD_COLUMN_KINDS` — but shown as what it
       * holds rather than hidden, because a blank cell under a heading somebody can see reads as
       * "nothing here", which is a different and wrong answer.
       */
      return (
        <span className="uboss-board-raw">{value === undefined ? '—' : summarise(value)}</span>
      );
  }
}

/** Whatever a kind without an editor holds, in one line, rather than a blank. */
function summarise(value: unknown): string {
  if (value === null) return '—';
  if (typeof value === 'string' || typeof value === 'number') return String(value);
  return JSON.stringify(value);
}

interface StatusLabel {
  id: string;
  label: string;
  tone: string;
}

/**
 * The status column — the one that makes a board a board.
 *
 * A select rather than a menu of coloured tiles, for now: a native select is keyboard-operable,
 * works on a phone, and does not need a popover layer. The badge beside it is what the row is
 * read by.
 */
function StatusCell({
  column,
  value,
  mayEdit,
  onWrite,
}: {
  column: BoardColumnView;
  value: unknown;
  mayEdit: boolean;
  onWrite: (value: unknown) => void;
}) {
  const labels = (column.settings['labels'] as StatusLabel[] | undefined) ?? [];
  const chosenId =
    value !== null && typeof value === 'object' && value !== undefined
      ? ((value as { labelId?: string }).labelId ?? null)
      : null;
  const chosen = labels.find((label) => label.id === chosenId) ?? null;

  if (!mayEdit) {
    return chosen === null ? (
      <span className="uboss-board-empty-cell">—</span>
    ) : (
      <StatusBadge status={chosen.label} tone={chosen.tone as 'grey'} />
    );
  }

  return (
    <select
      className="uboss-board-select"
      value={chosenId ?? ''}
      aria-label={column.title}
      onChange={(event) =>
        // The empty option clears the cell, which removes the row rather than storing nothing.
        onWrite(event.target.value === '' ? undefined : { labelId: event.target.value })
      }
    >
      <option value="">—</option>
      {labels.map((label) => (
        <option key={label.id} value={label.id}>
          {label.label}
        </option>
      ))}
    </select>
  );
}

/**
 * Free text.
 *
 * Saved on blur and on Enter, not on every keystroke: a board of two hundred rows would otherwise
 * be a request per character, and the row people are typing in is the one that would feel it.
 */
function TextCell({
  value,
  mayEdit,
  onWrite,
}: {
  value: unknown;
  mayEdit: boolean;
  onWrite: (value: unknown) => void;
}) {
  const stored = typeof value === 'string' ? value : '';
  const [draft, setDraft] = useState(stored);
  const committed = useRef(stored);

  // The board reloads after every write, so the value can arrive from the server while this is
  // mounted. Following it keeps two people on one board from overwriting each other's cell.
  useEffect(() => {
    if (stored !== committed.current) {
      committed.current = stored;
      setDraft(stored);
    }
  }, [stored]);

  if (!mayEdit) {
    return stored === '' ? (
      <span className="uboss-board-empty-cell">—</span>
    ) : (
      <span>{stored}</span>
    );
  }

  const commit = () => {
    if (draft === committed.current) return;
    committed.current = draft;
    onWrite(draft.trim() === '' ? undefined : draft);
  };

  return (
    <input
      className="uboss-board-input"
      value={draft}
      onChange={(event) => setDraft(event.target.value)}
      onBlur={commit}
      onKeyDown={(event) => {
        if (event.key === 'Enter') event.currentTarget.blur();
        if (event.key === 'Escape') setDraft(committed.current);
      }}
    />
  );
}

function NumberCell({
  value,
  mayEdit,
  onWrite,
}: {
  value: unknown;
  mayEdit: boolean;
  onWrite: (value: unknown) => void;
}) {
  const stored = typeof value === 'number' ? String(value) : '';
  const [draft, setDraft] = useState(stored);
  const committed = useRef(stored);

  useEffect(() => {
    if (stored !== committed.current) {
      committed.current = stored;
      setDraft(stored);
    }
  }, [stored]);

  if (!mayEdit) {
    return stored === '' ? (
      <span className="uboss-board-empty-cell">—</span>
    ) : (
      <span>{stored}</span>
    );
  }

  const commit = () => {
    if (draft === committed.current) return;
    committed.current = draft;
    const parsed = Number(draft);
    // Not a number is not a value. Writing NaN would store a cell nothing can read back.
    onWrite(draft.trim() === '' || Number.isNaN(parsed) ? undefined : parsed);
  };

  return (
    <input
      className="uboss-board-input"
      inputMode="decimal"
      value={draft}
      onChange={(event) => setDraft(event.target.value)}
      onBlur={commit}
      onKeyDown={(event) => {
        if (event.key === 'Enter') event.currentTarget.blur();
        if (event.key === 'Escape') setDraft(committed.current);
      }}
    />
  );
}

/** A date, stored as the `YYYY-MM-DD` the native picker already speaks. */
function DateCell({
  value,
  mayEdit,
  onWrite,
}: {
  value: unknown;
  mayEdit: boolean;
  onWrite: (value: unknown) => void;
}) {
  const stored = typeof value === 'string' ? value : '';

  if (!mayEdit) {
    return stored === '' ? (
      <span className="uboss-board-empty-cell">—</span>
    ) : (
      <span>{new Date(stored).toLocaleDateString()}</span>
    );
  }

  return (
    <input
      type="date"
      className="uboss-board-input"
      value={stored}
      onChange={(event) => onWrite(event.target.value === '' ? undefined : event.target.value)}
    />
  );
}

function CheckboxCell({
  value,
  mayEdit,
  onWrite,
}: {
  value: unknown;
  mayEdit: boolean;
  onWrite: (value: unknown) => void;
}) {
  const checked = value === true;

  return (
    <input
      type="checkbox"
      className="uboss-board-check"
      checked={checked}
      disabled={!mayEdit}
      // Unchecking clears the cell rather than storing `false`: an unticked box and a box nobody
      // has touched are the same thing, and two ways to say it is two things to read.
      onChange={(event) => onWrite(event.target.checked ? true : undefined)}
    />
  );
}
