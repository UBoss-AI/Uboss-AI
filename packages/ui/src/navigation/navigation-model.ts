import type { IconName } from '../primitives/Icon';

export interface NavItem {
  /** Stable key, also used as the active-item identifier. */
  key: string;
  label: string;
  icon: IconName;
  /** Target route. Mock at Prompt 2 — no navigation is wired to real data yet. */
  href?: string;
  /** Count shown as a pill, e.g. pending approvals. */
  badge?: number;
}

export interface NavGroup {
  group: string;
  items: NavItem[];
}

/**
 * Company Workspace navigation.
 *
 * Mirrors the client's approved UI reference. Two corrections to the prototype are applied
 * here deliberately (see docs/UX_MAP.md §7):
 *  - "Roles & Permissions" IS present. In the prototype a broken group-name lookup meant the
 *    item was never inserted into the sidebar, leaving the screen reachable only by URL.
 *  - "Users & Access" IS present, for the same reason.
 *
 * Visibility is presentation only. The server decides what a user may actually open, and every
 * route is independently guarded — a hidden item is not an access control.
 */
export const COMPANY_NAV: readonly NavGroup[] = [
  {
    group: 'Home',
    items: [{ key: 'dashboard', label: 'Dashboard', icon: 'grid', href: '/dashboard' }],
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
      { key: 'chat', label: 'Workspace Chat', icon: 'chat', href: '/chat' },
      { key: 'approvals', label: 'Approvals', icon: 'govern', href: '/approvals', badge: 5 },
      { key: 'performance', label: 'Performance', icon: 'medal', href: '/performance' },
      { key: 'reports', label: 'Reports', icon: 'chart', href: '/reports' },
    ],
  },
  {
    group: 'Administration',
    items: [
      { key: 'users', label: 'Users & Access', icon: 'users', href: '/users' },
      { key: 'roles', label: 'Roles & Permissions', icon: 'key', href: '/roles' },
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
      { key: 'dashboard', label: 'Dashboard', icon: 'grid', href: '/dashboard' },
      { key: 'companies', label: 'Companies', icon: 'build', href: '/companies' },
      { key: 'create-company', label: 'Create Company', icon: 'plus', href: '/create-company' },
    ],
  },
  {
    group: 'Commercial',
    items: [
      { key: 'plans', label: 'Plans & Entitlements', icon: 'card', href: '/plans' },
      { key: 'billing', label: 'Billing & Payments', icon: 'card', href: '/billing' },
      { key: 'credits', label: 'AI Usage & Credits', icon: 'bolt', href: '/credits' },
    ],
  },
  {
    group: 'AI Platform',
    items: [
      { key: 'providers', label: 'Providers & Models', icon: 'bot', href: '/providers' },
      { key: 'skills', label: 'Skill Catalog', icon: 'file', href: '/skills' },
      { key: 'testing', label: 'Testing & Evaluation', icon: 'check', href: '/testing' },
      { key: 'release', label: 'Release & Features', icon: 'bolt', href: '/release' },
    ],
  },
  {
    group: 'Operate',
    items: [
      { key: 'dev-ops', label: 'Development & Operations', icon: 'build', href: '/dev-ops' },
      { key: 'support', label: 'Support & Ops', icon: 'bell', href: '/support' },
      { key: 'security', label: 'Security & Audit', icon: 'shield', href: '/security' },
      { key: 'health', label: 'System Health', icon: 'ops', href: '/health' },
      {
        key: 'platform-settings',
        label: 'Platform Settings',
        icon: 'gear',
        href: '/platform-settings',
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
    personalLabel: 'My Profile',
    description: 'Company and workspace identity.',
  },
  {
    key: 'organization',
    label: 'Organization',
    description: 'Vision, mission and hierarchy defaults.',
  },
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
  { key: 'skills', label: 'Skills & AI', description: 'Skill library and governance.' },
  { key: 'providers', label: 'AI Providers', description: 'Providers and model profiles.' },
  { key: 'tokens', label: 'Tokens & Cost', description: 'Budgets and the AI cost lifecycle.' },
  { key: 'schedules', label: 'Schedules', description: 'Scheduling policy for recurring work.' },
  {
    key: 'integrations',
    label: 'Integrations & Connections',
    personalLabel: 'My Connections',
    description: 'Connected systems and their health.',
  },
  {
    key: 'knowledge',
    label: 'Knowledge & Data',
    description: 'Approved sources and data controls.',
  },
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
  { key: 'audit', label: 'Audit & Activity', description: 'Searchable audit trail.' },
  { key: 'billing', label: 'Billing', description: 'Plan and invoices.' },
  { key: 'appearance', label: 'Appearance', description: 'Branding and accessibility.' },
  {
    key: 'uboss',
    label: 'UBoss Profile Search Policy',
    description: 'Cross-company lookup policy, by UBoss Unique ID.',
  },
  {
    key: 'performance',
    label: 'Performance & Reward Policy',
    description: 'Scoring, badge thresholds and reward eligibility.',
  },
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
): NavGroup[] {
  if (visibleModules === null || visibleModules === undefined) return [...groups];

  const visible = new Set(visibleModules);

  return groups
    .map((group) => ({
      group: group.group,
      // `users` and `roles` are the two nav keys that are also module keys, so a plain lookup
      // covers every item. An item whose key is not a module — none today — would be kept, which
      // is the same fail-open direction as above.
      items: group.items.filter((item) => visible.has(item.key)),
    }))
    .filter((group) => group.items.length > 0);
}
