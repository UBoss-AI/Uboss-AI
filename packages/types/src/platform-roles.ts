import {
  PLATFORM_MODULES,
  type Action,
  type ModuleKey,
  type PermissionSet,
  type PlatformModuleKey,
} from './authorization.js';
import { PLATFORM_PERMISSIONS } from './role-templates.js';

/**
 * Platform roles — who among platform staff may do what in the Master Console.
 *
 * ## The gap this closes
 *
 * Until Prompt 9, `isPlatformActor` was a single boolean on `users`, and any platform actor was
 * granted the whole of {@link PLATFORM_PERMISSIONS}: all fifteen modules, with `Administer` on
 * nearly all of them. A `@RequirePermission({ module: 'plans', action: 'Administer' })` on a
 * Master Console route was therefore **decorative** — it could not refuse anybody who had got
 * that far. The client asked for platform-role guards, and this is what makes them real.
 *
 * ## Why these five roles, and why that is not inventing vocabulary
 *
 * Each role is a **strict subset of `PLATFORM_PERMISSIONS`**, which is itself derived from the
 * client's approved fifteen platform modules and fourteen actions. No role introduces a module,
 * an action, or a capability that did not already exist — the decomposition only takes things
 * away. `sanitisePlatformRole` enforces that at module load, so a future edit cannot widen one
 * by accident.
 *
 * `PlatformAdmin` is the role the client's own UI names ("Dibyanshu (Platform) · Platform
 * Admin"), and it deliberately keeps **exactly** today's behaviour — the full set. That is what
 * makes this change safe to ship: nothing an existing platform actor could do stops working, and
 * the narrower roles become available for least-privilege use.
 *
 * The four narrower roles follow the client's own grouping of the Master Console navigation —
 * Platform, Commercial, AI Platform, Operate — rather than a structure invented here:
 *
 *   * `PlatformOwner` is the only role that may change **Platform Settings** and **Release &
 *     Feature Control**. Those two decide what the product *is* for every customer at once, so
 *     they are separated from day-to-day company administration on purpose.
 *   * `PlatformCommercial` covers Commercial (plans, billing, AI allowance) and can read
 *     companies. It cannot touch security, releases or provisioning.
 *   * `PlatformSupport` covers Support & Operations and can read companies. It is the role a
 *     support engineer holds, and it deliberately **cannot** administer anything commercial or
 *     security-related — a support engineer who needs a customer's data uses break-glass
 *     (ADR-048), which is audited and needs a second person.
 *   * `PlatformSecurity` covers Security & Audit with `Administer`, and reads everything else.
 *     A security reviewer must be able to see the whole platform and change none of it.
 *   * `PlatformEngineer` covers AI Platform and Operate — providers, skills, testing, dev-ops,
 *     system health. It can read releases and **not** control them, because deciding what ships
 *     to customers is a different decision from building it.
 *
 * **This decomposition is a UBoss-side proposal and is recorded as an open question** in
 * `docs/SECURITY_DECISIONS.md`: the client named one platform role, and a real support
 * organisation will have opinions about the rest. It is code rather than data for the same
 * reason as the company templates (ADR-038) — a built-in role's meaning must be the same
 * everywhere, and changing it should be a reviewed deploy.
 */

export const PLATFORM_ROLE_KINDS = [
  'PlatformOwner',
  'PlatformAdmin',
  'PlatformCommercial',
  'PlatformSupport',
  'PlatformSecurity',
  'PlatformEngineer',
] as const;

export type PlatformRoleKind = (typeof PLATFORM_ROLE_KINDS)[number];

export interface PlatformRoleTemplate {
  kind: PlatformRoleKind;
  label: string;
  /** One sentence a permissions screen can show. */
  summary: string;
  permissions: PermissionSet;
}

const READ: readonly Action[] = ['View'];
const READ_EXPORT: readonly Action[] = ['View', 'Export'];
const OPERATE: readonly Action[] = ['View', 'Comment', 'Create', 'EditDraft'];
const ADMINISTER: readonly Action[] = [
  'View',
  'Comment',
  'Create',
  'EditDraft',
  'Export',
  'Administer',
  'Audit',
];

/** Every platform module, read-only. The floor every platform role stands on. */
function readAcrossPlatform(): Record<string, readonly Action[]> {
  return Object.fromEntries(PLATFORM_MODULES.map((module) => [module, READ]));
}

