import type { IconName } from '../primitives/Icon';

export interface NavItem {
  /** Stable key, also used as the active-item identifier. */
  key: string;
  label: string;
  icon: IconName;
  /** Target route. Rendered as a real link, so it must be a route that exists. */
  href?: string;
  /**
   * The permission module that decides whether this item is shown. Defaults to `key`, which is
   * true of every module-backed screen.
   *
   * `null` means the item is **not module-gated at all**. Workspace Chat is the case: access there
   * is being a participant in a conversation, and `chat.controller.ts` argues at length why no
   * `chat` module should exist — a `chat:View` grant would mean somebody could be given everybody's
   * correspondence. Filtering such an item against the module list hides a working feature from
   * every single user, which is exactly what happened.
   */
  module?: string | null;
  /** Count shown as a pill, e.g. pending approvals. Only ever a real, computed number. */
  badge?: number;
}

export interface NavGroup {
  group: string;
  items: NavItem[];
}

/**
 * Company Workspace navigation.
 *
 * Mirrors the client's approved UI reference.
 *
 * ## Why Administration holds no "Users & Access" or "Roles & Permissions"
 *
 * Both were once listed here. The prototype's broken group-name lookup meant neither item was
 * ever inserted into its sidebar, and the screens were reachable only by typing a URL, so this
 * file added them back (docs/UX_MAP.md §7). That reasoning has since stopped applying: Settings
 * carries both as sections of its own — `users` with an explicit "Open Users & Access" button
 * onto /settings/users, and `roles` as the very section the old sidebar link pointed at
 * (`/settings?section=roles`). An admin therefore met the same two destinations twice, once in
 * the sidebar and again inside Settings.
 *
 * The client asked for the duplicates to go, so the sidebar now offers each destination once,
 * through Settings. Nothing became unreachable — the tests below assert both sections still
 * stand in SETTINGS_SECTIONS, which is what the earlier "is present" tests were really
 * protecting.
 *
 * "UBoss Profile Search" STAYS, and is not the same kind of item. Settings does hold a
 * similarly-named section, but that one is `uboss` — "UBoss Profile Search Policy", the
 * cross-company lookup *policy*. The search screen itself lives at /profile-search and nothing
 * else in the product links to it, so removing it here would orphan it.
 *
 * Visibility is presentation only. The server decides what a user may actually open, and every
 * route is independently guarded — a hidden item is not an access control.
 */
export const COMPANY_NAV: readonly NavGroup[] = [
  {
    group: 'Home',
    items: [
      /*
       * Operations is deliberately not a screen.
       *
       * It was one, and it was a third place showing what two others already show: the human work
       * waiting on somebody, and the agent work they may run. Those are To-do List and Engine
       * Agents, and both sit under the Operations *group* below — which is what "the operations
       * section" always meant. A person doing the work opens the one that matches what they have
       * been given; an extra landing page in front of the two adds a click and answers nothing.
       *
       * The company-wide view of the same question — who is working, on what, and what is stuck —
       * is the Dashboard's "Where the work is", which is a different question asked by a
       * different person.
       */
      { key: 'dashboard', label: 'Dashboard', icon: 'grid', href: '/dashboard' },
    ],
  },
  {
    group: 'Builders',
    items: [
      { key: 'hierarchy', label: 'Hierarchy', icon: 'tree', href: '/hierarchy' },
      { key: 'objective', label: 'Objective Optimization', icon: 'target', href: '/objective' },
      { key: 'agent-builder', label: 'Agent Builder', icon: 'bot', href: '/agent-builder' },
    ],
  },
  {
    group: 'Operations',
    items: [
      { key: 'todo', label: 'To-do List', icon: 'list', href: '/todo' },
      { key: 'agents', label: 'Engine Agents', icon: 'bot', href: '/agents' },
      { key: 'executor', label: 'Executor Agent', icon: 'shield', href: '/executor' },
      // Prompt 40A (CR-03). Under OPERATIONS, where the client put it.
      // No module: a conversation is correspondence between participants, not company data a
      // role grants. See the design note at the top of apps/api/src/chat/chat.controller.ts.
      { key: 'chat', label: 'Workspace Chat', icon: 'chat', href: '/chat', module: null },
      { key: 'approvals', label: 'Approvals', icon: 'govern', href: '/approvals' },
      { key: 'performance', label: 'Performance', icon: 'medal', href: '/performance' },
      { key: 'reports', label: 'Reports', icon: 'chart', href: '/reports' },
    ],
  },
  {
    group: 'Administration',
    items: [
      /*
       * Three screens that used to live inside Settings as signposts.
       *
       * Each was a "settings category" whose entire content was a sentence and a button reading
       * *Open X* — and for two of them that button was the only route to the screen at all. A
       * category that exists to point somewhere else is not a setting; it is a menu entry in the
       * wrong menu, and it cost a reader three clicks to reach a screen that should have been
       * one.
       *
       * Roles & Permissions stays in Settings, because it genuinely is one: the catalogue and
       * the company's own roles are configuration, and they are edited there rather than
       * anywhere else.
       */
      /*
       * Users & Access, Billing and Audit are Settings sections, not sidebar entries.
       *
       * They were sections holding a sentence and an *Open X* button, which is why they briefly
       * moved here. The client's decision is that they belong in Settings — so they are back
       * there, and the fix for the original complaint is that selecting one now opens the screen
       * itself instead of a panel describing it.
       *
       * The screens stay full pages rather than being embedded in the Settings dialog. Users &
       * Access is three tabs of tables and bulk operations; in an eight-hundred-pixel modal it
       * would be worse than the page, not tidier.
       */
      {
        key: 'profile-search',
        label: 'UBoss Profile Search',
        icon: 'search',
        href: '/profile-search',
      },
      { key: 'settings', label: 'Settings', icon: 'gear', href: '/settings' },
    ],
  },
] as const;

