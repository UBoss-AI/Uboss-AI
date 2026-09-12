import type { Action, ModuleKey } from './authorization';

/**
 * The company settings catalogue: every setting, its type, its default and the permission that
 * governs it.
 *
 * ## Why the catalogue is code and the values are data
 *
 * The client's requirement is "typed configuration storage with effective inheritance and safe
 * defaults", and the hard part of that is not storage — it is that a setting's **meaning** must
 * be the same everywhere. A `settings` table with a free-text key and a JSON value can hold
 * anything, so:
 *
 *   * two screens can disagree about a setting's default;
 *   * a typo creates a new setting that silently does nothing;
 *   * nothing states which permission governs which value, so the check is per-handler and
 *     eventually one handler forgets.
 *
 * A catalogue in TypeScript fixes all three by construction. A setting that is not here cannot be
 * written — the API rejects an unknown key — its default is one literal, and the permission it
 * requires travels with it, so the server can enforce every setting without a per-setting
 * `if`.
 *
 * ## Why it is not a database table
 *
 * The same reason the role templates are code (ADR-038): a built-in setting's *meaning* must be
 * identical in every deployment, and changing it should be a reviewed deploy rather than an
 * UPDATE. Per-company **values** are data; the shape of the thing is not.
 */

/** The 19 categories, in the client's approved order. */
export const SETTINGS_CATEGORIES = [
  'general',
  'organization',
  'users',
  'roles',
  'objective',
  'agent',
  'skills',
  'providers',
  'tokens',
  'schedules',
  'integrations',
  'knowledge',
  'notifications',
  'security',
  'audit',
  'billing',
  'appearance',
  'uboss',
  'performance',
] as const;

export type SettingsCategory = (typeof SETTINGS_CATEGORIES)[number];

/**
 * What kind of value a setting holds.
 *
 * A closed set, because each kind has its own validator and its own control. `enum` carries its
 * options so a screen can render a select without a second source of truth.
 */
export type SettingType =
  | { kind: 'string'; maxLength: number; pattern?: RegExp }
  | { kind: 'text'; maxLength: number }
  | { kind: 'boolean' }
  | { kind: 'integer'; min: number; max: number }
  | { kind: 'enum'; options: readonly { value: string; label: string }[] };

export interface SettingDefinition {
  /** Stable dotted key, e.g. `general.display_name`. Never renamed — it is stored data. */
  key: string;
  category: SettingsCategory;
  label: string;
  /** One sentence a settings screen shows under the control. */
  description: string;
  type: SettingType;
  /** The safe default, used when no company value exists. */
  defaultValue: string | number | boolean;
  /** The module and action a caller must hold to **write** this setting. */
  writePermission: { module: ModuleKey; action: Action };
  /**
   * The module and action to **read** it. Usually the same module at `View`; a few settings are
   * readable by everybody because a screen needs them to render at all.
   */
  readPermission: { module: ModuleKey; action: Action };
  /**
   * Whether a change is **material** — worth keeping a version history for.
   *
   * The client asks for "version/change history where material". A branding colour changing
   * twenty times is noise; a guest expiry policy or a data-retention window changing once is the
   * thing somebody will need to reconstruct. Marking it per setting rather than keeping history
   * for everything is what keeps the history readable.
   */
  material: boolean;
  /** Present when a setting is stored elsewhere and shown here for completeness. */
  managedElsewhere?: string;
}

