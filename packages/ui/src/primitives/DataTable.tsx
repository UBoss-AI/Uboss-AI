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
  /**
   * Cell renderer.
   *
   * `index` is the row's position in what is currently on screen, from zero — which is what a
   * serial-number column needs and the only thing it is for. It is the position in the **rendered**
   * list, so it follows a search or a filter rather than claiming to be an identity: row 3 of a
   * filtered list is row 3 of what you are looking at, not record 3 of the table. A record's real
   * identity is its own code, which every list that has one already shows.
   */
  render: (row: Row, index: number) => ReactNode;
  /** Right-align and tabular-align numeric columns. */
  numeric?: boolean;
  /** Column width, e.g. `'160px'` or `'20%'`. */
  width?: string;
  /**
   * This column holds more than one line — a name over a code, a title over a date.
   *
   * A row is a fixed height so a list of them scans evenly, and two lines crammed into that
   * height is what makes a table look squeezed. A stacked column opts out of the fixed height
   * and takes its own padding instead. The styling already existed and nothing could ask for it,
   * which is why every two-line cell in the product looked tight.
   */
  stacked?: boolean;
}

export interface DataTableProps<Row> {
  /** Accessible caption describing the table's contents. */
  caption: string;
  columns: DataTableColumn<Row>[];
  rows: Row[];
  /**
   * Stable row identity — required so React reconciles rows correctly.
   *
   * The position is offered as well as the row, for the tables whose rows carry no id of their
   * own. A report of aggregates can return two rows that are identical in every column and still
   * be two rows; keyed on their values alone, React treats them as one and drops the second.
   */
  rowKey: (row: Row, index: number) => string;
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
          {rows.map((row, index) => (
            <tr
              key={rowKey(row, index)}
              /*
               * The row's position, published for CSS.
               *
               * No table animates by default — a product where every list ripples on arrival makes
               * ordinary lists feel urgent. But a caller that has a reason to stagger its rows
               * needs the index in CSS, and this is the only place that can give it. Costs one
               * custom property per row and changes nothing on its own.
               */
              style={{ '--uboss-row': index } as React.CSSProperties}
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
                <td
                  key={column.key}
                  className={
                    [
                      column.numeric ? 'uboss-table-numeric' : null,
                      column.stacked === true ? 'uboss-table-cell--stacked' : null,
                    ]
                      .filter(Boolean)
                      .join(' ') || undefined
                  }
                >
                  {column.render(row, index)}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
