'use client';

import { useMemo, useState } from 'react';

import { Button, Icon, RowMenu } from '@uboss/ui';

import type { BoardSummary, FolderSummary, SpaceSummary } from '../../lib/api-client';

/**
 * The left-hand tree: space, folders, sub-folders, boards.
 *
 * ## Why a tree and not the list of cards it replaces
 *
 * A company with seventeen departments has seventeen folders and a board or four in each, and
 * seventy cards in one scroll is a wall. monday.com puts the same thing in a narrow rail for the
 * same reason: the point of a folder is that most of it is closed.
 *
 * ## Why the server sends it flat
 *
 * `FolderSummary` carries `parentFolderId` and nothing else about shape. Building the tree here
 * means a move is a change to one field rather than a re-fetch of a nested payload, and it keeps
 * the one piece of knowledge that matters — that a folder can contain a folder — in one place.
 *
 * ## The loop
 *
 * The server refuses a folder placed inside its own descendant, which is what makes `walk` below
 * safe to write as plain recursion. It is still written to visit each folder once: a tree that
 * arrives looping should draw wrong rather than hang the tab, because a hung tab tells nobody
 * what happened.
 */

export interface TreeNode {
  folder: FolderSummary;
  children: TreeNode[];
  boards: BoardSummary[];
}

/** What is open. Folders start closed — that is the point of a folder. */
export type OpenFolders = ReadonlySet<string>;

/**
 * What a row's "Move to…" asks the page to open a picker for.
 *
 * The row knows what cannot be a destination — a folder cannot go inside itself or anything
 * under it — and the picker does not, so the row says.
 */
export interface MoveTarget {
  kind: 'folder' | 'board';
  id: string;
  name: string;
  currentParentId: string | null;
  /** Boards cannot cross spaces, so the picker narrows to one. Folders are already in theirs. */
  spaceId?: string;
  forbiddenIds: string[];
}

export function buildTree(
  folders: FolderSummary[],
  boards: BoardSummary[],
): { roots: TreeNode[]; looseBoards: BoardSummary[] } {
  const byParent = new Map<string | null, FolderSummary[]>();
  for (const folder of folders) {
    const siblings = byParent.get(folder.parentFolderId) ?? [];
    siblings.push(folder);
    byParent.set(folder.parentFolderId, siblings);
  }

  const boardsByFolder = new Map<string, BoardSummary[]>();
  const looseBoards: BoardSummary[] = [];
  for (const board of boards) {
    if (board.folderId === null) {
      looseBoards.push(board);
      continue;
    }
    const inFolder = boardsByFolder.get(board.folderId) ?? [];
    inFolder.push(board);
    boardsByFolder.set(board.folderId, inFolder);
  }

  // Visited, not depth-limited: a folder reached twice is a loop, and drawing it once is the
  // honest outcome. The server already refuses to make one; this is what happens if it ever does.
  const seen = new Set<string>();

  const walk = (parentId: string | null): TreeNode[] =>
    (byParent.get(parentId) ?? [])
      .filter((folder) => {
        if (seen.has(folder.id)) return false;
        seen.add(folder.id);
        return true;
      })
      .sort((left, right) => left.position - right.position || left.name.localeCompare(right.name))
      .map((folder) => ({
        folder,
        children: walk(folder.id),
        boards: (boardsByFolder.get(folder.id) ?? []).sort((left, right) =>
          left.name.localeCompare(right.name),
        ),
      }));

  return {
    roots: walk(null),
    looseBoards: looseBoards.sort((left, right) => left.name.localeCompare(right.name)),
  };
}

/** Every folder id at or below this one — what a search has to open to show its hit. */
function idsWithin(node: TreeNode): string[] {
  return [node.folder.id, ...node.children.flatMap(idsWithin)];
}

