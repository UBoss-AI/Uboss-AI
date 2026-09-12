import { BadRequestException, Injectable, Logger } from '@nestjs/common';

import {
  isModuleKey,
  isRoleKind,
  isScopeKind,
  isUserType,
  sanitisePermissionSet,
  type Action,
  type ModuleKey,
  type PermissionSet,
  type RoleKind,
  type ScopeKind,
  type UserType,
} from '@uboss/types';

import { AuthorizationRepository } from '../persistence/authorization.repository.js';
import type { TenantScope } from '../persistence/tenant-context.js';
import { SECURITY_ACTIONS, SecurityEventPublisher } from '../auth/security-event.publisher.js';

/**
 * One row of the client's approved external reference, translated to UBoss.
 *
 * Every field on the **external** side is free text holding the client's vocabulary verbatim.
 * Every field on the **UBoss** side is validated against `@uboss/types`, so a mapping cannot name
 * a module or action UBoss does not have.
 */
export interface TcsionMappingInput {
  /** The external user type, exactly as the approved reference spells it. */
  externalUserType: string;
  /** The external allotment, when the reference distinguishes them. */
  externalAllotment?: string | null;
  ubossUserType: UserType;
  roleKind: RoleKind;
  customRoleId?: string | undefined;
  scopeKind: ScopeKind;
  departmentIds?: readonly string[] | undefined;
  /** `{ module: true|false }`. An absent module is not visible — fails closed. */
  moduleVisibility: Record<string, boolean>;
  /** `{ module: [action] }`. A **restriction** on the role, never an addition. */
  allowedActions: Record<string, string[]>;
  /** Which client document and version this row came from. Mandatory. */
  approvedReference: string;
}

export interface ResolvedExternalIdentity {
  ubossUserType: UserType;
  roleKind: RoleKind;
  customRoleId: string | null;
  scopeKind: ScopeKind;
  departmentIds: readonly string[];
  visibleModules: readonly ModuleKey[];
  /** The mapping's ceiling, to be intersected with the role — never unioned. */
  actionCeiling: PermissionSet;
  approvedReference: string;
}

/**
 * The TCSiON mapping extension point.
 *
 * ## Nothing here invents a TCSiON definition
 *
 * The client has stated that TCSiON user types and allotments are an external dependency and that
 * the approved reference has not been supplied. So this service is the **shape that reference maps
 * into**, and it ships empty:
 *
 *   * `externalUserType` and `externalAllotment` are free-text columns holding whatever the
 *     client's document says. Constraining them to an enum would mean guessing the vocabulary,
 *     which is exactly what was forbidden.
 *   * There is no seeded mapping, no default and no example row. `listSupportedExternalTypes`
 *     returns what has been *loaded*, which is nothing until someone loads it.
 *   * `resolve` for an unmapped external type returns `null` and records a
 *     `tcsion_mapping_missing` security event. It does **not** fall back to Employee, because a
 *     silent default is how an external user ends up with permissions nobody chose.
 *
 * ## The UBoss side is fully validated
 *
 * A mapping may only name a module, action, role and scope that `@uboss/types` recognises. A row
 * that names something else is refused at load time with a message saying which value is wrong —
 * so a mistake in transcribing the client's reference is caught when it is loaded, not when
 * somebody signs in.
 *
 * ## The action list is a ceiling, not a grant
 *
 * `allowedActions` is intersected with what the mapped role grants. A mapping cannot award an
 * action the role does not have — otherwise the mapping table would be a second, invisible role
 * system, and "what can this person do" would have two answers.
 */
@Injectable()
export class TcsionMappingService {
  private readonly logger = new Logger(TcsionMappingService.name);

  constructor(
    private readonly repository: AuthorizationRepository,
    private readonly securityEvents: SecurityEventPublisher,
  ) {}

