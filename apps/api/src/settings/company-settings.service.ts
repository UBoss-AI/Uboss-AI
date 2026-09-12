import { BadRequestException, ConflictException, Injectable } from '@nestjs/common';

import {
  SETTING_DEFINITIONS,
  SETTINGS_CATEGORIES,
  settingDefinition,
  validateSetting,
  validateSettingCombination,
  type SettingDefinition,
  type SettingsCategory,
  type SettingValue,
} from '@uboss/types';

import { AuditEventService } from '../audit/audit-event.service.js';
import {
  AuthorizationService,
  type AuthorizationContext,
} from '../authorization/authorization.service.js';
import { PlatformRepository } from '../persistence/platform.repository.js';
import { PrismaService } from '../persistence/prisma.service.js';
import type { TenantScope } from '../persistence/tenant-context.js';

/** Where an effective value came from. Shown, so a screen never implies a company chose it. */
export type SettingSource = 'company' | 'platform' | 'default';

export interface ResolvedSetting {
  key: string;
  category: SettingsCategory;
  label: string;
  description: string;
  type: SettingDefinition['type'];
  value: SettingValue;
  /** Which of the three layers supplied the value. */
  source: SettingSource;
  defaultValue: SettingValue;
  material: boolean;
  /** Whether **this caller** may change it. The server's answer, not the screen's guess. */
  editable: boolean;
}

export interface SettingsCategoryView {
  key: SettingsCategory;
  /** Every setting in this category the caller may read. */
  settings: ResolvedSetting[];
  /** True when the caller may change at least one setting here. */
  anyEditable: boolean;
  /**
   * Present when a category has no settings of its own yet.
   *
   * The client asked for the full information architecture, so the category still appears —
   * with a panel saying where its configuration actually lives. A category silently missing
   * from the sidebar reads as a permission problem, which is a different and misleading message.
   */
  note?: string;
}

export interface SettingsView {
  /** Only the categories this caller may see. The server decides scope. */
  categories: SettingsCategoryView[];
  /** Which of the 19 were withheld, and how many — stated rather than silently absent. */
  withheldCategories: number;
}

/**
 * Where each category's configuration lives when it is not a row in `company_settings`.
 *
 * Written down rather than left as an empty panel, because "there is nothing here" and "this is
 * configured on another screen" are different messages and only one of them is true.
 */
const CATEGORY_NOTES: Partial<Record<SettingsCategory, string>> = {
  users:
    'Managed on Settings → Users & Access: the three tabs, invitations, guests, suspension, ' +
    'offboarding and bulk operations.',
  roles:
    'Roles and scopes are granted per person and are not a company-wide setting. The role ' +
    'catalogue itself is built-in and identical in every deployment, so it is deliberately not ' +
    'editable here.',
  billing: 'Managed on Settings → Billing: the plan, entitlements, allowance, seats and requests.',
  security:
    'Sign-in policy (password, MFA, SSO) is configured by the platform today, and each person ' +
    'manages their own sessions and second factors under Login & Security.',
  audit: 'The searchable trail is its own screen; there is nothing to configure about it.',
  objective: 'Arrives with the Objective prompts, which define what there is to govern.',
  agent:
    'The company-wide AI mode and budget policy are set at provisioning; per-Agent policy arrives with the Engine Agent prompts.',
  skills: 'Arrives with the Skill Catalog prompt.',
  providers: 'Provider configuration is platform-side until the Model Gateway prompt.',
  tokens:
    'The AI budget guardrails are set at provisioning; per-department allocation arrives with metering.',
  schedules: 'Arrives with the scheduling prompt, alongside the job runner.',
  integrations: 'Arrives with the Integrations & Connections prompt.',
  knowledge: 'Arrives with the Knowledge & Data prompt.',
  uboss: 'Cross-company lookup policy arrives with UBoss Profile Search.',
  performance: 'Arrives with the Performance & Reward prompt.',
};