/**
 * The folders flattened back out, but in the order the tree draws them.
 *
 * For the move and new-board pickers, which are a `select` and so cannot nest. Indenting by
 * `depth` only reads as a tree if a child follows its parent; in the order the server sends
 * them, a sub-folder lands wherever it was created — typically at the bottom, indented under
 * nothing, which looks like a bug rather than a hierarchy.
 */
export function foldersInTreeOrder(folders: FolderSummary[]): FolderSummary[] {
  const { roots } = buildTree(folders, []);
  const flat: FolderSummary[] = [];
  const walk = (nodes: TreeNode[]) => {
    for (const node of nodes) {
      flat.push(node.folder);
      walk(node.children);
    }
  };
  walk(roots);
  return flat;
}

/** Does anything under here match? Used to open the path to a search hit, and only that path. */
function matches(node: TreeNode, needle: string): boolean {
  if (needle === '') return true;
  if (node.folder.name.toLowerCase().includes(needle)) return true;
  if (node.boards.some((board) => board.name.toLowerCase().includes(needle))) return true;
  return node.children.some((child) => matches(child, needle));
}

export function BoardTree({
  spaces,
  folders,
  boards,
  activeBoardId,
  selectedFolderId,
  query,
  mayCreate,
  onSelectFolder,
  onOpenBoard,
  onNewFolder,
  onNewBoard,
  onRequestMove,

  onFromDepartments,
}: {
  spaces: SpaceSummary[];
  folders: FolderSummary[];
  boards: BoardSummary[];
  activeBoardId?: string | null;
  /** Which folder the page is showing. Null is the whole space. */
  selectedFolderId: string | null;
  query: string;
  mayCreate: boolean;
  onSelectFolder: (folderId: string | null) => void;
  onOpenBoard: (boardId: string) => void;
  onNewFolder: (parentFolderId: string | null) => void;
  onNewBoard: (folderId: string | null) => void;
  onRequestMove: (target: MoveTarget) => void;
  onFromDepartments: () => void;
}) {
  const [open, setOpen] = useState<ReadonlySet<string>>(new Set());

  const needle = query.trim().toLowerCase();
  const { roots, looseBoards } = useMemo(() => buildTree(folders, boards), [folders, boards]);

  /*
   * A search opens what it found and nothing else.
   *
   * Opening everything would answer "where is it?" with "somewhere in all of this", which is the
   * question. Closed folders that contain no hit stay closed.
   */
  const effectivelyOpen = useMemo<ReadonlySet<string>>(() => {
    if (needle === '') return open;
    const forced = new Set<string>();
    const mark = (node: TreeNode) => {
      if (!matches(node, needle)) return;
      forced.add(node.folder.id);
      node.children.forEach(mark);
    };
    roots.forEach(mark);
    return forced;
  }, [needle, open, roots]);

  const toggle = (folderId: string) =>
    setOpen((current) => {
      const next = new Set(current);
      if (next.has(folderId)) next.delete(folderId);
      else next.add(folderId);
      return next;
    });

  const spaceName = spaces.find((space) => space.isDefault)?.name ?? spaces[0]?.name ?? 'Boards';

  const visibleRoots = roots.filter((node) => matches(node, needle));
  const visibleLoose = looseBoards.filter(
    (board) => needle === '' || board.name.toLowerCase().includes(needle),
  );

  return (
    <nav className="uboss-tree" aria-label="Boards and folders">
      <div
        className={selectedFolderId === null ? 'uboss-tree__space is-active' : 'uboss-tree__space'}
      >
        <button
          type="button"
          className="uboss-tree__space-pick"
          onClick={() => onSelectFolder(null)}
        >
          <Icon name="grid" size={16} />
          <span className="uboss-tree__space-name">{spaceName}</span>
        </button>
        {mayCreate ? (
          <RowMenu
            subject={spaceName}
            items={[
              { key: 'folder', label: 'New folder', onSelect: () => onNewFolder(null) },
              { key: 'board', label: 'New board', onSelect: () => onNewBoard(null) },
              {
                key: 'departments',
                label: 'A folder per department…',
                detail: 'Shows what it would make before making it.',
                onSelect: onFromDepartments,
              },
            ]}
          />
        ) : null}
      </div>

      {visibleRoots.length === 0 && visibleLoose.length === 0 ? (
        <p className="uboss-tree__empty uboss-muted">
          {needle === '' ? 'Nothing here yet.' : 'Nothing matches that.'}
        </p>
      ) : null}

      <ul className="uboss-tree__list">
        {visibleRoots.map((node) => (
          <FolderRow
            key={node.folder.id}
            node={node}
            depth={0}
            open={effectivelyOpen}
            needle={needle}
            activeBoardId={activeBoardId ?? null}
            selectedFolderId={selectedFolderId}
            mayCreate={mayCreate}

            onToggle={toggle}
            onSelectFolder={onSelectFolder}
            onOpenBoard={onOpenBoard}
            onNewFolder={onNewFolder}
            onNewBoard={onNewBoard}
            onRequestMove={onRequestMove}
          />
        ))}

        {visibleLoose.map((board) => (
          <BoardRow
            key={board.id}
            board={board}
            depth={0}
            active={board.id === activeBoardId}
            mayCreate={mayCreate}

            onOpen={onOpenBoard}
            onRequestMove={onRequestMove}
          />
        ))}
      </ul>
    </nav>
  );
}

