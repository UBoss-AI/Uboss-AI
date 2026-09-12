import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  MASTER_NAV_MODULE,
  PLATFORM_MODULES,
  PLATFORM_PERMISSIONS,
  PLATFORM_ROLE_KINDS,
  PLATFORM_ROLE_TEMPLATES,
  moduleForMasterNavKey,
  unionPlatformPermissions,
  type Action,
  type PlatformRoleKind,
} from '@uboss/types';

import { PlatformConsoleService } from '../src/platform/platform-console.service.js';
import type { CompanyOverviewRow } from '../src/persistence/platform.repository.js';

/**
 * Platform roles and the dashboard's derivation, without a database.
 *
 * Two things are proved here that a request-layer test cannot prove cheaply: that **no platform
 * role can exceed the platform ceiling** (the property the whole decomposition rests on), and
 * that the attention-flag precedence is exactly what the product intends for every combination.
 */

const actionsFor = (kind: PlatformRoleKind, module: string): readonly Action[] =>
  (PLATFORM_ROLE_TEMPLATES[kind].permissions as Record<string, readonly Action[]>)[module] ?? [];

describe('platform roles — the ceiling', () => {
  it('defines every role in the union', () => {
    for (const kind of PLATFORM_ROLE_KINDS) {
      assert.ok(PLATFORM_ROLE_TEMPLATES[kind], `${kind} has no template.`);
      assert.equal(PLATFORM_ROLE_TEMPLATES[kind].kind, kind);
      assert.ok(PLATFORM_ROLE_TEMPLATES[kind].summary.length > 20, `${kind} needs a real summary.`);
    }
  });

  it('never grants anything PLATFORM_PERMISSIONS does not', () => {
    // The property the decomposition rests on: a platform role may only ever **subtract**. If
    // this fails, a role has become a privilege-escalation path rather than a restriction —
    // which is the exact opposite of why the roles exist.
    for (const kind of PLATFORM_ROLE_KINDS) {
      for (const [module, actions] of Object.entries(PLATFORM_ROLE_TEMPLATES[kind].permissions)) {
        const ceiling = (PLATFORM_PERMISSIONS as Record<string, readonly Action[]>)[module];
        assert.ok(ceiling, `${kind} names "${module}", which is not a platform module.`);
        for (const action of actions) {
          assert.ok(
            ceiling.includes(action),
            `${kind} grants ${action} on ${module}, which the platform ceiling does not.`,
          );
        }
      }
    }
  });

  it('names no company module', () => {
    // A platform role governing a company module would blur the two planes: the Master Console
    // administers the platform, and a company's own modules are governed by company roles.
    const platform = new Set<string>(PLATFORM_MODULES);
    for (const kind of PLATFORM_ROLE_KINDS) {
      for (const module of Object.keys(PLATFORM_ROLE_TEMPLATES[kind].permissions)) {
        assert.ok(platform.has(module), `${kind} names non-platform module "${module}".`);
      }
    }
  });

  it('lets every role read every module, so nothing is invisible to platform staff', () => {
    // A platform operator who cannot even *see* that a module exists cannot reason about the
    // platform they run. Read is the floor; the roles differ in what they may change.
    for (const kind of PLATFORM_ROLE_KINDS) {
      for (const module of PLATFORM_MODULES) {
        assert.ok(actionsFor(kind, module).includes('View'), `${kind} cannot even view ${module}.`);
      }
    }
  });
});

