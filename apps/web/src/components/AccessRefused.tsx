'use client';

import Link from 'next/link';

import { Button, EmptyState } from '@uboss/ui';

/**
 * What a screen shows when the server refused its data.
 *
 * ## Why a screen needs this at all
 *
 * A refused page used to render itself anyway: a red banner across the top, and underneath it the
 * whole working surface — the search box, the status filter, the column headings, an empty table
 * saying "No objectives yet". An Employee opening Objectives got a screen that looked like a
 * screen with nothing in it, so they searched, and filtered, and found nothing, and concluded the
 * company had no objectives. The truthful answer — this is not yours to see — was one line of red
 * above a page that contradicted it.
 *
 * The distinction matters more than it sounds. "You may not see this" and "there is nothing here"
 * are different facts, and showing controls for the second when the first is true is how somebody
 * decides the software is broken.
 *
 * ## It offers a way out
 *
 * The locked rule is no dead ends. Somebody refused a page did not arrive there by accident — it
 * was in their sidebar, or a colleague sent them a link — so the screen names what they can do
 * instead of leaving them on a wall.
 *
 * ## It is presentation, and nothing more
 *
 * The refusal already happened, on the server, before this renders. Nothing here is a control:
 * hiding a screen protects nobody, and every route stays independently guarded. This only stops
 * the product from describing a refusal as an absence.
 */
export function AccessRefused({
  what,
  message,
}: {
  /** The thing they cannot see, in the words the sidebar uses: "Objectives", "the Executor Agent". */
  what: string;
  /**
   * What the server said, when it said something useful.
   *
   * Shown rather than replaced, because the API's own message often names the grant that is
   * missing — which is exactly what an administrator needs when the person forwards them this
   * screen. A generic sentence in its place would throw that away.
   */
  message?: string | null | undefined;
}): React.JSX.Element {
  return (
    <EmptyState
      icon="shield"
      title={`${what} is not part of your access`}
      description={
        message && message.trim() !== ''
          ? message
          : 'Your roles in this company do not include this. Nothing is missing and nothing has ' +
            'failed — there is simply nothing here for you to open.'
      }
      actions={
        <>
          <Link href="/dashboard">
            <Button variant="primary" size="sm">
              Go to your dashboard
            </Button>
          </Link>
          <Link href="/todo">
            <Button size="sm">See your work</Button>
          </Link>
        </>
      }
    />
  );
}

/**
 * Whether a failure was a refusal rather than a fault.
 *
 * 403 is "you may not"; 401 is "you are not signed in", which the shell handles by sending
 * somebody to the login screen. Everything else — a timeout, a 500, a network drop — is a fault,
 * and a fault must keep saying so: presenting a broken server as a permission boundary would have
 * people asking their administrator for access they already hold.
 */
export function isRefusal(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'statusCode' in error &&
    (error as { statusCode: unknown }).statusCode === 403
  );
}
