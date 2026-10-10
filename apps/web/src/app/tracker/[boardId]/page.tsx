'use client';

import { useParams, useRouter } from 'next/navigation';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import {
  Banner,
  Button,
  Card,
  CardBody,
  FormField,
  Icon,
  Modal,
  PageHeader,
  SegmentedControl,
  RowMenu,
  SkeletonText,
  StatusBadge,
} from '@uboss/ui';

import { BOARD_COLUMN_KINDS, MAX_BOARD_ITEM_DEPTH } from '@uboss/types';

import {
  ApiError,
  authApi,
  boardsApi,
  type BoardCellView,
  type BoardColumnView,
  type BoardItemView,
  type BoardOpenView,
  type MeResponse,
} from '../../../lib/api-client';

import {
  forgetWorkspace,
  readRememberedWorkspace,
  resolveActiveWorkspace,
} from '../../../lib/active-workspace';
import { RoutedAppShell } from '../../../components/RoutedAppShell';
import { useAccountMenu } from '../../../lib/use-account-menu';
import { useCompanyNavigation } from '../../../lib/use-company-navigation';
import { useNotificationBell } from '../../../lib/use-notification-bell';
import { useSignedInUser } from '../../../lib/use-signed-in-user';
import { BoardCell } from './BoardCell';
import { cellDomId, useGridCursor } from './useGridCursor';

/** A row as the grid sees it: flat, so arrow keys cross groups without knowing about them. */
interface FlatRow {
  item: BoardItemView;
  groupId: string;
}

/**
 * One board: groups down the page, columns across it.
 *
 * ## Why it reads like a sheet
 *
 * A table you can click is not a board. What makes monday.com's feel like a spreadsheet is that
 * the keyboard owns it — arrows and Tab move a cursor, Enter opens the cell under it, Backspace
 * clears it — and somebody filling in forty rows never reaches for the mouse. The shortcuts here
 * are monday's own, so nobody arriving from it has to learn a second set. See `useGridCursor`.
 *
 * ## Why the whole board arrives in one request
 *
 * A board is read as a shape — every group, every column, every row and the cells that are
 * filled — and fetching those separately would paint four times and settle into place while
 * somebody watched. The cells are sparse, so "every cell" is however many people actually filled.
 *
 * ## Why editing asks the server rather than deciding here
 *
 * `board.mayEdit` is the server's answer. "May I type here" has two inputs — the module grant and
 * the board role — and a screen that recomputed it would eventually disagree with the route that
 * enforces it. Every write is refused again on the way in.
 */
