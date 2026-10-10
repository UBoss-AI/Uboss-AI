'use client';

import { useRouter } from 'next/navigation';
import { useCallback, useEffect, useMemo, useState } from 'react';

import {
  Banner,
  Button,
  Card,
  CardBody,
  EmptyState,
  FilterBar,
  FormField,
  Modal,
  PageHeader,
  SearchField,
  SegmentedControl,
  SkeletonText,
  StatusBadge,
} from '@uboss/ui';

import { BOARD_KIND_DESCRIPTIONS, BOARD_KINDS } from '@uboss/types';

import {
  ApiError,
  authApi,
  boardsApi,
  type BoardSummary,
  type FolderSummary,
  type MeResponse,
  type SpaceSummary,
} from '../../lib/api-client';

import { BoardTree, foldersInTreeOrder, type MoveTarget } from './BoardTree';

import {
  forgetWorkspace,
  readRememberedWorkspace,
  resolveActiveWorkspace,
} from '../../lib/active-workspace';
import { RoutedAppShell } from '../../components/RoutedAppShell';
import { useAccountMenu } from '../../lib/use-account-menu';
import { can, useMyAccess } from '../../lib/use-my-access';
import { useCompanyNavigation } from '../../lib/use-company-navigation';
import { useNotificationBell } from '../../lib/use-notification-bell';
import { useSignedInUser } from '../../lib/use-signed-in-user';

/**
 * Task & Tracker — the boards somebody can open.
 *
 * ## What is listed and what is not
 *
 * A `Main` board is the company's and appears for everybody. A `Private` or `Shareable` one
 * appears only for the people on it — and is *absent* rather than refused, because a row saying
 * "Pay review (you may not open this)" is most of what somebody wanted to know. The server
 * decides; nothing is filtered here.
 *
 * ## Why creating one is not always offered
 *
 * `todo:Create`, which Manager, Head and Administrator hold and a standard Employee does not.
 * monday.com gates board creation at the account level for the same reason: a company of four
 * hundred where everybody makes boards has four hundred boards and no map. An administrator can
 * grant it deliberately.
 */