describe('platform roles — who may change what', () => {
  it('makes PlatformOwner the only role that can change global settings or releases', () => {
    // The central separation in the design. `release` and `platform-settings` change the product
    // for every customer at once, which is categorically different from administering one
    // company — so `PlatformAdmin`, who can do nearly everything else, deliberately cannot.
    for (const module of ['platform-settings', 'release'] as const) {
      const administers = PLATFORM_ROLE_KINDS.filter((kind) =>
        actionsFor(kind, module).includes('Administer'),
      );
      assert.deepEqual(
        administers,
        ['PlatformOwner'],
        `Exactly PlatformOwner should administer ${module}; got ${administers.join(', ')}.`,
      );
    }
  });

  it('keeps PlatformAdmin equal to the old blanket grant apart from those two modules', () => {
    // This is what made the Prompt 9 change safe to ship: the migration backfills every existing
    // platform actor to `PlatformAdmin`, so nothing that worked before can stop working. If this
    // test fails, the backfill has silently become a downgrade.
    for (const module of PLATFORM_MODULES) {
      if (module === 'platform-settings' || module === 'release') {
        continue;
      }
      const admin = actionsFor('PlatformAdmin', module);
      const ceiling = (PLATFORM_PERMISSIONS as Record<string, readonly Action[]>)[module] ?? [];
      // `security` is the one narrowing: an administrator reads and exports the security plane
      // but does not administer it, which is the Security role's job.
      if (module === 'security') {
        assert.ok(!admin.includes('Administer'), 'PlatformAdmin must not administer security.');
        assert.ok(admin.includes('Export'));
        continue;
      }
      for (const action of ceiling) {
        assert.ok(
          admin.includes(action),
          `PlatformAdmin lost ${action} on ${module}; the migration backfill would be a downgrade.`,
        );
      }
    }
  });

  it('gives PlatformSecurity administration of security and nothing else', () => {
    assert.ok(actionsFor('PlatformSecurity', 'security').includes('Administer'));
    const others = PLATFORM_MODULES.filter(
      (module) =>
        module !== 'security' && actionsFor('PlatformSecurity', module).includes('Administer'),
    );
    assert.deepEqual(
      others,
      [],
      `A security reviewer must change nothing else; got ${others.join(', ')}.`,
    );
  });

  it('gives PlatformSupport no commercial or security administration', () => {
    for (const module of ['plans', 'billing', 'credits', 'security', 'release'] as const) {
      assert.ok(
        !actionsFor('PlatformSupport', module).includes('Administer'),
        `PlatformSupport must not administer ${module}.`,
      );
    }
    assert.ok(actionsFor('PlatformSupport', 'support').includes('Administer'));
  });

  it('lets PlatformEngineer read releases without controlling them', () => {
    // Deciding what ships to customers is a different decision from building it.
    assert.ok(actionsFor('PlatformEngineer', 'release').includes('View'));
    assert.ok(!actionsFor('PlatformEngineer', 'release').includes('Administer'));
    assert.ok(actionsFor('PlatformEngineer', 'providers').includes('Administer'));
  });

  it('unions the permissions of several held roles', () => {
    const union = unionPlatformPermissions(['PlatformSupport', 'PlatformSecurity']);
    const security = (union as Record<string, readonly Action[]>)['security'] ?? [];
    const support = (union as Record<string, readonly Action[]>)['support'] ?? [];

    // Holding two roles must never be more restrictive than holding either alone, or nobody
    // would accept the second.
    assert.ok(security.includes('Administer'), 'The Security role brings security:Administer.');
    assert.ok(support.includes('Administer'), 'The Support role brings support:Administer.');
  });

  it('returns an empty set for no roles, which is what makes the guards fail closed', () => {
    assert.deepEqual(unionPlatformPermissions([]), {});
  });
});

describe('master navigation keys map to platform modules', () => {
  it('maps every navigation key, including the two that differ', () => {
    // Without this map, filtering navigation by permission would hide the Dashboard and System
    // Health from everyone, because no module named `dashboard` or `health` exists.
    assert.equal(moduleForMasterNavKey('dashboard'), 'platform-dashboard');
    assert.equal(moduleForMasterNavKey('health'), 'system-health');
    assert.equal(moduleForMasterNavKey('companies'), 'companies');
  });

  it('maps to real modules only, and covers all fifteen', () => {
    const platform = new Set<string>(PLATFORM_MODULES);
    const mapped = Object.values(MASTER_NAV_MODULE);
    for (const module of mapped) {
      assert.ok(platform.has(module), `"${module}" is not a platform module.`);
    }
    assert.equal(new Set(mapped).size, PLATFORM_MODULES.length, 'Every module needs a nav key.');
  });

  it('returns undefined for an unmapped key, so a new item fails closed', () => {
    // A navigation entry with no module mapping is unguarded. Returning nothing makes the console
    // hide it, which turns an open door into a visibly missing item.
    assert.equal(moduleForMasterNavKey('not-a-module'), undefined);
  });
});

// ---------------------------------------------------------------------------
// The dashboard's derivation
// ---------------------------------------------------------------------------

const BASE: CompanyOverviewRow = {
  tenantId: '018f0000-0000-7000-8000-000000000001',
  slug: 'acme',
  name: 'Acme',
  legalName: 'Acme Ltd',
  lifecycleState: 'Active',
  createdAt: new Date('2026-01-01T00:00:00.000Z'),
  seatsUsed: 10,
  membershipsTotal: 12,
  planCode: 'growth',
  planName: 'Growth',
  planTier: 'Growth',
  seatsLicensed: 40,
  subscriptionState: 'Active',
  billingState: 'Current',
  renewsAt: new Date(Date.now() + 200 * 86_400_000),
  aiAllowanceMinor: 100_000,
  aiConsumedMinor: 10_000,
  currency: 'USD',
  pinnedFlag: 'None',
  criticalSecurityEvents: 0,
  breakGlassPendingNotification: 0,
  breakGlassActive: 0,
  openServiceAlerts: 0,
};