/** `general` — company and workspace identity. */
const GENERAL: SettingDefinition[] = [
  {
    key: 'general.display_name',
    category: 'general',
    label: 'Workspace display name',
    description:
      'Shown in the header as UBOSS AI AMS | {name}. Changing it changes what every person in ' +
      'the company sees at the top of every screen.',
    type: { kind: 'string', maxLength: 200 },
    defaultValue: '',
    writePermission: { module: 'settings', action: 'Administer' },
    readPermission: { module: 'settings', action: 'View' },
    material: true,
  },
  {
    key: 'general.timezone',
    category: 'general',
    label: 'Business timezone',
    description:
      'Every schedule and due date is computed against this. It is company data rather than a ' +
      'personal preference: a Monday deadline means the company’s Monday.',
    type: { kind: 'string', maxLength: 60 },
    defaultValue: 'Asia/Kolkata',
    writePermission: { module: 'settings', action: 'Administer' },
    readPermission: { module: 'dashboard', action: 'View' },
    material: true,
  },
  {
    key: 'general.week_starts_on',
    category: 'general',
    label: 'Week starts on',
    description: 'Used by reports and schedules that group by week.',
    type: {
      kind: 'enum',
      options: [
        { value: 'Monday', label: 'Monday' },
        { value: 'Sunday', label: 'Sunday' },
        { value: 'Saturday', label: 'Saturday' },
      ],
    },
    defaultValue: 'Monday',
    writePermission: { module: 'settings', action: 'Administer' },
    readPermission: { module: 'dashboard', action: 'View' },
    material: false,
  },
  {
    key: 'general.working_days',
    category: 'general',
    label: 'Working days',
    description:
      'Which days the company works, comma-separated. Scheduled agent runs are computed against ' +
      'this, so a Friday schedule does not quietly fire on a Saturday. A comma list rather than ' +
      'a set of checkboxes because a setting value is a scalar here; it keeps every real working ' +
      'week expressible, including Sunday-to-Thursday.',
    type: {
      kind: 'string',
      maxLength: 120,
      // Any comma-separated selection of the seven day names. The scheduler additionally parses
      // it against the closed weekday vocabulary, so a typo that slips the pattern still cannot
      // become a working day.
      pattern:
        /^(Monday|Tuesday|Wednesday|Thursday|Friday|Saturday|Sunday)(\s*,\s*(Monday|Tuesday|Wednesday|Thursday|Friday|Saturday|Sunday))*$/,
    },
    defaultValue: 'Monday,Tuesday,Wednesday,Thursday,Friday',
    writePermission: { module: 'settings', action: 'Administer' },
    readPermission: { module: 'dashboard', action: 'View' },
    material: true,
  },
  {
    key: 'general.holidays',
    category: 'general',
    label: 'Company holidays',
    description:
      'Dates the company does not work, comma-separated as YYYY-MM-DD in the business timezone. ' +
      'A holiday is a date in a place rather than an instant — stored as an instant it would be ' +
      'the wrong day for half the world.',
    type: {
      kind: 'string',
      maxLength: 2200,
      // Shape only. An impossible date such as 2026-02-31 passes the pattern and then simply
      // never matches a real day, which is harmless — whereas rejecting it here would need a
      // calendar in a regex.
      pattern: /^$|^\d{4}-\d{2}-\d{2}(\s*,\s*\d{4}-\d{2}-\d{2})*$/,
    },
    defaultValue: '',
    writePermission: { module: 'settings', action: 'Administer' },
    readPermission: { module: 'dashboard', action: 'View' },
    material: true,
  },
  {
    key: 'runs.missed_run_policy',
    category: 'general',
    label: 'Missed scheduled runs',
    description:
      'What happens to a scheduled run whose moment passed while nothing was running — after an ' +
      'outage, for example. An agent may override this. Defaults to skipping, because catching ' +
      'up every missed occurrence can flood a provider and spend a budget in minutes.',
    type: {
      kind: 'enum',
      options: [
        { value: 'Skip', label: 'Skip what was missed' },
        { value: 'RunOnce', label: 'Run once to catch up' },
        { value: 'RunAll', label: 'Run every missed occurrence' },
      ],
    },
    defaultValue: 'Skip',
    writePermission: { module: 'settings', action: 'Administer' },
    readPermission: { module: 'agents', action: 'View' },
    material: true,
  },
  {
    key: 'runs.overlap_policy',
    category: 'general',
    label: 'Overlapping runs',
    description:
      'What happens when a run is due and the previous one has not finished. An agent may ' +
      'override this. Defaults to skipping, because two concurrent runs can have one agent ' +
      'writing over the other’s output.',
    type: {
      kind: 'enum',
      options: [
        { value: 'Skip', label: 'Skip this occurrence' },
        { value: 'Queue', label: 'Queue it behind the running one' },
        { value: 'Allow', label: 'Run them concurrently' },
      ],
    },
    defaultValue: 'Skip',
    writePermission: { module: 'settings', action: 'Administer' },
    readPermission: { module: 'agents', action: 'View' },
    material: true,
  },
  {
    key: 'runs.max_attempts',
    category: 'general',
    label: 'Maximum run attempts',
    description:
      'How many times a retryable failure is tried before it goes to the dead-letter path and ' +
      'raises an Executor exception. Bounded on purpose: unbounded retries are how a queue eats ' +
      'itself.',
    type: { kind: 'integer', min: 1, max: 10 },
    defaultValue: 3,
    writePermission: { module: 'settings', action: 'Administer' },
    readPermission: { module: 'agents', action: 'View' },
    material: true,
  },
];