function FolderRow({
  node,
  depth,
  open,
  needle,
  activeBoardId,
  selectedFolderId,
  mayCreate,

  onToggle,
  onSelectFolder,
  onOpenBoard,
  onNewFolder,
  onNewBoard,
  onRequestMove,
}: {
  node: TreeNode;
  depth: number;
  open: OpenFolders;
  needle: string;
  activeBoardId: string | null;
  selectedFolderId: string | null;
  mayCreate: boolean;

  onToggle: (folderId: string) => void;
  onSelectFolder: (folderId: string | null) => void;
  onOpenBoard: (boardId: string) => void;
  onNewFolder: (parentFolderId: string | null) => void;
  onNewBoard: (folderId: string | null) => void;
  onRequestMove: (target: MoveTarget) => void;
}) {
  const isOpen = open.has(node.folder.id);
  const count = node.boards.length + node.children.length;

  const visibleChildren = node.children.filter((child) => matches(child, needle));
  const visibleBoards = node.boards.filter(
    (board) => needle === '' || board.name.toLowerCase().includes(needle),
  );

  // A folder cannot be moved into itself or anything under it — the server refuses it, and
  // offering it as a destination is offering a dead end.
  const forbidden = idsWithin(node);

  return (
    <li className="uboss-tree__node">
      <div
        className={
          node.folder.id === selectedFolderId ? 'uboss-tree__row is-active' : 'uboss-tree__row'
        }
        style={{ paddingInlineStart: `calc(var(--uboss-space-3) + ${depth} * 0.875rem)` }}
      >
        {/*
          One click, two effects: it opens the folder and shows what is in it on the right.
          Separating them into two hit targets at this width is how a sidebar becomes fiddly.
        */}
        <button
          type="button"
          className="uboss-tree__disclose"
          onClick={() => {
            onToggle(node.folder.id);
            onSelectFolder(node.folder.id);
          }}
          aria-expanded={isOpen}
        >
          {/* The chevron turns; it is not swapped for a second icon, so nothing jumps. */}
          <Icon
            name="chevron"
            size={14}
            className={isOpen ? 'uboss-tree__chevron is-open' : 'uboss-tree__chevron'}
          />
          <Icon name="folder" size={16} />
          <span className="uboss-tree__name">{node.folder.name}</span>
          <span className="uboss-tree__count uboss-muted">{count === 0 ? '' : count}</span>
        </button>

        {mayCreate ? (
          <RowMenu
            subject={node.folder.name}
            items={[
              {
                key: 'board',
                label: 'New board here',
                onSelect: () => onNewBoard(node.folder.id),
              },
              {
                key: 'folder',
                label: 'New folder inside',
                onSelect: () => onNewFolder(node.folder.id),
              },
              /*
                One item, not a destination per folder.

                It was a list of "Move into X" at first, capped at eight so the menu stayed a
                menu. With seventeen departments that cap is the whole problem: the eight it
                shows are the first eight alphabetically, so the folder somebody actually wants
                is the one that is missing. A picker shows all of them and costs one more click.
              */
              {
                key: 'move',
                label: 'Move to…',
                onSelect: () =>
                  onRequestMove({
                    kind: 'folder',
                    id: node.folder.id,
                    name: node.folder.name,
                    currentParentId: node.folder.parentFolderId,
                    forbiddenIds: forbidden,
                  }),
              },
            ]}
          />
        ) : null}
      </div>

      {isOpen ? (
        <ul className="uboss-tree__list">
          {visibleChildren.map((child) => (
            <FolderRow
              key={child.folder.id}
              node={child}
              depth={depth + 1}
              open={open}
              needle={needle}
              activeBoardId={activeBoardId}
              selectedFolderId={selectedFolderId}
              mayCreate={mayCreate}

              onToggle={onToggle}
              onSelectFolder={onSelectFolder}
              onOpenBoard={onOpenBoard}
              onNewFolder={onNewFolder}
              onNewBoard={onNewBoard}
              onRequestMove={onRequestMove}
            />
          ))}

          {visibleBoards.map((board) => (
            <BoardRow
              key={board.id}
              board={board}
              depth={depth + 1}
              active={board.id === activeBoardId}
              mayCreate={mayCreate}

              onOpen={onOpenBoard}
              onRequestMove={onRequestMove}
            />
          ))}

          {visibleChildren.length === 0 && visibleBoards.length === 0 ? (
            <li
              className="uboss-tree__empty uboss-muted"
              style={{ paddingInlineStart: `calc(var(--uboss-space-6) + ${depth} * 0.875rem)` }}
            >
              Empty
              {mayCreate ? (
                <Button variant="ghost" onClick={() => onNewBoard(node.folder.id)}>
                  Add a board
                </Button>
              ) : null}
            </li>
          ) : null}
        </ul>
      ) : null}
    </li>
  );
}

