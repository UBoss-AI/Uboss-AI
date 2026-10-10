import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';

import {
  DEFAULT_BOARD_GROUPS,
  DEFAULT_STATUS_LABELS,
  isBoardColumnKind,
  isBoardKind,
  isBoardMemberRole,
  MAX_BOARD_ITEM_DEPTH,
  MAX_FOLDER_DEPTH,
  type BoardColumnKind,
  type BoardMemberRole,
} from '@uboss/types';

import { AuditEventService } from '../audit/audit-event.service.js';
import { AuthorizationService } from '../authorization/authorization.service.js';
import type { Board, BoardMember } from '../generated/prisma/client.js';
import { BoardRepository } from '../persistence/board.repository.js';
import { OrganizationRepository } from '../persistence/organization.repository.js';
import { PrismaService } from '../persistence/prisma.service.js';
import type { TenantScope } from '../persistence/tenant-context.js';

/**
 * Task & Tracker — boards, and who may do what on them.
 *
 * ## Two gates, not one
 *
 * A **module grant** says whether somebody may use this feature at all; a **board membership**
 * says what they may do on one particular board. Both are checked, in that order, and neither
 * substitutes for the other — a Company Administrator with every grant in the product is still
 * not a member of a private board somebody else made, and an Employee who owns a board still
 * cannot create a second one without `todo:Create`.
 *
 * The grants are the ones the `todo` module already has, because the module list is the client's
 * approved set and a fifteenth module would be vocabulary nobody asked for:
 *
 *   * `todo:View` — every template. Seeing the boards you are on.
 *   * `todo:Comment` — every template. Posting on an item's thread.
 *   * `todo:EditDraft` — Employee and up. Adding and changing items and cells.
 *   * `todo:Create` — Manager, Head, Administrator. Making or archiving a board, a space or a
 *     column. monday.com gates board creation at the account level for the same reason: a company
 *     of four hundred where everybody can make boards has four hundred boards and no map.
 *
 * ## Board kinds decide reach before membership does
 *
 * `Main` is everybody's; `Private` and `Shareable` are their members'. That is a question the
 * member list cannot answer — a board with no members is either the whole company's or nobody's,
 * and which one has to be stated. See `BOARD_KINDS`.
 */
