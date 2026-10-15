import {
  COMPANY_MODULES,
  COMPANY_MODULE_LABELS,
  type Action,
  type CompanyModuleKey,
} from './authorization.js';

/**
 * Access, chosen one section at a time.
 *
 * ## What this replaces, and why
 *
 * An administrator used to be shown eight capabilities grouped under three headings — "Run work
 * assigned to them", "Manage people and assigned work", "Design objectives and build agents" —
 * each with a paragraph under it. The client's objection was plain: those are sentences, not
 * names, and somebody deciding what a colleague may do should not have to read an essay to find
 * out whether they are granting Agent Builder.
 *
 * So the question is asked the way the client asked for it: **pick a section, then pick a level**.
 * The sections are the ones in the sidebar, because they are the words everybody in the company
 * already uses. The levels are four, and always the same four, so the shape of the answer does
 * not change as you move down the list.
 *
 * ## This is not a second permission system
 *
 * Every level expands to the actions the existing engine already understands — `View`, `Approve`,
 * `Publish` and the rest — exactly as `CAPABILITIES` does, and is granted the same way: a shared
 * custom role per (section, level), assigned to the person. The authorization engine remains the
 * only thing that decides anything. What is new is the vocabulary an administrator chooses in.
 */

// ---------------------------------------------------------------------------
// The four levels
// ---------------------------------------------------------------------------

/**
 * Ordered, from least to most, and the order is load-bearing.
 *
 * Each level **includes** the one below it, which is what makes it a level rather than a
 * checkbox: "Approver" is somebody who can also create, and could also only look. Offering them
 * as independent ticks would let a company grant Approve to somebody who may not open the thing
 * they are approving, which is not a permission anybody means to hand out.
 */
export const ACCESS_LEVELS = ['Viewer', 'Creator', 'Approver', 'Admin'] as const;
export type AccessLevel = (typeof ACCESS_LEVELS)[number];

export function accessLevelRank(level: AccessLevel): number {
  return ACCESS_LEVELS.indexOf(level);
}

export const ACCESS_LEVEL_LABELS: Record<AccessLevel, string> = {
  Viewer: 'Viewer',
  Creator: 'Creator',
  Approver: 'Approver',
  Admin: 'Admin',
};

/**
 * What each level adds, in the engine's own vocabulary.
 *
 * Cumulative by construction: `actionsForLevel` unions every step up to the one chosen, so a
 * level can never be defined in a way that grants less than the level below it.
 *
 * Two placements are worth saying out loud:
 *
 *   * **`Export` is a Viewer action.** Taking a copy of what you may already read is not a new
 *     power, and the client's own list puts "See their team's reports" — which exports — at the
 *     bottom. Treating a download as administration would make every manager an administrator.
 *   * **`Run` is a Creator action.** On Engine Agents there is nothing to create; running an
 *     agent somebody assigned you *is* the doing of the work, and it is the second level for the
 *     same reason writing an objective is.
 */
const LEVEL_STEPS: Record<AccessLevel, readonly Action[]> = {
  Viewer: ['View', 'Comment', 'Export'],
  Creator: ['Create', 'EditDraft', 'Run'],
  Approver: ['Approve'],
  Admin: ['Assign', 'Publish', 'Schedule', 'Pause', 'ManageAccess', 'Administer', 'Audit'],
};

/** Every action a level carries, including everything the levels below it carry. */
export function actionsForLevel(level: AccessLevel): readonly Action[] {
  const upTo = ACCESS_LEVELS.slice(0, accessLevelRank(level) + 1);
  return [...new Set(upTo.flatMap((step) => LEVEL_STEPS[step]))];
}

// ---------------------------------------------------------------------------
// Which levels a section actually offers
// ---------------------------------------------------------------------------