/** UBoss Master Console navigation — the platform control plane, separate from any tenant. */
export const MASTER_NAV: readonly NavGroup[] = [
  {
    group: 'Platform',
    items: [
      { key: 'dashboard', label: 'Dashboard', icon: 'grid', href: '/master/dashboard' },
      { key: 'companies', label: 'Companies', icon: 'build', href: '/master/companies' },
      {
        key: 'create-company',
        label: 'Create Company',
        icon: 'plus',
        href: '/master/create-company',
      },
    ],
  },
  {
    group: 'Commercial',
    items: [
      { key: 'plans', label: 'Plans & Entitlements', icon: 'card', href: '/master/plans' },
      { key: 'billing', label: 'Billing & Payments', icon: 'card', href: '/master/billing' },
      { key: 'credits', label: 'AI Usage & Credits', icon: 'bolt', href: '/master/credits' },
    ],
  },
  {
    group: 'AI Platform',
    items: [
      // providers: Providers and model profiles are a platform decision, not a company setting.
      { key: 'skills', label: 'Skill Catalog', icon: 'file', href: '/master/skills' },
      { key: 'testing', label: 'Testing & Evaluation', icon: 'check', href: '/master/testing' },
      { key: 'release', label: 'Release & Features', icon: 'bolt', href: '/master/release' },
    ],
  },
  {
    group: 'Operate',
    items: [
      { key: 'dev-ops', label: 'Development & Operations', icon: 'build', href: '/master/dev-ops' },
      { key: 'support', label: 'Support & Ops', icon: 'bell', href: '/master/support' },
      { key: 'security', label: 'Security & Audit', icon: 'shield', href: '/master/security' },
      { key: 'health', label: 'System Health', icon: 'ops', href: '/master/health' },
      {
        key: 'platform-settings',
        label: 'Platform Settings',
        icon: 'gear',
        href: '/master/platform-settings',
      },
    ],
  },
] as const;

export interface SettingsSection {
  key: string;
  label: string;
  /** Label shown instead of `label` for non-admin roles, per the approved UI reference. */
  personalLabel?: string;
  description: string;
}

/**
 * The 19 Company Settings categories, in the approved order.
 * Rendered as left navigation with a right detail panel (locked UI rule).
 */