@Injectable()
export class BoardService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly boards: BoardRepository,
    // For the one button that reads outside this feature: a folder per department, which the
    // company already has and should not have to type again.
    private readonly organization: OrganizationRepository,
    private readonly authorization: AuthorizationService,
    private readonly auditEvents: AuditEventService,
  ) {}

  // ---- Spaces -------------------------------------------------------------

  /** Every space in the company. A space is a container; what is inside it is filtered per board. */
  async listSpaces(scope: TenantScope, actorUserId: string) {
    await this.assertCan(scope, actorUserId, 'View');
    return this.boards.listSpaces(scope);
  }

  async createSpace(input: {
    scope: TenantScope;
    actorUserId: string;
    name: string;
    description?: string | undefined;
    tone?: string | undefined;
  }) {
    await this.assertCan(input.scope, input.actorUserId, 'Create');

    const name = input.name.trim();
    if (name === '') throw new BadRequestException('A space needs a name.');

    const position = await this.boards.nextPosition(input.scope, 'space', {});
    const space = await this.boards.createSpace(input.scope, {
      name,
      description: input.description?.trim() || null,
      tone: input.tone ?? 'blue',
      /*
       * Never by request.
       *
       * Exactly one space per company is the default, and `one_default_space_per_company` is a
       * database constraint rather than a rule here. Letting a caller ask for it would mean the
       * second caller gets a unique-violation they did not cause and cannot act on.
       */
      isDefault: false,
      createdByUserId: input.actorUserId,
      position,
    });

    await this.audit(input.scope, {
      action: 'board.space_created',
      resourceType: 'space',
      resourceId: space.id,
      actorUserId: input.actorUserId,
      summary: `Created the space "${space.name}".`,
    });

    return space;
  }

  /**
   * The space a board lands in when nobody chose one, made on first use.
   *
   * Not seeded at provisioning: a company that never opens Task & Tracker should not carry a
   * space it did not ask for, and the first board is the moment one is actually needed.
   */
  private async ensureDefaultSpace(scope: TenantScope, actorUserId: string) {
    const existing = await this.boards.defaultSpace(scope);
    if (existing) return existing;

    const position = await this.boards.nextPosition(scope, 'space', {});
    return this.boards.createSpace(scope, {
      name: 'Main space',
      description: null,
      tone: 'blue',
      isDefault: true,
      createdByUserId: actorUserId,
      position,
    });
  }

  // ---- Folders ------------------------------------------------------------

  /** Every live folder, flat. The screen builds the tree from `parentFolderId`. */
  async listFolders(scope: TenantScope, actorUserId: string, spaceId?: string) {
    await this.assertCan(scope, actorUserId, 'View');
    return this.boards.listFolders(scope, spaceId);
  }

  /**
   * A folder, at the top of a space or inside another.
   *
   * `todo:Create`, like a board and a space: a folder is where other people's work gets put, and
   * a company where anybody can rearrange that has no shape at all.
   */
  async createFolder(input: {
    scope: TenantScope;
    actorUserId: string;
    name: string;
    spaceId?: string | undefined;
    parentFolderId?: string | undefined;
    tone?: string | undefined;
  }) {
    await this.assertCan(input.scope, input.actorUserId, 'Create');

    const name = input.name.trim();
    if (name === '') throw new BadRequestException('A folder needs a name.');

    let spaceId = input.spaceId;
    let depth = 0;

    if (input.parentFolderId !== undefined) {
      const parent = await this.boards.findFolder(input.scope, input.parentFolderId);
      if (!parent || parent.archivedAt !== null) {
        throw new NotFoundException('That folder does not exist in this company.');
      }
      depth = parent.depth + 1;
      if (depth >= MAX_FOLDER_DEPTH) {
        throw new ConflictException(
          `Folders can be nested ${MAX_FOLDER_DEPTH} deep, and this would be one more. Nothing ` +
            'useful lives that far in; put it beside the one above instead.',
        );
      }
      // A sub-folder is in its parent's space whatever the caller said. The composite key would
      // refuse the other arrangement anyway; this is what makes the message sensible.
      spaceId = parent.spaceId;
    }

    const space =
      spaceId === undefined
        ? await this.ensureDefaultSpace(input.scope, input.actorUserId)
        : await this.boards.findSpace(input.scope, spaceId);

    if (!space || space.archivedAt !== null) {
      throw new NotFoundException('That space does not exist in this company, or is archived.');
    }

    const position = await this.boards.nextPosition(input.scope, 'folder', {
      spaceId: space.id,
      parentFolderId: input.parentFolderId ?? null,
    });

    const folder = await this.boards.createFolder(input.scope, {
      spaceId: space.id,
      parentFolderId: input.parentFolderId ?? null,
      depth,
      name,
      tone: input.tone ?? 'grey',
      position,
      createdByUserId: input.actorUserId,
    });

    await this.audit(input.scope, {
      action: 'board.folder_created',
      resourceType: 'board_folder',
      resourceId: folder.id,
      actorUserId: input.actorUserId,
      summary: `Created the folder "${folder.name}".`,
      metadata: { spaceId: space.id, depth },
    });

    return folder;
  }

  /**
   * Move a folder — and refuse the move that breaks the tree.
   *
   * **A folder may never go inside one of its own descendants.** That is not a depth, it is a
   * loop: A inside B inside A. Nothing would complain at the moment of the move; the damage
   * appears later, when anything that walks the tree — the sidebar's own render, a breadcrumb,
   * a permission check — runs until the tab is killed, with no error to read.
   *
   * The descendants are found with one recursive query rather than a loop here, because a loop
   * that is checking for loops is a loop that can hang too.
   */
  async moveFolder(input: {
    scope: TenantScope;
    actorUserId: string;
    folderId: string;
    parentFolderId: string | null;
  }) {
    await this.assertCan(input.scope, input.actorUserId, 'Create');

    const folder = await this.boards.findFolder(input.scope, input.folderId);
    if (!folder || folder.archivedAt !== null) {
      throw new NotFoundException('That folder does not exist in this company.');
    }

    if (input.parentFolderId === null) {
      await this.boards.moveFolder(input.scope, folder.id, null, 0);
      return this.afterMove(input.scope, input.actorUserId, folder.id, folder.name);
    }

    if (input.parentFolderId === folder.id) {
      throw new ConflictException('A folder cannot be put inside itself.');
    }

    const parent = await this.boards.findFolder(input.scope, input.parentFolderId);
    if (!parent || parent.archivedAt !== null) {
      throw new NotFoundException('That folder does not exist in this company.');
    }
    if (parent.spaceId !== folder.spaceId) {
      throw new BadRequestException('That folder is in a different space.');
    }

    const below = await this.boards.descendantFolderIds(input.scope, folder.id);
    if (below.includes(parent.id)) {
      throw new ConflictException(
        `"${parent.name}" is inside "${folder.name}". Putting one inside the other would make a ` +
          'loop that nothing could walk out of.',
      );
    }

    const depth = parent.depth + 1;
    if (depth >= MAX_FOLDER_DEPTH) {
      throw new ConflictException(
        `Folders can be nested ${MAX_FOLDER_DEPTH} deep, and this would be one more.`,
      );
    }

    await this.boards.moveFolder(input.scope, folder.id, parent.id, depth);
    return this.afterMove(input.scope, input.actorUserId, folder.id, folder.name);
  }

  private async afterMove(scope: TenantScope, actorUserId: string, folderId: string, name: string) {
    await this.audit(scope, {
      action: 'board.folder_moved',
      resourceType: 'board_folder',
      resourceId: folderId,
      actorUserId,
      summary: `Moved the folder "${name}".`,
    });
    return this.boards.findFolder(scope, folderId);
  }

  /**
   * One folder per department, in one press — and said before it is done.
   *
   * Offered because a company that has just imported its org chart has seventeen departments and
   * would otherwise type seventeen folder names. Not done automatically, and not silently: this
   * creates rows in somebody's company, and a button that quietly adds seventeen folders is the
   * same surprise the first import of this product handed somebody.
   *
   * `preview` tells the caller exactly what would happen. Applying twice is safe — a name that
   * already has a folder is reported as skipped rather than duplicated — because the second
   * press is almost always somebody who did not see the first one work.
   */
  async foldersFromDepartments(input: {
    scope: TenantScope;
    actorUserId: string;
    spaceId?: string | undefined;
    preview: boolean;
  }) {
    await this.assertCan(input.scope, input.actorUserId, 'Create');

    const space =
      input.spaceId === undefined
        ? await this.ensureDefaultSpace(input.scope, input.actorUserId)
        : await this.boards.findSpace(input.scope, input.spaceId);

    if (!space || space.archivedAt !== null) {
      throw new NotFoundException('That space does not exist in this company, or is archived.');
    }

    const [departments, folders] = await Promise.all([
      this.organization.listDepartments(input.scope, false),
      this.boards.listFolders(input.scope, space.id),
    ]);

    const taken = new Set(
      folders
        .filter((folder) => folder.parentFolderId === null)
        .map((folder) => folder.name.toLowerCase()),
    );

    const toCreate = departments.filter((department) => !taken.has(department.name.toLowerCase()));
    const skipped = departments.length - toCreate.length;

    if (input.preview) {
      return {
        spaceId: space.id,
        willCreate: toCreate.map((department) => department.name),
        skipped,
        created: 0,
      };
    }

    let position = await this.boards.nextPosition(input.scope, 'folder', {
      spaceId: space.id,
      parentFolderId: null,
    });

    for (const department of toCreate) {
      await this.boards.createFolder(input.scope, {
        spaceId: space.id,
        parentFolderId: null,
        depth: 0,
        name: department.name,
        tone: 'grey',
        position,
        createdByUserId: input.actorUserId,
      });
      position += 1000;
    }

    await this.audit(input.scope, {
      action: 'board.folders_from_departments',
      resourceType: 'space',
      resourceId: space.id,
      actorUserId: input.actorUserId,
      summary:
        `Created ${toCreate.length} folder(s) from this company's departments` +
        (skipped === 0 ? '.' : `, and left ${skipped} that already had one.`),
      metadata: { created: toCreate.length, skipped },
    });

    return {
      spaceId: space.id,
      willCreate: toCreate.map((department) => department.name),
      skipped,
      created: toCreate.length,
    };
  }

  // ---- Boards -------------------------------------------------------------

  /**
   * The boards this person may open.
   *
   * A `Main` board is the company's. A `Private` or `Shareable` one is its members'. Filtered
   * here rather than in the query because the kind decides the rule and the membership decides
   * the outcome, and expressing that as SQL hides it from the one file that should state it.
   */
  async listBoards(scope: TenantScope, actorUserId: string, spaceId?: string) {
    await this.assertCan(scope, actorUserId, 'View');

    const rows = await this.boards.listBoards(scope, actorUserId, spaceId);
    return rows
      .filter((board) => board.kind === 'Main' || board.members.length > 0)
      .map((board) => ({
        id: board.id,
        spaceId: board.spaceId,
        folderId: board.folderId,
        name: board.name,
        description: board.description,
        kind: board.kind,
        itemCount: board._count.items,
        myRole: board.members[0]?.role ?? null,
        createdAt: board.createdAt,
      }));
  }

  /**
   * A new board, with the three groups and three columns every work board converges on.
   *
   * An empty board is a dead end: somebody has to invent groups, columns and a first row before
   * anything on screen does anything. All of it can be renamed or removed, which is the
   * difference between a starting point and a decision made for somebody.
   */
  async createBoard(input: {
    scope: TenantScope;
    actorUserId: string;
    name: string;
    description?: string | undefined;
    kind?: string | undefined;
    spaceId?: string | undefined;
    folderId?: string | undefined;
  }) {
    await this.assertCan(input.scope, input.actorUserId, 'Create');

    const name = input.name.trim();
    if (name === '') throw new BadRequestException('A board needs a name.');

    const kind = input.kind ?? 'Main';
    if (!isBoardKind(kind)) {
      throw new BadRequestException(`"${kind}" is not a kind of board.`);
    }

    /*
     * A folder decides the space, the same way a parent folder does.
     *
     * Saying "in the Production folder, in the Marketing space" is not a thing somebody means;
     * it is a thing a form lets them type. The folder wins and the space follows it.
     */
    const folder =
      input.folderId === undefined
        ? null
        : await this.boards.findFolder(input.scope, input.folderId);

    if (input.folderId !== undefined && (!folder || folder.archivedAt !== null)) {
      throw new NotFoundException('That folder does not exist in this company.');
    }

    const spaceId = folder?.spaceId ?? input.spaceId;

    const space =
      spaceId === undefined
        ? await this.ensureDefaultSpace(input.scope, input.actorUserId)
        : await this.boards.findSpace(input.scope, spaceId);

    if (!space || space.archivedAt !== null) {
      throw new NotFoundException('That space does not exist in this company, or is archived.');
    }

    const position = await this.boards.nextPosition(input.scope, 'board', { spaceId: space.id });
    const board = await this.boards.createBoard(input.scope, {
      spaceId: space.id,
      folderId: folder?.id ?? null,
      name,
      description: input.description?.trim() || null,
      kind,
      createdByUserId: input.actorUserId,
      position,
    });

    /*
     * The maker owns it.
     *
     * On a private board this is the only thing standing between the person who made it and a
     * board they cannot open — and on a main board it is still what makes them able to change
     * its columns.
     */
    await this.boards.upsertMember(input.scope, {
      boardId: board.id,
      userId: input.actorUserId,
      role: 'Owner',
      addedByUserId: input.actorUserId,
    });

    for (const [index, group] of DEFAULT_BOARD_GROUPS.entries()) {
      await this.boards.createGroup(input.scope, {
        boardId: board.id,
        title: group.title,
        tone: group.tone,
        position: (index + 1) * 1000,
      });
    }

    const starters: { title: string; kind: BoardColumnKind; settings: object }[] = [
      {
        title: 'Status',
        kind: 'Status',
        settings: {
          labels: DEFAULT_STATUS_LABELS.map((label, index) => ({
            id: String(index + 1),
            label: label.label,
            tone: label.tone,
          })),
        },
      },
      { title: 'Owner', kind: 'People', settings: {} },
      { title: 'Due date', kind: 'Date', settings: {} },
    ];

    for (const [index, column] of starters.entries()) {
      await this.boards.createColumn(input.scope, {
        boardId: board.id,
        title: column.title,
        kind: column.kind,
        settings: column.settings,
        position: (index + 1) * 1000,
        width: 160,
      });
    }

    await this.audit(input.scope, {
      action: 'board.created',
      resourceType: 'board',
      resourceId: board.id,
      actorUserId: input.actorUserId,
      summary: `Created the board "${board.name}".`,
      metadata: { kind: board.kind, spaceId: space.id },
    });

    return board;
  }

  /** A board and everything on it: groups, columns, items and the cells people filled. */
  async openBoard(scope: TenantScope, actorUserId: string, boardId: string) {
    await this.assertCan(scope, actorUserId, 'View');
    const { board, membership } = await this.reachable(scope, actorUserId, boardId);

    const [groups, columns, items, cells, members] = await Promise.all([
      this.boards.listGroups(scope, boardId),
      this.boards.listColumns(scope, boardId),
      this.boards.listItems(scope, boardId),
      this.boards.listCells(scope, boardId),
      this.boards.listMembers(scope, boardId),
    ]);

    /*
     * The members' names, so a People cell can offer somebody rather than a UUID.
     *
     * The board's own members, not the company roster — which a standard Employee has no grant
     * to read at all, and which on a factory floor is four hundred names nobody wants in a
     * dropdown. monday.com assigns from the board's subscribers for the same reason: the people
     * on a board are the people its work belongs to.
     */
    const named = await this.boards.namesFor(
      scope,
      members.map((member) => member.userId),
    );

    return {
      board: {
        id: board.id,
        spaceId: board.spaceId,
        name: board.name,
        description: board.description,
        kind: board.kind,
        myRole: membership?.role ?? null,
        /*
         * Stated rather than left for the screen to work out from a role.
         *
         * "May I type here" is one question with two inputs — the module grant and the board
         * role — and a screen that recomputes it will eventually disagree with the route that
         * enforces it. The server answers once.
         */
        mayEdit: await this.mayEdit(scope, actorUserId, board, membership),
      },
      groups,
      columns,
      items,
      cells,
      members: members.map((member) => ({
        ...member,
        name: named.get(member.userId) ?? 'Somebody who has left',
      })),
    };
  }

  async archiveBoard(scope: TenantScope, actorUserId: string, boardId: string) {
    await this.assertCan(scope, actorUserId, 'Create');
    const { board, membership } = await this.reachable(scope, actorUserId, boardId);

    if (membership?.role !== 'Owner') {
      throw new ForbiddenException(
        'Only an owner of this board can archive it. Ask one of them, or have them make you an owner.',
      );
    }

    await this.boards.archiveBoard(scope, boardId);
    await this.audit(scope, {
      action: 'board.archived',
      resourceType: 'board',
      resourceId: boardId,
      actorUserId,
      // Archived, never deleted: a board is a record of what people did, and tidying a sidebar
      // is not a reason to lose it.
      summary: `Archived the board "${board.name}". Nothing was deleted.`,
    });
  }

  /**
   * Put a board in a folder, or take it back out to the top of its space.
   *
   * Owner, not merely `todo:Create` — moving somebody's board out of the folder their team looks
   * in is the same disruption as renaming it, and the people who can do that are the people who
   * own it.
   *
   * A folder in another space is refused rather than quietly dragging the board across: a board
   * that changed space without anybody asking is how a company loses one for a week.
   */
  async moveBoard(input: {
    scope: TenantScope;
    actorUserId: string;
    boardId: string;
    folderId: string | null;
  }) {
    await this.assertCan(input.scope, input.actorUserId, 'Create');
    const { board, membership } = await this.reachable(
      input.scope,
      input.actorUserId,
      input.boardId,
    );

    if (membership?.role !== 'Owner') {
      throw new ForbiddenException(
        'Only an owner of this board can move it. Ask one of them, or have them make you an owner.',
      );
    }

    let destination = 'the top of its space';

    if (input.folderId !== null) {
      const folder = await this.boards.findFolder(input.scope, input.folderId);
      if (!folder || folder.archivedAt !== null) {
        throw new NotFoundException('That folder does not exist in this company.');
      }
      if (folder.spaceId !== board.spaceId) {
        throw new BadRequestException('That folder is in a different space.');
      }
      destination = `"${folder.name}"`;
    }

    await this.boards.setBoardFolder(input.scope, board.id, input.folderId);
    await this.audit(input.scope, {
      action: 'board.moved',
      resourceType: 'board',
      resourceId: board.id,
      actorUserId: input.actorUserId,
      summary: `Moved the board "${board.name}" to ${destination}.`,
    });

    return { boardId: board.id, folderId: input.folderId };
  }

  // ---- Membership ---------------------------------------------------------

  async addMember(input: {
    scope: TenantScope;
    actorUserId: string;
    boardId: string;
    userId: string;
    role: string;
  }) {
    await this.assertCan(input.scope, input.actorUserId, 'Create');
    const { membership } = await this.reachable(input.scope, input.actorUserId, input.boardId);

    if (membership?.role !== 'Owner') {
      throw new ForbiddenException('Only an owner of this board can change who is on it.');
    }
    if (!isBoardMemberRole(input.role)) {
      throw new BadRequestException(`"${input.role}" is not a role on a board.`);
    }

    const member = await this.boards.upsertMember(input.scope, {
      boardId: input.boardId,
      userId: input.userId,
      role: input.role,
      addedByUserId: input.actorUserId,
    });

    await this.audit(input.scope, {
      action: 'board.member_set',
      resourceType: 'board',
      resourceId: input.boardId,
      actorUserId: input.actorUserId,
      summary: `Set a board role to ${input.role}.`,
      metadata: { subjectUserId: input.userId, role: input.role },
    });

    return member;
  }

  async removeMember(input: {
    scope: TenantScope;
    actorUserId: string;
    boardId: string;
    userId: string;
  }) {
    await this.assertCan(input.scope, input.actorUserId, 'Create');
    const { membership } = await this.reachable(input.scope, input.actorUserId, input.boardId);

    if (membership?.role !== 'Owner') {
      throw new ForbiddenException('Only an owner of this board can change who is on it.');
    }

    /*
     * A board cannot be left without an owner.
     *
     * Not a tidiness rule: membership is what makes a private board reachable, and the last
     * owner removing themselves leaves a board nobody can open, administer or archive — a row
     * only a database client can reach.
     */
    const members = await this.boards.listMembers(input.scope, input.boardId);
    const owners = members.filter((member) => member.role === 'Owner');
    if (owners.length === 1 && owners[0]?.userId === input.userId) {
      throw new ConflictException(
        'That is the last owner of this board. Make somebody else an owner first.',
      );
    }

    await this.boards.removeMember(input.scope, input.boardId, input.userId);
    await this.audit(input.scope, {
      action: 'board.member_removed',
      resourceType: 'board',
      resourceId: input.boardId,
      actorUserId: input.actorUserId,
      summary: 'Removed somebody from a board.',
      metadata: { subjectUserId: input.userId },
    });
  }

  // ---- Columns and groups -------------------------------------------------

  /**
   * Add a column — which is to say, change what the board is for.
   *
   * `todo:Create`, not `EditDraft`. Putting a row on a board is doing the work; deciding that
   * every row now has a Priority is changing the shape of everybody's board, and that is the
   * same kind of decision as making the board in the first place.
   *
   * A Status column with no labels is a column nobody can fill, so one that arrives without them
   * gets the default four. Everything else starts empty and is the kind's business.
   */
  async addColumn(input: {
    scope: TenantScope;
    actorUserId: string;
    boardId: string;
    title: string;
    kind: string;
    settings?: Record<string, unknown> | undefined;
  }) {
    await this.assertCan(input.scope, input.actorUserId, 'Create');
    const { board, membership } = await this.reachable(
      input.scope,
      input.actorUserId,
      input.boardId,
    );
    await this.assertMayEdit(input.scope, input.actorUserId, board, membership);

    const title = input.title.trim();
    if (title === '') throw new BadRequestException('A column needs a name.');
    BoardService.assertColumnKind(input.kind);

    const settings =
      input.kind === 'Status' && input.settings?.['labels'] === undefined
        ? {
            labels: DEFAULT_STATUS_LABELS.map((label, index) => ({
              id: String(index + 1),
              label: label.label,
              tone: label.tone,
            })),
          }
        : (input.settings ?? {});

    const position = await this.boards.nextPosition(input.scope, 'column', {
      boardId: input.boardId,
    });

    const column = await this.boards.createColumn(input.scope, {
      boardId: input.boardId,
      title,
      kind: input.kind,
      settings,
      position,
      width: 160,
    });

    await this.audit(input.scope, {
      action: 'board.column_added',
      resourceType: 'board',
      resourceId: input.boardId,
      actorUserId: input.actorUserId,
      summary: `Added a ${input.kind} column "${title}" to "${board.name}".`,
      metadata: { columnId: column.id, kind: input.kind },
    });

    return column;
  }

  /** Add a section down the board. Same permission and same reasoning as a column. */
  async addGroup(input: {
    scope: TenantScope;
    actorUserId: string;
    boardId: string;
    title: string;
    tone?: string | undefined;
  }) {
    await this.assertCan(input.scope, input.actorUserId, 'Create');
    const { board, membership } = await this.reachable(
      input.scope,
      input.actorUserId,
      input.boardId,
    );
    await this.assertMayEdit(input.scope, input.actorUserId, board, membership);

    const title = input.title.trim();
    if (title === '') throw new BadRequestException('A group needs a name.');

    const position = await this.boards.nextPosition(input.scope, 'group', {
      boardId: input.boardId,
    });

    const group = await this.boards.createGroup(input.scope, {
      boardId: input.boardId,
      title,
      tone: input.tone ?? 'grey',
      position,
    });

    await this.audit(input.scope, {
      action: 'board.group_added',
      resourceType: 'board',
      resourceId: input.boardId,
      actorUserId: input.actorUserId,
      summary: `Added the group "${title}" to "${board.name}".`,
      metadata: { groupId: group.id },
    });

    return group;
  }

  // ---- Items, cells and the thread ----------------------------------------

  /**
   * A new row, or a subitem of one.
   *
   * The group is required even for a subitem: a subitem is still on a board, and a row with no
   * group is a row no view can place. It inherits its parent's group unless told otherwise.
   */
  async createItem(input: {
    scope: TenantScope;
    actorUserId: string;
    boardId: string;
    groupId?: string | undefined;
    parentItemId?: string | undefined;
    name: string;
  }) {
    await this.assertCan(input.scope, input.actorUserId, 'EditDraft');
    const { board, membership } = await this.reachable(
      input.scope,
      input.actorUserId,
      input.boardId,
    );
    await this.assertMayEdit(input.scope, input.actorUserId, board, membership);

    const name = input.name.trim();
    if (name === '') throw new BadRequestException('An item needs a name.');

    let depth = 0;
    let groupId = input.groupId;

    if (input.parentItemId !== undefined) {
      const parent = await this.boards.findItem(input.scope, input.parentItemId);
      if (!parent || parent.boardId !== input.boardId || parent.archivedAt !== null) {
        throw new NotFoundException('That parent item is not on this board.');
      }
      depth = BoardService.depthOf(parent.depth);
      groupId = groupId ?? parent.groupId;
    }

    if (groupId === undefined) {
      // The first group on the board, which is where monday.com drops a row somebody added
      // without saying where. A board always has at least one; a new one ships with three.
      const groups = await this.boards.listGroups(input.scope, input.boardId);
      const first = groups[0];
      if (!first) throw new ConflictException('This board has no groups to put an item in.');
      groupId = first.id;
    } else {
      const group = await this.boards.findGroup(input.scope, groupId);
      if (!group || group.boardId !== input.boardId || group.archivedAt !== null) {
        throw new NotFoundException('That group is not on this board.');
      }
    }

    const position = await this.boards.nextPosition(input.scope, 'item', {
      boardId: input.boardId,
      groupId,
    });

    const item = await this.boards.createItem(input.scope, {
      boardId: input.boardId,
      groupId,
      parentItemId: input.parentItemId ?? null,
      depth,
      name,
      position,
      createdByUserId: input.actorUserId,
    });

    await this.audit(input.scope, {
      action: depth === 0 ? 'board.item_created' : 'board.subitem_created',
      resourceType: 'board_item',
      resourceId: item.id,
      actorUserId: input.actorUserId,
      summary: `Added "${item.name}" to the board "${board.name}".`,
      metadata: { boardId: board.id, depth },
    });

    return item;
  }

  async renameItem(input: {
    scope: TenantScope;
    actorUserId: string;
    itemId: string;
    name: string;
  }) {
    await this.assertCan(input.scope, input.actorUserId, 'EditDraft');

    const item = await this.boards.findItem(input.scope, input.itemId);
    if (!item || item.archivedAt !== null) throw new NotFoundException('No such item.');

    const { board, membership } = await this.reachable(
      input.scope,
      input.actorUserId,
      item.boardId,
    );
    await this.assertMayEdit(input.scope, input.actorUserId, board, membership);

    const name = input.name.trim();
    if (name === '') throw new BadRequestException('An item needs a name.');

    return this.boards.renameItem(input.scope, input.itemId, name);
  }

  async archiveItem(input: { scope: TenantScope; actorUserId: string; itemId: string }) {
    await this.assertCan(input.scope, input.actorUserId, 'EditDraft');

    const item = await this.boards.findItem(input.scope, input.itemId);
    if (!item || item.archivedAt !== null) throw new NotFoundException('No such item.');

    const { board, membership } = await this.reachable(
      input.scope,
      input.actorUserId,
      item.boardId,
    );
    await this.assertMayEdit(input.scope, input.actorUserId, board, membership);

    await this.boards.archiveItem(input.scope, input.itemId);
    await this.audit(input.scope, {
      action: 'board.item_archived',
      resourceType: 'board_item',
      resourceId: item.id,
      actorUserId: input.actorUserId,
      // Archived, like everything else here. Its thread and its cells go with it and come back
      // with it; deleting them to tidy a board is not a trade anybody should be offered.
      summary: `Archived "${item.name}". Nothing was deleted.`,
      metadata: { boardId: board.id },
    });
  }

  /**
   * Write one cell.
   *
   * The value's shape belongs to the column's kind, which is why the kind is checked here and
   * the value is not: a Status cell holds a label id, a People cell a list of user ids, a Date a
   * date. Validating each shape is the column kinds' own work and arrives with their editors —
   * until then this refuses a kind it cannot render rather than storing a shape nothing reads.
   */
  async setCell(input: {
    scope: TenantScope;
    actorUserId: string;
    itemId: string;
    columnId: string;
    value: unknown;
  }) {
    await this.assertCan(input.scope, input.actorUserId, 'EditDraft');

    const item = await this.boards.findItem(input.scope, input.itemId);
    if (!item || item.archivedAt !== null) throw new NotFoundException('No such item.');

    const column = await this.boards.findColumn(input.scope, input.columnId);
    if (!column || column.archivedAt !== null) throw new NotFoundException('No such column.');
    if (column.boardId !== item.boardId) {
      throw new BadRequestException('That column is on a different board from that item.');
    }
    BoardService.assertColumnKind(column.kind);

    const { board, membership } = await this.reachable(
      input.scope,
      input.actorUserId,
      item.boardId,
    );
    await this.assertMayEdit(input.scope, input.actorUserId, board, membership);

    return this.boards.setCell(input.scope, {
      itemId: input.itemId,
      columnId: input.columnId,
      value: input.value,
      updatedByUserId: input.actorUserId,
    });
  }

  /** The thread on an item: what was asked, what was decided. */
  async listUpdates(scope: TenantScope, actorUserId: string, itemId: string) {
    await this.assertCan(scope, actorUserId, 'View');

    const item = await this.boards.findItem(scope, itemId);
    if (!item) throw new NotFoundException('No such item.');
    await this.reachable(scope, actorUserId, item.boardId);

    return this.boards.listUpdates(scope, itemId);
  }

  /**
   * Post on the thread.
   *
   * `todo:Comment`, not `EditDraft`. Saying something about a row is not changing it, and the
   * one template that may read a board without working on it — Approver — is exactly the one
   * whose comment is worth having.
   */
  async postUpdate(input: {
    scope: TenantScope;
    actorUserId: string;
    itemId: string;
    body: string;
    parentUpdateId?: string | undefined;
  }) {
    await this.assertCan(input.scope, input.actorUserId, 'Comment');

    const item = await this.boards.findItem(input.scope, input.itemId);
    if (!item || item.archivedAt !== null) throw new NotFoundException('No such item.');

    const { membership } = await this.reachable(input.scope, input.actorUserId, item.boardId);
    if (membership?.role === 'Viewer') {
      throw new ForbiddenException('A viewer of this board can read it but not write on it.');
    }

    const body = input.body.trim();
    if (body === '') throw new BadRequestException('An update needs something in it.');

    if (input.parentUpdateId !== undefined) {
      const parent = await this.boards.findUpdate(input.scope, input.parentUpdateId);
      if (!parent || parent.itemId !== input.itemId) {
        throw new NotFoundException('That update is not on this item.');
      }
      /*
       * One level, and only one.
       *
       * A reply to a reply is a forum, and nobody reads those. The parent of a reply is the post
       * it answers, so a reply to a reply answers the same post.
       */
      if (parent.parentUpdateId !== null) {
        throw new BadRequestException(
          'Replies go on the post, not on another reply. Reply to the first one.',
        );
      }
    }

    return this.boards.createUpdate(input.scope, {
      itemId: input.itemId,
      parentUpdateId: input.parentUpdateId ?? null,
      body,
      authorUserId: input.actorUserId,
    });
  }

  // ---- Shared checks ------------------------------------------------------

  /** The module gate. Everything in this service passes through one of these first. */
  private async assertCan(
    scope: TenantScope,
    actorUserId: string,
    action: 'View' | 'Comment' | 'EditDraft' | 'Create',
  ): Promise<void> {
    const context = await this.authorization.contextFor(scope, actorUserId);
    await this.authorization.assertCan(context, { module: 'todo', action });
  }

  /**
   * Can this person reach this board at all, and as what.
   *
   * 404 rather than 403 for a private board they are not on — a 403 confirms the board exists,
   * which is the one thing a private board is for.
   */
  private async reachable(
    scope: TenantScope,
    actorUserId: string,
    boardId: string,
  ): Promise<{ board: Board; membership: BoardMember | null }> {
    const board = await this.boards.findBoard(scope, boardId);
    if (!board || board.archivedAt !== null) {
      throw new NotFoundException('No such board in this company.');
    }

    const membership = await this.boards.membership(scope, boardId, actorUserId);
    if (board.kind !== 'Main' && membership === null) {
      throw new NotFoundException('No such board in this company.');
    }

    return { board, membership };
  }

  /**
   * May they change what is on this board?
   *
   * A `Viewer` never may, whatever module grants they hold — that is the whole point of the
   * role. Everybody else needs `todo:EditDraft`, and on a `Main` board that is enough: a board
   * the whole company can open is a board the whole company can work on, which is what "main"
   * means on monday.com and what people expect.
   */
  private async mayEdit(
    scope: TenantScope,
    actorUserId: string,
    board: Board,
    membership: BoardMember | null,
  ): Promise<boolean> {
    if (membership?.role === 'Viewer') return false;
    if (board.kind !== 'Main' && membership === null) return false;

    const context = await this.authorization.contextFor(scope, actorUserId);
    const decision = await this.authorization.authorize(context, {
      module: 'todo',
      action: 'EditDraft',
    });
    return decision.allowed;
  }

  /** The same question as `mayEdit`, in the form a write needs: refuse, with a reason. */
  private async assertMayEdit(
    scope: TenantScope,
    actorUserId: string,
    board: Board,
    membership: BoardMember | null,
  ): Promise<void> {
    if (await this.mayEdit(scope, actorUserId, board, membership)) return;

    throw new ForbiddenException(
      membership?.role === 'Viewer'
        ? 'A viewer of this board can read it but not change it.'
        : 'You can open this board but not change it. An owner of it can give you a member role.',
    );
  }

  /** Every write in this service says what it did, in the company's own trail. */
  private async audit(
    scope: TenantScope,
    event: {
      action: string;
      resourceType: string;
      resourceId: string;
      actorUserId: string;
      summary: string;
      metadata?: Record<string, string | number | boolean | null>;
    },
  ): Promise<void> {
    await this.prisma.runInTenantTransaction(scope, async () => {
      await this.auditEvents.appendWithinCurrentScope(scope.tenantId, event);
    });
  }

  /** The nesting ceiling, so a caller can be told before it tries. */
  static depthOf(parentDepth: number): number {
    const depth = parentDepth + 1;
    if (depth >= MAX_BOARD_ITEM_DEPTH) {
      throw new ConflictException(
        `A board item can be nested ${MAX_BOARD_ITEM_DEPTH} levels deep, and this would be one more.`,
      );
    }
    return depth;
  }

  /** Whether a column kind is one this release can render. Used by the item writes. */
  static assertColumnKind(kind: string): asserts kind is BoardColumnKind {
    if (!isBoardColumnKind(kind)) {
      throw new BadRequestException(`"${kind}" is not a kind of column this release can render.`);
    }
  }

  /** Whether a board role is one that exists. */
  static assertMemberRole(role: string): asserts role is BoardMemberRole {
    if (!isBoardMemberRole(role)) {
      throw new BadRequestException(`"${role}" is not a role on a board.`);
    }
  }
}
