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
  const itemRefs = useRef<(HTMLButtonElement | null)[]>([]);
  const menuId = useId();

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
        <div className="uboss-rowmenu-panel" id={menuId} role="menu" aria-label={subject}>
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