export const SETTINGS_SECTIONS: readonly SettingsSection[] = [
  {
    key: 'general',
    label: 'General',
    /*
     * Not "My Profile".
     *
     * What somebody without administration rights sees here is the company's working setup —
     * the timezone every deadline is computed in, the working week, the holidays. Useful, and
     * theirs to read rather than to change. Calling it their profile promised a page about them
     * and delivered a page about the company, which is the kind of label somebody stops
     * trusting the rest of the screen over.
     */
    personalLabel: 'How this company works',
    description: 'Company and workspace identity.',
  },
  /*
   * Organization is not a section, because Hierarchy is already a screen.
   *
   * Both went to the same place. Users & Access, Billing and Audit are here because Settings is
   * their only home; the company chart has its own entry in the sidebar, where somebody
   * building a hierarchy expects to find it, and a second door into the same room is the
   * duplication this list was cleared of.
   */
  { key: 'users', label: 'Users & Access', description: 'Employees, guests and invitations.' },
  {
    key: 'roles',
    label: 'Roles & Permissions',
    description: 'Roles, scope, module visibility and allowed actions.',
  },
  {
    key: 'objective',
    label: 'Objective & Approval Rules',
    description: 'Objective lifecycle and approval gates.',
  },
  {
    key: 'agent',
    label: 'Agent Policy',
    personalLabel: 'My Agent Preferences',
    description: 'Engine Agent governance.',
  },
  /*
   * Skills & AI is deliberately absent.
   *
   * Browsing and governing a catalogue of four hundred Skills is not something a company admin
   * does in the course of running work — the Skills an agent uses are settled when the agent is
   * built, not administered separately afterwards. The panel, its API and every stored Skill are
   * untouched: published agents pin the Skill versions they were built from, so the catalogue is
   * still what gives those pins a meaning. This removes a door, not a room.
   */
  // providers: Providers and model profiles are a platform decision, not a company setting.
  { key: 'tokens', label: 'Tokens & Cost', description: 'Budgets and the AI cost lifecycle.' },
  // schedules: Scheduling policy is set per objective, where the schedule is.
  {
    key: 'integrations',
    label: 'Integrations & Connections',
    personalLabel: 'My Connections',
    description: 'Connected systems and their health.',
  },
  // knowledge: Approved sources are managed where the knowledge is, not here.
  {
    key: 'notifications',
    label: 'Notifications & Escalations',
    description: 'Alerts and escalation chains.',
  },
  {
    key: 'security',
    label: 'Security',
    personalLabel: 'Login & Security',
    description: 'Sessions, MFA policy and security events.',
  },
  /*
   * Audit & Activity is absent, and that is a gap rather than a decision.
   *
   * The section promised "a searchable audit trail" and opened `/internal/audit`, a page whose
   * own first line calls itself "a diagnostic for the Prompt 8 audit and security foundations —
   * not the Security Center". That is a developer's tool: unlabelled columns, no filters a
   * company would use, and a heading that tells an administrator they are somewhere they should
   * not be.
   *
   * The trail itself exists and is complete — every action in the product writes to it, and the
   * Employee panel already reads it per person. What does not exist is a company-facing screen
   * over it. Offering a door to the diagnostic was worse than offering none, because it looked
   * like the feature.
   */
  { key: 'billing', label: 'Billing', description: 'Plan and invoices.' },
  { key: 'appearance', label: 'Appearance', description: 'Branding and accessibility.' },
  // uboss: Cross-company lookup policy has no company-level switch today.
  // performance: Scoring and badge thresholds are the product’s, and identical everywhere.
] as const;

/**
 * The six login presentation sections, with the copy taken verbatim from the client's approved
 * .
 *
 * Taken from the **effective** login — the reference defines its login twice and the later
 * definition wins. An earlier version of this file used the superseded definition's wording
 * ("Chart your organization, roles and objectives" and so on); these are the strings the
 * reference actually renders, and  places each card on the correct side of the mind-map.
 *
 * Presentation only — they grant no application access, and there is no public company signup.
 */
export interface LoginCapability {
  key: string;
  icon: IconName;
  title: string;
  description: string;
  /** Which side of the radial mind-map this card sits on. */
  side: 'left' | 'right';
}

export const LOGIN_CAPABILITIES: readonly LoginCapability[] = [
  { key: 'map', icon: 'map', title: 'MAP', description: 'Departments and people', side: 'left' },
  {
    key: 'optimize',
    icon: 'ops',
    title: 'Optimize',
    description: 'Objectives and their plans',
    side: 'left',
  },
  {
    key: 'build',
    icon: 'build',
    title: 'Build',
    description: 'Agents built and released',
    side: 'left',
  },
  {
    key: 'operate',
    icon: 'bolt',
    title: 'Operate',
    description: 'Approved versions, running',
    side: 'right',
  },
  {
    key: 'govern',
    icon: 'govern',
    title: 'Govern',
    description: 'Approvals and audit trail',
    side: 'right',
  },
  {
    key: 'manage-task',
    icon: 'list',
    title: 'Manage Task',
    description: 'What is waiting on you',
    side: 'right',
  },
] as const;