export default function BoardPage() {
  const navGroups = useCompanyNavigation();
  const router = useRouter();
  const params = useParams<{ boardId: string }>();
  const boardId = typeof params?.boardId === 'string' ? params.boardId : null;

  const [me, setMe] = useState<MeResponse | null>(null);
  const [view, setView] = useState<BoardOpenView | null>(null);
  const [error, setError] = useState<string | null>(null);

  /** What is half-typed in each group's add row. Per group, because each has its own. */
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const [collapsed, setCollapsed] = useState<ReadonlySet<string>>(new Set());
  const [dialog, setDialog] = useState<'column' | 'group' | null>(null);

  const tenantId =
    resolveActiveWorkspace(me?.workspaces, readRememberedWorkspace())?.tenantId ?? null;

  const signedInUser = useSignedInUser(me);
  const accountMenu = useAccountMenu(me);
  const bell = useNotificationBell(tenantId);

  useEffect(() => {
    authApi
      .me()
      .then(setMe)
      .catch((caught: unknown) =>
        setError(caught instanceof ApiError ? caught.message : 'Could not load your workspaces.'),
      );
  }, []);

  const load = useCallback(() => {
    if (!tenantId || boardId === null) return;
    setError(null);

    boardsApi
      .open(tenantId, boardId)
      .then(setView)
      .catch((caught: unknown) =>
        setError(caught instanceof ApiError ? caught.message : 'Could not open that board.'),
      );
  }, [tenantId, boardId]);

  useEffect(load, [load]);

  /** Cells by item and column, so a row finds its own without scanning the board. */
  const cellsByItem = useMemo(() => {
    const map = new Map<string, Map<string, BoardCellView>>();
    for (const cell of view?.cells ?? []) {
      const row = map.get(cell.itemId) ?? new Map<string, BoardCellView>();
      row.set(cell.columnId, cell);
      map.set(cell.itemId, row);
    }
    return map;
  }, [view]);

  /**
   * Every visible row, in the order they appear, with subitems under their parent.
   *
   * Flat on purpose: the cursor walks an index, so pressing Down at the bottom of one group
   * lands in the next — which is what a sheet does and what a tree of nested arrays could not
   * express without the cursor knowing about groups.
   */
  const rows = useMemo<FlatRow[]>(() => {
    if (view === null) return [];

    const children = new Map<string, BoardItemView[]>();
    for (const item of view.items) {
      if (item.parentItemId === null) continue;
      const list = children.get(item.parentItemId) ?? [];
      list.push(item);
      children.set(item.parentItemId, list);
    }

    const flat: FlatRow[] = [];
    const push = (item: BoardItemView, groupId: string) => {
      flat.push({ item, groupId });
      for (const child of children.get(item.id) ?? []) push(child, groupId);
    };

    for (const group of view.groups) {
      if (collapsed.has(group.id)) continue;
      for (const item of view.items) {
        if (item.groupId !== group.id || item.parentItemId !== null) continue;
        push(item, group.id);
      }
    }

    return flat;
  }, [view, collapsed]);

  const grid = useGridCursor({
    boardId: boardId ?? '',
    rowCount: rows.length,
    columnCount: view?.columns.length ?? 0,
    enabled: view !== null,
  });

  const writeCell = useCallback(
    async (itemId: string, columnId: string, value: unknown) => {
      if (!tenantId) return;
      try {
        await boardsApi.setCell(tenantId, itemId, columnId, value);
        load();
      } catch (caught: unknown) {
        setError(caught instanceof ApiError ? caught.message : 'That change was not saved.');
      }
    },
    [tenantId, load],
  );

  /**
   * Add the row that is being typed into, and stay in it.
   *
   * The field is not cleared by blurring away from it and not committed by leaving: Enter makes
   * the row, the box empties, and the cursor is still there for the next one. Somebody entering
   * eleven things types eleven names and eleven returns.
   */
  const addItem = async (groupId: string) => {
    const name = (drafts[groupId] ?? '').trim();
    if (!tenantId || boardId === null || name === '') return;

    try {
      await boardsApi.createItem(tenantId, boardId, { name, groupId });
      setDrafts((current) => ({ ...current, [groupId]: '' }));
      load();
    } catch (caught: unknown) {
      setError(caught instanceof ApiError ? caught.message : 'That item could not be added.');
    }
  };

  /**
   * Take a row off the board.
   *
   * Archived, not deleted — its cells and its thread go with it and would come back with it.
   * Confirmed first, because it is the one action here that removes something somebody can see,
   * and an accidental click on a menu is how that happens.
   */
  const archiveItem = useCallback(
    async (itemId: string) => {
      if (!tenantId) return;
      if (!window.confirm('Take this row off the board? Nothing is deleted.')) return;
      try {
        await boardsApi.archiveItem(tenantId, itemId);
        load();
      } catch (caught: unknown) {
        setError(caught instanceof ApiError ? caught.message : 'That row was not archived.');
      }
    },
    [tenantId, load],
  );

  /** A row under a row. The server refuses past four levels and says so. */
  const addSubitem = useCallback(
    async (parentItemId: string) => {
      if (!tenantId || boardId === null) return;
      try {
        await boardsApi.createItem(tenantId, boardId, { name: 'New subitem', parentItemId });
        load();
      } catch (caught: unknown) {
        setError(caught instanceof ApiError ? caught.message : 'That subitem could not be added.');
      }
    },
    [tenantId, boardId, load],
  );

  /** Rename a row. The name is a cell like any other — it is simply the one that is always there. */
  const renameItem = useCallback(
    async (itemId: string, name: string) => {
      if (!tenantId || name.trim() === '') return;
      try {
        await boardsApi.renameItem(tenantId, itemId, name.trim());
        load();
      } catch (caught: unknown) {
        setError(caught instanceof ApiError ? caught.message : 'That name was not saved.');
      }
    },
    [tenantId, load],
  );

  /**
   * The board-level shortcuts, monday's own.
   *
   * On the window rather than the table, because `Ctrl+Shift+C` should open the column dialog
   * from anywhere on the board and not only when a cell happens to hold focus.
   */
  useEffect(() => {
    if (view === null) return;

    const onKey = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null;
      if (
        target &&
        (target.tagName === 'INPUT' || target.tagName === 'SELECT' || target.isContentEditable)
      ) {
        return;
      }

      if (
        event.ctrlKey &&
        event.shiftKey &&
        event.key.toLowerCase() === 'c' &&
        view.board.mayEdit
      ) {
        event.preventDefault();
        setDialog('column');
      } else if (
        event.ctrlKey &&
        event.shiftKey &&
        event.key.toLowerCase() === 'g' &&
        view.board.mayEdit
      ) {
        event.preventDefault();
        setDialog('group');
      } else if (event.ctrlKey && !event.shiftKey && event.key.toLowerCase() === 'g') {
        event.preventDefault();
        // Collapse all, or open all when everything is already shut.
        setCollapsed((current) =>
          current.size === view.groups.length
            ? new Set()
            : new Set(view.groups.map((group) => group.id)),
        );
      }
    };

    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [view]);

  const activeWorkspace = me?.workspaces.find((workspace) => workspace.tenantId === tenantId);

  /** Where each group's rows start in the flat list, so a row knows its cursor index. */
  const rowIndex = useMemo(() => {
    const map = new Map<string, number>();
    rows.forEach((row, index) => map.set(row.item.id, index));
    return map;
  }, [rows]);

  return (
    <RoutedAppShell
      variant="company"
      workspaceName={activeWorkspace?.tenantName ?? '—'}
      groups={navGroups}
      activeKey="tracker"
      {...bell.shellProps}
      user={signedInUser}
      accountMenu={accountMenu}
      onSignOut={() => {
        forgetWorkspace();
        void authApi.logout().finally(() => window.location.assign('/login'));
      }}
    >
      <PageHeader
        title={view?.board.name ?? 'Opening…'}
        description={view?.board.description ?? 'Groups down the page, columns across it.'}
        breadcrumbs={[{ label: 'RIS', href: '/tracker' }, { label: view?.board.name ?? '…' }]}
        actions={
          <>
            {view?.board.mayEdit ? (
              <>
                <Button variant="default" onClick={() => setDialog('column')}>
                  Add column
                </Button>
                <Button variant="default" onClick={() => setDialog('group')}>
                  Add group
                </Button>
              </>
            ) : null}
            <Button variant="ghost" onClick={() => router.push('/tracker')}>
              All boards
            </Button>
          </>
        }
      />

      {error ? <Banner tone="danger">{error}</Banner> : null}

      {view === null ? (
        error === null ? (
          <Card>
            <CardBody>
              <SkeletonText lines={8} />
            </CardBody>
          </Card>
        ) : null
      ) : (
        <>
          <div className="uboss-board-meta">
            <StatusBadge
              status={view.board.kind}
              tone={view.board.kind === 'Private' ? 'purple' : 'grey'}
            />
            <span className="uboss-muted">
              {view.board.myRole === null ? 'Not a member' : view.board.myRole}
              {view.board.mayEdit ? '' : ' · read only'}
            </span>
            <span className="uboss-muted uboss-board-hint">
              Arrows or Tab to move · Enter to edit · Ctrl+Shift+C for a column
            </span>
          </div>

          {view.groups.map((group) => {
            const shut = collapsed.has(group.id);
            const groupRows = rows.filter((row) => row.groupId === group.id);
            const count = view.items.filter(
              (item) => item.groupId === group.id && item.parentItemId === null,
            ).length;

            return (
              <section key={group.id} className="uboss-board-group">
                <button
                  type="button"
                  className={`uboss-board-group__title uboss-board-group__title--${group.tone}`}
                  onClick={() =>
                    setCollapsed((current) => {
                      const next = new Set(current);
                      if (next.has(group.id)) next.delete(group.id);
                      else next.add(group.id);
                      return next;
                    })
                  }
                  aria-expanded={!shut}
                >
                  <Icon
                    name="chevron"
                    size={13}
                    className={shut ? undefined : 'uboss-board-group__caret--open'}
                  />
                  {group.title}
                  <span className="uboss-board-group__count">{count}</span>
                </button>

                {shut ? null : (
                  <div
                    className="uboss-board-table"
                    role="grid"
                    aria-label={group.title}
                    onKeyDown={(event) => {
                      if (grid.onKeyDown(event)) event.preventDefault();
                    }}
                  >
                    <div className="uboss-board-row uboss-board-row--head" role="row">
                      <span className="uboss-board-cell uboss-board-cell--name" role="columnheader">
                        Item
                      </span>
                      {view.columns.map((column) => (
                        <span
                          key={column.id}
                          className="uboss-board-cell"
                          role="columnheader"
                          style={{ width: column.width }}
                        >
                          {column.title}
                        </span>
                      ))}
                    </div>

                    {groupRows.length === 0 ? (
                      <p className="uboss-board-empty uboss-muted">Nothing in this group yet.</p>
                    ) : (
                      groupRows.map((row) => (
                        <Row
                          key={row.item.id}
                          boardId={boardId ?? ''}
                          index={rowIndex.get(row.item.id) ?? 0}
                          item={row.item}
                          columns={view.columns}
                          cells={cellsByItem.get(row.item.id)}
                          people={view.members}
                          mayEdit={view.board.mayEdit}
                          cursor={grid.cursor}
                          onFocusCell={grid.put}
                          onWrite={writeCell}
                          onRename={renameItem}
                          onArchive={archiveItem}
                          onAddSubitem={addSubitem}
                        />
                      ))
                    )}

                    {/*
                      The last row of every group is an empty one.

                      Not a button that turns into a field: monday.com keeps a row at the bottom
                      you type straight into, and pressing Enter leaves you in it ready for the
                      next. That is how somebody enters eleven things in a row — a button means
                      a click, a field, a return, and a click again, eleven times.

                      It keeps the columns of the rows above it, so the grid does not change
                      shape at the bottom and the eye follows one set of lines down the page.
                    */}
                    {!view.board.mayEdit ? null : (
                      <div className="uboss-board-row uboss-board-row--add" role="row">
                        <span className="uboss-board-cell uboss-board-cell--name" role="gridcell">
                          <input
                            className="uboss-board-add-input"
                            value={drafts[group.id] ?? ''}
                            placeholder="+ Add item"
                            onChange={(event) =>
                              setDrafts((current) => ({
                                ...current,
                                [group.id]: event.target.value,
                              }))
                            }
                            onKeyDown={(event) => {
                              if (event.key === 'Enter') void addItem(group.id);
                              if (event.key === 'Escape') {
                                setDrafts((current) => ({ ...current, [group.id]: '' }));
                                event.currentTarget.blur();
                              }
                            }}
                            aria-label={`Add an item to ${group.title}`}
                          />
                        </span>
                        {view.columns.map((column) => (
                          <span
                            key={column.id}
                            className="uboss-board-cell"
                            role="gridcell"
                            style={{ width: column.width }}
                          />
                        ))}
                      </div>
                    )}
                  </div>
                )}
              </section>
            );
          })}
        </>
      )}

      {dialog !== null && tenantId && boardId !== null ? (
        <AddDialog
          what={dialog}
          tenantId={tenantId}
          boardId={boardId}
          onClose={() => setDialog(null)}
          onDone={() => {
            setDialog(null);
            load();
          }}
        />
      ) : null}
    </RoutedAppShell>
  );
}

