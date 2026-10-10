import type { StatusTone } from './status-tone.js';

/**
 * Boards — the Task & Tracker work model.
 *
 * ## What this is modelled on, and where it deliberately differs
 *
 * The shape is monday.com's, because that is what the client asked for: a container of boards, a
 * board of groups and items, items that nest, and **columns that decide what the board is for**.
 * A board is an empty table until somebody chooses its columns; the same structure becomes a
 * hiring pipeline, a bug list or a delivery plan depending on nothing but which columns are on it.
 * That is the whole idea, and it is why the column kinds below are a list that grows rather than
 * a schema change each time.
 *
 * Two names differ on purpose.
 *
 * **Space, not Workspace.** UBoss already calls a *company* a workspace — the top bar says it, the
 * shell takes `workspaceName`, and `/me` returns `workspaces`. A second meaning for the same word,
 * one level down, would be a question in every conversation about this product forever.
 *
 * **Item, not Task.** `HumanTask` already exists and belongs to an objective — `objectiveId` is
 * required, and that chain is what scores somebody's performance. A board item is free-standing by
 * design. They are related by an optional link on the item, never by being the same row: making
 * `objectiveId` optional to merge them would loosen the engine that depends on it.
 */

/**
 * Who can reach a board, before any membership is consulted.
 *
 * The first question, and the one people get wrong when it is expressed only as a member list:
 * a board nobody was added to is either everybody's or nobody's, and which one has to be stated
 * rather than inferred from an empty table.
 */
export const BOARD_KINDS = ['Main', 'Private', 'Shareable'] as const;
export type BoardKind = (typeof BOARD_KINDS)[number];

export const BOARD_KIND_LABELS: Record<BoardKind, string> = {
  Main: 'Main',
  Private: 'Private',
  Shareable: 'Shareable',
};

export const BOARD_KIND_DESCRIPTIONS: Record<BoardKind, string> = {
  Main: 'Everybody in the space can open it.',
  Private: 'Only the people added to it can open it, and only they can see that it exists.',
  Shareable: 'For working with guests, who see this board and nothing else.',
};

/** What somebody added to a board may do on it. */
export const BOARD_MEMBER_ROLES = ['Owner', 'Member', 'Viewer'] as const;
export type BoardMemberRole = (typeof BOARD_MEMBER_ROLES)[number];

export const BOARD_MEMBER_ROLE_LABELS: Record<BoardMemberRole, string> = {
  Owner: 'Owner',
  Member: 'Member',
  Viewer: 'Viewer',
};

/**
 * The column kinds this release ships.
 *
 * Eight, not thirty. Each one is a cell renderer, an editor, a validator and a sort order, and
 * shipping thirty half-finished kinds is how a board becomes a spreadsheet nobody trusts. These
 * eight cover the boards people actually build first; the ninth is a day's work, not a redesign,
 * because a kind is a string and a cell is JSON rather than a column on a table.
 */
export const BOARD_COLUMN_KINDS = [
  'Status',
  'People',
  'Date',
  'Text',
  'Number',
  'Dropdown',
  'Timeline',
  'Checkbox',
  'Doc',
] as const;
export type BoardColumnKind = (typeof BOARD_COLUMN_KINDS)[number];

export const BOARD_COLUMN_KIND_LABELS: Record<BoardColumnKind, string> = {
  Status: 'Status',
  People: 'People',
  Date: 'Date',
  Text: 'Text',
  Number: 'Number',
  Dropdown: 'Dropdown',
  Timeline: 'Timeline',
  Checkbox: 'Checkbox',
  Doc: 'Doc',
};

/**
 * How deep an item may nest.
 *
 * Four levels, which is where monday.com settled and is already more than most boards use. The
 * limit exists because the depth is what every recursive read walks: without one, a cycle or a
 * careless import turns a board query into a tree walk nobody bounded.
 */
export const MAX_BOARD_ITEM_DEPTH = 4;

/** A status column's settings: the labels, in order, each with a tone. */
export interface StatusColumnSettings {
  labels: { id: string; label: string; tone: string }[];
}

/** A dropdown column's settings: the options, and whether more than one may be chosen. */
export interface DropdownColumnSettings {
  options: { id: string; label: string }[];
  multiple: boolean;
}

/**
 * The tones a status label may carry: the product's own palette, not a second one.
 *
 * Named rather than free hex, so a board cannot end up with forty shades nobody can tell apart.
 * And `STATUS_TONE_NAMES` rather than a list of colour words invented here, because a board's
 * "done" must be the same green as a run's, a task's and an approval's — a second palette is two
 * vocabularies for one idea, and the screens drift apart the week after they are written.
 */
export type BoardStatusTone = StatusTone;

/**
 * What a brand-new board starts with.
 *
 * An empty board is a dead end: somebody has to invent groups, columns and a first row before
 * anything on screen does anything. These three groups and three columns are the arrangement
 * every work board converges on anyway, and all of them can be renamed or deleted.
 */
export const DEFAULT_BOARD_GROUPS: readonly { title: string; tone: BoardStatusTone }[] = [
  { title: 'To do', tone: 'grey' },
  { title: 'In progress', tone: 'blue' },
  { title: 'Done', tone: 'success' },
];

export const DEFAULT_STATUS_LABELS: readonly { label: string; tone: BoardStatusTone }[] = [
  { label: 'Not started', tone: 'grey' },
  { label: 'Working on it', tone: 'warn' },
  { label: 'Stuck', tone: 'danger' },
  { label: 'Done', tone: 'success' },
];

export function isBoardKind(value: string): value is BoardKind {
  return (BOARD_KINDS as readonly string[]).includes(value);
}

export function isBoardColumnKind(value: string): value is BoardColumnKind {
  return (BOARD_COLUMN_KINDS as readonly string[]).includes(value);
}

export function isBoardMemberRole(value: string): value is BoardMemberRole {
  return (BOARD_MEMBER_ROLES as readonly string[]).includes(value);
}

/**
 * How deep folders may nest.
 *
 * Ten, which is not a product limit — four or five is as deep as anybody navigates, and nobody
 * has ever been glad of the sixth. It is a stop for the day an import, a bad move or a bug builds
 * a tree nine hundred levels deep: without a ceiling the sidebar's own render walks it, and the
 * screen hangs with no error to read. One number, raised the day somebody genuinely hits it.
 *
 * The ceiling is the cheap half of the protection. The half that matters is that a folder can
 * never be moved inside one of its own descendants — see `BoardService.moveFolder`. That makes a
 * loop, and a loop is not deep, it is endless.
 */
export const MAX_FOLDER_DEPTH = 10;