export default function TrackerPage() {
  const navGroups = useCompanyNavigation();
  const router = useRouter();
  const access = useMyAccess();

  const [me, setMe] = useState<MeResponse | null>(null);
  const [boards, setBoards] = useState<BoardSummary[] | null>(null);
  const [spaces, setSpaces] = useState<SpaceSummary[]>([]);
  const [folders, setFolders] = useState<FolderSummary[]>([]);
  const [error, setError] = useState<string | null>(null);

  const [query, setQuery] = useState('');
  // Where a new one would go. `undefined` means no dialog is open; `null` means the top of the
  // space — which is a real answer, and the reason this is not a boolean and an id.
  const [makingBoardIn, setMakingBoardIn] = useState<string | null | undefined>(undefined);
  const [makingFolderIn, setMakingFolderIn] = useState<string | null | undefined>(undefined);
  const [fromDepartments, setFromDepartments] = useState(false);
  const [selectedFolderId, setSelectedFolderId] = useState<string | null>(null);
  const [moving, setMoving] = useState<MoveTarget | null>(null);

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
    if (!tenantId) return;
    setError(null);

    void Promise.all([
      boardsApi.listBoards(tenantId),
      boardsApi.listSpaces(tenantId),
      boardsApi.listFolders(tenantId),
    ])
      .then(([boardList, spaceList, folderList]) => {
        setBoards(boardList.boards);
        setSpaces(spaceList.spaces);
        setFolders(folderList.folders);
      })
      .catch((caught: unknown) =>
        setError(caught instanceof ApiError ? caught.message : 'Could not load your boards.'),
      );
  }, [tenantId]);

  useEffect(load, [load]);

  const activeWorkspace = me?.workspaces.find((workspace) => workspace.tenantId === tenantId);
  const mayCreate = can(access, 'todo', 'Create');

  /*
   * What the right-hand pane shows.
   *
   * A folder selected in the tree shows that folder and everything under it, not only its own
   * boards — somebody who clicks PRODUCTION means the production work, not the four boards that
   * happen to sit at that exact level. Nothing selected shows the lot.
   */
  const visibleBoards = useMemo(() => {
    const needle = query.trim().toLowerCase();

    const within = new Set<string>();
    if (selectedFolderId !== null) {
      const queue = [selectedFolderId];
      while (queue.length > 0) {
        const id = queue.pop()!;
        if (within.has(id)) continue;
        within.add(id);
        for (const folder of folders) {
          if (folder.parentFolderId === id) queue.push(folder.id);
        }
      }
    }

    return (boards ?? []).filter((board) => {
      if (selectedFolderId !== null && (board.folderId === null || !within.has(board.folderId))) {
        return false;
      }
      return (
        needle === '' ||
        board.name.toLowerCase().includes(needle) ||
        (board.description ?? '').toLowerCase().includes(needle)
      );
    });
  }, [boards, folders, query, selectedFolderId]);

  const folderName = (id: string | null) =>
    id === null ? null : (folders.find((folder) => folder.id === id)?.name ?? null);

  /** The path to a folder, for the breadcrumb: PRODUCTION / IV Cannula / October. */
  const folderPath = useMemo(() => {
    const trail: string[] = [];
    let cursor = selectedFolderId;
    const seen = new Set<string>();
    while (cursor !== null && !seen.has(cursor)) {
      seen.add(cursor);
      const folder = folders.find((row) => row.id === cursor);
      if (!folder) break;
      trail.unshift(folder.name);
      cursor = folder.parentFolderId;
    }
    return trail;
  }, [folders, selectedFolderId]);

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
        title="RIS"
        description="Boards: groups down the page, columns across it, and whatever work you put on them."
        breadcrumbs={[{ label: 'RIS' }, ...folderPath.map((label) => ({ label }))]}
        {...(mayCreate
          ? {
              actions: (
                <>
                  <Button variant="default" onClick={() => setMakingFolderIn(selectedFolderId)}>
                    New folder
                  </Button>
                  <Button variant="primary" onClick={() => setMakingBoardIn(selectedFolderId)}>
                    New board
                  </Button>
                </>
              ),
            }
          : {})}
      />

      {error ? <Banner tone="danger">{error}</Banner> : null}

      {boards === null ? (
        error === null ? (
          <Card>
            <CardBody>
              <SkeletonText lines={5} />
            </CardBody>
          </Card>
        ) : null
      ) : (
        /*
          The tree on the left, what is in it on the right.

          A company with seventeen departments has seventeen folders and a board or four in each.
          Seventy cards in one scroll is a wall; the rail is what makes most of it closed.
        */
        <div className="uboss-tracker">
          <aside className="uboss-tracker__rail">
            <BoardTree
              spaces={spaces}
              folders={folders}
              boards={boards}
              selectedFolderId={selectedFolderId}
              query={query}
              mayCreate={mayCreate}
              onSelectFolder={setSelectedFolderId}
              onOpenBoard={(boardId) => router.push(`/tracker/${boardId}`)}
              onNewFolder={(parentFolderId) => setMakingFolderIn(parentFolderId)}
              onNewBoard={(folderId) => setMakingBoardIn(folderId)}
              onRequestMove={setMoving}
              onFromDepartments={() => setFromDepartments(true)}
            />
          </aside>

          <div className="uboss-tracker__main">
            <FilterBar>
              <SearchField
                label="Search boards"
                value={query}
                onChange={(event) => setQuery(event.target.value)}
                placeholder="Board name or description"
              />
            </FilterBar>

            {visibleBoards.length === 0 ? (
              <EmptyState
                icon="panel"
                title={
                  query.trim() !== ''
                    ? 'No board matches that'
                    : selectedFolderId === null
                      ? 'No boards yet'
                      : `Nothing in ${folderName(selectedFolderId) ?? 'this folder'} yet`
                }
                description={
                  query.trim() !== ''
                    ? undefined
                    : mayCreate
                      ? 'A board is a table you choose the columns of — a delivery plan, a hiring pipeline, a list of faults. Start with one and rename what it ships with.'
                      : 'Boards you are added to appear here. Ask an administrator or a manager to make one, or to add you to theirs.'
                }
                actions={
                  query.trim() !== '' ? (
                    <Button variant="default" onClick={() => setQuery('')}>
                      Show all boards
                    </Button>
                  ) : mayCreate ? (
                    <Button variant="primary" onClick={() => setMakingBoardIn(selectedFolderId)}>
                      New board
                    </Button>
                  ) : undefined
                }
              />
            ) : (
              <div className="uboss-board-grid">
                {visibleBoards.map((board) => (
                  <Card key={board.id}>
                    <CardBody>
                      <button
                        type="button"
                        className="uboss-board-card__open"
                        onClick={() => router.push(`/tracker/${board.id}`)}
                      >
                        <span className="uboss-board-card__head">
                          <span className="uboss-board-card__name">{board.name}</span>
                          {/*
                            The kind, stated. A board nobody was added to is either everybody's
                            or nobody's, and which one is not something a member list can say.
                          */}
                          <StatusBadge
                            status={board.kind}
                            tone={board.kind === 'Private' ? 'purple' : 'grey'}
                          />
                        </span>
                        {board.description === null ? null : (
                          <span className="uboss-board-card__desc">{board.description}</span>
                        )}
                        <span className="uboss-board-card__foot">
                          <span>
                            {board.itemCount} {board.itemCount === 1 ? 'item' : 'items'}
                          </span>
                          <span className="uboss-muted">
                            {/* Where it lives, so the card and the rail agree. */}
                            {folderName(board.folderId) ?? 'Top level'}
                          </span>
                        </span>
                      </button>
                    </CardBody>
                  </Card>
                ))}
              </div>
            )}
          </div>
        </div>
      )}

      {makingBoardIn !== undefined && tenantId ? (
        <NewBoardDialog
          tenantId={tenantId}
          folders={folders}
          folderId={makingBoardIn}
          onClose={() => setMakingBoardIn(undefined)}
          onMade={(boardId) => {
            setMakingBoardIn(undefined);
            router.push(`/tracker/${boardId}`);
          }}
        />
      ) : null}

      {makingFolderIn !== undefined && tenantId ? (
        <NewFolderDialog
          tenantId={tenantId}
          parentFolderId={makingFolderIn}
          parentName={folderName(makingFolderIn)}
          onClose={() => setMakingFolderIn(undefined)}
          onMade={() => {
            setMakingFolderIn(undefined);
            load();
          }}
        />
      ) : null}

      {moving !== null && tenantId ? (
        <MoveDialog
          tenantId={tenantId}
          target={moving}
          folders={folders}
          onClose={() => setMoving(null)}
          onMoved={() => {
            setMoving(null);
            load();
          }}
        />
      ) : null}

      {fromDepartments && tenantId ? (
        <FromDepartmentsDialog
          tenantId={tenantId}
          onClose={() => setFromDepartments(false)}
          onDone={() => {
            setFromDepartments(false);
            load();
          }}
        />
      ) : null}
    </RoutedAppShell>
  );
}

