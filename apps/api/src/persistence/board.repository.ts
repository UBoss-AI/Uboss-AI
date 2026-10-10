import { Injectable } from '@nestjs/common';

import type {
  Board,
  BoardCellValue,
  BoardFolder,
  BoardColumn,
  BoardGroup,
  BoardItem,
  BoardItemUpdate,
  BoardMember,
  Space,
} from '../generated/prisma/client.js';
import { PrismaService } from './prisma.service.js';
import type { TenantScope } from './tenant-context.js';

/**
 * Task & Tracker data access.
 *
 * Reads and writes only. Who may do them is `BoardService`'s question, and the reason it is not
 * this file's is the one the codebase settled long ago: authorization that lives beside the query
 * ends up restated at every call site, and the two drift. Nothing here checks a permission.
 *
 * Every method opens a tenant transaction, because row-level security reads
 * `app.current_tenant_id` and an unwrapped query comes back **empty rather than failing** — the
 * quietest way to be wrong that this codebase has.
 */
@Injectable()
export class BoardRepository {
  constructor(private readonly prisma: PrismaService) {}

  // ---- Spaces -------------------------------------------------------------

  async listSpaces(scope: TenantScope, includeArchived = false): Promise<Space[]> {
    return this.prisma.runInTenantTransaction(scope, () =>
      this.prisma.client.space.findMany({
        where: {
          tenantId: scope.tenantId,
          ...(includeArchived ? {} : { archivedAt: null }),
        },
        orderBy: [{ position: 'asc' }, { createdAt: 'asc' }],
      }),
    );
  }

  async findSpace(scope: TenantScope, spaceId: string): Promise<Space | null> {
    return this.prisma.runInTenantTransaction(scope, () =>
      this.prisma.client.space.findFirst({ where: { tenantId: scope.tenantId, id: spaceId } }),
    );
  }

  async defaultSpace(scope: TenantScope): Promise<Space | null> {
    return this.prisma.runInTenantTransaction(scope, () =>
      this.prisma.client.space.findFirst({
        where: { tenantId: scope.tenantId, isDefault: true, archivedAt: null },
      }),
    );
  }

  async createSpace(
    scope: TenantScope,
    input: {
      name: string;
      description: string | null;
      tone: string;
      isDefault: boolean;
      createdByUserId: string;
      position: number;
    },
  ): Promise<Space> {
    return this.prisma.runInTenantTransaction(scope, () =>
      this.prisma.client.space.create({ data: { tenantId: scope.tenantId, ...input } }),
    );
  }

  // ---- Boards -------------------------------------------------------------

  /**
   * Every live board in the company, with the asker's own membership attached.
   *
   * One query rather than a list followed by a membership lookup per board: a company with two
   * hundred boards is two hundred extra round trips for a sidebar, and the caller needs the
   * membership on every single row to decide whether the row may be shown at all.
   */
  async listBoards(
    scope: TenantScope,
    userId: string,
    spaceId?: string,
  ): Promise<(Board & { members: BoardMember[]; _count: { items: number } })[]> {
    return this.prisma.runInTenantTransaction(scope, () =>
      this.prisma.client.board.findMany({
        where: {
          tenantId: scope.tenantId,
          archivedAt: null,
          ...(spaceId === undefined ? {} : { spaceId }),
        },
        include: {
          members: { where: { userId } },
          _count: { select: { items: true } },
        },
        orderBy: [{ position: 'asc' }, { createdAt: 'asc' }],
      }),
    );
  }

  async findBoard(scope: TenantScope, boardId: string): Promise<Board | null> {
    return this.prisma.runInTenantTransaction(scope, () =>
      this.prisma.client.board.findFirst({ where: { tenantId: scope.tenantId, id: boardId } }),
    );
  }

  async createBoard(
    scope: TenantScope,
    input: {
      spaceId: string;
      folderId: string | null;
      name: string;
      description: string | null;
      kind: string;
      createdByUserId: string;
      position: number;
    },
  ): Promise<Board> {
    return this.prisma.runInTenantTransaction(scope, () =>
      this.prisma.client.board.create({ data: { tenantId: scope.tenantId, ...input } }),
    );
  }

  async archiveBoard(scope: TenantScope, boardId: string): Promise<void> {
    await this.prisma.runInTenantTransaction(scope, async () => {
      await this.prisma.client.board.update({
        where: { id: boardId },
        data: { archivedAt: new Date() },
      });
    });
  }

  // ---- Folders ------------------------------------------------------------

