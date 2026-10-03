'use client';

import type { ReactNode } from 'react';

import { cn } from '../lib/class-names';

/**
 * A sign-in button for a named identity provider.
 *
 * ## What this is, and what it is not
 *
 * It is a branded face on the connection the company has configured. Google, Microsoft and Apple
 * are all OIDC providers, and UBoss already speaks OIDC — the button carries the mark so people
 * recognise the door, and the click starts the same real authorization redirect any other OIDC
 * connection starts.
 *
 * It is **not** a way to make a provider appear to work. A button is only rendered for a
 * connection that exists and is enabled, because a Google mark that does nothing is worse than no
 * Google mark: somebody will click it, be refused, and conclude their account is broken rather
 * than that the company has not set it up.
 *
 * ## The marks
 *
 * Drawn from each provider's own published geometry and left in their own colours, because that is
 * what makes them recognisable and it is what each provider's brand terms require. They are
 * `aria-hidden`: the button's text already names the provider, and a screen reader does not need
 * to hear the shape described as well.
 */
export type ProviderKind = 'google' | 'microsoft' | 'apple' | 'generic';

export interface ProviderButtonProps {
  kind: ProviderKind;
  /** What the button says. The company's own wording for the connection, when it has one. */
  label: string;
  onClick?: (() => void) | undefined;
  disabled?: boolean | undefined;
  /** Why it cannot be used, when it cannot. Shown on hover and to assistive technology. */
  title?: string | undefined;
  className?: string;
}

const MARKS: Record<ProviderKind, ReactNode> = {
  google: (
    <svg width="18" height="18" viewBox="0 0 48 48" aria-hidden="true" focusable="false">
      <path
        fill="#EA4335"
        d="M24 9.5c3.5 0 6.6 1.2 9 3.6l6.7-6.7C35.6 2.7 30.2.5 24 .5 14.6.5 6.5 5.9 2.6 13.8l7.8 6.1C12.3 13.9 17.6 9.5 24 9.5z"
      />
      <path
        fill="#4285F4"
        d="M46.6 24.5c0-1.6-.15-3.2-.43-4.7H24v9h12.7c-.55 2.9-2.2 5.4-4.7 7.1l7.6 5.9c4.4-4.1 7-10.1 7-17.3z"
      />
      <path fill="#FBBC05" d="M10.4 28.6a14.5 14.5 0 010-9.2l-7.8-6.1a24 24 0 000 21.4l7.8-6.1z" />
      <path
        fill="#34A853"
        d="M24 47.5c6.2 0 11.5-2 15.3-5.6l-7.6-5.9c-2.1 1.4-4.8 2.3-7.7 2.3-6.4 0-11.7-4.4-13.6-10.3l-7.8 6.1C6.5 42.1 14.6 47.5 24 47.5z"
      />
    </svg>
  ),
  microsoft: (
    <svg width="18" height="18" viewBox="0 0 23 23" aria-hidden="true" focusable="false">
      <path fill="#F25022" d="M1 1h10v10H1z" />
      <path fill="#7FBA00" d="M12 1h10v10H12z" />
      <path fill="#00A4EF" d="M1 12h10v10H1z" />
      <path fill="#FFB900" d="M12 12h10v10H12z" />
    </svg>
  ),
  apple: (
    <svg width="18" height="18" viewBox="0 0 24 24" aria-hidden="true" focusable="false">
      <path
        fill="currentColor"
        d="M16.4 12.7c0-2.5 2-3.7 2.1-3.8-1.1-1.7-2.9-1.9-3.5-1.9-1.5-.2-2.9.9-3.7.9-.8 0-1.9-.9-3.1-.8-1.6 0-3.1.9-3.9 2.4-1.7 2.9-.4 7.1 1.2 9.4.8 1.1 1.7 2.4 3 2.4 1.2 0 1.6-.8 3.1-.8 1.4 0 1.9.8 3.1.7 1.3 0 2.1-1.2 2.9-2.3.9-1.3 1.3-2.6 1.3-2.7 0 0-2.5-1-2.5-3.5zM14 5.2c.7-.8 1.1-1.9 1-3-1 0-2.2.7-2.9 1.5-.6.7-1.2 1.9-1 3 1.1.1 2.2-.6 2.9-1.5z"
      />
    </svg>
  ),
  generic: null,
};

export function ProviderButton({
  kind,
  label,
  onClick,
  disabled,
  title,
  className,
}: ProviderButtonProps) {
  return (
    <button
      type="button"
      className={cn('uboss-provider-btn', `uboss-provider-btn--${kind}`, className)}
      onClick={onClick}
      disabled={disabled}
      {...(title === undefined ? {} : { title })}
    >
      <span className="uboss-provider-mark" aria-hidden="true">
        {MARKS[kind]}
      </span>
      <span className="uboss-provider-label">{label}</span>
    </button>
  );
}

/**
 * Which provider a connection belongs to, read from its issuer.
 *
 * The issuer is the provider's own identifier and is the only thing here that cannot be typed
 * wrong by whoever named the connection — a company can call its connection anything, so matching
 * on the display name would put an Apple mark on a Google connection the first time somebody
 * wrote "Apple SSO (via Google Workspace)".
 *
 * Anything unrecognised is `generic`, which gets the shield and the company's own wording. That is
 * the right default: a provider this does not know about is not a provider to guess at.
 */
export function providerKindFrom(issuer: string | null | undefined): ProviderKind {
  if (!issuer) return 'generic';

  let hostname: string;
  try {
    hostname = new URL(issuer).hostname.toLowerCase().replace(/\.$/, '');
  } catch {
    return 'generic';
  }

  if (hostname === 'accounts.google.com') return 'google';
  if (hostname === 'login.microsoftonline.com' || hostname === 'sts.windows.net') {
    return 'microsoft';
  }
  if (hostname === 'appleid.apple.com') return 'apple';
  return 'generic';
}
