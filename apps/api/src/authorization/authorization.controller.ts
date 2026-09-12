import {
  BadRequestException,
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Logger,
  NotFoundException,
  Param,
  Post,
  Put,
} from '@nestjs/common';

import {
  ACTION_LABELS,
  ACTIONS,
  COMPANY_MODULES,
  HIGH_RISK_ACTIONS,
  PLATFORM_MODULES,
  POLICY_LAYER_LABELS,
  POLICY_LAYERS,
  ROLE_KIND_LABELS,
  ROLE_KINDS,
  SCOPE_KIND_LABELS,
  SCOPE_KINDS,
  SOD_RULE_LABELS,
  USER_TYPE_CEILINGS,
  USER_TYPE_LABELS,
  USER_TYPES,
  type Action,
  type ResourceDescriptor,
} from '@uboss/types';

import { actorUserId, isPlatformActor } from '../request-context/authenticated-actor.js';
import { getActor } from '../request-context/request-context.js';
import { PlatformOnly } from '../tenancy/tenancy.decorators.js';
import { AuthorizationRepository } from '../persistence/authorization.repository.js';
import { AuthorizationService } from './authorization.service.js';
import {
  AssignRoleDto,
  CreateCustomRoleDto,
  CreatePolicyRuleDto,
  CreateSodPolicyDto,
  EvaluatePermissionDto,
  LoadTcsionMappingDto,
  SetUserTypeDto,
} from './authorization.dto.js';
import { RoleAdministrationService } from './role-administration.service.js';
import { TcsionMappingService } from './tcsion-mapping.service.js';

/**
 * Authorization administration, and the internal permission test endpoint.
 *
 * ## Why this is still `@PlatformOnly`
 *
 * The same interim decision as Prompt 5 and 6, and the last one of its kind: these are Company
 * Admin operations, and the *engine* that would let a Company Admin perform them is what this
 * prompt built. Re-homing five route groups onto it is a deliberate, testable follow-up rather
 * than something to fold in silently at the end of the prompt that created the mechanism — the
 * routes that check `@RequirePermission({ module: 'roles', action: 'ManageAccess' })` need a
 * Company Admin whose assignment exists, and assignments are created by these very routes.
 *
 * Recorded honestly in `docs/IMPLEMENTATION_STATE.md` rather than presented as finished.
 */
@Controller('tenants/:tenantId/authorization')
@PlatformOnly()
export class AuthorizationController {
  private readonly logger = new Logger(AuthorizationController.name);

  constructor(
    private readonly authorization: AuthorizationService,
    private readonly roles: RoleAdministrationService,
    private readonly tcsion: TcsionMappingService,
    private readonly repository: AuthorizationRepository,
  ) {}

  // -------------------------------------------------------------------------
  // The vocabulary
  // -------------------------------------------------------------------------

  /**
   * Every dimension, with labels.
   *
   * Served from `@uboss/types` rather than duplicated, so a screen rendering a permissions matrix
   * and the server enforcing it cannot disagree about what a module or action is called.
   */
  @Get('vocabulary')
  vocabulary() {
    return {
      userTypes: USER_TYPES.map((userType) => ({
        value: userType,
        label: USER_TYPE_LABELS[userType],
        // The ceiling is public: a screen needs to explain why a control is unavailable to a
        // guest, and "guests may never approve" is a product rule rather than a secret.
        forbiddenActions: USER_TYPE_CEILINGS[userType].forbidden,
      })),
      roles: ROLE_KINDS.map((roleKind) => ({
        value: roleKind,
        label: ROLE_KIND_LABELS[roleKind],
      })),
      scopes: SCOPE_KINDS.map((scopeKind) => ({
        value: scopeKind,
        label: SCOPE_KIND_LABELS[scopeKind],
      })),
      modules: {
        company: COMPANY_MODULES,
        platform: PLATFORM_MODULES,
      },
      actions: ACTIONS.map((action) => ({
        value: action,
        label: ACTION_LABELS[action],
        highRisk: HIGH_RISK_ACTIONS.includes(action),
      })),
      policyLayers: POLICY_LAYERS.map((layer) => ({
        value: layer,
        label: POLICY_LAYER_LABELS[layer],
      })),
      sodRules: Object.entries(SOD_RULE_LABELS).map(([value, label]) => ({ value, label })),
      precedenceNote:
        'Policy layers apply outermost first. A lower layer may be stricter, and may grant an ' +
        'exception to a non-mandatory higher control — but a mandatory higher control cannot be ' +
        'lifted by any lower layer.',
    };
  }