  async listFolders(scope: TenantScope, spaceId?: string): Promise<BoardFolder[]> {
    return this.prisma.runInTenantTransaction(scope, () =>
      this.prisma.client.boardFolder.findMany({
        where: {
          tenantId: scope.tenantId,
          archivedAt: null,
          ...(spaceId === undefined ? {} : { spaceId }),
        },
        orderBy: [{ depth: 'asc' }, { position: 'asc' }, { createdAt: 'asc' }],
      }),
    );
  }

  async findFolder(scope: TenantScope, folderId: string): Promise<BoardFolder | null> {
    return this.prisma.runInTenantTransaction(scope, () =>
      this.prisma.client.boardFolder.findFirst({
        where: { tenantId: scope.tenantId, id: folderId },
      }),
    );
  }

  async createFolder(
    scope: TenantScope,
    input: {
      spaceId: string;
      parentFolderId: string | null;
      depth: number;
      name: string;
      tone: string;
      position: number;
      createdByUserId: string;
    },
  ): Promise<BoardFolder> {
    return this.prisma.runInTenantTransaction(scope, () =>
      this.prisma.client.boardFolder.create({ data: { tenantId: scope.tenantId, ...input } }),
    );
  }

  /**
   * Every folder under this one, at any depth.
   *
   * Used by the move check, which has to know whether a destination is one of the folder's own
   * descendants. A recursive query rather than a loop in the service: the database walks the
   * tree once instead of the service making one round trip per level, and the walk is bounded by
   * the same `depth` the rows already carry.
   */
  async descendantFolderIds(scope: TenantScope, folderId: string): Promise<string[]> {
    const rows = await this.prisma.runInTenantTransaction(
      scope,
      () =>
        this.prisma.client.$queryRaw<{ id: string }[]>`
        WITH RECURSIVE below AS (
          SELECT id FROM board_folders
           WHERE tenant_id = ${scope.tenantId}::uuid AND parent_folder_id = ${folderId}::uuid
          UNION ALL
          SELECT f.id FROM board_folders f
            JOIN below b ON f.parent_folder_id = b.id
           WHERE f.tenant_id = ${scope.tenantId}::uuid
        )
        SELECT id FROM below
      `,
    );

    return rows.map((row) => row.id);
  }

  async moveFolder(
    scope: TenantScope,
    folderId: string,
    parentFolderId: string | null,
    depth: number,
  ): Promise<BoardFolder> {
    return this.prisma.runInTenantTransaction(scope, () =>
      this.prisma.client.boardFolder.update({
        where: { id: folderId },
        data: { parentFolderId, depth },
      }),
    );
  }

  /** Put a board in a folder, or take it out of one. */
  async setBoardFolder(
    scope: TenantScope,
    boardId: string,
    folderId: string | null,
  ): Promise<void> {
    await this.prisma.runInTenantTransaction(scope, async () => {
      await this.prisma.client.board.update({ where: { id: boardId }, data: { folderId } });
    });
  }

  // ---- Membership ---------------------------------------------------------

  async membership(
    scope: TenantScope,
    boardId: string,
    userId: string,
  ): Promise<BoardMember | null> {
    return this.prisma.runInTenantTransaction(scope, () =>
      this.prisma.client.boardMember.findFirst({
        where: { tenantId: scope.tenantId, boardId, userId },
      }),
    );
  }

  async listMembers(scope: TenantScope, boardId: string): Promise<BoardMember[]> {
    return this.prisma.runInTenantTransaction(scope, () =>
      this.prisma.client.boardMember.findMany({
        where: { tenantId: scope.tenantId, boardId },
        orderBy: { createdAt: 'asc' },
      }),
    );
  }

  /**
   * Add somebody, or change the role they already hold.
   *
   * An upsert because "add Priya as a Viewer" twice is one membership, not a duplicate-key error
   * the caller has to interpret — and `one_membership_per_person_per_board` would raise exactly
   * that. The second call is the operator correcting the first.
   */
  async upsertMember(
    scope: TenantScope,
    input: { boardId: string; userId: string; role: string; addedByUserId: string },
  ): Promise<BoardMember> {
    return this.prisma.runInTenantTransaction(scope, () =>
      this.prisma.client.boardMember.upsert({
        where: { boardId_userId: { boardId: input.boardId, userId: input.userId } },
        create: { tenantId: scope.tenantId, ...input },
        update: { role: input.role },
      }),
    );
  }

