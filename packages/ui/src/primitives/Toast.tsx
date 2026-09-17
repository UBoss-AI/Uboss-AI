'use client';

import { motion } from 'motion/react';
import { useEffect, useRef, useState } from 'react';

import { cn } from '../lib/class-names';
import { transition } from '../motion/motion';
import { Icon } from './Icon';

/**
 * A short, transient message about something that has already happened.
 *
 * ## What this is not for
 *
 * It does not replace inline validation. A field that is wrong must say so beside itself, where
 * the person is looking and for as long as it stays wrong — a toast that reports a validation
 * error puts the explanation somewhere else and then takes it away, which is worse than silence
 * because the person now knows something is wrong and cannot see what.
 *
 * It is also not for anything a person needs to act on. Nothing dismissible-by-timeout may carry
 * the only copy of information, and nothing here takes focus: a toast that stole focus from the
 * control you were using would make the interface unusable with a keyboard for as long as it was
 * on screen.
 *
 * So the whole permitted set is: a save that succeeded, an action that completed, a recoverable
 * error worth mentioning once, and the state of something happening in the background.
 *
 * ## Where it sits
 *
 * Bottom left, above the page and clear of the primary controls, which in this product live at the
 * bottom right of a drawer footer and the top right of the top bar. A toast that covers the button
 * you were about to press is a toast that causes the next mistake.
 *
 * ## How it announces itself
 *
 * `role="status"` for the ordinary cases, so a screen reader mentions it at the next pause without
 * interrupting. `role="alert"` only for an error, because that one is worth interrupting for.
 * Either way the message is in the DOM as text — the motion is decoration on top of something
 * already readable.
 */
export type ToastTone = 'ok' | 'info' | 'error' | 'working';

export interface ToastProps {
  /** The message. One sentence: it is going away. */
  message: string;
  tone?: ToastTone;
  /**
   * Milliseconds before it leaves on its own. `null` keeps it until dismissed, which is right for
   * a background job whose end is the thing being reported.
   */
  durationMs?: number | null;
  onDismiss?: () => void;
  className?: string;
}

const ICONS = { ok: 'check', info: 'bell', error: 'alert', working: 'clock' } as const;

export function Toast({ message, tone = 'info', durationMs = 5000, onDismiss, className }: ToastProps) {
  const [leaving, setLeaving] = useState(false);
  const dismiss = useRef(onDismiss);
  dismiss.current = onDismiss;

  useEffect(() => {
    if (durationMs === null) return undefined;
    /*
     * Five seconds is the default because a message shorter than the time it takes to notice and
     * read it is not a message. `working` never expires on its own — it is reporting something
     * that has not finished, and removing it would be claiming it had.
     */
    const timer = window.setTimeout(() => {
      setLeaving(true);
      dismiss.current?.();
    }, durationMs);
    return () => window.clearTimeout(timer);
  }, [durationMs]);

  return (
    <motion.div
      className={cn('uboss-toast', `uboss-toast--${tone}`, className)}
      // An error interrupts; everything else waits for a pause.
      role={tone === 'error' ? 'alert' : 'status'}
      // Never takes focus. It is not a dialog and there is nothing in it to operate except the
      // dismiss, which is reachable in the normal tab order.
      initial={{ opacity: 0, y: 8 }}
      animate={{ opacity: leaving ? 0 : 1, y: leaving ? 4 : 0 }}
      transition={transition('panel', 'enter')}
    >
      <Icon name={ICONS[tone]} size={15} />
      <span className="uboss-toast-message">{message}</span>
      {onDismiss === undefined ? null : (
        <button
          type="button"
          className="uboss-toast-close"
          onClick={() => {
            setLeaving(true);
            onDismiss();
          }}
          aria-label="Dismiss this message"
        >
          <Icon name="close" size={14} />
        </button>
      )}
    </motion.div>
  );
}

/**
 * Where toasts go. One per screen, rendered by the shell.
 *
 * A region rather than a bare stack, so assistive technology can find it, and labelled, so the
 * label is not the first toast's text.
 */
export function ToastRegion({ children, className }: { children?: React.ReactNode; className?: string }) {
  return (
    <div className={cn('uboss-toast-region', className)} aria-label="Notifications" role="region">
      {children}
    </div>
  );
}