  /** The six built-in roles. Read-only: a built-in role's meaning is code, not data (ADR-038). */
  @Get('role-catalogue')
  roleCatalogue() {
    return { roles: this.roles.roleCatalogue() };
  }

  // -------------------------------------------------------------------------
  // The internal permission test endpoint
  // -------------------------------------------------------------------------

  /**
   * Answer one permission question, with the full reasoning.
   *
   * This is the API behind the internal permission test page, and it is the only endpoint that
   * returns the decision **trace**. That is safe here and nowhere else: the route is platform-only,
   * so the caller already administers the platform, and the trace describes the company's own
   * policy configuration. A normal 403 never carries it.
   *
   * It exists because a five-dimension, five-layer engine is close to undebuggable from the
   * outside. "Why can this Manager not approve this?" should be answerable in one request, and
   * the answer should name the layer that decided.
   */
  @Post('evaluate')
  @HttpCode(HttpStatus.OK)
  async evaluate(@Param('tenantId') tenantId: string, @Body() body: EvaluatePermissionDto) {
    const scope = this.authorization.platformScopeFor(tenantId);
    const subject = body.userId ?? actorUserId(getActor());

    if (!subject) {
      throw new BadRequestException('userId is required when the caller has no identity.');
    }

    const context = await this.authorization.contextFor(scope, subject);

    const resource: ResourceDescriptor | undefined =
      body.resourceId === undefined
        ? undefined
        : {
            id: body.resourceId,
            ...(body.resourceOwnerUserId === undefined
              ? {}
              : { ownerUserId: body.resourceOwnerUserId }),
            ...(body.resourceCreatedByUserId === undefined
              ? {}
              : { createdByUserId: body.resourceCreatedByUserId }),
            ...(body.resourceDepartmentId === undefined
              ? {}
              : { departmentId: body.resourceDepartmentId }),
            ...(body.priorActorUserIds === undefined
              ? {}
              : { priorActorUserIds: body.priorActorUserIds }),
          };

    const decision = await this.authorization.authorize(context, {
      module: body.module,
      action: body.action,
      ...(resource === undefined ? {} : { resource }),
      ...(body.actingAsAgent === undefined ? {} : { actingAsAgent: body.actingAsAgent }),
    });

    const governingSod = this.authorization.governingSod(context, body.module, body.action);

    return {
      subject: {
        userId: subject,
        userType: context.userType,
        roles: context.roleSummary,
        assignedScope: context.scope.kind,
      },
      question: {
        module: body.module,
        action: body.action,
        resource: resource ?? null,
        actingAsAgent: body.actingAsAgent === true,
      },
      decision: {
        allowed: decision.allowed,
        reason: decision.reason ?? null,
        message: decision.message,
        decidedBy: decision.decidedBy ?? null,
        effectiveScope: decision.effectiveScope ?? null,
      },
      /** The whole chain. Platform-only, as explained on the method. */
      trace: decision.trace ?? [],
      separationOfDuties: governingSod
        ? {
            rule: governingSod.rule,
            mandatory: governingSod.mandatory,
            reason: governingSod.reason,
          }
        : null,
      /** What a list query for this (module, action) would be allowed to cover. */
      listingScope: this.authorization.scopeForListing(context, body.module, body.action),
    };
  }

  /**
   * The complete matrix for one person.
   *
   * Computed by running the same engine per (module, action) — there is no second implementation
   * to drift. Resource-level scope and separation of duties are deliberately absent, because both
   * need a specific row and a matrix that implied otherwise would be misleading.
   */
  @Get('matrix/:userId')
  async matrix(@Param('tenantId') tenantId: string, @Param('userId') userId: string) {
    const scope = this.authorization.platformScopeFor(tenantId);
    const context = await this.authorization.contextFor(scope, userId);

    return {
      userId,
      userType: context.userType,
      roles: context.roleSummary,
      assignedScope: context.scope.kind,
      visibleModules: context.visibleModules,
      matrix: this.authorization.matrixFor(context),
      note:
        'Module and action only. Scope and separation-of-duties controls need a specific ' +
        'resource, so a matrix cannot express them — use POST evaluate for that.',
      appliedRules: context.rules.length,
      appliedSodPolicies: context.sodPolicies.length,
    };
  }

  // -------------------------------------------------------------------------
  // Role assignments
  // -------------------------------------------------------------------------