/**
 * Refuse a role that grants anything `PLATFORM_PERMISSIONS` does not.
 *
 * Runs at module load, so widening a platform role by accident is a **startup failure** rather
 * than a privilege that ships. This is the platform-plane equivalent of the Prompt 7 rule that a
 * custom role cannot exceed its creator's matrix, applied to code instead of data — and it is
 * the reason the decomposition above can be trusted to only ever subtract.
 */
function sanitisePlatformRole(kind: PlatformRoleKind, permissions: PermissionSet): PermissionSet {
  const safe: Record<string, readonly Action[]> = {};

  for (const [module, actions] of Object.entries(permissions)) {
    const ceiling = PLATFORM_PERMISSIONS[module as ModuleKey];
    if (!ceiling) {
      throw new Error(
        `Platform role ${kind} names module "${module}", which is not a platform module. ` +
          'A platform role can only ever be a subset of PLATFORM_PERMISSIONS.',
      );
    }
    const excess = actions.filter((action) => !ceiling.includes(action));
    if (excess.length > 0) {
      throw new Error(
        `Platform role ${kind} grants ${excess.join(', ')} on "${module}", which ` +
          'PLATFORM_PERMISSIONS does not. A platform role may only subtract.',
      );
    }
    safe[module] = actions;
  }

  return safe as PermissionSet;
}

/**
 * The ceiling with specific modules narrowed.
 *
 * The opposite construction from {@link role}: start from everything and take things away. Used
 * for `PlatformAdmin`, where the role is *defined* as "the full set minus these", and where
 * building it up by hand risks dropping an action nobody meant to drop.
 */
function withoutModules(
  ceiling: PermissionSet,
  narrowed: Partial<Record<PlatformModuleKey, readonly Action[]>>,
): PermissionSet {
  return sanitisePlatformRole('PlatformAdmin', {
    ...(ceiling as Record<string, readonly Action[]>),
    ...narrowed,
  } as PermissionSet);
}

function role(
  kind: PlatformRoleKind,
  label: string,
  summary: string,
  overrides: Partial<Record<PlatformModuleKey, readonly Action[]>>,
): PlatformRoleTemplate {
  return {
    kind,
    label,
    summary,
    permissions: sanitisePlatformRole(kind, {
      ...readAcrossPlatform(),
      ...overrides,
    } as PermissionSet),
  };
}

export const PLATFORM_ROLE_TEMPLATES: Record<PlatformRoleKind, PlatformRoleTemplate> = {
  /**
   * Platform Owner — the only role that may change what the product is.
   *
   * Identical to `PlatformAdmin` plus `platform-settings` and `release`. Those two are separated
   * because a global default or a feature flag changes every customer at once, which is a
   * different kind of decision from administering one company.
   */
  PlatformOwner: {
    kind: 'PlatformOwner',
    label: 'Platform Owner',
    summary: 'Everything, including global settings and feature releases.',
    permissions: PLATFORM_PERMISSIONS,
  },

  /**
   * Platform Admin — the role the client's UI names.
   *
   * Everything **except** the two global controls. Company provisioning, plans, billing,
   * support, security review and operations are all here, so this is the role most platform
   * staff hold and the one existing platform actors are migrated to.
   */
  PlatformAdmin: {
    kind: 'PlatformAdmin',
    label: 'Platform Admin',
    summary:
      'Administers companies, commercial terms and operations. Not global settings or releases.',
    // Derived from the ceiling by **subtraction**, not listed by addition.
    //
    // This matters more than it looks. The Prompt 9 migration backfills every existing platform
    // actor to this role, so `PlatformAdmin` must be exactly the old blanket grant minus the
    // controls that are being separated out — otherwise the backfill is a silent downgrade of
    // somebody's working access. Listing it by hand meant an action the uniform ceiling happens
    // to include (`Comment` on the dashboard, say) could be dropped by accident; a unit test
    // caught precisely that. Subtracting from the ceiling makes the relationship structural.
    permissions: withoutModules(PLATFORM_PERMISSIONS, {
      // Read-only: a feature flag and a global default change the product for every customer at
      // once, which is a different decision from administering one company.
      release: READ,
      'platform-settings': READ,
      // Reads and exports the security plane; administering it is the Security role's job.
      security: READ_EXPORT,
    }),
  },

  /** Commercial — plans, billing and AI allowance. Reads companies, changes nothing else. */
  PlatformCommercial: role(
    'PlatformCommercial',
    'Platform Commercial',
    'Owns plans, billing and AI allowance. Reads companies; administers nothing else.',
    {
      plans: ADMINISTER,
      billing: ADMINISTER,
      credits: ADMINISTER,
      companies: READ_EXPORT,
    },
  ),

  /**
   * Support — tenant support and operational tasks.
   *
   * Reads companies and administers Support & Operations. It cannot administer anything
   * commercial or security-related, and it has no route into a customer's data: that is
   * break-glass, which needs a second person and is audited (ADR-048).
   */
  PlatformSupport: role(
    'PlatformSupport',
    'Platform Support',
    'Handles tenant support and operational tasks. No commercial or security administration.',
    {
      support: ADMINISTER,
      companies: READ,
      'system-health': READ,
    },
  ),

  /**
   * Security — the platform's security posture and audit.
   *
   * `Administer` on `security` and `Audit`/`Export` breadth elsewhere, and **read-only on
   * everything else**. A security reviewer must be able to see the whole platform and change
   * none of it, which is the same reasoning as the company `Auditor` template.
   */
  PlatformSecurity: role(
    'PlatformSecurity',
    'Platform Security',
    'Reviews platform security and audit. Sees everything, changes only security.',
    {
      security: PLATFORM_PERMISSIONS['security'] as readonly Action[],
      companies: READ_EXPORT,
      support: READ_EXPORT,
      'system-health': READ,
      'dev-ops': READ_EXPORT,
    },
  ),

  /**
   * Engineer — the AI platform and operations.
   *
   * Providers, skills, testing, dev-ops and system health. Reads `release` and cannot control
   * it: deciding what ships to customers is a different decision from building it, and keeping
   * them apart is what makes a staged rollout a decision rather than a deploy artefact.
   */
  PlatformEngineer: role(
    'PlatformEngineer',
    'Platform Engineer',
    'Runs the AI platform and operations. Reads releases; does not control them.',
    {
      providers: ADMINISTER,
      skills: ADMINISTER,
      testing: ADMINISTER,
      'dev-ops': ADMINISTER,
      'system-health': OPERATE,
      release: READ,
    },
  ),
};