/**
 * Making a board.
 *
 * Three fields, and the kind explained rather than named: "Shareable" tells somebody nothing on
 * its own, and this is the one decision on this screen that is hard to change afterwards.
 */
function NewBoardDialog({
  tenantId,
  folders,
  folderId,
  onClose,
  onMade,
}: {
  tenantId: string;
  folders: FolderSummary[];
  /** Where the click came from. Null is the top of the space, and is a real answer. */
  folderId: string | null;
  onClose: () => void;
  onMade: (boardId: string) => void;
}) {
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [kind, setKind] = useState<string>('Main');
  const [where, setWhere] = useState<string>(folderId ?? '');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async () => {
    setBusy(true);
    setError(null);
    try {
      const board = await boardsApi.createBoard(tenantId, {
        name,
        kind,
        ...(where === '' ? {} : { folderId: where }),
        ...(description.trim() === '' ? {} : { description }),
      });
      onMade(board.id);
    } catch (caught: unknown) {
      setError(caught instanceof ApiError ? caught.message : 'That board could not be made.');
      setBusy(false);
    }
  };

  return (
    <Modal
      open
      onClose={onClose}
      title="New board"
      footer={
        <>
          <Button variant="ghost" onClick={onClose} disabled={busy}>
            Cancel
          </Button>
          <Button
            variant="primary"
            onClick={() => void submit()}
            disabled={busy || name.trim() === ''}
          >
            {busy ? 'Making…' : 'Make the board'}
          </Button>
        </>
      }
    >
      {error ? <Banner tone="danger">{error}</Banner> : null}

      <FormField label="Name" required>
        {(field) => (
          <input
            {...field}
            className="uboss-input"
            value={name}
            onChange={(event) => setName(event.target.value)}
            placeholder="Delivery plan"
            maxLength={200}
            /* The field this dialog is about, rather than its close button. See useFocusTrap. */
            data-autofocus
          />
        )}
      </FormField>

      <FormField label="What it is for" hint="Optional.">
        {(field) => (
          <input
            {...field}
            className="uboss-input"
            value={description}
            onChange={(event) => setDescription(event.target.value)}
            maxLength={2000}
          />
        )}
      </FormField>

      {/*
        Where it goes, pre-filled from wherever the click came from. Indented by depth, because
        two folders called "October" in different departments are otherwise the same line twice.
      */}
      <FormField label="Where it goes" hint="It can be moved afterwards.">
        {(field) => (
          <select
            {...field}
            className="uboss-input"
            value={where}
            onChange={(event) => setWhere(event.target.value)}
          >
            <option value="">Top level</option>
            {foldersInTreeOrder(folders).map((folder) => (
              <option key={folder.id} value={folder.id}>
                {`${'  '.repeat(folder.depth)}${folder.name}`}
              </option>
            ))}
          </select>
        )}
      </FormField>

      {/*
        Not a FormField: that wires a label to one control, and this is a group of buttons with a
        sentence under it. SegmentedControl carries its own accessible name.
      */}
      <div className="uboss-board-kind">
        <SegmentedControl
          label="Who can reach it"
          value={kind}
          onChange={setKind}
          options={BOARD_KINDS.map((value) => ({ value, label: value }))}
        />
        {/* The kind explained rather than named — this is the one choice here that is hard to
            change later, and "Shareable" tells nobody anything on its own. */}
        <p className="uboss-muted uboss-board-kind__note">
          {BOARD_KIND_DESCRIPTIONS[kind as 'Main']}
        </p>
      </div>

      <p className="uboss-muted">
        It arrives with three groups and three columns — Status, Owner and Due date. Rename or
        remove any of them.
      </p>
    </Modal>
  );
}