/**
 * Not every section can be approved, and offering a level that means nothing is worse than
 * offering three.
 *
 * Only three modules govern a decision of their own: an objective review and a workflow publish
 * are `objective`, an agent activation is `agents`, and everything else routes to the generic
 * `approvals` queue — which is `APPROVAL_TYPE_MODULE`, and this list is that fact read back. An
 * "Approver" on the Dashboard would be a radio button that changes nothing, and a person who
 * ticked it would reasonably believe they had given somebody something.
 *
 * Dashboard is the other shape: there is nothing to create, approve or administer on it. It is a
 * screen you can see or cannot, so it offers one level, and the screen draws it as a switch
 * rather than as a row of four.
 */
export const SECTION_LEVELS: Record<CompanyModuleKey, readonly AccessLevel[]> = {
  dashboard: ['Viewer'],
  hierarchy: ['Viewer', 'Creator', 'Admin'],
  objective: ['Viewer', 'Creator', 'Approver', 'Admin'],
  'agent-builder': ['Viewer', 'Creator', 'Admin'],
  todo: ['Viewer', 'Creator', 'Admin'],
  agents: ['Viewer', 'Creator', 'Approver', 'Admin'],
  executor: ['Viewer', 'Admin'],
  approvals: ['Viewer', 'Approver', 'Admin'],
  performance: ['Viewer', 'Admin'],
  reports: ['Viewer', 'Admin'],
  users: ['Viewer', 'Creator', 'Admin'],
  roles: ['Viewer', 'Admin'],
  'profile-search': ['Viewer'],
  settings: ['Viewer', 'Admin'],
};

export function sectionOffers(module: CompanyModuleKey, level: AccessLevel): boolean {
  return SECTION_LEVELS[module].includes(level);
}

// ---------------------------------------------------------------------------
// What a level means, in this section, in one line
// ---------------------------------------------------------------------------

/**
 * One sentence per section and level, because "Creator" means different things in different
 * places and the name alone would be a riddle.
 *
 * The four names stay the same everywhere — that is the whole point of a level — and the line
 * underneath says what it is here. On Engine Agents a Creator runs; on Objective Optimization a
 * Creator writes. Changing the *name* per section was the alternative and it is worse: an
 * administrator comparing two colleagues would be comparing two vocabularies.
 *
 * Absent entries fall back to a generic line, so a section added later is never blank.
 */
const SECTION_LEVEL_LINES: Partial<Record<CompanyModuleKey, Partial<Record<AccessLevel, string>>>> =
  {
    dashboard: { Viewer: 'Can open the dashboard.' },
    hierarchy: {
      Viewer: 'Can see the org chart and who reports to whom.',
      Creator: 'Can add people and edit their records.',
      Admin: 'Can restructure departments and reporting lines.',
    },
    objective: {
      Viewer: 'Can read objectives and their plans.',
      Creator: 'Can write and change objectives.',
      Approver: 'Can approve an objective or send it back.',
      Admin: 'Can run the analysis, publish and assign the work.',
    },
    'agent-builder': {
      Viewer: 'Can see how an agent is built.',
      Creator: 'Can design, configure and test an agent, and save a draft.',
      Admin: 'Can put a tested agent live.',
    },
    todo: {
      Viewer: 'Can see their own tasks.',
      Creator: 'Can work on their own tasks, with notes and evidence.',
      Admin: 'Can give tasks to the people who report to them.',
    },
    agents: {
      Viewer: 'Can see the agents and what they produced.',
      Creator: 'Can run the agents assigned or shared with them.',
      Approver: 'Can approve an agent going live.',
      Admin: 'Can schedule and pause agents.',
    },
    executor: {
      Viewer: 'Can see what the Executor Agent is watching.',
      Admin: 'Can pause it and change what it watches.',
    },
    approvals: {
      Viewer: 'Can see the approvals queue.',
      Approver: 'Can decide the requests addressed to them.',
      Admin: 'Can delegate and reassign a decision.',
    },
    performance: {
      Viewer: 'Can see performance and rewards.',
      Admin: 'Can change how performance is measured.',
    },
    reports: {
      Viewer: 'Can read and download reports.',
      Admin: 'Can change what the reports cover.',
    },
    users: {
      Viewer: 'Can see who is in the company.',
      Creator: 'Can add employees and edit their records.',
      Admin: 'Can grant and remove access for other people.',
    },
    roles: {
      Viewer: 'Can see the roles this company has.',
      Admin: 'Can write and change custom roles.',
    },
    'profile-search': { Viewer: 'Can look somebody up across companies.' },
    settings: {
      Viewer: 'Can see the company settings.',
      Admin: 'Can change them, and read the audit trail.',
    },
  };