  @Get('assignments')
  async listAssignments(@Param('tenantId') tenantId: string) {
    const scope = this.authorization.platformScopeFor(tenantId);
    return { assignments: await this.roles.listAssignments(scope) };
  }

  @Post('assignments')
  @HttpCode(HttpStatus.CREATED)
  async assign(@Param('tenantId') tenantId: string, @Body() body: AssignRoleDto) {
    const scope = this.authorization.platformScopeFor(tenantId);
    const actor = actorUserId(getActor());
    if (!actor) {
      throw new BadRequestException('An identified actor is required to grant a role.');
    }

    const expiresAt = body.expiresAt === undefined ? undefined : new Date(body.expiresAt);
    if (expiresAt !== undefined && Number.isNaN(expiresAt.getTime())) {
      throw new BadRequestException('expiresAt is not a valid timestamp.');
    }
    if (expiresAt !== undefined && expiresAt <= new Date()) {
      throw new BadRequestException(
        'expiresAt is in the past, so the assignment would grant nothing.',
      );
    }

    return this.roles.assign(
      scope,
      {
        userId: body.userId,
        roleKind: body.roleKind,
        ...(body.customRoleId === undefined ? {} : { customRoleId: body.customRoleId }),
        scopeKind: body.scopeKind,
        ...(body.departmentIds === undefined ? {} : { departmentIds: body.departmentIds }),
        ...(body.selectedResourceIds === undefined
          ? {}
          : { selectedResourceIds: body.selectedResourceIds }),
        ...(expiresAt === undefined ? {} : { expiresAt }),
        ...(body.justification === undefined ? {} : { justification: body.justification }),
      },
      actor,
    );
  }

  @Delete('assignments/:assignmentId')
  @HttpCode(HttpStatus.NO_CONTENT)
  async revoke(@Param('tenantId') tenantId: string, @Param('assignmentId') assignmentId: string) {
    const scope = this.authorization.platformScopeFor(tenantId);
    const actor = actorUserId(getActor());
    if (!actor) {
      throw new BadRequestException('An identified actor is required to revoke a role.');
    }

    if (!(await this.roles.revoke(scope, assignmentId, actor))) {
      throw new NotFoundException('No such role assignment.');
    }
  }

  // -------------------------------------------------------------------------
  // Custom roles
  // -------------------------------------------------------------------------

  @Get('custom-roles')
  async listCustomRoles(@Param('tenantId') tenantId: string) {
    const scope = this.authorization.platformScopeFor(tenantId);
    return { roles: await this.roles.listCustomRoles(scope) };
  }

  @Post('custom-roles')
  @HttpCode(HttpStatus.CREATED)
  async createCustomRole(@Param('tenantId') tenantId: string, @Body() body: CreateCustomRoleDto) {
    const scope = this.authorization.platformScopeFor(tenantId);
    const actor = actorUserId(getActor());
    if (!actor) {
      throw new BadRequestException('An identified actor is required to create a role.');
    }

    /**
     * The creator's own effective matrix caps the new role — gate 2 in
     * `RoleAdministrationService`.
     *
     * A platform administrator has no company membership, so their *company* matrix is empty and
     * the gate would refuse every custom role. They are the interim authority for these routes
     * (see the class comment), so they get the full company matrix here — stated explicitly
     * rather than arrived at by accident, and it narrows to a real Company Admin's own matrix the
     * moment Prompt 7's engine is used to re-home these routes.
     */
    const creatorMatrix = isPlatformActor(getActor())
      ? (Object.fromEntries(COMPANY_MODULES.map((module) => [module, [...ACTIONS]])) as Record<
          string,
          Action[]
        >)
      : this.authorization.matrixFor(await this.authorization.contextFor(scope, actor));

    return this.roles.createCustomRole(
      scope,
      {
        displayName: body.displayName,
        ...(body.description === undefined ? {} : { description: body.description }),
        permissions: body.permissions,
        maxScope: body.maxScope,
      },
      actor,
      creatorMatrix,
    );
  }

  // -------------------------------------------------------------------------
  // Policy rules
  // -------------------------------------------------------------------------

  @Get('policy-rules')
  async listPolicyRules(@Param('tenantId') tenantId: string) {
    const scope = this.authorization.platformScopeFor(tenantId);
    const rules = await this.repository.listPolicyRules(scope);

    return {
      rules: rules.map((rule) => ({
        id: rule.id,
        layer: rule.layer,
        departmentId: rule.departmentId,
        objectiveId: rule.objectiveId,
        engineAgentId: rule.engineAgentId,
        module: rule.module,
        action: rule.action,
        effect: rule.effect,
        mandatory: rule.mandatory,
        maxScope: rule.maxScope,
        reason: rule.reason,
        enabled: rule.enabled,
      })),
    };
  }