  async removeMember(scope: TenantScope, boardId: string, userId: string): Promise<void> {
    await this.prisma.runInTenantTransaction(scope, async () => {
      await this.prisma.client.boardMember.deleteMany({
        where: { tenantId: scope.tenantId, boardId, userId },
      });
    });
  }

  // ---- Columns and groups -------------------------------------------------

  async listColumns(scope: TenantScope, boardId: string): Promise<BoardColumn[]> {
    return this.prisma.runInTenantTransaction(scope, () =>
      this.prisma.client.boardColumn.findMany({
        where: { tenantId: scope.tenantId, boardId, archivedAt: null },
        orderBy: [{ position: 'asc' }, { createdAt: 'asc' }],
      }),
    );
  }

  async findColumn(scope: TenantScope, columnId: string): Promise<BoardColumn | null> {
    return this.prisma.runInTenantTransaction(scope, () =>
      this.prisma.client.boardColumn.findFirst({
        where: { tenantId: scope.tenantId, id: columnId },
      }),
    );
  }

  async createColumn(
    scope: TenantScope,
    input: {
      boardId: string;
      title: string;
      kind: string;
      settings: object;
      position: number;
      width: number;
    },
  ): Promise<BoardColumn> {
    return this.prisma.runInTenantTransaction(scope, () =>
      this.prisma.client.boardColumn.create({ data: { tenantId: scope.tenantId, ...input } }),
    );
  }

  async listGroups(scope: TenantScope, boardId: string): Promise<BoardGroup[]> {
    return this.prisma.runInTenantTransaction(scope, () =>
      this.prisma.client.boardGroup.findMany({
        where: { tenantId: scope.tenantId, boardId, archivedAt: null },
        orderBy: [{ position: 'asc' }, { createdAt: 'asc' }],
      }),
    );
  }

  async createGroup(
    scope: TenantScope,
    input: { boardId: string; title: string; tone: string; position: number },
  ): Promise<BoardGroup> {
    return this.prisma.runInTenantTransaction(scope, () =>
      this.prisma.client.boardGroup.create({ data: { tenantId: scope.tenantId, ...input } }),
    );
  }

  async findGroup(scope: TenantScope, groupId: string): Promise<BoardGroup | null> {
    return this.prisma.runInTenantTransaction(scope, () =>
      this.prisma.client.boardGroup.findFirst({ where: { tenantId: scope.tenantId, id: groupId } }),
    );
  }

  // ---- Items and cells ----------------------------------------------------

  async listItems(scope: TenantScope, boardId: string): Promise<BoardItem[]> {
    return this.prisma.runInTenantTransaction(scope, () =>
      this.prisma.client.boardItem.findMany({
        where: { tenantId: scope.tenantId, boardId, archivedAt: null },
        orderBy: [{ position: 'asc' }, { createdAt: 'asc' }],
      }),
    );
  }

  async findItem(scope: TenantScope, itemId: string): Promise<BoardItem | null> {
    return this.prisma.runInTenantTransaction(scope, () =>
      this.prisma.client.boardItem.findFirst({ where: { tenantId: scope.tenantId, id: itemId } }),
    );
  }

  async createItem(
    scope: TenantScope,
    input: {
      boardId: string;
      groupId: string;
      parentItemId: string | null;
      depth: number;
      name: string;
      position: number;
      createdByUserId: string;
    },
  ): Promise<BoardItem> {
    return this.prisma.runInTenantTransaction(scope, () =>
      this.prisma.client.boardItem.create({ data: { tenantId: scope.tenantId, ...input } }),
    );
  }

  async renameItem(scope: TenantScope, itemId: string, name: string): Promise<BoardItem> {
    return this.prisma.runInTenantTransaction(scope, () =>
      this.prisma.client.boardItem.update({ where: { id: itemId }, data: { name } }),
    );
  }

  async archiveItem(scope: TenantScope, itemId: string): Promise<void> {
    await this.prisma.runInTenantTransaction(scope, async () => {
      await this.prisma.client.boardItem.update({
        where: { id: itemId },
        data: { archivedAt: new Date() },
      });
    });
  }

  /** Every filled cell on a board. Sparse: an empty cell has no row at all. */
  async listCells(scope: TenantScope, boardId: string): Promise<BoardCellValue[]> {
    return this.prisma.runInTenantTransaction(scope, () =>
      this.prisma.client.boardCellValue.findMany({
        where: { tenantId: scope.tenantId, item: { boardId, archivedAt: null } },
      }),
    );
  }