const GENERIC_LINES: Record<AccessLevel, string> = {
  Viewer: 'Can see it.',
  Creator: 'Can create and change things here.',
  Approver: 'Can approve or send back.',
  Admin: 'Full control, including giving others access to this section.',
};

export function sectionLevelLine(module: CompanyModuleKey, level: AccessLevel): string {
  return SECTION_LEVEL_LINES[module]?.[level] ?? GENERIC_LINES[level];
}

/** Every section, in sidebar order, with the levels it offers. Built for the screen. */
export function accessSections(): {
  module: CompanyModuleKey;
  label: string;
  levels: { level: AccessLevel; label: string; line: string }[];
}[] {
  return COMPANY_MODULES.map((module) => ({
    module,
    label: COMPANY_MODULE_LABELS[module],
    levels: SECTION_LEVELS[module].map((level) => ({
      level,
      label: ACCESS_LEVEL_LABELS[level],
      line: sectionLevelLine(module, level),
    })),
  }));
}

// ---------------------------------------------------------------------------
// What an administrator may hand out
// ---------------------------------------------------------------------------

/**
 * May this administrator set this level on this section?
 *
 * The same two rules `delegationProblems` applies to capabilities, because they are the same
 * rules and a second answer to one question is how two screens start disagreeing:
 *
 *   1. **You cannot grant a section you hold nothing on.**
 *   2. **You cannot grant above your own level in that section.** Holding Creator on Objective
 *      Optimization does not let you make somebody its Admin.
 *
 * A company administrator is exempt, as they are for capabilities: there is nothing above them
 * inside their own company, so "above your own level" has nothing to mean.
 *
 * Returns the reason rather than a boolean, so the screen can grey out the exact radio button and
 * say why — a flat refusal on a grid of fourteen rows is a support ticket.
 */
export function levelGrantProblem(input: {
  granterLevel: AccessLevel | null;
  requested: AccessLevel;
  module: CompanyModuleKey;
  granterIsCompanyAdmin: boolean;
}): string | null {
  if (input.granterIsCompanyAdmin) return null;

  const section = COMPANY_MODULE_LABELS[input.module];

  if (input.granterLevel === null) {
    return `You have no access to ${section} yourself, so you cannot give it to somebody else.`;
  }

  if (accessLevelRank(input.requested) > accessLevelRank(input.granterLevel)) {
    return (
      `${ACCESS_LEVEL_LABELS[input.requested]} on ${section} is above the ` +
      `${ACCESS_LEVEL_LABELS[input.granterLevel]} access you hold there.`
    );
  }

  return null;
}

/**
 * The highest level these actions amount to, or null for none.
 *
 * Used to read a person's current level back off the grants they actually hold, rather than
 * storing it separately — a stored level and a real grant are two records of one fact, and the
 * stored one is the one that goes stale.
 */
export function levelFromActions(
  module: CompanyModuleKey,
  actions: readonly Action[],
): AccessLevel | null {
  const held = new Set(actions);
  let best: AccessLevel | null = null;

  for (const level of SECTION_LEVELS[module]) {
    const needed = actionsForLevel(level).filter((action) =>
      // Only the actions this section offers at some level. A module that never offers `Approve`
      // must not be judged against it, or nobody could ever reach Admin there.
      SECTION_LEVELS[module].some((candidate) => actionsForLevel(candidate).includes(action)),
    );
    if (needed.every((action) => held.has(action))) best = level;
  }

  return best;
}
