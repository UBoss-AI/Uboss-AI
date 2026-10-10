import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Query,
  UnauthorizedException,
} from '@nestjs/common';
import {
  Allow,
  IsBoolean,
  IsIn,
  IsOptional,
  IsString,
  IsUUID,
  MaxLength,
  MinLength,
} from 'class-validator';

import { BOARD_COLUMN_KINDS, BOARD_KINDS, BOARD_MEMBER_ROLES } from '@uboss/types';

import { RequirePermission } from '../authorization/authorization.decorators.js';
import { actorUserId } from '../request-context/authenticated-actor.js';
import { getActor } from '../request-context/request-context.js';
import { TenantScoped } from '../tenancy/tenancy.decorators.js';
import { TenantContextService } from '../tenancy/tenant-context.service.js';
import { BoardService } from './board.service.js';

class CreateSpaceDto {
  @IsString()
  @MinLength(1)
  @MaxLength(200)
  name!: string;

  @IsOptional()
  @IsString()
  @MaxLength(2000)
  description?: string;

  @IsOptional()
  @IsString()
  @MaxLength(20)
  tone?: string;
}

class CreateBoardDto {
  @IsString()
  @MinLength(1)
  @MaxLength(200)
  name!: string;

  @IsOptional()
  @IsString()
  @MaxLength(2000)
  description?: string;

  @IsOptional()
  @IsIn([...BOARD_KINDS])
  kind?: string;

  @IsOptional()
  @IsUUID()
  spaceId?: string;

  /** A folder decides the space, so sending both and disagreeing is the folder's call. */
  @IsOptional()
  @IsUUID()
  folderId?: string;
}

class MoveBoardDto {
  /** Null, or absent, takes it to the top of its space. */
  @IsOptional()
  @IsUUID()
  folderId?: string | null;
}

class SetMemberDto {
  @IsUUID()
  userId!: string;

  @IsIn([...BOARD_MEMBER_ROLES])
  role!: string;
}

class CreateFolderDto {
  @IsString()
  @MinLength(1)
  @MaxLength(200)
  name!: string;

  @IsOptional()
  @IsUUID()
  spaceId?: string;

  /** Absent for a folder at the top of a space; set for one inside another. */
  @IsOptional()
  @IsUUID()
  parentFolderId?: string;

  @IsOptional()
  @IsString()
  @MaxLength(20)
  tone?: string;
}

class MoveFolderDto {
  /** Null, or absent, takes it to the top of its space. */
  @IsOptional()
  @IsUUID()
  parentFolderId?: string | null;
}

class FromDepartmentsDto {
  @IsOptional()
  @IsUUID()
  spaceId?: string;

  /** Defaults to a preview. Creating has to be asked for. */
  @IsOptional()
  @IsBoolean()
  preview?: boolean;
}

class AddColumnDto {
  @IsString()
  @MinLength(1)
  @MaxLength(200)
  title!: string;

  @IsIn([...BOARD_COLUMN_KINDS])
  kind!: string;

  /*
   * The kind's own settings — a status column's labels, a dropdown's options. Shapeless here for
   * the same reason a cell's value is: the kind owns the shape, and a DTO describing all eight
   * would be a union nobody could read and an edit for every new kind.
   */
  @IsOptional()
  @Allow()
  settings?: Record<string, unknown>;
}

class AddGroupDto {
  @IsString()
  @MinLength(1)
  @MaxLength(200)
  title!: string;

  @IsOptional()
  @IsString()
  @MaxLength(20)
  tone?: string;
}

class CreateItemDto {
  @IsString()
  @MinLength(1)
  @MaxLength(500)
  name!: string;

  @IsOptional()
  @IsUUID()
  groupId?: string;

  @IsOptional()
  @IsUUID()
  parentItemId?: string;
}

class RenameItemDto {
  @IsString()
  @MinLength(1)
  @MaxLength(500)
  name!: string;
}

class SetCellDto {
  @IsUUID()
  columnId!: string;

