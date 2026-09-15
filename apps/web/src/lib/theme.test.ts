import { beforeEach, describe, expect, it, vi } from 'vitest';

import {
  applyThemeChoice,
  readThemeChoice,
  setThemeChoice,
  THEME_BOOT_SCRIPT,
  THEME_STORAGE_KEY,
} from './theme';

/**
 * Appearance — Light, Dark and System.
 *
 * The rule worth protecting is the one that is easy to get wrong: **System must remove the
 * attribute, not set it to "system"**. `data-theme="system"` matches neither the dark media block
 * nor the explicit dark selector, so it silently produces the light theme on a dark machine —
 * which looks exactly like the bug this whole feature exists to fix.
 */
describe('appearance', () => {
  beforeEach(() => {
    document.documentElement.removeAttribute('data-theme');
    window.localStorage.clear();
  });

  it('defaults to following the device', () => {
    expect(readThemeChoice()).toBe('system');
  });

  it('stamps an explicit choice on the root element', () => {
    setThemeChoice('dark');
    expect(document.documentElement.getAttribute('data-theme')).toBe('dark');

    setThemeChoice('light');
    expect(document.documentElement.getAttribute('data-theme')).toBe('light');
  });

  it('removes the attribute for System rather than writing "system"', () => {
    setThemeChoice('dark');
    setThemeChoice('system');

    // Not `toBe('system')` — the absence is the mechanism.
    expect(document.documentElement.hasAttribute('data-theme')).toBe(false);
  });

  it('remembers the choice', () => {
    setThemeChoice('dark');
    expect(readThemeChoice()).toBe('dark');
  });

  it('ignores a stored value that is not a choice', () => {
    window.localStorage.setItem(THEME_STORAGE_KEY, 'midnight');
    expect(readThemeChoice()).toBe('system');
  });

  it('survives a store that throws', () => {
    const getItem = vi.spyOn(window.localStorage, 'getItem').mockImplementation(() => {
      throw new Error('site data blocked');
    });
    const setItem = vi.spyOn(window.localStorage, 'setItem').mockImplementation(() => {
      throw new Error('site data blocked');
    });

    // A private window must still get a working, themed application.
    expect(readThemeChoice()).toBe('system');
    expect(() => setThemeChoice('dark')).not.toThrow();
    expect(document.documentElement.getAttribute('data-theme')).toBe('dark');

    getItem.mockRestore();
    setItem.mockRestore();
  });

  it('previews without storing', () => {
    setThemeChoice('light');
    applyThemeChoice('dark');

    expect(document.documentElement.getAttribute('data-theme')).toBe('dark');
    // The stored preference is untouched, so leaving the control puts it back.
    expect(readThemeChoice()).toBe('light');
  });

  describe('the pre-paint boot script', () => {
    it('applies a stored dark choice before React runs', () => {
      window.localStorage.setItem(THEME_STORAGE_KEY, 'dark');
      new Function(THEME_BOOT_SCRIPT)();

      expect(document.documentElement.getAttribute('data-theme')).toBe('dark');
    });

    it('sets nothing for System, so prefers-color-scheme decides', () => {
      window.localStorage.setItem(THEME_STORAGE_KEY, 'system');
      new Function(THEME_BOOT_SCRIPT)();

      expect(document.documentElement.hasAttribute('data-theme')).toBe(false);
    });

    it('cannot throw, whatever the store does', () => {
      const getItem = vi.spyOn(window.localStorage, 'getItem').mockImplementation(() => {
        throw new Error('blocked');
      });

      // This runs before anything else on the page; a throw here is a blank application.
      expect(() => new Function(THEME_BOOT_SCRIPT)()).not.toThrow();

      getItem.mockRestore();
    });
  });
});
