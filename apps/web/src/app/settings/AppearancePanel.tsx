'use client';

import { useEffect, useState } from 'react';

import { Card, CardBody, CardHeader } from '@uboss/ui';

import {
  applyThemeChoice,
  readThemeChoice,
  setThemeChoice,
  THEME_CHOICES,
  THEME_LABELS,
  type ThemeChoice,
} from '../../lib/theme';

/**
 * Appearance.
 *
 * Settings has listed this section since Prompt 14 and it changed nothing: there was no
 * `prefers-color-scheme` rule and no theme attribute anywhere in the product, so the whole
 * application was light regardless of the device. This is the control, and the theme it drives is
 * defined in `packages/ui/src/styles/tokens.css`.
 *
 * ## Why there is no Save button
 *
 * The choice applies as it is made and is stored in the browser, because it is a property of this
 * person on this device rather than company configuration — the same person reasonably wants dark
 * at night and light on a bright monitor. Nothing is sent to the server, so there is nothing to
 * save, nothing to authorize and nothing that can fail.
 *
 * ## Why "Match my device" is the default
 *
 * It is the only option that is right without being chosen. Someone whose machine is already dark
 * should not have to find this screen to stop being dazzled.
 */
export function AppearancePanel() {
  const [choice, setChoice] = useState<ThemeChoice>('system');
  const [systemIsDark, setSystemIsDark] = useState(false);

  // Read after mount: this component server-renders, and localStorage does not exist there.
  useEffect(() => {
    setChoice(readThemeChoice());

    const query = window.matchMedia('(prefers-color-scheme: dark)');
    setSystemIsDark(query.matches);

    // Follow the device while "Match my device" is selected, so switching the OS theme is
    // reflected without a reload. The tokens do this on their own; this only keeps the label
    // underneath the option honest.
    const onChange = (event: MediaQueryListEvent) => setSystemIsDark(event.matches);
    query.addEventListener('change', onChange);
    return () => query.removeEventListener('change', onChange);
  }, []);

  const select = (next: ThemeChoice) => {
    setChoice(next);
    setThemeChoice(next);
  };

  return (
    <Card>
      <CardHeader title="Appearance" />
      <CardBody>
        <div role="radiogroup" aria-label="Appearance" className="uboss-theme-choices">
          {THEME_CHOICES.map((option) => (
            <button
              key={option}
              type="button"
              role="radio"
              aria-checked={choice === option}
              className={`uboss-theme-choice${choice === option ? ' is-on' : ''}`}
              onClick={() => select(option)}
              // Preview on hover so the choice can be seen before it is made, and put back on
              // leave. The stored value is untouched until a click.
              onMouseEnter={() => applyThemeChoice(option)}
              onMouseLeave={() => applyThemeChoice(choice)}
              onFocus={() => applyThemeChoice(option)}
              onBlur={() => applyThemeChoice(choice)}
            >
              <span className="uboss-theme-swatch" data-variant={option} aria-hidden="true" />
              <b>{THEME_LABELS[option]}</b>
              {option === 'system' ? (
                <span className="uboss-theme-note">
                  Currently {systemIsDark ? 'dark' : 'light'}
                </span>
              ) : null}
            </button>
          ))}
        </div>
      </CardBody>
    </Card>
  );
}