/**
 * Making a folder.
 *
 * One field. A folder is a name and a place, and the place came from wherever the click was.
 */
function NewFolderDialog({
  tenantId,
  parentFolderId,
  parentName,
  onClose,
  onMade,
}: {
  tenantId: string;
  parentFolderId: string | null;
  parentName: string | null;
  onClose: () => void;
  onMade: () => void;
}) {
  const [name, setName] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async () => {
    setBusy(true);
    setError(null);
    try {
      await boardsApi.createFolder(tenantId, {
        name,
        ...(parentFolderId === null ? {} : { parentFolderId }),
      });
      onMade();
    } catch (caught: unknown) {
      setError(caught instanceof ApiError ? caught.message : 'That folder could not be made.');
      setBusy(false);
    }
  };

  return (
    <Modal
      open
      onClose={onClose}
      title={parentName === null ? 'New folder' : `New folder in ${parentName}`}
      footer={
        <>
          <Button variant="ghost" onClick={onClose} disabled={busy}>
            Cancel
          </Button>
          <Button
            variant="primary"
            onClick={() => void submit()}
            disabled={busy || name.trim() === ''}
          >
            {busy ? 'Making…' : 'Make the folder'}
          </Button>
        </>
      }
    >
      {error ? <Banner tone="danger">{error}</Banner> : null}

      <FormField label="Name" required>
        {(field) => (
          <input
            {...field}
            className="uboss-input"
            value={name}
            onChange={(event) => setName(event.target.value)}
            placeholder="PRODUCTION"
            maxLength={200}
            data-autofocus
          />
        )}
      </FormField>

      <p className="uboss-muted">
        A folder can hold boards and more folders. Nothing is in it until you put something there.
      </p>
    </Modal>
  );
}

/**
 * A folder per department, in one press.
 *
 * ## Why it previews first
 *
 * Seventeen folders that appeared without being asked for is a surprise found a week later by
 * somebody who did not press the button. This shows the names it would create, and only then
 * offers to create them — and a department that already has a folder is listed as left alone
 * rather than silently duplicated.
 *
 * The client asked for both ways: folders typed one at a time, and this. Neither replaces the
 * other, which is why the manual path stays on every menu in the rail.
 */