  @Post('policy-rules')
  @HttpCode(HttpStatus.CREATED)
  async createPolicyRule(@Param('tenantId') tenantId: string, @Body() body: CreatePolicyRuleDto) {
    const scope = this.authorization.platformScopeFor(tenantId);

    if (body.layer === 'Platform') {
      throw new BadRequestException(
        'A Platform-layer rule applies to every company and cannot be created through a ' +
          "company's own endpoint.",
      );
    }
    if (body.mandatory && body.effect === 'Allow') {
      throw new BadRequestException(
        'A mandatory Allow is not a thing: "mandatory" means lower layers cannot lift it, and a ' +
          'grant lower layers cannot tighten is exactly what the precedence rule forbids.',
      );
    }
    if (body.layer === 'Department' && body.departmentId === undefined) {
      throw new BadRequestException('A Department rule needs a departmentId.');
    }
    if (body.layer === 'Objective' && body.objectiveId === undefined) {
      throw new BadRequestException('An Objective rule needs an objectiveId.');
    }
    if (body.layer === 'EngineAgent' && body.engineAgentId === undefined) {
      throw new BadRequestException('An Engine Agent rule needs an engineAgentId.');
    }

    const actor = actorUserId(getActor());
    const rule = await this.repository.createPolicyRule(scope, {
      layer: body.layer,
      ...(body.departmentId === undefined ? {} : { departmentId: body.departmentId }),
      ...(body.objectiveId === undefined ? {} : { objectiveId: body.objectiveId }),
      ...(body.engineAgentId === undefined ? {} : { engineAgentId: body.engineAgentId }),
      ...(body.module === undefined ? {} : { module: body.module }),
      ...(body.action === undefined ? {} : { action: body.action }),
      effect: body.effect,
      mandatory: body.mandatory,
      ...(body.maxScope === undefined ? {} : { maxScope: body.maxScope }),
      reason: body.reason,
      ...(actor === undefined ? {} : { createdByUserId: actor }),
    });

    return { id: rule.id };
  }

  @Delete('policy-rules/:ruleId')
  @HttpCode(HttpStatus.NO_CONTENT)
  async deletePolicyRule(@Param('tenantId') tenantId: string, @Param('ruleId') ruleId: string) {
    const scope = this.authorization.platformScopeFor(tenantId);
    if ((await this.repository.deletePolicyRule(scope, ruleId)) === 0) {
      throw new NotFoundException('No such policy rule.');
    }
  }

  // -------------------------------------------------------------------------
  // Separation of duties
  // -------------------------------------------------------------------------

  @Get('separation-of-duties')
  async listSod(@Param('tenantId') tenantId: string) {
    const scope = this.authorization.platformScopeFor(tenantId);
    const [company, platform] = await Promise.all([
      this.repository.listSodPolicies(scope),
      this.authorization.platformSodBaseline(),
    ]);

    return {
      /** Inherited by every company and, when mandatory, not removable by any of them. */
      platformBaseline: platform.map((policy) => ({
        action: policy.action,
        module: policy.module,
        rule: policy.rule,
        mandatory: policy.mandatory,
        reason: policy.reason,
      })),
      companyPolicies: company.map((policy) => ({
        id: policy.id,
        layer: policy.layer,
        module: policy.module,
        action: policy.action,
        rule: policy.rule,
        mandatory: policy.mandatory,
        reason: policy.reason,
      })),
      candidateActions: HIGH_RISK_ACTIONS,
      note:
        'The platform baseline is inherited. A mandatory baseline control cannot be removed by ' +
        'a company, department, objective or Engine Agent layer.',
    };
  }

  @Post('separation-of-duties')
  @HttpCode(HttpStatus.CREATED)
  async createSod(@Param('tenantId') tenantId: string, @Body() body: CreateSodPolicyDto) {
    const scope = this.authorization.platformScopeFor(tenantId);

    const policy = await this.repository.createSodPolicy(scope, {
      layer: body.layer ?? 'Company',
      ...(body.module === undefined ? {} : { module: body.module }),
      action: body.action,
      rule: body.rule,
      mandatory: body.mandatory,
      reason: body.reason,
    });

    return { id: policy.id };
  }

