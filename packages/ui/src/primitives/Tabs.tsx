'use client';

import type { KeyboardEvent, ReactNode } from 'react';
import { useRef } from 'react';

import { cn } from '../lib/class-names';

export interface TabItem {
  id: string;
  label: string;
  disabled?: boolean;
}

export interface TabsProps {
  items: TabItem[];
  activeId: string;
  onChange: (id: string) => void;
  /** Accessible name for the tab list. */
  label: string;
  className?: string;
}

/**
 * Keyboard-navigable tab list following the WAI-ARIA tabs pattern:
 * arrow keys move between tabs, Home/End jump to the ends, and only the active tab is tabbable.
 */
export function Tabs({ items, activeId, onChange, label, className }: TabsProps) {
  const refs = useRef<Record<string, HTMLButtonElement | null>>({});

  const focusTab = (id: string) => {
    onChange(id);
    refs.current[id]?.focus();
  };

  const handleKeyDown = (event: KeyboardEvent<HTMLButtonElement>) => {
    const selectable = items.filter((item) => !item.disabled);
    const currentIndex = selectable.findIndex((item) => item.id === activeId);
    if (currentIndex === -1) {
      return;
    }

    // Every branch either assigns or returns, so no initializer is needed.
    let nextIndex: number;
    switch (event.key) {
      case 'ArrowRight':
        nextIndex = (currentIndex + 1) % selectable.length;
        break;
      case 'ArrowLeft':
        nextIndex = (currentIndex - 1 + selectable.length) % selectable.length;
        break;
      case 'Home':
        nextIndex = 0;
        break;
      case 'End':
        nextIndex = selectable.length - 1;
        break;
      default:
        return;
    }

    const next = selectable[nextIndex];
    if (next) {
      event.preventDefault();
      focusTab(next.id);
    }
  };

  return (
    <div role="tablist" aria-label={label} className={cn('uboss-tabs', className)}>
      {items.map((item) => {
        const selected = item.id === activeId;

        return (
          <button
            key={item.id}
            ref={(node) => {
              refs.current[item.id] = node;
            }}
            type="button"
            role="tab"
            id={`tab-${item.id}`}
            aria-selected={selected}
            aria-controls={`tabpanel-${item.id}`}
            // Roving tabindex: the tab list is a single tab stop.
            tabIndex={selected ? 0 : -1}
            disabled={item.disabled}
            className="uboss-tab"
            onClick={() => onChange(item.id)}
            onKeyDown={handleKeyDown}
          >
            {item.label}
          </button>
        );
      })}
    </div>
  );
}

export interface TabPanelProps {
  id: string;
  activeId: string;
  children: ReactNode;
}

export function TabPanel({ id, activeId, children }: TabPanelProps) {
  const selected = id === activeId;

  return (
    <div
      role="tabpanel"
      id={`tabpanel-${id}`}
      aria-labelledby={`tab-${id}`}
      hidden={!selected}
      tabIndex={0}
    >
      {selected ? children : null}
    </div>
  );
}