/** The assurance strip beneath the mind-map, again verbatim from the reference. */
export interface LoginAssurance {
  icon: IconName;
  label: string;
}

export const LOGIN_ASSURANCES: readonly LoginAssurance[] = [
  { icon: 'shield', label: 'Tenant-isolated' },
  { icon: 'check', label: 'Human governed' },
  { icon: 'key', label: 'Fully audited' },
] as const;

/**
 * Hide the groups and items this person holds no grant on — Prompt 40A (CR-03).
 *
 * ## Presentation follows the grants, and does not decide anything
 *
 * The server's `visibleModules` is derived from whichever modules a person actually holds a grant
 * on, so this filter renders a fact rather than making a judgement. **It is not an access
 * control**: every route is independently guarded, and a hidden item that somebody reaches by URL
 * is refused by the same absent grant that hid it. One mechanism, read twice.
 *
 * ## Module presence is not always the whole answer
 *
 * A screen whose landing request names a specific row is subject to the scope layer as well as the
 * module grant, and the scope layer can refuse what the grant allowed. The server reports those
 * cases in `unavailableNavKeys`, computed by running the route's own authorize call, and they are
 * filtered out here too. Still one mechanism read twice — the route refuses the same request.
 *
 * That matters most for CR-03's central change. A standard Employee no longer holds `objective` or
 * `agent-builder`, so Objective Optimization and Agent Builder disappear from their sidebar —
 * and there is deliberately **no role check anywhere in this function**. Hard-coding "hide Agent
 * Builder from Employees" would be a second rule to keep in step with the first, and the two would
 * eventually disagree.
 *
 * ## Why an empty group vanishes rather than rendering empty
 *
 * A heading with nothing under it reads as a loading failure. A standard Employee's BUILDERS group
 * still contains Hierarchy, so it stays; a group that emptied entirely would go.
 *
 * ## Fail open, and only here
 *
 * `visibleModules` of `null` — nothing loaded yet, or an older server that does not send it —
 * renders the full navigation. Being generous with a *menu* is right: the routes still refuse, and
 * the alternative is a sidebar that flickers to empty on every page load and looks broken.
 */
export function filterNavigation(
  groups: readonly NavGroup[],
  visibleModules: readonly string[] | null | undefined,
  unavailableNavKeys: readonly string[] | null | undefined = null,
): NavGroup[] {
  const unavailable = new Set(unavailableNavKeys ?? []);
  if (visibleModules === null || visibleModules === undefined) {
    // Still honour the refusals. An unavailable key is a fact the server has already established
    // by running the route's own check, so there is nothing generous about showing it — unlike a
    // missing module list, which only means the answer has not arrived.
    return groups
      .map((group) => ({ group: group.group, items: group.items.filter((item) => !unavailable.has(item.key)) }))
      .filter((group) => group.items.length > 0);
  }

  const visible = new Set(visibleModules);

  return groups
    .map((group) => ({
      group: group.group,
      items: group.items.filter((item) => {
        // An item says which module governs it; by default that is its own key. An item that
        // declares `module: null` is not module-gated and is always offered — the route still
        // refuses if the person does not belong there.
        //
        // This used to be a plain `visible.has(item.key)`, with a comment claiming an item that
        // was not a module "would be kept". It was not: Workspace Chat, which deliberately has no
        // module, was filtered out for every role in the product.
        // The server may also have established that this particular entry's landing request
        // would be refused even though its module grant exists — a screen whose first request
        // names a row the scope layer cannot place. Offering it anyway is the "hidden navigation
        // is presentation only" rule read backwards: the item is not hidden to enforce anything,
        // it is hidden because the answer is already known.
        if (unavailable.has(item.key)) return false;

        const moduleKey = item.module === undefined ? item.key : item.module;
        return moduleKey === null || visible.has(moduleKey);
      }),
    }))
    .filter((group) => group.items.length > 0);
}
