'use client';

import { useEffect, useId, useRef, useState } from 'react';

import { cn } from '../lib/class-names';
import { initials } from '../lib/initials';
import { Icon, type IconName } from '../primitives/Icon';
import type { SidebarUser } from './Sidebar';

export interface AccountMenuItem {
  key: string;
  label: string;
  icon?: IconName;
  onSelect: () => void;
  /**
   * Rendered below a separator. Sign out uses this: the audit brief asks for it to be visually
   * separated and not easy to trigger by accident, and a separator is what does that.
   */
  separated?: boolean;
  /** A second line under the label, for context a label cannot carry on its own. */
  detail?: string;
}

export interface AccountMenuProps {
  user: SidebarUser;
  /** Role and scope, e.g. "Company Admin · Whole company". Shown in the menu header. */
  scopeLabel?: string | undefined;
  items: readonly AccountMenuItem[];
  className?: string;
}

/**
 * The account menu behind the top bar's avatar.
 *
 * ## What this replaces
 *
 * The top bar had a **standalone key-icon button** whose only job was to sign out, and an avatar
 * that was a `<div aria-hidden="true">` — not focusable, not clickable, invisible to a screen
 * reader. So the one control that ends your session was a padlock-ish glyph sitting next to the
 * notification bell, one mis-click away, and the thing that looks like a profile control did
 * nothing at all. Both are what the audit brief §7 objects to.
 *
 * ## Only real destinations
 *
 * The items are supplied by the host, and the host only passes what exists. "Switch workspace" is
 * offered when the person actually holds more than one membership and not otherwise, because an
 * option that is always there and never works is worse than its absence.
 *
 * ## Keyboard
 *
 * A menu, not a dialog, so focus is moved rather than trapped: Up/Down walk the items, Home/End
 * jump, Enter and Space activate, Escape closes and returns focus to the avatar, and Tab closes
 * and lets focus continue past it. Clicking outside closes. The trigger carries
 * `aria-haspopup="menu"` and `aria-expanded`, so assistive technology announces it as what it is.
 */
export function AccountMenu({ user, scopeLabel, items, className }: AccountMenuProps) {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const itemRefs = useRef<(HTMLButtonElement | null)[]>([]);
  const menuId = useId();

  const close = (returnFocus: boolean) => {
    setOpen(false);
    if (returnFocus) triggerRef.current?.focus();
  };

  // Close on a click anywhere else, and on Escape from anywhere inside.
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

  // Opening moves focus to the first item, which is what a menu is expected to do.
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
        // Let focus leave rather than fighting it, but do not leave an open menu behind.
        setOpen(false);
        break;
      default:
        break;
    }
  };

  return (
    <div className={cn('uboss-account', className)} ref={rootRef}>
      <button
        type="button"
        ref={triggerRef}
        className="uboss-account-trigger"
        aria-haspopup="menu"
        aria-expanded={open}
        aria-controls={open ? menuId : undefined}
        // The accessible name is the person, because that is what the control is about. The word
        // "menu" is carried by the role, not by the label.
        aria-label={`${user.name} — account menu`}
        onClick={() => setOpen((value) => !value)}
        onKeyDown={(event) => {
          if (event.key === 'ArrowDown' && !open) {
            event.preventDefault();
            setOpen(true);
          }
        }}
      >
        <span className="uboss-avatar" aria-hidden="true">
          {initials(user.name)}
        </span>
      </button>

      {open ? (
        <div className="uboss-account-menu" role="menu" id={menuId} aria-label="Account">
          <div className="uboss-account-head">
            <b>{user.name}</b>
            {scopeLabel !== undefined ? <span>{scopeLabel}</span> : null}
          </div>

          {items.map((item, index) => (
            <div key={item.key} className={cn(item.separated && 'uboss-account-separated')}>
              <button
                type="button"
                role="menuitem"
                className="uboss-account-item"
                ref={(element) => {
                  itemRefs.current[index] = element;
                }}
                onKeyDown={(event) => onItemKeyDown(event, index)}
                onClick={() => {
                  // Close first: a selection that navigates would otherwise leave the menu open
                  // over the new screen.
                  setOpen(false);
                  item.onSelect();
                }}
              >
                {item.icon !== undefined ? <Icon name={item.icon} size={16} /> : null}
                <span className="uboss-account-item-text">
                  {item.label}
                  {item.detail !== undefined ? <small>{item.detail}</small> : null}
                </span>
              </button>
            </div>
          ))}
        </div>
      ) : null}
    </div>
  );
}
