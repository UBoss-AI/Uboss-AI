'use client';

import type { ReactNode } from 'react';

import { cn } from '../lib/class-names';
import { EmptyState } from './EmptyState';
import { ErrorState } from './ErrorState';
import { Skeleton } from './Skeleton';

export interface DataTableColumn<Row> {
  /** Stable column key. */
  key: string;
  header: string;
  /** Cell renderer. */
  render: (row: Row) => ReactNode;
  /** Right-align and tabular-align numeric columns. */
  numeric?: boolean;
  /** Column width, e.g. `'160px'` or `'20%'`. */
  width?: string;
}

export interface DataTableProps<Row> {
  /** Accessible caption describing the table's contents. */
  caption: string;
  columns: DataTableColumn<Row>[];
  rows: Row[];
  /** Stable row identity — required so React reconciles rows correctly. */
  rowKey: (row: Row) => string;
  /** Row activation. Makes rows focusable and keyboard-activatable. */
  onRowSelect?: (row: Row) => void;
  /** Loading placeholder. */
  loading?: boolean;
  /** Error message. Takes precedence over rows. */
  error?: string;
  /** Retry handler offered alongside the error state. */
  onRetry?: () => void;
  /** Shown when there are no rows and no error. */
  emptyTitle?: string;
  emptyDescription?: string;
  emptyActions?: ReactNode;
  className?: string;
}

/**
 * Enterprise data table with built-in loading, error and empty states.
 *
 * Every screen is required to handle those states (working rule F), so they live in the
 * component rather than being re-implemented per page.
 */
export function DataTable<Row>({
  caption,
  columns,
  rows,
  rowKey,
  onRowSelect,
  loading = false,
  error,
  onRetry,
  emptyTitle = 'Nothing here yet',
  emptyDescription,
  emptyActions,
  className,
}: DataTableProps<Row>) {
  if (error) {
    return (
      <ErrorState
        kind="error"
        title="Couldn't load this list"
        description={error}
        actions={
          onRetry ? (
            <button type="button" className="uboss-btn uboss-btn--sm" onClick={onRetry}>
              Retry
            </button>
          ) : undefined
        }
      />
    );
  }

  if (loading) {
    return (
      <div className="uboss-table-wrap" aria-busy="true" aria-label={`${caption} — loading`}>
        <table className={cn('uboss-table', className)}>
          <caption className="uboss-sr-only">{caption} — loading</caption>
          <thead>
            <tr>
              {columns.map((column) => (
                <th key={column.key} scope="col" style={{ width: column.width }}>
                  {column.header}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {Array.from({ length: 4 }, (_, rowIndex) => (
              <tr key={rowIndex}>
                {columns.map((column) => (
                  <td key={column.key}>
                    <Skeleton height={14} width="80%" />
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    );
  }

  if (rows.length === 0) {
    return <EmptyState title={emptyTitle} description={emptyDescription} actions={emptyActions} />;
  }

  return (
    <div className="uboss-table-wrap">
      <table className={cn('uboss-table', className)}>
        <caption className="uboss-sr-only">{caption}</caption>
        <thead>
          <tr>
            {columns.map((column) => (
              <th
                key={column.key}
                scope="col"
                style={{ width: column.width }}
                className={column.numeric ? 'uboss-table-numeric' : undefined}
              >
                {column.header}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => (
            <tr
              key={rowKey(row)}
              data-clickable={onRowSelect ? 'true' : undefined}
              // Keyboard parity for clickable rows: focusable, and activated by Enter or Space.
              tabIndex={onRowSelect ? 0 : undefined}
              role={onRowSelect ? 'button' : undefined}
              onClick={onRowSelect ? () => onRowSelect(row) : undefined}
              onKeyDown={
                onRowSelect
                  ? (event) => {
                      if (event.key === 'Enter' || event.key === ' ') {
                        event.preventDefault();
                        onRowSelect(row);
                      }
                    }
                  : undefined
              }
            >
              {columns.map((column) => (
                <td key={column.key} className={column.numeric ? 'uboss-table-numeric' : undefined}>
                  {column.render(row)}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