  @Delete('separation-of-duties/:policyId')
  @HttpCode(HttpStatus.NO_CONTENT)
  async deleteSod(@Param('tenantId') tenantId: string, @Param('policyId') policyId: string) {
    const scope = this.authorization.platformScopeFor(tenantId);
    if ((await this.repository.deleteSodPolicy(scope, policyId)) === 0) {
      throw new NotFoundException('No such separation-of-duties policy.');
    }
  }

  // -------------------------------------------------------------------------
  // User type
  // -------------------------------------------------------------------------

  @Put('members/:userId/user-type')
  async setUserType(
    @Param('tenantId') tenantId: string,
    @Param('userId') userId: string,
    @Body() body: SetUserTypeDto,
  ) {
    const scope = this.authorization.platformScopeFor(tenantId);
    const actor = actorUserId(getActor());
    if (!actor) {
      throw new BadRequestException('An identified actor is required.');
    }

    if (!(await this.roles.setUserType(scope, userId, body.userType, actor))) {
      throw new NotFoundException('That person is not a member of this company.');
    }

    return { userId, userType: body.userType };
  }

  // -------------------------------------------------------------------------
  // TCSiON mapping
  // -------------------------------------------------------------------------

  /**
   * What has been loaded from the client's approved reference.
   *
   * Returns an empty list and an explanatory note until it is supplied, so a screen can say "no
   * approved TCSiON reference has been loaded" rather than showing an empty table that looks
   * like a bug.
   */
  @Get('tcsion-mappings')
  async tcsionStatus(@Param('tenantId') tenantId: string) {
    const scope = this.authorization.platformScopeFor(tenantId);
    const [status, mappings] = await Promise.all([
      this.tcsion.status(scope),
      this.tcsion.list(scope),
    ]);

    return { ...status, mappings };
  }

  @Put('tcsion-mappings')
  async loadTcsionMapping(@Param('tenantId') tenantId: string, @Body() body: LoadTcsionMappingDto) {
    const scope = this.authorization.platformScopeFor(tenantId);
    const actor = actorUserId(getActor());

    return this.tcsion.load(
      scope,
      {
        externalUserType: body.externalUserType,
        ...(body.externalAllotment === undefined
          ? {}
          : { externalAllotment: body.externalAllotment }),
        ubossUserType: body.ubossUserType,
        roleKind: body.roleKind,
        ...(body.customRoleId === undefined ? {} : { customRoleId: body.customRoleId }),
        scopeKind: body.scopeKind,
        ...(body.departmentIds === undefined ? {} : { departmentIds: body.departmentIds }),
        moduleVisibility: body.moduleVisibility,
        allowedActions: body.allowedActions,
        approvedReference: body.approvedReference,
      },
      actor,
    );
  }

  @Delete('tcsion-mappings/:mappingId')
  @HttpCode(HttpStatus.NO_CONTENT)
  async removeTcsionMapping(
    @Param('tenantId') tenantId: string,
    @Param('mappingId') mappingId: string,
  ) {
    const scope = this.authorization.platformScopeFor(tenantId);
    if (!(await this.tcsion.remove(scope, mappingId))) {
      throw new NotFoundException('No such TCSiON mapping.');
    }
  }

  /**
   * Resolve an external identity, without provisioning anything.
   *
   * A dry run: it answers "what would this external user type become in UBoss", which is the
   * question an administrator has while transcribing the client's reference. Returns a refusal
   * naming the missing mapping when there is none — never a default.
   */
  @Post('tcsion-mappings/resolve')
  @HttpCode(HttpStatus.OK)
  async resolveTcsion(
    @Param('tenantId') tenantId: string,
    @Body() body: { externalUserType?: string; externalAllotment?: string },
  ) {
    const scope = this.authorization.platformScopeFor(tenantId);
    const externalUserType = body.externalUserType?.trim();

    if (!externalUserType) {
      throw new BadRequestException('externalUserType is required.');
    }

    const resolved = await this.tcsion.resolve(
      scope,
      externalUserType,
      body.externalAllotment ?? null,
    );

    if (!resolved) {
      return {
        resolved: false as const,
        message:
          `No approved TCSiON mapping exists for "${externalUserType}". TCSiON user types and ` +
          'allotments are an external client dependency and are not invented here — load the ' +
          'approved reference before provisioning identities of this type.',
      };
    }

    return { resolved: true as const, ...resolved };
  }
}