  /*
   * Deliberately unvalidated here, and validated by the column's kind in the service.
   *
   * A cell's shape belongs to its column — a Status cell holds a label id, a People cell a list
   * of user ids, a Timeline a from/to pair. A DTO that tried to describe all of them would be a
   * union nobody could read, and would have to be edited for every new kind. The route takes the
   * value; the kind decides whether it is one.
   *
   * `@Allow()` and not "no decorator at all": the global pipe runs `forbidNonWhitelisted`, which
   * rejects any property no validator knows about — so leaving it bare made every write of a
   * cell a 400 with a message about an unexpected field. This is the decorator that says "take
   * this, and do not check it".
   */
  @Allow()
  value?: unknown;
}

class PostUpdateDto {
  @IsString()
  @MinLength(1)
  @MaxLength(20000)
  body!: string;

  @IsOptional()
  @IsUUID()
  parentUpdateId?: string;
}

/**
 * Task & Tracker.
 *
 * Every route is `todo`, because the module list is the client's approved set and this feature
 * is work people are given — the same thing the To-do List is, arranged by the people doing it
 * rather than by the objective that produced it. `BoardService` states which action each one
 * needs and why.
 *
 * The route permission is the floor and never the whole answer: reaching a board also depends on
 * its kind and on whether the asker is on it. That second gate is the service's, because it is a
 * rule about a row rather than about a person.
 */
@Controller('tenants/:tenantId/boards')
@TenantScoped()
export class BoardController {
  constructor(
    private readonly boards: BoardService,
    private readonly tenantContext: TenantContextService,
  ) {}

  // ---- Spaces -------------------------------------------------------------

  @Get('spaces')
  @RequirePermission({ module: 'todo', action: 'View' })
  async listSpaces(): Promise<unknown> {
    const spaces = await this.boards.listSpaces(
      this.tenantContext.requireScope(),
      this.currentUserId(),
    );
    return { spaces };
  }

  @Post('spaces')
  @RequirePermission({ module: 'todo', action: 'Create' })
  async createSpace(@Body() body: CreateSpaceDto): Promise<unknown> {
    return this.boards.createSpace({
      scope: this.tenantContext.requireScope(),
      actorUserId: this.currentUserId(),
      name: body.name,
      description: body.description,
      tone: body.tone,
    });
  }

  // ---- Folders ------------------------------------------------------------

  /**
   * Every folder, flat. The screen builds the tree from `parentFolderId`.
   *
   * Declared above `:boardId`, like every other fixed segment here, or that route matches
   * "folders" first and the screen asks to open a board called folders.
   */
  @Get('folders')
  @RequirePermission({ module: 'todo', action: 'View' })
  async listFolders(@Query('spaceId') spaceId?: string): Promise<unknown> {
    const folders = await this.boards.listFolders(
      this.tenantContext.requireScope(),
      this.currentUserId(),
      spaceId,
    );
    return { folders };
  }

  @Post('folders')
  @RequirePermission({ module: 'todo', action: 'Create' })
  async createFolder(@Body() body: CreateFolderDto): Promise<unknown> {
    return this.boards.createFolder({
      scope: this.tenantContext.requireScope(),
      actorUserId: this.currentUserId(),
      name: body.name,
      spaceId: body.spaceId,
      parentFolderId: body.parentFolderId,
      tone: body.tone,
    });
  }

  /**
   * Move a folder, or take it to the top of its space by sending no parent.
   *
   * 409 when the destination is inside the folder being moved: that is a loop rather than a
   * depth, and nothing that walks the tree afterwards would ever stop.
   */
  @Patch('folders/:folderId')
  @RequirePermission({ module: 'todo', action: 'Create' })
  async moveFolder(
    @Param('folderId', new ParseUUIDPipe()) folderId: string,
    @Body() body: MoveFolderDto,
  ): Promise<unknown> {
    return this.boards.moveFolder({
      scope: this.tenantContext.requireScope(),
      actorUserId: this.currentUserId(),
      folderId,
      parentFolderId: body.parentFolderId ?? null,
    });
  }

