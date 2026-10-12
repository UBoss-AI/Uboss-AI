'use client';

import { motion } from 'motion/react';
import { useId, useMemo, useState, type ReactNode } from 'react';

import { Icon } from '../primitives/Icon';
import { cn } from '../lib/class-names';
import { transition } from '../motion/motion';
import { SETTINGS_GROUPS, type SettingsSection } from '../navigation/navigation-model';

export interface SettingsShellProps {
  /**
   * Sections in this user's scope. The caller passes only permitted sections — the server
   * decides scope, and every section's data is separately authorized.
   */
  sections: readonly SettingsSection[];
  activeKey: string;
  onSelect: (key: string) => void;
  /**
   * Use the personal label variants (My Profile, Login & Security, My Connections,
   * My Agent Preferences) for non-admin roles, per the approved UI reference.
   */
  personalLabels?: boolean;
  /** The right-hand detail panel. */
  children: ReactNode;
  className?: string;
}

/**
 * Company Settings shell: left settings navigation, right detail panel (locked UI rule).
 *
 * ## The search box
 *
 * Nineteen categories is more than a person scans comfortably, and the ones people actually come
 * looking for — notifications, providers, budgets — sit in the middle of the list. The filter
 * matches on the label *and* the description, so "budget" finds Tokens & Cost and "password"
 * finds Security even though neither word is in the category name.
 *
 * It filters only what is already there. Sections the server withheld were never passed to this
 * component, so searching cannot surface one: an empty result means this person has no matching
 * category, never that a category is hidden behind the search.
 */
export function SettingsShell({
  sections,
  activeKey,
  onSelect,
  personalLabels = false,
  children,
  className,
}: SettingsShellProps) {
  const [query, setQuery] = useState('');
  const searchId = useId();
  // Scoped per instance, like the sidebar's: a second settings list on the same screen sharing
  // this id would send the highlight travelling between the two.
  const indicatorId = useId();

  const labelFor = (section: SettingsSection) =>
    personalLabels && section.personalLabel ? section.personalLabel : section.label;

  const visible = useMemo(() => {
    const needle = query.trim().toLowerCase();
    if (needle === '') return sections;
    return sections.filter((section) =>
      `${labelFor(section)} ${section.description ?? ''}`.toLowerCase().includes(needle),
    );
    // `labelFor` is derived from `personalLabels`, which is in the dependency list.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sections, query, personalLabels]);

  return (
    <div className={cn('uboss-settings', className)}>
      <nav className="uboss-settings-nav" aria-label="Settings sections">
        {/*
          The top bar's search markup, reused rather than restyled: same `.uboss-search` wrapper,
          same icon placement, so the two search boxes in the product cannot drift apart.

          Labelled rather than placeholder-only — a placeholder disappears the moment somebody
          types, leaving a screen reader and a distracted reader with an unnamed box.

          It sits outside the scrolling list, not stuck to the top of it. Sticky put it in the
          same scroll flow as the categories, and the band of nav padding it could not paint over
          let a category name show through the box while the list moved under it — reported as the
          search box and "Objective Rules" drawn on top of each other. A box that never scrolls
          cannot be overlapped by what does.
        */}
        <div className="uboss-search uboss-settings-search">
          <label className="uboss-sr-only" htmlFor={searchId}>
            Search settings
          </label>
          <span className="uboss-search-icon">
            <Icon name="search" size={14} />
          </span>
          <input
            id={searchId}
            type="search"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="Search settings"
            autoComplete="off"
          />
        </div>

        {/*
          Banded by what somebody came to do.

          A flat list of a dozen — General, Users & Access, Roles & Permissions, Objective Rules,
          Agent Policy, Tokens & Cost, Integrations, Notifications, Security, Billing, Appearance —
          in no order anybody could name, so finding one meant reading all of them, every time.

          A band with nothing in it is not drawn: which sections a reader gets depends on their
          grants, and an empty "Money" heading would say the product had lost something.

          While searching, the headings go: a filtered list is already short, and grouping three
          results under three headings is more chrome than answer.
        */}
        {/*
          The one thing on this screen that scrolls on its own.

          Nineteen categories do not fit a dialog, and giving the whole dialog a scrollbar made
          two of them: one for the dialog and one for the panel beside this, so a reader had to
          work out which of them moved the thing they were looking at. The list scrolls here, the
          panel scrolls in its own box, and the dialog itself does not move at all.
        */}
        <div className="uboss-settings-nav-list">
          {(query.trim() === '' ? SETTINGS_GROUPS : ['' as const]).map((group) => {
            const inGroup =
              query.trim() === '' ? visible.filter((section) => section.group === group) : visible;
            if (inGroup.length === 0) return null;

            return (
              <div key={group || 'results'}>
                {group === '' ? null : <div className="uboss-settings-nav-group">{group}</div>}
                {inGroup.map((section) => {
                  const active = section.key === activeKey;

                  return (
                    <button
                      key={section.key}
                      type="button"
                      className="uboss-settings-nav-item"
                      aria-current={active ? 'page' : undefined}
                      onClick={() => onSelect(section.key)}
                    >
                      {active ? (
                        <motion.span
                          layoutId={indicatorId}
                          className="uboss-settings-indicator"
                          aria-hidden="true"
                          transition={transition('panel', 'standard')}
                        />
                      ) : null}
                      <span className="uboss-settings-nav-label">{labelFor(section)}</span>
                      {/*
                      Marks the three entries that leave the dialog.

                      Ten of these swap a panel in place; Users & Access, Billing and UBoss
                      Profile Search are screens of their own and close the dialog to open one.
                      That is the right call — each is far too big to read in a dialog 433px tall
                      — but the list said nothing about it, so the only way to learn which was
                      which was to press one and lose your place. The title carries the same
                      sentence for anybody who cannot see the arrow.
                    */}
                      {section.opensScreen === true ? (
                        <span
                          className="uboss-settings-nav-leaves"
                          aria-hidden="true"
                          title="Opens its own screen"
                        >
                          ↗
                        </span>
                      ) : null}
                    </button>
                  );
                })}
              </div>
            );
          })}

          {visible.length === 0 ? (
            <p className="uboss-settings-nav-empty" role="status">
              No settings match “{query.trim()}”.
            </p>
          ) : null}
        </div>
      </nav>

      <div className="uboss-settings-panel">{children}</div>
    </div>
  );
}