function BoardRow({
  board,
  depth,
  active,
  mayCreate,
  onOpen,
  onRequestMove,
}: {
  board: BoardSummary;
  depth: number;
  active: boolean;
  mayCreate: boolean;
  onOpen: (boardId: string) => void;
  onRequestMove: (target: MoveTarget) => void;
}) {
  return (
    <li className="uboss-tree__node">
      <div
        className={active ? 'uboss-tree__row is-active' : 'uboss-tree__row'}
        style={{ paddingInlineStart: `calc(var(--uboss-space-3) + ${depth} * 0.875rem)` }}
      >
        <button type="button" className="uboss-tree__open" onClick={() => onOpen(board.id)}>
          {/* Indented to where a chevron would be, so board names line up under folder names. */}
          <span className="uboss-tree__chevron-slot" aria-hidden />
          <Icon name="panel" size={16} />
          <span className="uboss-tree__name">{board.name}</span>
          {board.kind === 'Private' ? (
            <Icon name="shield" size={13} className="uboss-tree__kind" label="Private" />
          ) : null}
        </button>

        {mayCreate ? (
          <RowMenu
            subject={board.name}
            items={[
              { key: 'open', label: 'Open', onSelect: () => onOpen(board.id) },
              {
                key: 'move',
                label: 'Move to…',
                onSelect: () =>
                  onRequestMove({
                    kind: 'board',
                    id: board.id,
                    name: board.name,
                    currentParentId: board.folderId,
                    // A board cannot leave its space, so the picker only offers that space.
                    spaceId: board.spaceId,
                    forbiddenIds: [],
                  }),
              },
            ]}
          />
        ) : null}
      </div>
    </li>
  );
}