  /**
   * Write one cell, or clear it.
   *
   * Clearing deletes the row rather than storing a null, because the model's claim is that an
   * empty cell is the *absence* of a value — a row holding null would be a second way to say
   * nothing, and every reader would have to handle both.
   */
  async setCell(
    scope: TenantScope,
    input: { itemId: string; columnId: string; value: unknown; updatedByUserId: string },
  ): Promise<BoardCellValue | null> {
    return this.prisma.runInTenantTransaction(scope, async () => {
      if (input.value === null || input.value === undefined) {
        await this.prisma.client.boardCellValue.deleteMany({
          where: { tenantId: scope.tenantId, itemId: input.itemId, columnId: input.columnId },
        });
        return null;
      }

      return this.prisma.client.boardCellValue.upsert({
        where: { itemId_columnId: { itemId: input.itemId, columnId: input.columnId } },
        create: {
          tenantId: scope.tenantId,
          itemId: input.itemId,
          columnId: input.columnId,
          value: input.value as object,
          updatedByUserId: input.updatedByUserId,
        },
        update: { value: input.value as object, updatedByUserId: input.updatedByUserId },
      });
    });
  }

  // ---- The thread ---------------------------------------------------------

  async listUpdates(scope: TenantScope, itemId: string): Promise<BoardItemUpdate[]> {
    return this.prisma.runInTenantTransaction(scope, () =>
      this.prisma.client.boardItemUpdate.findMany({
        where: { tenantId: scope.tenantId, itemId, archivedAt: null },
        orderBy: { createdAt: 'asc' },
      }),
    );
  }

  async createUpdate(
    scope: TenantScope,
    input: {
      itemId: string;
      parentUpdateId: string | null;
      body: string;
      authorUserId: string;
    },
  ): Promise<BoardItemUpdate> {
    return this.prisma.runInTenantTransaction(scope, () =>
      this.prisma.client.boardItemUpdate.create({ data: { tenantId: scope.tenantId, ...input } }),
    );
  }

  async findUpdate(scope: TenantScope, updateId: string): Promise<BoardItemUpdate | null> {
    return this.prisma.runInTenantTransaction(scope, () =>
      this.prisma.client.boardItemUpdate.findFirst({
        where: { tenantId: scope.tenantId, id: updateId },
      }),
    );
  }

  /**
   * Display names for a set of people.
   *
   * On the platform plane, like every other read of `users`: a name belongs to the human and not
   * to one of their companies. The ids come from this tenant's own board membership, and only
   * the name is read.
   */
  async namesFor(scope: TenantScope, userIds: readonly string[]): Promise<Map<string, string>> {
    if (userIds.length === 0) return new Map();
    void scope;

    const rows = await this.prisma.runAsPlatformOperation(() =>
      this.prisma.client.user.findMany({
        where: { id: { in: [...new Set(userIds)] } },
        select: { id: true, displayName: true },
      }),
    );

    return new Map(rows.map((row) => [row.id, row.displayName]));
  }

  /**
   * The next free slot at the end of a list.
   *
   * Fractional positions mean inserting between two rows is one update rather than a
   * renumbering, and appending only needs to know what the last one was.
   */
  async nextPosition(
    scope: TenantScope,
    of: 'space' | 'board' | 'group' | 'column' | 'item' | 'folder',
    where: { spaceId?: string; boardId?: string; groupId?: string; parentFolderId?: string | null },
  ): Promise<number> {
    return this.prisma.runInTenantTransaction(scope, async () => {
      const filter = { tenantId: scope.tenantId, ...where };
      const last =
        of === 'space'
          ? await this.prisma.client.space.findFirst({
              where: { tenantId: scope.tenantId },
              orderBy: { position: 'desc' },
              select: { position: true },
            })
          : of === 'board'
            ? await this.prisma.client.board.findFirst({
                where: filter,
                orderBy: { position: 'desc' },
                select: { position: true },
              })
            : of === 'group'
              ? await this.prisma.client.boardGroup.findFirst({
                  where: filter,
                  orderBy: { position: 'desc' },
                  select: { position: true },
                })
              : of === 'folder'
                ? await this.prisma.client.boardFolder.findFirst({
                    where: filter,
                    orderBy: { position: 'desc' },
                    select: { position: true },
                  })
                : of === 'column'
                  ? await this.prisma.client.boardColumn.findFirst({
                      where: filter,
                      orderBy: { position: 'desc' },
                      select: { position: true },
                    })
                  : await this.prisma.client.boardItem.findFirst({
                      where: filter,
                      orderBy: { position: 'desc' },
                      select: { position: true },
                    });

      return (last?.position ?? 0) + 1000;
    });
  }
}
