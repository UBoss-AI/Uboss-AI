'use client';

import { useState } from 'react';

import { Button, Icon, Modal, RichTextEditor } from '@uboss/ui';

import type { BoardColumnView } from '../../../lib/api-client';

/**
 * The four column kinds that need more than an input.
 *
 * Split from `BoardCell` because each of these is a renderer, an editor, an empty state and a
 * decision about what "no value" means — and a single file holding nine of those is a file
 * nobody can find anything in. The switch stays in one place; the work does not have to.
 */

/**
 * Who a row belongs to.
 *
 * From the board's own members rather than the company roster: a standard Employee has no grant
 * to read the roster at all, and a factory floor is four hundred names nobody wants in a
 * dropdown. monday.com assigns from a board's subscribers for the same reason — the people on a
 * board are the people its work belongs to. Somebody who is not on it gets added to the board
 * first, which is the honest order.
 */
export function PeopleCell({
  value,
  people,
  mayEdit,
  onWrite,
}: {
  value: unknown;
  people: readonly { userId: string; name: string }[];
  mayEdit: boolean;
  onWrite: (value: unknown) => void;
}) {
  const chosen = Array.isArray(value) ? (value as string[]) : [];
  const names = chosen
    .map((id) => people.find((person) => person.userId === id)?.name)
    .filter((name): name is string => typeof name === 'string');

  if (!mayEdit) {
    return names.length === 0 ? (
      <span className="uboss-board-empty-cell">—</span>
    ) : (
      <span className="uboss-board-people">
        {names.map((name) => (
          <span key={name} className="uboss-board-person" title={name}>
            {initialsOf(name)}
          </span>
        ))}
      </span>
    );
  }

  /*
   * One person per cell for now.
   *
   * Which is what a select can express honestly. Several is a popover with checkboxes, and a
   * half-built multi-select that silently keeps only the last choice is worse than one that
   * says it takes one. The value is still stored as a list, so the day it takes several nothing
   * already written has to move.
   */
  return (
    <select
      className="uboss-board-select"
      value={chosen[0] ?? ''}
      aria-label="Owner"
      onChange={(event) => onWrite(event.target.value === '' ? undefined : [event.target.value])}
    >
      <option value="">—</option>
      {people.map((person) => (
        <option key={person.userId} value={person.userId}>
          {person.name}
        </option>
      ))}
    </select>
  );
}

/** Two letters, first and last word — a surname is what distinguishes people on a roster. */
function initialsOf(name: string): string {
  const words = name.trim().split(/\s+/).filter(Boolean);
  if (words.length === 0) return '?';
  if (words.length === 1) return words[0]!.slice(0, 2).toUpperCase();
  return (words[0]![0]! + words[words.length - 1]![0]!).toUpperCase();
}

interface DropdownOption {
  id: string;
  label: string;
}