/**
 * One row.
 *
 * Subitems are not nested here: the flat list already has them in place, indented by their own
 * depth. A nested render would have had to agree with the cursor's index about what order the
 * rows are in, and two things agreeing about an order is one thing too many.
 */
function Row({
  boardId,
  index,
  item,
  columns,
  cells,
  people,
  mayEdit,
  cursor,
  onFocusCell,
  onWrite,
  onRename,
  onArchive,
  onAddSubitem,
}: {
  boardId: string;
  index: number;
  item: BoardItemView;
  columns: BoardColumnView[];
  cells: Map<string, BoardCellView> | undefined;
  people: readonly { userId: string; name: string }[];
  mayEdit: boolean;
  cursor: { row: number; column: number } | null;
  onFocusCell: (cursor: { row: number; column: number }) => void;
  onWrite: (itemId: string, columnId: string, value: unknown) => void;
  onRename: (itemId: string, name: string) => void;
  onArchive: (itemId: string) => void;
  onAddSubitem: (parentItemId: string) => void;
}) {
  const here = (column: number) => cursor?.row === index && cursor.column === column;

  return (
    <div className="uboss-board-row" role="row" style={{ paddingLeft: item.depth * 20 }}>
      <span
        id={cellDomId(boardId, index, -1)}
        className={`uboss-board-cell uboss-board-cell--name${here(-1) ? ' is-on' : ''}`}
        role="gridcell"
        tabIndex={here(-1) ? 0 : -1}
        onFocus={() => onFocusCell({ row: index, column: -1 })}
      >
        {/*
          The name is a cell too.

          It was drawn as text, so a row somebody had just created could not be corrected — and
          the one field every board item has is the one it could not change. It edits in place
          like every other cell: Enter or blur saves, Escape puts it back.
        */}
        {mayEdit ? (
          <ItemName name={item.name} onRename={(next) => onRename(item.id, next)} />
        ) : (
          <span>{item.name}</span>
        )}

        {/*
          The row's own actions, behind one control.

          monday.com puts a three-dot menu on every row — add a subitem, duplicate, archive,
          delete. Without it a row somebody created by mistake stayed on the board for ever, and
          a subitem could only be made through the API. The two here are the two that have
          something behind them; the rest arrive with the services that do the work.
        */}
        {!mayEdit ? null : (
          <RowMenu
            subject={item.name}
            className="uboss-board-row__menu"
            items={[
              ...(item.depth + 1 < MAX_BOARD_ITEM_DEPTH
                ? [
                    {
                      key: 'subitem',
                      label: 'Add a subitem',
                      detail: `Nested under ${item.name}.`,
                      onSelect: () => onAddSubitem(item.id),
                    },
                  ]
                : []),
              {
                key: 'archive',
                label: 'Archive this row',
                // Archived, never deleted — the same promise the rest of the product makes, and
                // the reason this is not called Delete.
                detail: 'It leaves the board. Nothing is deleted.',
                destructive: true,
                onSelect: () => onArchive(item.id),
              },
            ]}
          />
        )}
      </span>

      {columns.map((column, position) => (
        <span
          key={column.id}
          id={cellDomId(boardId, index, position)}
          className={`uboss-board-cell${here(position) ? ' is-on' : ''}`}
          role="gridcell"
          tabIndex={here(position) ? 0 : -1}
          style={{ width: column.width }}
          onFocus={() => onFocusCell({ row: index, column: position })}
          onKeyDown={(event) => {
            // Backspace clears the cell under the cursor, as it does in a sheet — but only when
            // nothing inside is being typed into, which the grid handler checks before this runs.
            if (!mayEdit) return;
            if (event.key !== 'Backspace' && event.key !== 'Delete') return;
            const target = event.target as HTMLElement;
            if (target.tagName === 'INPUT' || target.tagName === 'SELECT') return;
            event.preventDefault();
            onWrite(item.id, column.id, undefined);
          }}
        >
          <BoardCell
            column={column}
            value={cells?.get(column.id)?.value}
            people={people}
            mayEdit={mayEdit}
            onWrite={(value) => onWrite(item.id, column.id, value)}
          />
        </span>
      ))}
    </div>
  );
}