  /**
   * One folder per department.
   *
   * `preview` first, always: this creates rows in somebody's company, and a button that quietly
   * adds seventeen folders is a surprise found a week later. Applying twice is safe — a name
   * that already has a folder is skipped rather than duplicated.
   */
  @Post('folders/from-departments')
  @RequirePermission({ module: 'todo', action: 'Create' })
  async foldersFromDepartments(@Body() body: FromDepartmentsDto): Promise<unknown> {
    return this.boards.foldersFromDepartments({
      scope: this.tenantContext.requireScope(),
      actorUserId: this.currentUserId(),
      spaceId: body.spaceId,
      preview: body.preview ?? true,
    });
  }

  // ---- Boards -------------------------------------------------------------

  /**
   * The boards this person may open.
   *
   * Declared above `:boardId`, like every other fixed segment on this controller, or that route
   * matches "spaces" first and the screen asks to open a board called spaces.
   */
  @Get()
  @RequirePermission({ module: 'todo', action: 'View' })
  async listBoards(@Query('spaceId') spaceId?: string): Promise<unknown> {
    const boards = await this.boards.listBoards(
      this.tenantContext.requireScope(),
      this.currentUserId(),
      spaceId,
    );
    return { boards, total: boards.length };
  }

  @Post()
  @RequirePermission({ module: 'todo', action: 'Create' })
  async createBoard(@Body() body: CreateBoardDto): Promise<unknown> {
    return this.boards.createBoard({
      scope: this.tenantContext.requireScope(),
      actorUserId: this.currentUserId(),
      name: body.name,
      description: body.description,
      kind: body.kind,
      spaceId: body.spaceId,
      folderId: body.folderId,
    });
  }

  /** A board and everything on it, in one request: groups, columns, items, cells and members. */
  @Get(':boardId')
  @RequirePermission({ module: 'todo', action: 'View' })
  async openBoard(@Param('boardId', new ParseUUIDPipe()) boardId: string): Promise<unknown> {
    return this.boards.openBoard(this.tenantContext.requireScope(), this.currentUserId(), boardId);
  }

  /**
   * Move a board between folders, or out to the top of its space.
   *
   * One segment, so it cannot collide with the two-segment PATCH routes below it whatever order
   * Nest reads them in.
   */
  @Patch(':boardId')
  @RequirePermission({ module: 'todo', action: 'Create' })
  async moveBoard(
    @Param('boardId', new ParseUUIDPipe()) boardId: string,
    @Body() body: MoveBoardDto,
  ): Promise<unknown> {
    return this.boards.moveBoard({
      scope: this.tenantContext.requireScope(),
      actorUserId: this.currentUserId(),
      boardId,
      folderId: body.folderId ?? null,
    });
  }

  @Delete(':boardId')
  @RequirePermission({ module: 'todo', action: 'Create' })
  async archiveBoard(@Param('boardId', new ParseUUIDPipe()) boardId: string): Promise<unknown> {
    await this.boards.archiveBoard(
      this.tenantContext.requireScope(),
      this.currentUserId(),
      boardId,
    );
    return { boardId, archived: true, nothingDeleted: true };
  }

  // ---- Membership ---------------------------------------------------------

  @Post(':boardId/members')
  @RequirePermission({ module: 'todo', action: 'Create' })
  async setMember(
    @Param('boardId', new ParseUUIDPipe()) boardId: string,
    @Body() body: SetMemberDto,
  ): Promise<unknown> {
    return this.boards.addMember({
      scope: this.tenantContext.requireScope(),
      actorUserId: this.currentUserId(),
      boardId,
      userId: body.userId,
      role: body.role,
    });
  }

  @Delete(':boardId/members/:userId')
  @RequirePermission({ module: 'todo', action: 'Create' })
  async removeMember(
    @Param('boardId', new ParseUUIDPipe()) boardId: string,
    @Param('userId', new ParseUUIDPipe()) userId: string,
  ): Promise<unknown> {
    await this.boards.removeMember({
      scope: this.tenantContext.requireScope(),
      actorUserId: this.currentUserId(),
      boardId,
      userId,
    });
    return { boardId, userId, removed: true };
  }

  // ---- Columns and groups -------------------------------------------------