/** One of a list the column's own settings carry. */
export function DropdownCell({
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
  const options = (column.settings['options'] as DropdownOption[] | undefined) ?? [];
  const chosen = Array.isArray(value) ? ((value as string[])[0] ?? '') : '';
  const label = options.find((option) => option.id === chosen)?.label ?? null;

  if (!mayEdit) {
    return label === null ? (
      <span className="uboss-board-empty-cell">—</span>
    ) : (
      <span>{label}</span>
    );
  }

  if (options.length === 0) {
    /*
     * A dropdown with no options is a column nobody can fill.
     *
     * Said plainly rather than drawn as an empty select, which looks broken and gives somebody
     * nothing to do about it.
     */
    return <span className="uboss-board-empty-cell">No options yet</span>;
  }

  return (
    <select
      className="uboss-board-select"
      value={chosen}
      aria-label={column.title}
      onChange={(event) => onWrite(event.target.value === '' ? undefined : [event.target.value])}
    >
      <option value="">—</option>
      {options.map((option) => (
        <option key={option.id} value={option.id}>
          {option.label}
        </option>
      ))}
    </select>
  );
}

/**
 * A stretch of time: from one date to another.
 *
 * Two fields rather than a range picker, because a range picker is a popover, a calendar and a
 * month to drag through, and what somebody actually types is two dates. Either half may be empty
 * while they fill in the other; the cell clears only when both are.
 */
export function TimelineCell({
  value,
  mayEdit,
  onWrite,
}: {
  value: unknown;
  mayEdit: boolean;
  onWrite: (value: unknown) => void;
}) {
  const span =
    value !== null && typeof value === 'object' ? (value as { from?: string; to?: string }) : {};
  const from = span.from ?? '';
  const to = span.to ?? '';

  if (!mayEdit) {
    return from === '' && to === '' ? (
      <span className="uboss-board-empty-cell">—</span>
    ) : (
      <span>
        {from === '' ? '…' : new Date(from).toLocaleDateString()}
        {' → '}
        {to === '' ? '…' : new Date(to).toLocaleDateString()}
      </span>
    );
  }

  const write = (next: { from: string; to: string }) =>
    onWrite(next.from === '' && next.to === '' ? undefined : { from: next.from, to: next.to });

  return (
    <span className="uboss-board-span">
      <input
        type="date"
        className="uboss-board-input"
        value={from}
        aria-label="From"
        onChange={(event) => write({ from: event.target.value, to })}
      />
      <input
        type="date"
        className="uboss-board-input"
        value={to}
        aria-label="To"
        onChange={(event) => write({ from, to: event.target.value })}
      />
    </span>
  );
}

/**
 * A document on a row — monday.com's "monday Doc" column.
 *
 * The cell says whether there is one and how long it is; the writing happens in a dialog, because
 * a rich text editor inside a 160px table cell is neither. The text is stored on the cell like
 * every other value, so a document moves, archives and comes back with the row it belongs to
 * rather than living somewhere that has to be kept in step with it.
 */
export function DocCell({
  value,
  name,
  mayEdit,
  onWrite,
}: {
  value: unknown;
  name: string;
  mayEdit: boolean;
  onWrite: (value: unknown) => void;
}) {
  const [open, setOpen] = useState(false);
  const stored =
    value !== null && typeof value === 'object' ? ((value as { html?: string }).html ?? '') : '';

  // Words rather than characters: "412 words" is a size somebody can picture, and the tags are
  // not part of what was written.
  const words = stored
    .replace(/<[^>]*>/g, ' ')
    .trim()
    .split(/\s+/)
    .filter(Boolean).length;

  return (
    <>
      <button
        type="button"
        className="uboss-board-doc"
        onClick={() => setOpen(true)}
        aria-label={stored === '' ? `Write the ${name}` : `Open the ${name}`}
      >
        <Icon name="file" size={13} />
        {stored === '' ? (mayEdit ? 'Write' : '—') : `${words} ${words === 1 ? 'word' : 'words'}`}
      </button>

      {open ? (
        <DocDialog
          name={name}
          html={stored}
          mayEdit={mayEdit}
          onClose={() => setOpen(false)}
          onSave={(html) => {
            onWrite(html.trim() === '' ? undefined : { html });
            setOpen(false);
          }}
        />
      ) : null}
    </>
  );
}

function DocDialog({
  name,
  html,
  mayEdit,
  onClose,
  onSave,
}: {
  name: string;
  html: string;
  mayEdit: boolean;
  onClose: () => void;
  onSave: (html: string) => void;
}) {
  const [draft, setDraft] = useState(html);

  return (
    <Modal
      open
      wide
      onClose={onClose}
      title={name}
      footer={
        mayEdit ? (
          <>
            <Button variant="ghost" onClick={onClose}>
              Cancel
            </Button>
            <Button variant="primary" onClick={() => onSave(draft)}>
              Save
            </Button>
          </>
        ) : (
          <Button variant="default" onClick={onClose}>
            Close
          </Button>
        )
      }
    >
      <RichTextEditor
        value={draft}
        onChange={setDraft}
        label={name}
        disabled={!mayEdit}
        // The cursor belongs in the text, not on the close button — which is where a focus trap
        // puts it by default, because it is the first focusable thing in any dialog.
        autoFocus={mayEdit}
        placeholder="Write what this row needs somebody to know."
      />
    </Modal>
  );
}
