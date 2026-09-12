'use client';

import type { ReactNode } from 'react';

import { cn } from '../lib/class-names';
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
 */
export function SettingsShell({
  sections,
  activeKey,
  onSelect,
  personalLabels = false,
  children,
  className,
}: SettingsShellProps) {
  return (
    <div className={cn('uboss-settings', className)}>
      <nav className="uboss-settings-nav" aria-label="Settings sections">
        {sections.map((section) => {
          const label =
            personalLabels && section.personalLabel ? section.personalLabel : section.label;
          const active = section.key === activeKey;

          return (
            <button
              key={section.key}
              type="button"
              className="uboss-settings-nav-item"
              aria-current={active ? 'page' : undefined}
              onClick={() => onSelect(section.key)}
            >
              {label}
            </button>
          );
        })}
      </nav>

      <div>{children}</div>
    </div>
  );
}
