'use client';

import { useRouter } from 'next/navigation';

import { AppShell, type AppShellProps } from '@uboss/ui';

/**
 * `AppShell` with the sidebar's links turned into client-side transitions.
 *
 * ## Why this is a wrapper and not a prop on every page
 *
 * Every company screen used to build its own `AppShell` and pass `onNavigate={() => undefined}`.
 * The Sidebar's only route out was that callback, so the entire navigation did nothing — on all
 * twenty-six of them — and nobody noticed, because a handler that does nothing looks exactly like
 * a handler that works.
 *
 * Two things stop that recurring. The Sidebar's items are real `<a href>` elements, so navigation
 * survives this component being forgotten entirely; and the router wiring lives here, once, rather
 * than being re-typed per page where it can be re-forgotten.
 *
 * ## Why the plain-link fallback matters
 *
 * `preventDefault()` is called **only** for an ordinary left click with no modifier. Ctrl/Cmd-click,
 * middle-click, shift-click and a right-click "open in new tab" are left to the browser, which is
 * the behaviour people expect from navigation and the reason it had to be a link rather than a
 * button in the first place.
 */
export function RoutedAppShell(props: AppShellProps) {
  const router = useRouter();

  return (
    <AppShell
      {...props}
      onNavigate={(key, href, event) => {
        props.onNavigate?.(key, href, event);
        if (href === undefined) return;

        // Let the browser handle anything that is not a plain left click.
        if (
          event.defaultPrevented ||
          event.button !== 0 ||
          event.metaKey ||
          event.ctrlKey ||
          event.shiftKey ||
          event.altKey
        ) {
          return;
        }

        event.preventDefault();
        router.push(href);
      }}
    />
  );
}
