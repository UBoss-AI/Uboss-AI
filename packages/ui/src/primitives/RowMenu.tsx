'use client';

import { useEffect, useId, useRef, useState } from 'react';

import { cn } from '../lib/class-names';

export interface RowMenuItem {
  key: string;
  label: string;
  onSelect: () => void;
  /** Rendered below a separator and in the danger tone. Offboarding uses this. */
  destructive?: boolean;
  disabled?: boolean;
  /** A second line under the label, for context the label cannot carry. */
  detail?: string;
}

export interface RowMenuProps {
  /**
   * Whose row this is, for the trigger's accessible name.
   *
   * Twenty-four identical "More" buttons down a table are twenty-four controls a screen reader
   * cannot tell apart. "More actions for Aman Singh" is what makes the list navigable.
   */
  subject: string;
  items: readonly RowMenuItem[];
  className?: string;
}

/**
 * The actions for one row of a table, behind a single control.
 *
 * ## What this replaces
 *
 * Users & Access rendered every action as its own button in every row: Access · Change role ·
 * Suspend · Offboard, and Invite, Resend or Cancel besides. Twenty-four people made **ninety-odd
 * buttons on one screen**, which has two costs and the second is the serious one.
 *
 * The first is that it is unreadable — a wall of small grey words where the eye is looking for a
 * person's name.
 *
 * The second is that **Offboard sat next to Suspend**. Those are a temporary hold and the end of
 * somebody's employment, rendered alike, a few pixels apart, on a row that scrolls. The confirm
 * dialog is what stops the mistake, and a dialog is not where a product should be placing its only
 * defence against a mis-click. Here the destructive action is behind a menu and below a separator,
 * so reaching it is deliberate.
 *
 * ## What stays outside
 *
 * The caller keeps the row's *primary* action as a real button and passes the rest here. A menu
 * that holds everything makes the common case slower, which is how overflow menus get a bad name.
 *
 * ## Keyboard
 *
 * A menu, not a dialog, so focus moves rather than being trapped: Down opens from the trigger,
 * Up/Down walk, Home/End jump, Escape closes and returns focus, Tab closes and lets focus carry
 * on. The same behaviour as the account menu, because two menus in one product that answer the
 * keyboard differently is worse than either.
 */
export function RowMenu({ subject, items, className }: RowMenuProps) {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const itemRefs = useRef<(HTMLButtonElement | null)[]>([]);
  const menuId = useId();
  /**
   * Which way the menu opens.
   *
   * It only ever opened downward, which is right until the row is near the bottom of the window
   * — and on a table the rows near the bottom are most of them. A four-item menu on the last
   * visible row ran off the screen with two of its items unreachable, and the one below the
   * separator is the destructive one, so the item most worth reaching deliberately was the item
   * hardest to reach at all.
   *
   * Measured on open rather than guessed from a row index, because the caller knows nothing
   * about the window and the menu's own height depends on how many items it was given.
   */
  const [placement, setPlacement] = useState<'below' | 'above'>('below');

  const close = (returnFocus: boolean) => {
    setOpen(false);
    if (returnFocus) triggerRef.current?.focus();
  };

  useEffect(() => {
    if (!open) return;

    const onPointerDown = (event: PointerEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) setOpen(false);
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.stopPropagation();
        close(true);
      }
    };

    document.addEventListener('pointerdown', onPointerDown);
    document.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('pointerdown', onPointerDown);
      document.removeEventListener('keydown', onKeyDown);
    };
  }, [open]);

  useEffect(() => {
    if (!open) {
      // Back to the default for the next opening, so a menu opened once near the bottom does not
      // keep opening upward after the table has scrolled.
      setPlacement('below');
      return;
    }

    const panel = panelRef.current;
    const trigger = triggerRef.current;
    if (panel === null || trigger === null) return;

    /*
     * Up when there is no room down, and only then.
     *
     * Compared against the window rather than the table: the menu is drawn over whatever is
     * beneath it and the thing that actually cuts it off is the bottom of the screen. The gap
     * above the trigger has to be big enough as well — flipping a menu into a space it also does
     * not fit is a different bug with the same symptom, so the default stands when neither side
     * has room and the reader can at least scroll.
     */
    const panelHeight = panel.getBoundingClientRect().height;
    const spaceBelow = window.innerHeight - trigger.getBoundingClientRect().bottom;
    const spaceAbove = trigger.getBoundingClientRect().top;
    const gutter = 8;

    if (panelHeight + gutter > spaceBelow && panelHeight + gutter <= spaceAbove) {
      setPlacement('above');
    }
  }, [open]);

  useEffect(() => {
    if (open) itemRefs.current[0]?.focus();
  }, [open]);

  const focusItem = (index: number) => {
    const count = items.length;
    if (count === 0) return;
    const wrapped = ((index % count) + count) % count;
    itemRefs.current[wrapped]?.focus();
  };

  const onItemKeyDown = (event: React.KeyboardEvent<HTMLButtonElement>, index: number) => {
    switch (event.key) {
      case 'ArrowDown':
        event.preventDefault();
        focusItem(index + 1);
        break;
      case 'ArrowUp':
        event.preventDefault();
        focusItem(index - 1);
        break;
      case 'Home':
        event.preventDefault();
        focusItem(0);
        break;
      case 'End':
        event.preventDefault();
        focusItem(items.length - 1);
        break;
      case 'Tab':
        setOpen(false);
        break;
      default:
        break;
    }
  };

  // A menu with nothing in it is a control that does nothing. The row simply has no menu.
  if (items.length === 0) return null;

  return (
    <div className={cn('uboss-rowmenu', className)} ref={rootRef}>
      <button
        type="button"
        ref={triggerRef}
        className="uboss-rowmenu-trigger"
        aria-haspopup="menu"
        aria-expanded={open}
        aria-controls={open ? menuId : undefined}
        aria-label={`More actions for ${subject}`}
        onClick={() => setOpen((value) => !value)}
        onKeyDown={(event) => {
          if (event.key === 'ArrowDown' && !open) {
            event.preventDefault();
            setOpen(true);
          }
        }}
      >
        <span aria-hidden="true">⋯</span>
      </button>

      {open ? (
        <div
          className={cn('uboss-rowmenu-panel', placement === 'above' && 'is-above')}
          id={menuId}
          role="menu"
          aria-label={subject}
          ref={panelRef}
        >
          {items.map((item, index) => (
            <button
              key={item.key}
              type="button"
              role="menuitem"
              disabled={item.disabled === true}
              className={cn('uboss-rowmenu-item', item.destructive === true && 'is-destructive')}
              ref={(node) => {
                itemRefs.current[index] = node;
              }}
              onKeyDown={(event) => onItemKeyDown(event, index)}
              onClick={() => {
                close(false);
                item.onSelect();
              }}
            >
              <span>{item.label}</span>
              {item.detail === undefined ? null : (
                <small className="uboss-rowmenu-detail">{item.detail}</small>
              )}
            </button>
          ))}
        </div>
      ) : null}
    </div>
  );
}