/**
 * Company settings: the typed store, its inheritance, and the permission behind every value.
 *
 * ## The backend enforces every setting permission
 *
 * The client's rule, verbatim: *Backend enforces every setting permission.* So each setting
 * carries its own read and write permission in the catalogue, and this service checks the
 * **setting's** permission rather than one blanket check for the screen. Two consequences worth
 * being explicit about:
 *
 *   * A category a caller cannot read is **not returned at all** — and the response says how
 *     many were withheld, so a screen shows nothing rather than an empty section that reads as
 *     a bug.
 *   * `editable` is the server's answer per setting. A screen may disable a control on it, and
 *     the write path checks again regardless. **Authorization is never through hidden navigation.**
 *
 * ## Effective inheritance, and why the source is on the wire
 *
 * A value is the company's row, or the platform's default for the same key, or the code default —
 * in that order. `source` is returned with every value because "we chose 24 hours" and "nobody
 * has chosen, so it is 24 hours" are different facts, and a settings screen that shows only the
 * number invites somebody to believe the first.
 *
 * ## Safe defaults mean a company with no rows is fully configured
 *
 * There is no migration backfilling settings and none is needed: a company that has never opened
 * this screen behaves exactly as the catalogue says, and a setting added in a later release
 * works on the day it ships.
 */