/**
 * Union the permissions of several platform roles.
 *
 * A person may hold more than one — a security reviewer who also handles support, say — and the
 * union is the right composition for the same reason it is on the company side: holding two
 * roles must not be more restrictive than holding either one alone, or nobody would accept the
 * second.
 */
export function unionPlatformPermissions(kinds: readonly PlatformRoleKind[]): PermissionSet {
  const merged: Record<string, Action[]> = {};

  for (const kind of kinds) {
    for (const [module, actions] of Object.entries(PLATFORM_ROLE_TEMPLATES[kind].permissions)) {
      const existing = merged[module] ?? [];
      for (const action of actions) {
        if (!existing.includes(action)) {
          existing.push(action);
        }
      }
      merged[module] = existing;
    }
  }

  return merged as PermissionSet;
}

// ---------------------------------------------------------------------------
// Navigation keys are not module keys
// ---------------------------------------------------------------------------

/**
 * `MASTER_NAV` key → platform module key.
 *
 * These are **not** the same vocabulary, and two of them differ: the navigation says `dashboard`
 * and `health` where the module set says `platform-dashboard` and `system-health`. The
 * navigation model came from the client's UI prototype and the module set from the client's
 * permission list, and neither is wrong — but filtering navigation by permission without this
 * map would silently hide the Dashboard and System Health from **everyone**, because no module
 * named `dashboard` exists.
 *
 * Mapped rather than renamed: the navigation keys are part of the locked UI reference, and the
 * module keys are part of the approved authorization vocabulary. Changing either to match the
 * other would be editing a client-supplied list to suit our code.
 */
export const MASTER_NAV_MODULE: Record<string, PlatformModuleKey> = {
  dashboard: 'platform-dashboard',
  companies: 'companies',
  'create-company': 'create-company',
  plans: 'plans',
  billing: 'billing',
  credits: 'credits',
  providers: 'providers',
  skills: 'skills',
  testing: 'testing',
  release: 'release',
  'dev-ops': 'dev-ops',
  support: 'support',
  security: 'security',
  health: 'system-health',
  'platform-settings': 'platform-settings',
};

/**
 * The platform module a Master Console navigation key needs `View` on.
 *
 * Returns `undefined` for an unmapped key, and callers must **hide** such an item rather than
 * show it: a new navigation entry with no module mapping is unguarded, and failing closed here
 * turns that into a visible missing item instead of an open door.
 */
export function moduleForMasterNavKey(key: string): PlatformModuleKey | undefined {
  return MASTER_NAV_MODULE[key];
}