  /**
   * Load or replace one mapping row.
   *
   * Validated field by field rather than accepted and sanitised, because a mapping is a
   * *configuration* artefact transcribed from a document by a human: a typo should be reported,
   * not quietly dropped. That is the opposite of how a custom role's stored matrix is read, where
   * dropping an unknown value is the fail-closed choice — the difference is that one is being
   * written now and the other was written before a rename.
   */
  async load(
    scope: TenantScope,
    input: TcsionMappingInput,
    actorUserId?: string,
  ): Promise<{ id: string }> {
    const externalUserType = input.externalUserType.trim();
    if (externalUserType === '') {
      throw new BadRequestException(
        'externalUserType is required and comes from the client reference.',
      );
    }
    if (input.approvedReference.trim() === '') {
      throw new BadRequestException(
        'approvedReference is required: a mapping has to be traceable to the client document and ' +
          'version it came from, or nobody can tell later whether it was approved or assumed.',
      );
    }

    if (!isUserType(input.ubossUserType)) {
      throw new BadRequestException(`"${String(input.ubossUserType)}" is not a UBoss user type.`);
    }
    if (!isRoleKind(input.roleKind)) {
      throw new BadRequestException(`"${String(input.roleKind)}" is not a UBoss role.`);
    }
    if (!isScopeKind(input.scopeKind)) {
      throw new BadRequestException(`"${String(input.scopeKind)}" is not a UBoss scope.`);
    }
    if (input.roleKind === 'Custom' && input.customRoleId === undefined) {
      throw new BadRequestException(
        'A mapping onto the Custom role must name the custom role, or it resolves to nothing.',
      );
    }
    if (input.roleKind !== 'Custom' && input.customRoleId !== undefined) {
      throw new BadRequestException(
        'A mapping onto a built-in role must not also name a custom role — that would be two ' +
          'answers to one question.',
      );
    }

    for (const module of Object.keys(input.moduleVisibility)) {
      if (!isModuleKey(module)) {
        throw new BadRequestException(
          `moduleVisibility names "${module}", which is not a UBoss module. Check the ` +
            'transcription against the approved reference.',
        );
      }
    }

    // The action ceiling is validated the same way, and additionally has to be a subset of the
    // modules the mapping makes visible: an action ceiling on an invisible module is dead
    // configuration that would mislead the next reader.
    const visible = new Set(
      Object.entries(input.moduleVisibility)
        .filter(([, isVisible]) => isVisible)
        .map(([module]) => module),
    );

    for (const [module, actions] of Object.entries(input.allowedActions)) {
      if (!isModuleKey(module)) {
        throw new BadRequestException(
          `allowedActions names "${module}", which is not a UBoss module.`,
        );
      }
      if (!visible.has(module)) {
        throw new BadRequestException(
          `allowedActions restricts "${module}", which moduleVisibility does not make visible. ` +
            'Either make it visible or remove the restriction.',
        );
      }
      const sanitised = sanitisePermissionSet({ [module]: actions });
      if ((sanitised[module as ModuleKey] ?? []).length !== actions.length) {
        throw new BadRequestException(
          `allowedActions for "${module}" names an action UBoss does not have. Valid actions are ` +
            'listed in @uboss/types.',
        );
      }
    }

    const mapping = await this.repository.upsertTcsionMapping(scope, {
      externalUserType,
      externalAllotment: input.externalAllotment?.trim() || null,
      ubossUserType: input.ubossUserType,
      roleKind: input.roleKind,
      ...(input.customRoleId === undefined ? {} : { customRoleId: input.customRoleId }),
      scopeKind: input.scopeKind,
      ...(input.departmentIds === undefined ? {} : { departmentIds: input.departmentIds }),
      moduleVisibility: input.moduleVisibility,
      allowedActions: input.allowedActions,
      approvedReference: input.approvedReference.trim(),
    });

    await this.securityEvents.record({
      action: SECURITY_ACTIONS.tcsionMappingLoaded,
      ...(actorUserId === undefined ? {} : { actorUserId }),
      tenantId: scope.tenantId,
      resourceType: 'tcsion_mapping',
      resourceId: mapping.id,
      summary: `Loaded a TCSiON mapping for "${externalUserType}".`,
      metadata: {
        externalUserType,
        externalAllotment: input.externalAllotment ?? null,
        ubossUserType: input.ubossUserType,
        roleKind: input.roleKind,
        scopeKind: input.scopeKind,
        approvedReference: input.approvedReference.trim(),
      },
    });

    return { id: mapping.id };
  }

