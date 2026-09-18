/**
 * Where the collapsed sidebar preference lives, and how it reaches the page before React does.
 *
 * ## Why an attribute on <html> and not just React state
 *
 * Every screen mounts its own shell, so navigating remounted the sidebar with `collapsed` false
 * and only corrected it in an effect — after the first paint. The result was the sidebar opening
 * to its full 248px and animating shut again on the way to every screen. Measured across one
 * navigation: 74, 248, 240, 216, 187, 160, 139, 98, 90, 80, 77, 75.
 *
 * A boot script sets this attribute before the first paint, exactly as the theme does, so the
 * layout is right in the very first frame the browser draws — including the frame the server's
 * HTML produces, which React has not touched yet.
 *
 * One key for both shells: it is the same person.
 */
export const SIDEBAR_COLLAPSED_STORAGE_KEY = 'uboss.sidebar.collapsed';

/** `data-uboss-sidebar="collapsed"` on the document element. */
export const SIDEBAR_COLLAPSED_ATTRIBUTE = 'data-uboss-sidebar';
export const SIDEBAR_COLLAPSED_VALUE = 'collapsed';

/** Reads what the boot script left, for a shell deciding its first render. */
export function sidebarCollapsedFromDocument(): boolean {
  if (typeof document === 'undefined') return false;
  return (
    document.documentElement.getAttribute(SIDEBAR_COLLAPSED_ATTRIBUTE) === SIDEBAR_COLLAPSED_VALUE
  );
}

/** Records the choice where both the next paint and the next page can find it. */
export function rememberSidebarCollapsed(collapsed: boolean): void {
  if (typeof document !== 'undefined') {
    if (collapsed) {
      document.documentElement.setAttribute(SIDEBAR_COLLAPSED_ATTRIBUTE, SIDEBAR_COLLAPSED_VALUE);
    } else {
      document.documentElement.removeAttribute(SIDEBAR_COLLAPSED_ATTRIBUTE);
    }
  }
  try {
    window.localStorage.setItem(SIDEBAR_COLLAPSED_STORAGE_KEY, collapsed ? '1' : '0');
  } catch {
    // Private window, or site data blocked. The sidebar still collapses; it just will not be
    // remembered.
  }
}
