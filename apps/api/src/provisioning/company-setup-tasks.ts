/**
 * The company setup checklist, verbatim from the client's approved documents.
 *
 * Source: `UBoss_Final_1_Latest_Client_Approved.docx` §33 "Client Company Admin — First Login &
 * Setup Checklist". The order, the titles and the `rationale` (the client's "why it comes here"
 * column) are all theirs — nothing here is invented, which matters because a checklist is the
 * first thing a new customer's administrator reads and its ordering encodes the client's own view
 * of how a workspace should be brought up.
 *
 * ## Why this is code and not a seed
 *
 * The same list has to be created by two paths — the migration backfills existing companies, and
 * provisioning creates it for new ones. Defined once here and used by provisioning; the migration
 * carries the same rows in SQL because a migration cannot import TypeScript. `company-setup.e2e`
 * asserts the two agree, so the duplication cannot drift silently.
 *
 * ## Why a table rather than a derived view
 *
 * The client's list mixes what the system can detect ("build departments and reporting
 * hierarchy") with what only a person can assert ("run readiness review and mark workspace ready
 * for managers"). A derived checklist cannot represent the second kind, and one that silently
 * ticks itself is one nobody trusts.
 */
export interface CompanySetupTaskDefinition {
  key: string;
  position: number;
  title: string;
  /** The client's "why it comes here". Shown, because a checklist without reasons is chores. */
  rationale: string;
  /** Where the work happens. Null for the final item, which is asserted rather than navigated. */
  targetRoute: string | null;
}

export const COMPANY_SETUP_TASKS: readonly CompanySetupTaskDefinition[] = [
  {
    key: 'company_profile',
    position: 1,
    title: 'Confirm company profile, timezone, locale and branding.',
    rationale: 'Every date/schedule and visible company identity depends on these defaults.',
    targetRoute: '/settings/general',
  },
  {
    key: 'hierarchy',
    position: 2,
    title: 'Build departments and reporting hierarchy.',
    rationale: 'Objectives and work assignment need real internal people/manager relationships.',
    targetRoute: '/hierarchy',
  },
  {
    key: 'roles',
    position: 3,
    title: 'Configure roles, scope, module visibility and allowed actions.',
    rationale: 'Prevents overexposure before users activate.',
    targetRoute: '/settings/roles',
  },
  {
    key: 'employee_profiles',
    position: 4,
    title: 'Create internal employee profiles.',
    rationale: 'People can be planned/assigned even before invitation.',
    targetRoute: '/hierarchy',
  },
  {
    key: 'invite_users',
    position: 5,
    title: 'Invite internal users from Settings -> Users & Access.',
    rationale: 'Activates login without duplicating hierarchy identities.',
    targetRoute: '/settings/users',
  },
  {
    key: 'guests',
    position: 6,
    title: 'Add external guests only when required.',
    rationale: 'Guests stay outside hierarchy.',
    targetRoute: '/settings/users',
  },
  {
    key: 'ai_policy',
    position: 7,
    title: 'Review AI Providers, Skills & AI, Token/Cost policy.',
    rationale: 'Controls which AI capabilities and budget are available.',
    targetRoute: '/settings/ai-providers',
  },
  {
    key: 'connections',
    position: 8,
    title: 'Connect approved company systems.',
    rationale: 'Agents need governed connections rather than raw credentials.',
    targetRoute: '/settings/integrations',
  },
  {
    key: 'governance_defaults',
    position: 9,
    title: 'Set approvals, notifications, escalation and schedule defaults.',
    rationale: 'Operational work gets predictable governance.',
    targetRoute: '/settings/notifications',
  },
  {
    key: 'readiness_review',
    position: 10,
    title: 'Run readiness review and mark workspace ready for managers.',
    rationale: 'Objective publishing can begin safely.',
    // No route: the client's final item is an assertion a person makes about the whole
    // workspace, not a screen they visit.
    targetRoute: null,
  },
];