  /**
   * Resolve an external identity to UBoss dimensions.
   *
   * Returns `null` when there is no mapping — never a default. The caller's job is then to refuse
   * the provisioning or sign-in with a message naming the missing mapping, so the gap is
   * actionable ("load the approved TCSiON reference") rather than mysterious.
   */
  async resolve(
    scope: TenantScope,
    externalUserType: string,
    externalAllotment?: string | null,
  ): Promise<ResolvedExternalIdentity | null> {
    const allotment = externalAllotment?.trim() || null;

    // Exact match first, then user type alone: a reference that distinguishes allotments should
    // win over one that does not, and falling back the other way would apply a specific rule to
    // a general case.
    const mapping =
      (await this.repository.findTcsionMapping(scope, externalUserType.trim(), allotment)) ??
      (allotment === null
        ? null
        : await this.repository.findTcsionMapping(scope, externalUserType.trim(), null));

    if (!mapping) {
      this.logger.warn(
        `No TCSiON mapping for external user type "${externalUserType}"` +
          `${allotment ? ` / allotment "${allotment}"` : ''} in tenant ${scope.tenantId}.`,
      );

      await this.securityEvents.record({
        action: SECURITY_ACTIONS.tcsionMappingMissing,
        tenantId: scope.tenantId,
        resourceType: 'tcsion_mapping',
        summary: 'An external identity had no approved TCSiON mapping and was refused.',
        // The external type is recorded because it is configuration, not a credential — and it
        // is the one thing an administrator needs in order to fix this.
        metadata: { externalUserType: externalUserType.trim(), externalAllotment: allotment },
      });

      return null;
    }

    const visibility = (mapping.moduleVisibility ?? {}) as Record<string, unknown>;
    const visibleModules = Object.entries(visibility)
      .filter(([module, isVisible]) => isVisible === true && isModuleKey(module))
      .map(([module]) => module as ModuleKey);

    return {
      ubossUserType: mapping.ubossUserType as UserType,
      roleKind: mapping.roleKind as RoleKind,
      customRoleId: mapping.customRoleId,
      scopeKind: mapping.scopeKind as ScopeKind,
      departmentIds: mapping.departmentIds,
      visibleModules,
      // Sanitised on read, so a module renamed since the mapping was loaded narrows the ceiling
      // rather than widening it.
      actionCeiling: sanitisePermissionSet(mapping.allowedActions),
      approvedReference: mapping.approvedReference,
    };
  }

  /**
   * Apply a mapping's ceiling to a role's permissions.
   *
   * An **intersection**, always. The mapping can only take away. Exported and tested separately
   * because "does the mapping table grant anything" is the question that decides whether this is
   * a translation layer or a second permission system.
   */
  applyCeiling(rolePermissions: PermissionSet, ceiling: PermissionSet): PermissionSet {
    const out: Record<string, readonly Action[]> = {};

    for (const [module, roleActions] of Object.entries(rolePermissions)) {
      const permittedByMapping = ceiling[module as ModuleKey];
      if (permittedByMapping === undefined) {
        // A module the mapping says nothing about keeps the role's actions: the ceiling restricts
        // where it speaks, and module *visibility* is the separate dimension that hides a module
        // entirely. Conflating them would mean any mapping had to enumerate every module.
        out[module] = roleActions ?? [];
        continue;
      }

      const intersection = (roleActions ?? []).filter((action) =>
        permittedByMapping.includes(action),
      );
      if (intersection.length > 0) {
        out[module] = intersection;
      }
    }

    return out as PermissionSet;
  }

  async list(scope: TenantScope) {
    const mappings = await this.repository.listTcsionMappings(scope);

    return mappings.map((mapping) => ({
      id: mapping.id,
      externalUserType: mapping.externalUserType,
      externalAllotment: mapping.externalAllotment,
      ubossUserType: mapping.ubossUserType,
      roleKind: mapping.roleKind,
      customRoleId: mapping.customRoleId,
      scopeKind: mapping.scopeKind,
      departmentIds: mapping.departmentIds,
      moduleVisibility: mapping.moduleVisibility,
      allowedActions: mapping.allowedActions,
      approvedReference: mapping.approvedReference,
      enabled: mapping.enabled,
      updatedAt: mapping.updatedAt.toISOString(),
    }));
  }

  async remove(scope: TenantScope, mappingId: string): Promise<boolean> {
    return (await this.repository.deleteTcsionMapping(scope, mappingId)) > 0;
  }

  /**
   * What has actually been loaded.
   *
   * Returns an empty list until the client's approved reference is supplied, and the accompanying
   * note says so — so a screen shows "no approved TCSiON reference has been loaded" rather than
   * an empty table that looks like a bug.
   */
  async status(scope: TenantScope): Promise<{
    loaded: number;
    externalUserTypes: readonly string[];
    note: string;
  }> {
    const mappings = await this.repository.listTcsionMappings(scope);
    const externalUserTypes = [...new Set(mappings.map((mapping) => mapping.externalUserType))];

    return {
      loaded: mappings.length,
      externalUserTypes,
      note:
        mappings.length === 0
          ? 'No approved TCSiON reference has been loaded. TCSiON user types and allotments are ' +
            'an external client dependency and are deliberately not invented here, so external ' +
            'identities cannot be resolved until the approved mapping is supplied.'
          : `${mappings.length} mapping(s) loaded from the approved reference.`,
    };
  }
}