function FromDepartmentsDialog({
  tenantId,
  onClose,
  onDone,
}: {
  tenantId: string;
  onClose: () => void;
  onDone: () => void;
}) {
  const [preview, setPreview] = useState<{ willCreate: string[]; skipped: number } | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    boardsApi
      .foldersFromDepartments(tenantId, true)
      .then((result) => setPreview({ willCreate: result.willCreate, skipped: result.skipped }))
      .catch((caught: unknown) =>
        setError(
          caught instanceof ApiError ? caught.message : 'Could not read this company departments.',
        ),
      );
  }, [tenantId]);

  const apply = async () => {
    setBusy(true);
    setError(null);
    try {
      await boardsApi.foldersFromDepartments(tenantId, false);
      onDone();
    } catch (caught: unknown) {
      setError(caught instanceof ApiError ? caught.message : 'Those folders could not be made.');
      setBusy(false);
    }
  };

  const nothingToDo = preview !== null && preview.willCreate.length === 0;

  return (
    <Modal
      open
      onClose={onClose}
      title="A folder per department"
      footer={
        <>
          <Button variant="ghost" onClick={onClose} disabled={busy}>
            {nothingToDo ? 'Close' : 'Cancel'}
          </Button>
          {nothingToDo ? null : (
            <Button
              variant="primary"
              onClick={() => void apply()}
              disabled={busy || preview === null}
            >
              {busy
                ? 'Making…'
                : preview === null
                  ? 'Reading…'
                  : `Make ${preview.willCreate.length} folder${preview.willCreate.length === 1 ? '' : 's'}`}
            </Button>
          )}
        </>
      }
    >
      {error ? <Banner tone="danger">{error}</Banner> : null}

      {preview === null ? (
        <SkeletonText lines={4} />
      ) : nothingToDo ? (
        <p>
          {preview.skipped === 0
            ? 'This company has no departments yet, so there is nothing to make folders from.'
            : 'Every department already has a folder. Nothing to do.'}
        </p>
      ) : (
        <>
          <p>These folders would be made at the top of the space:</p>
          <ul className="uboss-list">
            {preview.willCreate.map((name) => (
              <li key={name}>{name}</li>
            ))}
          </ul>
          {preview.skipped === 0 ? null : (
            <p className="uboss-muted">
              {preview.skipped} department{preview.skipped === 1 ? '' : 's'} already{' '}
              {preview.skipped === 1 ? 'has' : 'have'} a folder and will be left alone.
            </p>
          )}
        </>
      )}
    </Modal>
  );
}

/**
 * Moving a folder or a board.
 *
 * ## Why this is a dialog and not a menu
 *
 * It was a menu: one "Move into X" per folder, capped at eight so the menu stayed a menu. With
 * seventeen departments that cap is the whole problem — the eight it shows are the first eight
 * alphabetically, so the folder somebody wants is reliably the one that is missing. A list that
 * is sometimes complete is worse than one that never pretends to be.
 *
 * ## What it refuses to offer
 *
 * A folder cannot go inside itself or anything under it. The server refuses that move, because
 * a loop is a tree nothing can finish walking — but a destination that will be refused should
 * not be on the list in the first place, so the row says which ids are out and they are dropped
 * here. The server is still the one enforcing it.
 */
function MoveDialog({
  tenantId,
  target,
  folders,
  onClose,
  onMoved,
}: {
  tenantId: string;
  target: MoveTarget;
  folders: FolderSummary[];
  onClose: () => void;
  onMoved: () => void;
}) {
  const [where, setWhere] = useState<string>(target.currentParentId ?? '');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const forbidden = new Set(target.forbiddenIds);
  const choices = foldersInTreeOrder(folders).filter((folder) => {
    if (forbidden.has(folder.id)) return false;
    if (target.spaceId !== undefined && folder.spaceId !== target.spaceId) return false;
    return true;
  });

  const submit = async () => {
    setBusy(true);
    setError(null);
    try {
      const destination = where === '' ? null : where;
      if (target.kind === 'folder') {
        await boardsApi.moveFolder(tenantId, target.id, destination);
      } else {
        await boardsApi.moveBoard(tenantId, target.id, destination);
      }
      onMoved();
    } catch (caught: unknown) {
      setError(caught instanceof ApiError ? caught.message : 'That could not be moved.');
      setBusy(false);
    }
  };

  const unchanged = (target.currentParentId ?? '') === where;

  return (
    <Modal
      open
      onClose={onClose}
      title={`Move ${target.name}`}
      footer={
        <>
          <Button variant="ghost" onClick={onClose} disabled={busy}>
            Cancel
          </Button>
          <Button variant="primary" onClick={() => void submit()} disabled={busy || unchanged}>
            {busy ? 'Moving…' : 'Move it'}
          </Button>
        </>
      }
    >
      {error ? <Banner tone="danger">{error}</Banner> : null}

      <FormField label="Where it goes">
        {(field) => (
          <select
            {...field}
            className="uboss-input"
            value={where}
            onChange={(event) => setWhere(event.target.value)}
            data-autofocus
          >
            <option value="">Top level</option>
            {choices.map((folder) => (
              <option key={folder.id} value={folder.id}>
                {`${'\u00a0\u00a0'.repeat(folder.depth)}${folder.name}`}
              </option>
            ))}
          </select>
        )}
      </FormField>

      {target.kind === 'folder' ? (
        <p className="uboss-muted">
          Everything inside it moves with it. A folder cannot go inside one of its own, so those are
          not listed.
        </p>
      ) : (
        <p className="uboss-muted">Only the folders in this board&rsquo;s own space are listed.</p>
      )}
    </Modal>
  );
}