/** Adding a column or a group — the two things that change what a board is. */
function AddDialog({
  what,
  tenantId,
  boardId,
  onClose,
  onDone,
}: {
  what: 'column' | 'group';
  tenantId: string;
  boardId: string;
  onClose: () => void;
  onDone: () => void;
}) {
  const [title, setTitle] = useState('');
  const [kind, setKind] = useState<string>('Status');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async () => {
    setBusy(true);
    setError(null);
    try {
      if (what === 'column') {
        await boardsApi.addColumn(tenantId, boardId, { title, kind });
      } else {
        await boardsApi.addGroup(tenantId, boardId, { title });
      }
      onDone();
    } catch (caught: unknown) {
      setError(caught instanceof ApiError ? caught.message : 'That could not be added.');
      setBusy(false);
    }
  };

  return (
    <Modal
      open
      onClose={onClose}
      title={what === 'column' ? 'Add a column' : 'Add a group'}
      footer={
        <>
          <Button variant="ghost" onClick={onClose} disabled={busy}>
            Cancel
          </Button>
          <Button
            variant="primary"
            onClick={() => void submit()}
            disabled={busy || title.trim() === ''}
          >
            {busy ? 'Adding…' : 'Add'}
          </Button>
        </>
      }
    >
      {error ? <Banner tone="danger">{error}</Banner> : null}

      <FormField label={what === 'column' ? 'Column name' : 'Group name'} required>
        {(field) => (
          <input
            {...field}
            className="uboss-input"
            value={title}
            onChange={(event) => setTitle(event.target.value)}
            placeholder={what === 'column' ? 'Priority' : 'Blocked'}
            maxLength={200}
            /* The field this dialog is about, rather than its close button. See useFocusTrap. */
            data-autofocus
          />
        )}
      </FormField>

      {what === 'group' ? null : (
        <>
          <div className="uboss-board-kind">
            <SegmentedControl
              label="What kind of column"
              value={kind}
              onChange={setKind}
              options={BOARD_COLUMN_KINDS.map((value) => ({ value, label: value }))}
            />
          </div>
          <p className="uboss-muted">
            The kind decides what a cell holds and how it is edited. A Status column arrives with
            four labels you can rename.
          </p>
        </>
      )}
    </Modal>
  );
}