  /**
   * Add a column.
   *
   * `todo:Create`, not `EditDraft`: putting a row on a board is doing the work, and deciding
   * every row now has a Priority is changing the shape of everybody's board.
   */
  @Post(':boardId/columns')
  @RequirePermission({ module: 'todo', action: 'Create' })
  async addColumn(
    @Param('boardId', new ParseUUIDPipe()) boardId: string,
    @Body() body: AddColumnDto,
  ): Promise<unknown> {
    return this.boards.addColumn({
      scope: this.tenantContext.requireScope(),
      actorUserId: this.currentUserId(),
      boardId,
      title: body.title,
      kind: body.kind,
      settings: body.settings,
    });
  }

  @Post(':boardId/groups')
  @RequirePermission({ module: 'todo', action: 'Create' })
  async addGroup(
    @Param('boardId', new ParseUUIDPipe()) boardId: string,
    @Body() body: AddGroupDto,
  ): Promise<unknown> {
    return this.boards.addGroup({
      scope: this.tenantContext.requireScope(),
      actorUserId: this.currentUserId(),
      boardId,
      title: body.title,
      tone: body.tone,
    });
  }

  // ---- Items --------------------------------------------------------------

  @Post(':boardId/items')
  @RequirePermission({ module: 'todo', action: 'EditDraft' })
  async createItem(
    @Param('boardId', new ParseUUIDPipe()) boardId: string,
    @Body() body: CreateItemDto,
  ): Promise<unknown> {
    return this.boards.createItem({
      scope: this.tenantContext.requireScope(),
      actorUserId: this.currentUserId(),
      boardId,
      name: body.name,
      groupId: body.groupId,
      parentItemId: body.parentItemId,
    });
  }

  @Patch('items/:itemId')
  @RequirePermission({ module: 'todo', action: 'EditDraft' })
  async renameItem(
    @Param('itemId', new ParseUUIDPipe()) itemId: string,
    @Body() body: RenameItemDto,
  ): Promise<unknown> {
    return this.boards.renameItem({
      scope: this.tenantContext.requireScope(),
      actorUserId: this.currentUserId(),
      itemId,
      name: body.name,
    });
  }

  @Delete('items/:itemId')
  @RequirePermission({ module: 'todo', action: 'EditDraft' })
  async archiveItem(@Param('itemId', new ParseUUIDPipe()) itemId: string): Promise<unknown> {
    await this.boards.archiveItem({
      scope: this.tenantContext.requireScope(),
      actorUserId: this.currentUserId(),
      itemId,
    });
    return { itemId, archived: true, nothingDeleted: true };
  }

  /** Write one cell, or clear it by sending no value. */
  @Patch('items/:itemId/cells')
  @RequirePermission({ module: 'todo', action: 'EditDraft' })
  async setCell(
    @Param('itemId', new ParseUUIDPipe()) itemId: string,
    @Body() body: SetCellDto,
  ): Promise<unknown> {
    const cell = await this.boards.setCell({
      scope: this.tenantContext.requireScope(),
      actorUserId: this.currentUserId(),
      itemId,
      columnId: body.columnId,
      value: body.value,
    });
    return cell ?? { itemId, columnId: body.columnId, cleared: true };
  }

  // ---- The thread ---------------------------------------------------------

  @Get('items/:itemId/updates')
  @RequirePermission({ module: 'todo', action: 'View' })
  async listUpdates(@Param('itemId', new ParseUUIDPipe()) itemId: string): Promise<unknown> {
    const updates = await this.boards.listUpdates(
      this.tenantContext.requireScope(),
      this.currentUserId(),
      itemId,
    );
    return { updates };
  }

  @Post('items/:itemId/updates')
  @RequirePermission({ module: 'todo', action: 'Comment' })
  async postUpdate(
    @Param('itemId', new ParseUUIDPipe()) itemId: string,
    @Body() body: PostUpdateDto,
  ): Promise<unknown> {
    return this.boards.postUpdate({
      scope: this.tenantContext.requireScope(),
      actorUserId: this.currentUserId(),
      itemId,
      body: body.body,
      parentUpdateId: body.parentUpdateId,
    });
  }

  private currentUserId(): string {
    const userId = actorUserId(getActor());
    if (userId === undefined || userId === null) {
      throw new UnauthorizedException('This requires a signed-in member of the company.');
    }
    return userId;
  }
}
