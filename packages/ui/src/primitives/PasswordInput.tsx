'use client';

import { useId, useState } from 'react';
import type { InputHTMLAttributes } from 'react';

import { Icon } from './Icon';

export interface PasswordInputProps extends Omit<
  InputHTMLAttributes<HTMLInputElement>,
  'type' | 'defaultValue'
> {
  /**
   * What the browser should offer. `current-password` when signing in, `new-password` when
   * choosing one — the two are different hints and getting them the wrong way round is how a
   * password manager fills a "choose a new password" box with the old one.
   */
  autoComplete: 'current-password' | 'new-password';
}

/**
 * A password field that can be read back.
 *
 * ## Why this exists at all
 *
 * Four screens ask for a password — signing in, activating an invitation, and the two boxes on
 * the reset screen — and none of them could show what had been typed. On a long generated
 * password, which is what this product's own policy pushes people towards at twelve characters
 * minimum, that turns one mistyped character into a lockout: five wrong attempts and the account
 * is locked for fifteen minutes, with no way to see which character went wrong.
 *
 * ## Why it is a component and not a prop on each field
 *
 * The toggle has more to it than swapping `type`: the button must not be a submit, it must say
 * what it does to a screen reader and say it *again* when the state changes, and it must never
 * be reachable before the field it belongs to. Written four times, one of those is forgotten
 * four times differently.
 *
 * ## It never remembers
 *
 * Revealed state resets on every mount, deliberately. A field that stayed visible because
 * somebody toggled it last week is a password on a screen in an office.
 *
 * `defaultValue` is omitted from the props on purpose: a password field must never carry a
 * prefilled credential.
 */
export function PasswordInput({ autoComplete, className, ...rest }: PasswordInputProps) {
  const [revealed, setRevealed] = useState(false);
  const describedBy = useId();

  return (
    <span className="uboss-password">
      <input
        {...rest}
        type={revealed ? 'text' : 'password'}
        autoComplete={autoComplete}
        className={className === undefined ? 'uboss-input' : className}
      />
      <button
        type="button"
        className="uboss-password-reveal"
        onClick={() => setRevealed((shown) => !shown)}
        // The control is the toggle; the label says which way it will go next.
        aria-label={revealed ? 'Hide password' : 'Show password'}
        aria-pressed={revealed}
        aria-describedby={describedBy}
        // Never focusable before the field it belongs to, and skipped by anybody tabbing through
        // the form to the submit button — they are typing, not inspecting.
        tabIndex={-1}
      >
        <Icon name={revealed ? 'eye-off' : 'eye'} size={16} />
      </button>
      {/*
        Announced on change rather than only on focus, so somebody using a screen reader is told
        their password became visible — which is a fact about the room they are in, not about the
        form.
      */}
      <span id={describedBy} className="uboss-sr-only" aria-live="polite">
        {revealed ? 'Password is visible' : 'Password is hidden'}
      </span>
    </span>
  );
}