/**
 * The item's name, edited in place.
 *
 * Saved on Enter and on leaving, not on every keystroke: a board of two hundred rows would
 * otherwise be a request per character, and the row being typed in is the one that would feel it.
 * Escape puts back what was there, which is the only way out that does not need an undo.
 */
function ItemName({ name, onRename }: { name: string; onRename: (name: string) => void }) {
  const [draft, setDraft] = useState(name);
  const committed = useRef(name);

  // The board re-reads itself after every write, so the name can arrive from the server while
  // this is mounted — two people on one board must not overwrite each other's row.
  useEffect(() => {
    if (name !== committed.current) {
      committed.current = name;
      setDraft(name);
    }
  }, [name]);

  const commit = () => {
    const next = draft.trim();
    if (next === '' || next === committed.current) {
      setDraft(committed.current);
      return;
    }
    committed.current = next;
    onRename(next);
  };

  return (
    <input
      className="uboss-board-input uboss-board-input--name"
      value={draft}
      onChange={(event) => setDraft(event.target.value)}
      onBlur={commit}
      onKeyDown={(event) => {
        if (event.key === 'Enter') event.currentTarget.blur();
        if (event.key === 'Escape') {
          setDraft(committed.current);
          event.currentTarget.blur();
        }
      }}
      aria-label={`Name of ${name}`}
    />
  );
}
