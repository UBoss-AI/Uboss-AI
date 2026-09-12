'use client';

import { useEffect, useRef } from 'react';

const FOCUSABLE = [
  'a[href]',
  'button:not([disabled])',
  'input:not([disabled]):not([type="hidden"])',
  'select:not([disabled])',
  'textarea:not([disabled])',
  '[tabindex]:not([tabindex="-1"])',
].join(',');

/**
 * Trap focus inside an overlay while it is open, and restore it on close.
 *
 * Enterprise dialogs are frequently the confirmation gate on a dangerous action, so a keyboard
 * user must not be able to Tab out into the page behind and act on the wrong control.
 *
 * ## Why `onClose` is held in a ref
 *
 * It used to be a dependency of the effect below, and every caller passes it as an inline arrow
 * (`onClose={() => setOpen(false)}`), so the identity changed on **every render**. The effect
 * therefore tore down and re-ran on every render — and its first act is to focus the first
 * focusable element in the dialog.
 *
 * The result was that typing into any field in any modal moved focus back to the first control
 * after a single character: the work email on Invite User, the reason on Suspend, the correction
 * on Report Issue. Found while testing the CR-03 dialogs, where a textarea ended up holding one
 * letter of a sentence.
 *
 * The handler still has to see the *current* `onClose`, so it is read through a ref rather than
 * captured — the effect runs once per open, and Escape still calls whatever the latest close is.
 */
export function useFocusTrap(open: boolean, onClose?: () => void) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const previouslyFocused = useRef<HTMLElement | null>(null);

  // Kept current without being a dependency. See the note above.
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;

  useEffect(() => {
    if (!open) {
      return;
    }

    previouslyFocused.current = document.activeElement as HTMLElement | null;

    const container = containerRef.current;
    if (container) {
      const first = container.querySelector<HTMLElement>(FOCUSABLE);
      (first ?? container).focus();
    }

    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && onCloseRef.current) {
        event.stopPropagation();
        onCloseRef.current();
        return;
      }

      if (event.key !== 'Tab') {
        return;
      }

      const node = containerRef.current;
      if (!node) {
        return;
      }

      const focusable = Array.from(node.querySelectorAll<HTMLElement>(FOCUSABLE)).filter(
        (element) => element.offsetParent !== null || element === document.activeElement,
      );
      if (focusable.length === 0) {
        return;
      }

      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      if (!first || !last) {
        return;
      }

      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    };

    document.addEventListener('keydown', handleKeyDown, true);

    // Prevent the page behind the overlay from scrolling.
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';

    return () => {
      document.removeEventListener('keydown', handleKeyDown, true);
      document.body.style.overflow = previousOverflow;
      previouslyFocused.current?.focus();
    };
  }, [open]);

  return containerRef;
}