@Injectable()
export class CompanySettingsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly platform: PlatformRepository,
    private readonly authorization: AuthorizationService,
    private readonly auditEvents: AuditEventService,
  ) {}

  /** The whole Settings screen, scoped to what this caller may read. */
  async viewFor(scope: TenantScope, userId: string): Promise<SettingsView> {
    const context = await this.authorization.contextFor(scope, userId);
    const platformDefaults = await this.platformDefaults();
    const resolved = await this.resolveAll(scope, context, platformDefaults);

    const categories: SettingsCategoryView[] = [];
    let withheld = 0;

    for (const category of SETTINGS_CATEGORIES) {
      const settings = resolved.filter((setting) => setting.category === category);
      const note = CATEGORY_NOTES[category];

      // A category with settings the caller cannot read is withheld entirely. A category with no
      // settings *of its own* still appears with its note — the difference matters: the first is
      // "you may not see this", the second is "this is configured elsewhere".
      const definitionsHere = SETTING_DEFINITIONS.filter(
        (definition) => definition.category === category,
      );

      if (definitionsHere.length > 0 && settings.length === 0) {
        withheld += 1;
        continue;
      }

      categories.push({
        key: category,
        settings,
        anyEditable: settings.some((setting) => setting.editable),
        ...(note === undefined ? {} : { note }),
      });
    }

    return { categories, withheldCategories: withheld };
  }

  /**
   * One setting's effective value, for code that needs to act on it.
   *
   * No permission check: this is the *internal* accessor other services use to read a policy
   * they are about to apply, and a service enforcing a company's escalation window must not
   * depend on who happens to be signed in. The screen-facing path is `viewFor`, which does check.
   */
  async effectiveValue(scope: TenantScope, key: string): Promise<SettingValue> {
    const definition = settingDefinition(key);
    if (!definition) {
      throw new BadRequestException(`"${key}" is not a setting.`);
    }
    const resolved = await this.resolveOne(scope, definition, await this.platformDefaults());
    return resolved.value;
  }

  /**
   * Change one or more settings.
   *
   * ## Why several at once
   *
   * A settings panel has a Save button, and cross-setting rules exist — escalating before
   * reminding, for instance. Validating one field at a time cannot see those, so a panel would
   * either save an invalid *combination* or check the combination in the browser only. Taking
   * the whole panel means the server validates what the person actually intends.
   *
   * ## Each key's own permission, checked individually
   *
   * A payload mixing a setting the caller may change with one they may not is refused **whole**,
   * naming the key. Applying the permitted half would be a partial save nobody asked for, and
   * silently dropping the other half would tell them their change succeeded.
   */
  async update(input: {
    scope: TenantScope;
    actorUserId: string;
    values: Record<string, unknown>;
    /** Required when any changed setting is material. */
    reason?: string | undefined;
  }): Promise<ResolvedSetting[]> {
    const context = await this.authorization.contextFor(input.scope, input.actorUserId);

    const keys = Object.keys(input.values);
    if (keys.length === 0) {
      throw new BadRequestException('Nothing to change.');
    }

    // 1. Every key must exist in the catalogue. An unknown key is a typo or a stale client, and
    //    accepting it would store a value nothing ever reads.
    const definitions: SettingDefinition[] = [];
    for (const key of keys) {
      const definition = settingDefinition(key);
      if (!definition) {
        throw new BadRequestException(
          `"${key}" is not a setting. Unknown keys are refused rather than stored, because a ` +
            'stored value nothing reads is a setting that appears to work and does not.',
        );
      }
      definitions.push(definition);
    }

    // 2. Every key's own write permission, individually. The whole payload is refused if any
    //    fails, naming the key.
    for (const definition of definitions) {
      const decision = await this.authorization.authorize(context, definition.writePermission);
      if (!decision.allowed) {
        throw new BadRequestException(
          `You cannot change "${definition.label}": it needs ` +
            `${definition.writePermission.module}:${definition.writePermission.action}. ` +
            'The whole change is refused rather than partly applied.',
        );
      }
    }

    // 3. Each value against its declared type.
    const validated = new Map<string, SettingValue>();
    for (const definition of definitions) {
      const result = validateSetting(definition, input.values[definition.key]);
      if (!result.ok) {
        throw new BadRequestException(result.reason);
      }
      validated.set(definition.key, result.value);
    }

    // 4. The combination, against the *effective* values after this change — so a rule between
    //    two settings is checked even when only one of them is being changed.
    const platformDefaults = await this.platformDefaults();
    const current = await this.resolveAll(input.scope, context, platformDefaults, true);
    const effective: Record<string, SettingValue> = {};
    for (const setting of current) {
      effective[setting.key] = setting.value;
    }
    for (const [key, value] of validated) {
      effective[key] = value;
    }

    const combinationProblems = validateSettingCombination(effective);
    if (combinationProblems.length > 0) {
      throw new BadRequestException(combinationProblems.join(' '));
    }

    // 5. A material change needs a reason.
    const material = definitions.filter((definition) => definition.material);
    if (material.length > 0 && !input.reason?.trim()) {
      throw new BadRequestException(
        `${material.map((definition) => definition.label).join(', ')} ` +
          `${material.length === 1 ? 'is a governance setting' : 'are governance settings'} and ` +
          'a change needs a recorded reason. A change nobody can account for is the one that ' +
          'gets disputed at a review.',
      );
    }

    return this.prisma.runInTenantTransaction(input.scope, async () => {
      for (const definition of definitions) {
        const value = validated.get(definition.key) as SettingValue;

        const existing = await this.prisma.client.companySetting.findFirst({
          where: { tenantId: input.scope.tenantId, key: definition.key },
        });

        if (existing) {
          await this.prisma.client.companySetting.update({
            where: { id: existing.id },
            data: {
              value: value as never,
              updatedByUserId: input.actorUserId,
              version: { increment: 1 },
            },
          });
        } else {
          await this.prisma.client.companySetting.create({
            data: {
              tenantId: input.scope.tenantId,
              key: definition.key,
              value: value as never,
              updatedByUserId: input.actorUserId,
            },
          });
        }

        // The version history, for material settings only — see the model comment.
        if (definition.material) {
          await this.prisma.client.companySettingChange.create({
            data: {
              tenantId: input.scope.tenantId,
              key: definition.key,
              ...(existing === null ? {} : { previousValue: existing.value as never }),
              newValue: value as never,
              reason: input.reason?.trim() ?? '',
              changedByUserId: input.actorUserId,
            },
          });
        }

        await this.auditEvents.appendWithinCurrentScope(input.scope.tenantId, {
          action: 'settings.changed',
          resourceType: 'company_setting',
          resourceId: definition.key,
          resourceRef: definition.key,
          actorUserId: input.actorUserId,
          summary: `Changed "${definition.label}".`,
          ...(input.reason?.trim() ? { reason: input.reason.trim() } : {}),
          metadata: {
            key: definition.key,
            category: definition.category,
            material: definition.material,
            // The value itself, because a settings change with no record of what it became is
            // not an audit event anybody can use. These are configuration values, not secrets —
            // the redaction pass still runs over the metadata.
            newValue: String(value),
            hadCompanyValue: existing !== null,
          },
        });
      }

      const refreshed = await this.resolveAll(input.scope, context, platformDefaults);
      return refreshed.filter((setting) => validated.has(setting.key));
    });
  }

  /** The change history for one material setting. `settings:Audit`. */
  async historyFor(input: { scope: TenantScope; actorUserId: string; key: string }): Promise<
    {
      previousValue: string | null;
      newValue: string;
      reason: string;
      changedByUserId: string;
      changedAt: string;
    }[]
  > {
    const definition = settingDefinition(input.key);
    if (!definition) {
      throw new BadRequestException(`"${input.key}" is not a setting.`);
    }

    const context = await this.authorization.contextFor(input.scope, input.actorUserId);
    // Reading who changed a governance setting and why is an audit question, not a settings one.
    await this.authorization.assertCan(context, { module: 'settings', action: 'Audit' });

    if (!definition.material) {
      throw new ConflictException(
        `"${definition.label}" is not a material setting, so no version history is kept for it. ` +
          'The audit trail still records every change. Keeping history for everything would ' +
          'bury the entries that matter.',
      );
    }

    return this.prisma.runInTenantTransaction(input.scope, async () => {
      const rows = await this.prisma.client.companySettingChange.findMany({
        where: { tenantId: input.scope.tenantId, key: input.key },
        orderBy: { changedAt: 'desc' },
        take: 100,
      });

      return rows.map((row) => ({
        previousValue: row.previousValue === null ? null : String(row.previousValue),
        newValue: String(row.newValue),
        reason: row.reason,
        changedByUserId: row.changedByUserId,
        changedAt: row.changedAt.toISOString(),
      }));
    });
  }

  // -------------------------------------------------------------------------
  // Resolution
  // -------------------------------------------------------------------------

  /**
   * Resolve every setting the caller may read, with its source and whether they may change it.
   *
   * `includeUnreadable` is used by the update path: a cross-setting rule has to see the *other*
   * setting's effective value even when the caller cannot read it, or the rule would silently
   * not apply to somebody with narrower permissions.
   */
  private async resolveAll(
    scope: TenantScope,
    context: AuthorizationContext,
    platformValues: Map<string, unknown>,
    includeUnreadable = false,
  ): Promise<ResolvedSetting[]> {
    const companyRows = await this.prisma.runInTenantTransaction(scope, () =>
      this.prisma.client.companySetting.findMany({ where: { tenantId: scope.tenantId } }),
    );

    const companyValues = new Map<string, unknown>(companyRows.map((row) => [row.key, row.value]));

    const resolved: ResolvedSetting[] = [];

    for (const definition of SETTING_DEFINITIONS) {
      const readable =
        includeUnreadable ||
        (await this.authorization.authorize(context, definition.readPermission)).allowed;

      if (!readable) {
        continue;
      }

      const editable = (await this.authorization.authorize(context, definition.writePermission))
        .allowed;

      resolved.push({
        key: definition.key,
        category: definition.category,
        label: definition.label,
        description: definition.description,
        type: definition.type,
        material: definition.material,
        defaultValue: definition.defaultValue,
        editable,
        ...CompanySettingsService.pick(definition, companyValues, platformValues),
      });
    }

    return resolved;
  }

  private async resolveOne(
    scope: TenantScope,
    definition: SettingDefinition,
    platformValues: Map<string, unknown>,
  ): Promise<{ value: SettingValue; source: SettingSource }> {
    const row = await this.prisma.runInTenantTransaction(scope, () =>
      this.prisma.client.companySetting.findFirst({
        where: { tenantId: scope.tenantId, key: definition.key },
      }),
    );

    return CompanySettingsService.pick(
      definition,
      new Map<string, unknown>(row ? [[row.key, row.value]] : []),
      platformValues,
    );
  }

  /**
   * The platform-default layer, fetched **outside** any tenant transaction.
   *
   * `PlatformRepository.listSettings` declares a platform operation, and
   * `runAsPlatformOperation` refuses to escalate from inside a tenant scope — the guard working,
   * not an obstacle. These values are read-only input to the resolution rather than part of a
   * transaction's work, so reading them first is both correct and cheaper: once per operation
   * instead of once per setting.
   */
  private async platformDefaults(): Promise<Map<string, unknown>> {
    const rows = await this.platform.listSettings();
    return new Map<string, unknown>(rows.map((row) => [row.key, row.value]));
  }

  /**
   * The three-layer choice, in one place.
   *
   * Company row → platform default → code default. Static and pure, so the inheritance rule is
   * one function rather than a condition repeated at every read — which is how two screens end
   * up disagreeing about a default.
   *
   * A stored value that no longer validates against its definition falls back to the default
   * rather than being returned: the type can change in a release while old rows remain, and
   * handing a screen an integer where it expects an enum is worse than showing the default and
   * letting somebody set it again.
   */
  private static pick(
    definition: SettingDefinition,
    companyValues: Map<string, unknown>,
    platformValues: Map<string, unknown>,
  ): { value: SettingValue; source: SettingSource } {
    for (const [candidate, source] of [
      [companyValues.get(definition.key), 'company' as const],
      [platformValues.get(definition.key), 'platform' as const],
    ] as const) {
      if (candidate === undefined || candidate === null) {
        continue;
      }
      const validated = validateSetting(definition, candidate);
      if (validated.ok) {
        return { value: validated.value, source };
      }
    }

    return { value: definition.defaultValue, source: 'default' };
  }
}
