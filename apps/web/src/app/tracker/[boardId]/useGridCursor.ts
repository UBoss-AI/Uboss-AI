'use client';

import { useCallback, useEffect, useRef, useState } from 'react';

/**
 * The cell cursor that makes a board feel like a spreadsheet.
 *
 * ## Why this exists
 *
 * A table you can click is not a board. What makes monday.com's feel like a sheet is that the
 * keyboard owns it: arrows and Tab move a cursor, Enter opens the cell under it, Backspace
 * clears it. Somebody filling in forty rows never reaches for the mouse, and that is the
 * difference between a grid and a form with lines on it.
 *
 * The shortcuts are monday's own, so nobody arriving from it has to learn a second set:
 *
 *   * **Arrows / Tab / Shift+Tab** — move
 *   * **Enter** — edit the cell under the cursor
 *   * **Backspace / Delete** — clear it
 *   * **Escape** — leave the cell without changing it
 *
 * ## Why focus is a DOM id rather than a ref per cell
 *
 * A board is rows times columns of components, and a ref for each is a map the size of the board
 * that has to be rebuilt every time a row is added. The cursor is two numbers; the element it
 * means is found by id when it is needed. Nothing is held between renders that a re-render could
 * make stale.
 */
export interface GridCursor {
  row: number;
  column: number;
}

export function cellDomId(boardId: string, row: number, column: number): string {
  return `cell-${boardId}-${row}-${column}`;
}

export function useGridCursor(input: {
  boardId: string;
  rowCount: number;
  /** How many value columns there are. The name is column -1 and is never counted here. */
  columnCount: number;
  enabled: boolean;
}) {
  const [cursor, setCursor] = useState<GridCursor | null>(null);
  const moved = useRef(false);

  /*
   * Put the browser's focus where the cursor is, but only after the cursor was moved by a key.
   *
   * Without the flag, every re-render — and a board re-reads itself after each write — would drag
   * focus back to the cursor and steal it from whatever somebody had clicked into.
   */
  useEffect(() => {
    if (cursor === null || !moved.current) return;
    moved.current = false;
    document.getElementById(cellDomId(input.boardId, cursor.row, cursor.column))?.focus();
  }, [cursor, input.boardId]);

  const move = useCallback(
    (rowStep: number, columnStep: number) => {
      moved.current = true;
      setCursor((current) => {
        const from = current ?? { row: 0, column: -1 };
        let row = from.row + rowStep;
        let column = from.column + columnStep;

        /*
         * Tab wraps, arrows do not.
         *
         * Running off the right with Tab lands on the first cell of the next row, which is how a
         * sheet behaves and how somebody fills a row in without looking. An arrow key stopping at
         * the edge is also how a sheet behaves — it is a direction, not a sequence.
         */
        if (columnStep !== 0 && rowStep === 0) {
          if (column > input.columnCount - 1) {
            column = -1;
            row += 1;
          } else if (column < -1) {
            column = input.columnCount - 1;
            row -= 1;
          }
        }

        return {
          row: Math.max(0, Math.min(input.rowCount - 1, row)),
          column: Math.max(-1, Math.min(input.columnCount - 1, column)),
        };
      });
    },
    [input.rowCount, input.columnCount],
  );

  const put = useCallback((next: GridCursor) => {
    // From a click. No focus is forced: the browser has already put it where it was clicked.
    moved.current = false;
    setCursor(next);
  }, []);

  /**
   * The table's key handler.
   *
   * Returns true when it took the key, so the caller can stop the browser doing its own thing
   * with it — Tab moving out of the board, Backspace going back a page.
   */
  const onKeyDown = useCallback(
    (event: React.KeyboardEvent): boolean => {
      if (!input.enabled) return false;

      /*
       * Not while somebody is typing.
       *
       * A text cell under edit owns its arrows, its Backspace and its Enter — moving the cursor
       * out from under a half-typed word is the single most irritating thing a grid can do.
       * Escape is the way out, and it is the only key taken back.
       */
      const target = event.target as HTMLElement;
      const editing =
        target.tagName === 'INPUT' || target.tagName === 'SELECT' || target.isContentEditable;

      if (editing) {
        if (event.key === 'Escape') {
          target.blur();
          moved.current = true;
          setCursor((current) => current);
          return true;
        }
        return false;
      }

      switch (event.key) {
        case 'ArrowDown':
          move(1, 0);
          return true;
        case 'ArrowUp':
          move(-1, 0);
          return true;
        case 'ArrowRight':
          move(0, 1);
          return true;
        case 'ArrowLeft':
          move(0, -1);
          return true;
        case 'Tab':
          move(0, event.shiftKey ? -1 : 1);
          return true;
        case 'Enter': {
          // The cell's own control, whatever kind it is. Nothing here knows what a Status cell
          // or a Date cell is made of, which is what keeps the ninth kind from needing a change.
          const cell =
            cursor === null
              ? null
              : document.getElementById(cellDomId(input.boardId, cursor.row, cursor.column));
          cell?.querySelector<HTMLElement>('input, select, textarea, button')?.focus();
          return true;
        }
        default:
          return false;
      }
    },
    [cursor, input.boardId, input.enabled, move],
  );

  return { cursor, put, onKeyDown };
}