/** `appearance` — branding and accessibility. */
const APPEARANCE: SettingDefinition[] = [
  {
    key: 'appearance.accent_colour',
    category: 'appearance',
    label: 'Accent colour',
    description:
      'Used for primary actions. Contrast is checked against the approved palette — a colour ' +
      'that fails contrast is refused rather than accepted and quietly unreadable.',
    type: { kind: 'string', maxLength: 7, pattern: /^#[0-9a-fA-F]{6}$/ },
    defaultValue: '#2563EB',
    writePermission: { module: 'settings', action: 'Administer' },
    readPermission: { module: 'dashboard', action: 'View' },
    material: false,
  },
  {
    key: 'appearance.density',
    category: 'appearance',
    label: 'Table density',
    description: 'Comfortable leaves more room between rows; compact fits more on a screen.',
    type: {
      kind: 'enum',
      options: [
        { value: 'Comfortable', label: 'Comfortable' },
        { value: 'Compact', label: 'Compact' },
      ],
    },
    defaultValue: 'Comfortable',
    writePermission: { module: 'settings', action: 'Administer' },
    readPermission: { module: 'dashboard', action: 'View' },
    material: false,
  },
  {
    key: 'appearance.reduce_motion',
    category: 'appearance',
    label: 'Reduce motion for everybody',
    description:
      'Turns off non-essential animation across the company. A per-person preference already ' +
      'follows the operating system; this is the company-wide floor for people whose device ' +
      'setting does not reach us.',
    type: { kind: 'boolean' },
    defaultValue: false,
    writePermission: { module: 'settings', action: 'Administer' },
    readPermission: { module: 'dashboard', action: 'View' },
    material: false,
  },
];

/** `notifications` — alerts and escalation chains. */
const NOTIFICATIONS: SettingDefinition[] = [
  {
    key: 'notifications.approval_reminder_hours',
    category: 'notifications',
    label: 'Approval reminder after (hours)',
    description:
      'How long an approval may sit before the approver is reminded. Zero disables reminders, ' +
      'which is a decision rather than a default — an approval nobody is reminded about is the ' +
      'one that blocks work for a week.',
    type: { kind: 'integer', min: 0, max: 336 },
    defaultValue: 24,
    writePermission: { module: 'settings', action: 'Administer' },
    readPermission: { module: 'approvals', action: 'View' },
    material: true,
  },
  {
    key: 'notifications.escalate_after_hours',
    category: 'notifications',
    label: 'Escalate to the manager after (hours)',
    description:
      'How long before an unanswered approval or exception escalates up the reporting line. ' +
      'Must be at least as long as the reminder — escalating before reminding surprises people.',
    type: { kind: 'integer', min: 0, max: 720 },
    defaultValue: 72,
    writePermission: { module: 'settings', action: 'Administer' },
    readPermission: { module: 'approvals', action: 'View' },
    material: true,
  },
  {
    key: 'notifications.notify_on_agent_exception',
    category: 'notifications',
    label: 'Notify the owner when an Engine Agent run raises an exception',
    description:
      'The Executor Agent detects and escalates exceptions. This decides whether the work’s ' +
      'owner hears about it directly as well.',
    type: { kind: 'boolean' },
    defaultValue: true,
    writePermission: { module: 'settings', action: 'Administer' },
    readPermission: { module: 'executor', action: 'View' },
    material: false,
  },
  {
    key: 'notifications.digest',
    category: 'notifications',
    label: 'Company digest',
    description: 'How often a summary of pending work and exceptions is sent.',
    type: {
      kind: 'enum',
      options: [
        { value: 'Off', label: 'Off' },
        { value: 'Daily', label: 'Daily' },
        { value: 'Weekly', label: 'Weekly' },
      ],
    },
    defaultValue: 'Daily',
    writePermission: { module: 'settings', action: 'Administer' },
    readPermission: { module: 'dashboard', action: 'View' },
    material: false,
  },
];

/** `organization` — Vision, Mission and hierarchy defaults. */
const ORGANIZATION: SettingDefinition[] = [
  {
    key: 'organization.default_hierarchy_view',
    category: 'organization',
    label: 'Default hierarchy view',
    description: 'Which view the Organization Hierarchy screen opens on.',
    type: {
      kind: 'enum',
      options: [
        { value: 'Tree', label: 'Tree' },
        { value: 'List', label: 'List' },
      ],
    },
    defaultValue: 'Tree',
    writePermission: { module: 'settings', action: 'Administer' },
    readPermission: { module: 'hierarchy', action: 'View' },
    material: false,
  },
  {
    key: 'organization.employee_id_uniqueness',
    category: 'organization',
    label: 'Employee ID uniqueness',
    description:
      'Company-wide is enforced today by a database constraint. Per-department is **not** ' +
      'available: the constraint is company-wide, and offering a choice the storage cannot ' +
      'honour would be a setting that lies.',
    type: {
      kind: 'enum',
      options: [{ value: 'CompanyWide', label: 'Enforced (company-wide)' }],
    },
    defaultValue: 'CompanyWide',
    writePermission: { module: 'settings', action: 'Administer' },
    readPermission: { module: 'hierarchy', action: 'View' },
    material: true,
  },
];

/**
 * Every setting, in one array.
 *
 * The categories with no settings of their own are still in `SETTINGS_CATEGORIES` and still
 * render — the client asked for the full information architecture, and a category that exists in
 * the navigation with its own "not configured here yet" panel is honest, whereas a category
 * silently missing from the sidebar reads as a permission problem.
 */
/** `objective` — how an objective's lifecycle is governed. */
const OBJECTIVE: SettingDefinition[] = [
  {
    key: 'objective.closure_sign_off',
    category: 'objective',
    label: 'Signing off a closure',
    description:
      'Who has to agree before a reviewed objective is closed. The default asks the objective’s ' +
      'owner, so a closure written by somebody else is never invisible to the person accountable ' +
      'for the work.',
    type: {
      kind: 'enum',
      options: [
        { value: 'Never', label: 'The reviewer closes it' },
        { value: 'OwnerSignOff', label: 'The objective’s owner signs it off' },
        { value: 'Approval', label: 'It goes through an approval' },
      ],
    },
    // `OwnerSignOff`, matching `DEFAULT_CLOSURE_SIGN_OFF_POLICY`. Kept in step by a test rather
    // than by hope: a default declared in two modules is one that can drift.
    defaultValue: 'OwnerSignOff',
    writePermission: { module: 'settings', action: 'Administer' },
    readPermission: { module: 'objective', action: 'View' },
    // Material: an auditor reconstructing why an objective was closed by one person needs to know
    // what the rule was at the time.
    material: true,
  },
];

const SECURITY: SettingDefinition[] = [
  {
    key: 'security.support_session_authorization',
    category: 'security',
    label: 'UBoss support access to this company',
    description:
      'A UBoss support session always needs a written reason, a verified identity, approval by a ' +
      'second UBoss person, an explicit scope and a hard expiry, and you are told it happened. ' +
      'This decides whether it also needs one of your own administrators to say yes first. There ' +
      'is no emergency bypass: if you require authorization and nobody gives it, UBoss does not ' +
      'enter.',
    type: {
      kind: 'enum',
      options: [
        {
          value: 'NotRequired',
          label: 'UBoss support may enter under its own approval',
        },
        {
          value: 'Required',
          label: 'One of our administrators must authorize each session',
        },
      ],
    },
    // `NotRequired`, matching `DEFAULT_SUPPORT_AUTHORIZATION_MODE`, and the prompt's own wording:
    // customer authorization applies "where policy requires" rather than always. A test keeps the
    // two in step, because a default declared in two modules is one that can drift.
    defaultValue: 'NotRequired',
    writePermission: { module: 'settings', action: 'Administer' },
    // Any company member may *read* it: "can UBoss look at our data without asking us" is a
    // question an employee is entitled to an answer to, and hiding the answer behind an admin
    // grant would be the wrong kind of discretion.
    readPermission: { module: 'settings', action: 'View' },
    // Material: reconstructing why a support session was allowed in March needs the rule that was
    // in force in March.
    material: true,
  },
];

const PORTABLE_PROFILE: SettingDefinition[] = [
  {
    key: 'security.portable_profile_search_enabled',
    category: 'security',
    label: 'Portable UBoss Profile Search',
    description:
      'Lets your HR administrators look up a person by their UBoss Unique ID and see where else ' +
      'they have worked, for how long and in what role. Off until you turn it on: looking into ' +
      'other companies’ employment records is a capability a company should choose rather than ' +
      'inherit. Every lookup is recorded in your audit trail with the ID that was searched.',
    type: { kind: 'boolean' },
    defaultValue: false,
    writePermission: { module: 'settings', action: 'Administer' },
    readPermission: { module: 'settings', action: 'View' },
    material: true,
  },
  {
    key: 'security.portable_performance_sharing',
    category: 'security',
    label: 'What other companies see about performance here',
    description:
      'When another company verifies somebody who worked for you, this decides how much of your ' +
      'own performance record travels with the verification. A badge is comparable between ' +
      'companies in a way a raw score is not, because a score depends on the policy that ' +
      'produced it — and only you can see that policy.',
    type: {
      kind: 'enum',
      options: [
        { value: 'Nothing', label: 'Employment dates and designation only' },
        { value: 'BadgeOnly', label: 'Also the badge and on-time percentage, but not the score' },
        { value: 'BadgeAndScore', label: 'Also the performance score' },
      ],
    },
    // `Nothing`, matching `DEFAULT_PERFORMANCE_SHARING`. A company that has never opened this
    // setting has never agreed to publish its performance judgements to other employers.
    defaultValue: 'Nothing',
    writePermission: { module: 'settings', action: 'Administer' },
    // Any member may read it: "does my score travel to other employers" is a question the person
    // it is about is entitled to an answer to.
    readPermission: { module: 'settings', action: 'View' },
    material: true,
  },
];

export const SETTING_DEFINITIONS: readonly SettingDefinition[] = [
  ...GENERAL,
  ...ORGANIZATION,
  ...NOTIFICATIONS,
  ...APPEARANCE,
  ...OBJECTIVE,
  ...SECURITY,
  ...PORTABLE_PROFILE,
];

const BY_KEY = new Map(SETTING_DEFINITIONS.map((definition) => [definition.key, definition]));

/** Look a setting up by key. `undefined` for an unknown key, which callers must refuse. */
export function settingDefinition(key: string): SettingDefinition | undefined {
  return BY_KEY.get(key);
}

/** Every setting in one category, in catalogue order. */
export function settingsInCategory(category: SettingsCategory): SettingDefinition[] {
  return SETTING_DEFINITIONS.filter((definition) => definition.category === category);
}

export type SettingValue = string | number | boolean;

export type SettingValidation = { ok: true; value: SettingValue } | { ok: false; reason: string };

/**
 * Validate and coerce a value against its definition.
 *
 * Pure, so the same check runs in the API and can run in a form. Coercion is deliberate and
 * narrow: a checkbox posts `"true"`, and a number input posts `"24"`, so accepting the string
 * form of the declared type is the difference between a working form and one that rejects
 * everything. Anything else is refused with the reason.
 */
export function validateSetting(definition: SettingDefinition, raw: unknown): SettingValidation {
  const { type } = definition;

  switch (type.kind) {
    case 'boolean': {
      if (typeof raw === 'boolean') {
        return { ok: true, value: raw };
      }
      if (raw === 'true' || raw === 'false') {
        return { ok: true, value: raw === 'true' };
      }
      return { ok: false, reason: `${definition.label} is a yes/no setting.` };
    }

    case 'integer': {
      const value = typeof raw === 'number' ? raw : Number(raw);
      if (!Number.isInteger(value)) {
        return { ok: false, reason: `${definition.label} must be a whole number.` };
      }
      if (value < type.min || value > type.max) {
        return {
          ok: false,
          reason: `${definition.label} must be between ${type.min} and ${type.max}.`,
        };
      }
      return { ok: true, value };
    }

    case 'enum': {
      const value = String(raw);
      if (!type.options.some((option) => option.value === value)) {
        return {
          ok: false,
          reason:
            `${definition.label} must be one of: ` +
            `${type.options.map((option) => option.label).join(', ')}.`,
        };
      }
      return { ok: true, value };
    }

    case 'string':
    case 'text': {
      if (typeof raw !== 'string') {
        return { ok: false, reason: `${definition.label} must be text.` };
      }
      const value = raw.trim();
      if (value.length > type.maxLength) {
        return {
          ok: false,
          reason: `${definition.label} is limited to ${type.maxLength} characters.`,
        };
      }
      if (type.kind === 'string' && type.pattern && value !== '' && !type.pattern.test(value)) {
        return { ok: false, reason: `${definition.label} is not in the expected format.` };
      }
      return { ok: true, value };
    }

    default: {
      // Exhaustiveness: a new kind must be handled explicitly rather than falling through to
      // accepting whatever it was given.
      const unreachable: never = type;
      return { ok: false, reason: `Unhandled setting type: ${JSON.stringify(unreachable)}` };
    }
  }
}

/**
 * Cross-setting rules, checked after each value validates on its own.
 *
 * Some constraints only exist *between* settings — escalating before reminding, for instance —
 * and a per-field validator cannot see them. Returns every violation rather than the first, so a
 * form can mark all the fields involved.
 */
export function validateSettingCombination(
  effective: Record<string, SettingValue>,
): readonly string[] {
  const problems: string[] = [];

  const reminder = Number(effective['notifications.approval_reminder_hours'] ?? 0);
  const escalate = Number(effective['notifications.escalate_after_hours'] ?? 0);

  if (escalate > 0 && reminder > 0 && escalate < reminder) {
    problems.push(
      'Escalation must not happen before the reminder. Escalating an approval to somebody’s ' +
        'manager before the approver has been reminded surprises both of them.',
    );
  }

  return problems;
}