const summarise = (overrides: Partial<CompanyOverviewRow>) =>
  PlatformConsoleService.summarise({ ...BASE, ...overrides });

describe('company attention flags', () => {
  it('flags nothing for a healthy company', () => {
    const row = summarise({});
    assert.equal(row.flag, 'None');
    assert.deepEqual(row.attentionReasons, []);
  });

  it('renders the reference’s seats and usage labels', () => {
    const row = summarise({ seatsUsed: 42, seatsLicensed: 60, aiConsumedMinor: 68_000 });
    assert.equal(row.seatsLabel, '42 / 60');
    assert.equal(row.aiUsageLabel, '68%');
  });

  it('shows an em dash for licensed seats and usage when there is no plan', () => {
    // A company with no subscription is a real state — an em dash rather than a zero, because
    // "not on a plan" and "zero seats" are different things.
    const row = summarise({ seatsLicensed: null, aiAllowanceMinor: 0, aiConsumedMinor: 0 });
    assert.equal(row.seatsLabel, '10 / —');
    assert.equal(row.aiUsageLabel, '—');
    assert.equal(row.aiUsagePercent, null);
  });

  it('flags Billing for overdue and for grace', () => {
    assert.equal(summarise({ billingState: 'Overdue' }).flag, 'Billing');
    assert.equal(summarise({ billingState: 'Grace' }).flag, 'Billing');
  });

  it('flags Budget once the allowance passes the threshold, and not before', () => {
    assert.equal(summarise({ aiConsumedMinor: 84_000 }).flag, 'None');
    assert.equal(summarise({ aiConsumedMinor: 85_000 }).flag, 'Budget');
    assert.equal(summarise({ aiConsumedMinor: 91_000 }).flag, 'Budget');
  });

  it('flags Seats at 90% of licensed', () => {
    assert.equal(summarise({ seatsUsed: 35, seatsLicensed: 40 }).flag, 'None');
    assert.equal(summarise({ seatsUsed: 36, seatsLicensed: 40 }).flag, 'Seats');
  });

  it('flags Renewal inside the window and reports a past renewal as overdue', () => {
    const soon = summarise({ renewsAt: new Date(Date.now() + 10 * 86_400_000) });
    assert.equal(soon.flag, 'Renewal');
    assert.ok(soon.attentionReasons.some((reason) => reason.includes('Renews in')));

    const past = summarise({ renewsAt: new Date(Date.now() - 12 * 86_400_000) });
    assert.ok(past.attentionReasons.some((reason) => reason.includes('was due')));
    assert.equal(past.daysToRenewal !== null && past.daysToRenewal < 0, true);
  });

  it('puts Security above every commercial flag', () => {
    // The precedence that matters: a commercial problem gets worse slowly and a security one
    // does not. Each of these companies has a billing problem too, and Security still wins.
    assert.equal(
      summarise({ billingState: 'Overdue', criticalSecurityEvents: 1 }).flag,
      'Security',
    );
    assert.equal(summarise({ billingState: 'Overdue', breakGlassActive: 1 }).flag, 'Security');
    assert.equal(
      summarise({ billingState: 'Overdue', breakGlassPendingNotification: 1 }).flag,
      'Security',
    );
  });

  it('treats an un-notified break-glass record as a security signal in its own right', () => {
    const row = summarise({ breakGlassPendingNotification: 2 });
    assert.equal(row.flag, 'Security');
    assert.ok(
      row.attentionReasons.some((reason) => reason.includes('customer has not been notified')),
      'The outstanding notification obligation must be stated, not just counted.',
    );
  });

  it('lets a pinned flag beat the derivation, and says it was pinned', () => {
    // If an operator has said "this one is a Security matter", the derivation does not get to
    // disagree — but the reader must be able to tell a pinned flag from a derived one.
    const row = summarise({ pinnedFlag: 'Security', billingState: 'Current' });
    assert.equal(row.flag, 'Security');
    assert.ok(row.attentionReasons[0]?.includes('Pinned by a platform operator'));
  });

  it('collects every reason even though only one flag shows', () => {
    const row = summarise({
      billingState: 'Overdue',
      aiConsumedMinor: 95_000,
      seatsUsed: 39,
      seatsLicensed: 40,
      renewsAt: new Date(Date.now() + 5 * 86_400_000),
      criticalSecurityEvents: 2,
    });
    assert.equal(row.flag, 'Security');
    // Dropping the others would make the console lie by omission; the detail screen shows them.
    assert.ok(row.attentionReasons.length >= 5, `only ${row.attentionReasons.length} reason(s)`);
  });

  it('reports a suspended company even when nothing else is wrong', () => {
    const row = summarise({ lifecycleState: 'Suspended', billingState: 'Current' });
    assert.ok(row.attentionReasons.some((reason) => reason.includes('suspended')));
  });
});
