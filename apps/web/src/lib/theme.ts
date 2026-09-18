'use client';

/**
 * Appearance: Light, Dark or System.
 *
 * ## Why the choice lives in the browser
 *
 * Appearance is a property of the person and the device in front of them, not of the company —
 * the same person wants dark on a laptop at night and light on a bright monitor. So it is stored
 * per browser and never sent to the server. That also means it needs no permission and cannot
 * fail: a blocked store falls back to System, which is the correct default anyway.
 *
 * ## How it is applied
 *
 * `light` and `dark` stamp `data-theme` on the root element. `system` **removes** the attribute,
 * which is what lets `prefers-color-scheme` decide — see the dark block in `tokens.css`. Writing
 * `data-theme="system"` would match neither rule and silently produce the light theme, which is
 * the obvious way to get this wrong.
 */

export const THEME_CHOICES = ['light', 'dark', 'system'] as const;
export type ThemeChoice = (typeof THEME_CHOICES)[number];

export const THEME_LABELS: Record<ThemeChoice, string> = {
  light: 'Light',
  dark: 'Dark',
  system: 'Match my device',
};

export const THEME_STORAGE_KEY = 'uboss.appearance';

/** The stored choice, or `system` when there is none or the store is unreadable. */
export function readThemeChoice(): ThemeChoice {
  try {
    const stored = window.localStorage.getItem(THEME_STORAGE_KEY);
    return THEME_CHOICES.includes(stored as ThemeChoice) ? (stored as ThemeChoice) : 'system';
  } catch {
    return 'system';
  }
}

/** Applies a choice to the document. Exported so the boot script and the UI agree exactly. */
export function applyThemeChoice(choice: ThemeChoice): void {
  const root = document.documentElement;
  if (choice === 'system') {
    root.removeAttribute('data-theme');
  } else {
    root.setAttribute('data-theme', choice);
  }
}

/** Records and applies a choice. */
export function setThemeChoice(choice: ThemeChoice): void {
  try {
    window.localStorage.setItem(THEME_STORAGE_KEY, choice);
  } catch {
    // Applied for this page either way; it just will not survive a reload.
  }
  applyThemeChoice(choice);
}

/**
 * The script that runs before first paint.
 *
 * It has to be inline and synchronous in `<head>`. React cannot do this: the first paint happens
 * before any effect runs, so a dark-mode user would see a white flash on every navigation — the
 * single most common way a theme implementation looks broken even when it works.
 *
 * Deliberately tiny and wrapped in try/catch: it runs before anything else on the page, so a
 * throw here would be a blank application.
 */
export const THEME_BOOT_SCRIPT = `try{var c=localStorage.getItem('${THEME_STORAGE_KEY}');if(c==='dark'||c==='light'){document.documentElement.setAttribute('data-theme',c)}}catch(e){}`;

/**
 * The collapsed sidebar, applied before the first paint.
 *
 * Without it the server's HTML is always the expanded sidebar, so every navigation painted a
 * 248px sidebar and then animated it shut — the client's words were that it "opens and closes".
 * The same trick as the theme above, and for the same reason: a preference that decides layout has
 * to be known before anything is drawn, not after React has mounted.
 */
export const SIDEBAR_BOOT_SCRIPT = `try{if(localStorage.getItem('uboss.sidebar.collapsed')==='1'){document.documentElement.setAttribute('data-uboss-sidebar','collapsed')}}catch(e){}`;
