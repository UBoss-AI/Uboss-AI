'use client';

import { motion } from 'motion/react';
import { useId, useMemo, useState, type ReactNode } from 'react';

import { Icon } from '../primitives/Icon';
import { cn } from '../lib/class-names';
import { transition } from '../motion/motion';
import type { SettingsSection } from '../navigation/navigation-model';

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

        {visible.map((section) => {
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
            </button>
          );
        })}

        {visible.length === 0 ? (
          <p className="uboss-settings-nav-empty" role="status">
            No settings match “{query.trim()}”.
          </p>
        ) : null}
      </nav>

      <div>{children}</div>
    </div>
  );
}
