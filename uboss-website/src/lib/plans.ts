/**
 * The plans, as the platform is actually configured.
 *
 * Every seat count and every module list below was read from the running `plans` table, not
 * written for the website:
 *
 *   select code, seat_limit, ai_allowance_minor, entitled_modules from plans order by price_minor;
 *
 * ## Why there are no prices here
 *
 * The plans carry prices in the product, and they are denominated in US dollars while the company
 * they are sold to is priced in rupees. Publishing the dollar figure would put a number on the
 * website that the invoice will not match, and converting it here would mean inventing an exchange
 * rate on a marketing page. Neither is a price — so the page asks for a conversation and says so
 * plainly, and the moment the rupee figures are set they go in `price` below and the page prints
 * them.
 *
 * That is not a placeholder standing in for work. A wrong price is the one thing on a pricing page
 * that costs something to get wrong.
 *
 * ## Why Pilot includes no AI
 *
 * Its allowance is zero, deliberately and enforced in the product: a free plan carrying an AI
 * allowance is UBoss buying tokens from a provider and giving them away, per company, every month.
 * A trial company gets the whole product and buys its AI, or is granted a top-up by hand. The page
 * says this rather than hiding it, because somebody who discovers it after signing up feels misled
 * and somebody who reads it here does not.
 */

export interface Plan {
  code: string;
  name: string;
  /** What this plan is for, in one line. */
  purpose: string;
  /** Licensed seats, or null where the number is negotiated. */
  seats: number | null;
  /** Whether the plan includes a monthly AI allowance. */
  includesAi: boolean;
  /** The price, once the rupee figures are agreed. Null means the page asks instead. */
  price: string | null;
  /** The modules a company on this plan can see. Read from `entitled_modules`. */
  modules: readonly string[];
  /** What somebody gets that the plan below does not give them. */
  adds: readonly string[];
  cta: string;
  featured: boolean;
}

/** The module keys as the product names them, with the words a buyer would use. */
export const MODULE_LABELS: Record<string, string> = {
  dashboard: 'Dashboard',
  hierarchy: 'Org chart and reporting lines',
  objective: 'Objectives',
  'agent-builder': 'Agent Builder',
  todo: 'To-do List',
  agents: 'Engine Agents',
  executor: 'Executor Agent',
  approvals: 'Approvals',
  performance: 'Performance and badges',
  reports: 'Reports',
  users: 'Users and access',
  roles: 'Custom roles',
  'profile-search': 'UBoss Profile Search',
  settings: 'Settings',
};

export const PLANS: readonly Plan[] = [
  {
    code: 'pilot',
    name: 'Pilot',
    purpose: 'See the product with your own company in it, before you buy anything.',
    seats: 1,
    includesAi: false,
    price: null,
    modules: ['dashboard', 'hierarchy', 'objective', 'todo', 'settings'],
    adds: [
      'The whole workspace, with a worked example already in it',
      'One seat — yours. A Pilot is for seeing the product, not for running a team on it',
      'No AI allowance, so it costs nothing and nothing runs',
    ],
    cta: 'Start a pilot',
    featured: false,
  },
  {
    code: 'starter',
    name: 'Starter',
    purpose: 'One team running its work through UBoss, with AI included.',
    seats: 10,
    includesAi: true,
    price: null,
    modules: ['dashboard', 'hierarchy', 'objective', 'todo', 'profile-search', 'settings'],
    adds: [
      'A monthly AI allowance in UBoss Tokens, included',
      'UBoss Profile Search for checking somebody’s history before you hire',
      'Ten seats',
    ],
    cta: 'Start with Starter',
    featured: false,
  },
  {
    code: 'growth',
    name: 'Growth',
    purpose: 'The whole product: agents you build, work they run, people who approve it.',
    seats: 40,
    includesAi: true,
    price: null,
    modules: [
      'dashboard',
      'hierarchy',
      'objective',
      'agent-builder',
      'todo',
      'agents',
      'executor',
      'approvals',
      'reports',
      'users',
      'profile-search',
      'settings',
    ],
    adds: [
      'Agent Builder, and the Engine Agents you build with it',
      'The Executor Agent, which watches execution and raises exceptions',
      'Approvals, so work stops where a person has to decide',
      'Reports, and the access screens to run the company',
      'Forty seats and a larger monthly allowance',
    ],
    cta: 'Start with Growth',
    featured: true,
  },
  {
    code: 'enterprise',
    name: 'Enterprise',
    purpose: 'Everything, with the seats, allowance and controls agreed with you.',
    seats: null,
    includesAi: true,
    price: null,
    modules: [
      'dashboard',
      'hierarchy',
      'objective',
      'agent-builder',
      'todo',
      'agents',
      'executor',
      'approvals',
      'performance',
      'reports',
      'users',
      'roles',
      'profile-search',
      'settings',
    ],
    adds: [
      'Custom roles — permission sets you write yourself, inside your own ceiling',
      'Performance and badges across the company',
      'Seats and allowance negotiated rather than fixed',
    ],
    cta: 'Start with Enterprise',
    featured: false,
  },
];

/**
 * The comparison, built from the plans above rather than typed a second time.
 *
 * A hand-written comparison table is the row that says "Reports ✓" for a plan whose module list
 * does not include it — and nobody finds that until a customer does. Every cell here is derived.
 */
export const COMPARED_MODULES: readonly string[] = [
  'objective',
  'todo',
  'hierarchy',
  'agent-builder',
  'agents',
  'executor',
  'approvals',
  'reports',
  'users',
  'roles',
  'performance',
  'profile-search',
];
