import { ForbiddenException, Inject, Injectable, Logger, Optional } from '@nestjs/common';

import {
  ACTIONS,
  checkSeparationOfDuties,
  evaluatePrecedence,
  effectiveScopeFor,
  governingSodPolicy,
  isAction,
  isInScopeAsync,
  isModuleKey,
  isPolicyLayer,
  isScopeKind,
  isSodRule,
  MODULE_KEYS,
  PLATFORM_PERMISSIONS,
  PLATFORM_ROLE_TEMPLATES,
  unionPlatformPermissions,
  ROLE_TEMPLATES,
  SCOPE_BREADTH,
  sanitisePermissionSet,
  widestGrant,
  type Action,
  type AuthorizationDecision,
  type HierarchyResolver,
  type ModuleKey,
  type PermissionSet,
  type PolicyRule,
  type ResourceDescriptor,
  type RoleKind,
  type ScopeGrant,
  type ScopeKind,
  type PlatformRoleKind,
  type SodPolicy,
  type UserType,
} from '@uboss/types';

import { AuthorizationRepository } from '../persistence/authorization.repository.js';
import { PlatformRepository } from '../persistence/platform.repository.js';
import { PrismaService } from '../persistence/prisma.service.js';
import {
  tenantScopeForPlatformOperation,
  type TenantScope,
} from '../persistence/tenant-context.js';
import { getActor } from '../request-context/request-context.js';
import { isPlatformActor, isTenantActor } from '../request-context/authenticated-actor.js';
import { SECURITY_ACTIONS, SecurityEventPublisher } from '../auth/security-event.publisher.js';

/** Registered by whichever module owns the hierarchy. Absent until Prompt 12. */
export const HIERARCHY_RESOLVER = 'HIERARCHY_RESOLVER';

/** Everything about one person's authority in one company, resolved once. */
export interface AuthorizationContext {
  tenantId: string;
  userId: string;
  userType: UserType;
  /** Union across every live assignment, module-keyed. */
  granted: PermissionSet;
  visibleModules: readonly ModuleKey[];
  scope: ScopeGrant;
  rules: readonly PolicyRule[];
  sodPolicies: readonly SodPolicy[];
  roleSummary: readonly { roleKind: RoleKind; customRoleName?: string; scopeKind: ScopeKind }[];
}

export interface AuthorizeInput {
  module: ModuleKey;
  action: Action;
  /** Omit for a coarse "could this role ever do this" check. */
  resource?: ResourceDescriptor | undefined;
  /** True when an Engine Agent or the Executor Agent is acting rather than a person. */
  actingAsAgent?: boolean | undefined;
  /**
   * Separation-of-duties controls this *resource* carries in its own right, evaluated alongside
   * the ones the company has configured.
   *
   * Added at Prompt 28 for one real case: a workflow step whose approval kind is `FourEyes` must
   * get a four-eyes control whether or not the company also configured a `FourEyes` policy on
   * that module. The alternative was a second implementation of the rule inside the Approval
   * Engine, which is how a codebase ends up with two answers to "may this person approve this".
   *
   * These are additional and never subtractive: a caller cannot pass a policy that relaxes a
   * configured one, because `checkSeparationOfDuties` refuses on the first control that bites and
   * the mandatory platform baseline is always in the list.
   */
  additionalSodPolicies?: readonly SodPolicy[] | undefined;
}

/**
 * The authorization engine's request-facing half.
 *
 * ## Two phases, on purpose
 *
 * A guard runs before the handler, so it cannot know which row is being touched. Splitting the
 * check is therefore not a convenience, it is forced by the shape of HTTP:
 *
 *   * **Phase 1** — `@RequirePermission(module, action)` on the route. Answers "could this
 *     person's roles and this company's policy ever permit this action on this module". Cheap,
 *     and stops the handler running at all in the common denial.
 *   * **Phase 2** — `authorize({ module, action, resource })` inside the handler, once the row is
 *     loaded. Answers "may they do it to *this*", which is where scope and separation of duties
 *     live.
 *
 * A route that only does phase 1 is still protected against the wrong *role*; it is not protected
 * against the wrong *row*. `assertCanOnResource` exists so that omission is a visible one-liner
 * rather than something you have to notice is missing.
 *
 * ## What this class does not decide
 *
 * Tenant isolation, company lifecycle state and account state are `TenantGuard`'s, already
 * enforced before any of this runs, and re-checked here only to produce a better message. RLS is
 * the backstop underneath both.
 */
@Injectable()
export class AuthorizationService {
  private readonly logger = new Logger(AuthorizationService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly repository: AuthorizationRepository,
    private readonly securityEvents: SecurityEventPublisher,
    private readonly platform: PlatformRepository,
    @Optional() @Inject(HIERARCHY_RESOLVER) private readonly hierarchy?: HierarchyResolver,
  ) {}

  /**
   * Resolve one person's authority in one company.
   *
   * Four reads: assignments, company policy rules, company SoD policies, and the platform-layer
   * baseline. Deliberately not cached — a permission change has to take effect on the next
   * request, and a cache with a TTL means a revoked role keeps working for the length of the TTL.
   * If this becomes a measured problem the answer is a cache invalidated by assignment writes,
   * not a timer.
   */
  async contextFor(scope: TenantScope, userId: string): Promise<AuthorizationContext> {
    const membership = await this.repository.findMembershipUserType(scope, userId);

    // A platform actor has no company membership. `TenantGuard` already refuses one inside a
    // workspace, so reaching here without a membership means the caller asked about the platform
    // plane, and the platform permission set is the honest answer.
    if (!membership) {
      return {
        tenantId: scope.tenantId,
        userId,
        userType: 'PlatformUser',
        granted: PLATFORM_PERMISSIONS,
        visibleModules: Object.keys(PLATFORM_PERMISSIONS) as ModuleKey[],
        scope: { kind: 'WholeCompany' },
        rules: [],
        sodPolicies: await this.platformSodPolicies(),
        roleSummary: [],
      };
    }

    const [assignments, companyRules, companySod, platformRules, platformSod] = await Promise.all([
      this.repository.listLiveAssignments(scope, userId),
      this.repository.listPolicyRules(scope),
      this.repository.listSodPolicies(scope),
      this.platformPolicyRules(),
      this.platformSodPolicies(),
    ]);

    const granted: Record<string, Action[]> = {};
    const grants: ScopeGrant[] = [];
    const roleSummary: AuthorizationContext['roleSummary'] = [];

    for (const assignment of assignments) {
      const permissions = this.permissionsFor(assignment);

      // A role's own template caps what the assignment can grant, and a custom role is capped by
      // its stored matrix. Either way the assignment cannot widen the role.
      for (const [module, actions] of Object.entries(permissions)) {
        if (!isModuleKey(module)) {
          continue;
        }
        const existing = granted[module] ?? [];
        granted[module] = [...new Set([...existing, ...(actions ?? [])])];
      }

      const assignedScope = this.scopeGrantFor(assignment);
      if (assignedScope) {
        grants.push(assignedScope);
      }

      (roleSummary as AuthorizationContext['roleSummary'][number][]).push({
        roleKind: assignment.roleKind as RoleKind,
        ...(assignment.customRole ? { customRoleName: assignment.customRole.displayName } : {}),
        scopeKind: assignment.scopeKind as ScopeKind,
      });
    }

    return {
      tenantId: scope.tenantId,
      userId,
      userType: (membership.userType as UserType) ?? 'InternalUser',
      granted: granted as PermissionSet,
      visibleModules: Object.keys(granted) as ModuleKey[],
      // No assignment means no scope at all — not "own work". Someone with a membership and no
      // role assignment can do nothing, which is the correct fail-closed answer.
      scope: widestGrant(grants) ?? { kind: 'OwnWork', selectedResourceIds: [] },
      rules: [...platformRules, ...this.toPolicyRules(companyRules)],
      sodPolicies: [...platformSod, ...this.toSodPolicies(companySod)],
      roleSummary,
    };
  }

  /**
   * The authority of a platform-plane actor.
   *
   * A platform actor has no company membership and therefore no company role — that is what
   * `TenantGuard` enforces, and it is why the Master Console is a separate plane rather than a
   * very powerful company role. Their permissions come from `PLATFORM_PERMISSIONS`, and the
   * platform-layer policy rules still apply on top, so the platform can restrict itself.
   */
  async platformContext(userId: string): Promise<AuthorizationContext> {
    const [rules, sodPolicies, assignments] = await Promise.all([
      this.platformPolicyRules(),
      this.platformSodPolicies(),
      this.platform.livePlatformRoles(userId),
    ]);

    const kinds = assignments.map((assignment) => assignment.role);

    // **Fail closed.** Before Prompt 9 this method returned the whole of PLATFORM_PERMISSIONS to
    // any platform actor, which made a permission decorator on a Master Console route incapable
    // of refusing anybody who got that far. Now the permissions come from the assignments, and a
    // platform actor with none gets an empty set.
    //
    // The empty set matters: an empty `granted` means every `authorize` call denies with
    // `module-not-visible`, and `roleSummary` below stays empty so the engine's "no role in this
    // company" refusal fires with a message that names the real problem. The migration backfilled
    // every existing platform actor to `PlatformAdmin`, so this is a new capability rather than a
    // retroactive lockout — see ADR-049.
    const granted = kinds.length > 0 ? unionPlatformPermissions(kinds) : ({} as PermissionSet);

    return {
      // A platform context is not scoped to a company; the id is carried only so the shape
      // matches and audit events have something to record.
      tenantId: '',
      userId,
      userType: 'PlatformUser',
      granted,
      visibleModules: Object.keys(granted) as ModuleKey[],
      scope: { kind: 'WholeCompany' },
      rules,
      sodPolicies,
      // One synthetic entry per held platform role, so the engine's "no role assignment" refusal
      // does not fire on a platform actor who legitimately has no *company* role — and so it DOES
      // fire on a platform actor holding no platform role at all.
      roleSummary: kinds.map((kind) => ({
        roleKind: 'CompanyAdmin' as RoleKind,
        customRoleName: PLATFORM_ROLE_TEMPLATES[kind].label,
        scopeKind: 'WholeCompany' as ScopeKind,
      })),
    };
  }

  /**
   * The platform roles a person actually holds, with their labels.
   *
   * Exposed separately from `platformContext` because the Master Console needs to show a person
   * their own roles, and deriving them back out of a merged `PermissionSet` would be guessing.
   */
  async platformRolesFor(
    userId: string,
  ): Promise<{ kind: PlatformRoleKind; label: string; expiresAt: Date | null }[]> {
    const assignments = await this.platform.livePlatformRoles(userId);
    return assignments.map((assignment) => ({
      kind: assignment.role,
      label: PLATFORM_ROLE_TEMPLATES[assignment.role].label,
      expiresAt: assignment.expiresAt,
    }));
  }

  /**
   * The mandatory platform-layer separation-of-duties baseline.
   *
   * A dedicated accessor because the alternative — and what the code used to do — was
   * `platformContext('')`, building an entire authorization context around an empty user id
   * just to read one list. That worked only for as long as `platformContext` did no user
   * lookup; Prompt 9 gave it one, and the empty string became `WHERE user_id = ''`, which
   * PostgreSQL rejects as a uuid. A 500 on a settings screen, from a call that never should have
   * passed a fake id.
   */
  async platformSodBaseline(): Promise<readonly SodPolicy[]> {
    return this.platformSodPolicies();
  }

  /**
   * The full platform permission ceiling, for the Platform Settings screen to render the role
   * catalogue against.
   *
   * Deliberately not what any one actor holds — it is the ceiling every platform role is a subset
   * of, which is the thing a reader needs in order to judge whether a role is narrow enough.
   */
  platformCeiling(): PermissionSet {
    return PLATFORM_PERMISSIONS;
  }

  /**
   * Decide one (module, action), optionally against a resource.
   *
   * Returns a decision rather than throwing, so a caller can render a disabled control as easily
   * as it can refuse a request. `assertCan` is the throwing form.
   */
  async authorize(
    context: AuthorizationContext,
    input: AuthorizeInput,
  ): Promise<AuthorizationDecision> {
    if (!isModuleKey(input.module)) {
      return { allowed: false, reason: 'unknown-module', message: 'Unknown module.' };
    }
    if (!isAction(input.action)) {
      return { allowed: false, reason: 'unknown-action', message: 'Unknown action.' };
    }

    if (context.roleSummary.length === 0 && context.userType !== 'PlatformUser') {
      return {
        allowed: false,
        reason: 'no-role-assignment',
        message: 'You have no role in this company yet. Ask an administrator to assign one.',
      };
    }

    // ---- Phase 1: the five dimensions and the policy chain. ----
    const precedence = evaluatePrecedence({
      userType: context.userType,
      module: input.module,
      action: input.action,
      grantedActions: context.granted[input.module] ?? [],
      visibleModules: context.visibleModules,
      assignedScope: context.scope.kind,
      rules: context.rules,
    });

    if (!precedence.allowed) {
      return precedence.decision;
    }

    // ---- Phase 2: this particular resource. ----
    if (!input.resource) {
      return precedence.decision;
    }

    const scopeOutcome = await isInScopeAsync({
      // The scope the *policy layers* left, not the raw assignment: a layer that narrowed a
      // manager to their own work must actually narrow the row check too, or the narrowing was
      // decorative.
      grant: { ...context.scope, kind: precedence.effectiveScope },
      resource: input.resource,
      actorUserId: context.userId,
      tenantId: context.tenantId,
      ...(this.hierarchy === undefined ? {} : { hierarchy: this.hierarchy }),
    });

    if (!scopeOutcome.inScope) {
      return {
        allowed: false,
        reason: scopeOutcome.reason,
        message:
          scopeOutcome.reason === 'scope-unevaluable'
            ? 'This needs the reporting hierarchy, which is not available yet.'
            : 'That is outside what your role covers.',
        effectiveScope: precedence.effectiveScope,
        trace: [
          ...(precedence.decision.trace ?? []),
          { layer: 'Scope', outcome: 'deny', detail: scopeOutcome.detail },
        ],
      };
    }

    // ---- Separation of duties. Last, because it is the most specific. ----
    const sod = checkSeparationOfDuties({
      policies:
        input.additionalSodPolicies === undefined
          ? context.sodPolicies
          : [...context.sodPolicies, ...input.additionalSodPolicies],
      action: input.action,
      module: input.module,
      actorUserId: context.userId,
      resource: input.resource,
      ...(input.actingAsAgent === undefined ? {} : { actingAsAgent: input.actingAsAgent }),
    });

    if (!sod.satisfied) {
      // Recorded as suspicious: an attempt to self-approve is exactly the pattern an audit wants
      // to see, whether it was a mistake or not.
      await this.securityEvents.recordSuspicious({
        action: SECURITY_ACTIONS.separationOfDutiesBlocked,
        actorUserId: context.userId,
        tenantId: context.tenantId,
        resourceType: input.module,
        resourceId: input.resource.id,
        summary: `Blocked by a ${sod.rule} control on ${input.action}.`,
        metadata: {
          module: input.module,
          permissionAction: input.action,
          rule: sod.rule,
          actingAsAgent: input.actingAsAgent === true,
        },
      });

      return {
        allowed: false,
        reason: 'separation-of-duties',
        message: sod.detail,
        effectiveScope: precedence.effectiveScope,
        trace: [
          ...(precedence.decision.trace ?? []),
          { layer: 'Scope', outcome: 'allow', detail: scopeOutcome.detail },
          { layer: 'SeparationOfDuties', outcome: 'deny', detail: sod.detail },
        ],
      };
    }

    return {
      allowed: true,
      message: 'Permitted.',
      effectiveScope: precedence.effectiveScope,
      trace: [
        ...(precedence.decision.trace ?? []),
        { layer: 'Scope', outcome: 'allow', detail: scopeOutcome.detail },
        { layer: 'SeparationOfDuties', outcome: 'allow', detail: sod.detail },
      ],
    };
  }

  /**
   * The throwing form, for use inside a handler.
   *
   * The 403 body carries the message but **never the trace**: the trace describes the company's
   * policy configuration, and a caller who was just refused has no business reading it.
   */
  async assertCan(context: AuthorizationContext, input: AuthorizeInput): Promise<void> {
    const decision = await this.authorize(context, input);
    if (!decision.allowed) {
      throw new ForbiddenException(decision.message);
    }
  }

  /**
   * Resolve the context and assert in one call, for the common handler case.
   *
   * Takes the actor from the ambient request context rather than a parameter, so a handler cannot
   * accidentally authorize the wrong person by passing the resource's owner id.
   */
  async assertCanOnResource(input: AuthorizeInput & { scope: TenantScope }): Promise<void> {
    const actor = getActor();
    if (actor.kind === 'anonymous') {
      throw new ForbiddenException('Authentication is required.');
    }

    const context = await this.contextFor(input.scope, actor.userId);
    await this.assertCan(context, input);
  }

  /**
   * The full permission matrix for one person.
   *
   * Computed by running the same `evaluatePrecedence` per (module, action) rather than by a second
   * implementation, so the matrix a screen renders and the check the server enforces cannot
   * disagree. Resource-level scope and separation of duties are deliberately absent — both need a
   * specific row, and a matrix that pretended otherwise would be misleading.
   */
  matrixFor(context: AuthorizationContext): Record<string, Action[]> {
    const matrix: Record<string, Action[]> = {};

    for (const module of MODULE_KEYS) {
      const allowed = ACTIONS.filter(
        (action) =>
          evaluatePrecedence({
            userType: context.userType,
            module,
            action,
            grantedActions: context.granted[module] ?? [],
            visibleModules: context.visibleModules,
            assignedScope: context.scope.kind,
            rules: context.rules,
          }).allowed,
      );

      if (allowed.length > 0) {
        matrix[module] = [...allowed];
      }
    }

    return matrix;
  }

  /** How wide a list query may go for one (module, action). */
  scopeForListing(context: AuthorizationContext, module: ModuleKey, action: Action): ScopeKind {
    return effectiveScopeFor(context.scope.kind, module, action, context.rules);
  }

  /** The separation-of-duties control that would apply, for explaining a disabled control. */
  governingSod(context: AuthorizationContext, module: ModuleKey, action: Action) {
    return governingSodPolicy(context.sodPolicies, action, module);
  }

  // -------------------------------------------------------------------------

  /** A built-in role's template, or a custom role's stored matrix. */
  private permissionsFor(assignment: {
    roleKind: string;
    customRole: { permissions: unknown; enabled: boolean } | null;
  }): PermissionSet {
    if (assignment.roleKind === 'Custom') {
      // A disabled custom role grants nothing but keeps its assignments for audit.
      if (!assignment.customRole || !assignment.customRole.enabled) {
        return {};
      }
      // Sanitised, so a module or action that was renamed becomes *no grant* rather than an
      // unenforceable one. Fails closed.
      return sanitisePermissionSet(assignment.customRole.permissions);
    }

    const template = ROLE_TEMPLATES[assignment.roleKind as keyof typeof ROLE_TEMPLATES];
    return template?.permissions ?? {};
  }

  /**
   * The scope an assignment grants, capped by the role's own `maxScope`.
   *
   * This is the first privilege-escalation gate: an assignment that names `WholeCompany` for an
   * Employee is capped back to `OwnWork` here, so a mis-written assignment row cannot grant more
   * than the role is allowed to.
   */
  private scopeGrantFor(assignment: {
    roleKind: string;
    scopeKind: string;
    departmentIds: string[];
    selectedResourceIds: string[];
    customRole: { maxScope: string } | null;
  }): ScopeGrant | undefined {
    if (!isScopeKind(assignment.scopeKind)) {
      return undefined;
    }

    const ceiling =
      assignment.roleKind === 'Custom'
        ? isScopeKind(assignment.customRole?.maxScope ?? '')
          ? (assignment.customRole?.maxScope as ScopeKind)
          : 'OwnWork'
        : (ROLE_TEMPLATES[assignment.roleKind as keyof typeof ROLE_TEMPLATES]?.maxScope ??
          'OwnWork');

    const kind =
      SCOPE_BREADTH[assignment.scopeKind] > SCOPE_BREADTH[ceiling] ? ceiling : assignment.scopeKind;

    return {
      kind,
      selectedResourceIds: assignment.selectedResourceIds,
      departmentIds: assignment.departmentIds,
    };
  }

  private toPolicyRules(
    rows: readonly {
      layer: string;
      module: string | null;
      action: string | null;
      effect: string;
      mandatory: boolean;
      maxScope: string | null;
      reason: string;
    }[],
  ): PolicyRule[] {
    return rows.flatMap((row) => {
      if (!isPolicyLayer(row.layer)) {
        return [];
      }
      const module = row.module !== null && isModuleKey(row.module) ? row.module : null;
      const action = row.action !== null && isAction(row.action) ? row.action : null;

      // A stored rule naming a module or action the vocabulary no longer has is DROPPED, not
      // widened to a wildcard. Dropping a restriction is the permissive direction, so it is
      // logged — a rule that stopped applying because of a rename is a policy gap, not a tidy-up.
      if ((row.module !== null && module === null) || (row.action !== null && action === null)) {
        this.logger.warn(
          `Ignoring a ${row.layer} policy rule that names an unknown module/action ` +
            `("${row.module ?? '*'}"/"${row.action ?? '*'}"). It no longer restricts anything.`,
        );
        return [];
      }

      return [
        {
          layer: row.layer,
          module,
          action,
          effect: row.effect === 'Allow' ? ('Allow' as const) : ('Deny' as const),
          mandatory: row.mandatory,
          ...(row.maxScope !== null && isScopeKind(row.maxScope) ? { maxScope: row.maxScope } : {}),
          reason: row.reason,
        },
      ];
    });
  }

  private toSodPolicies(
    rows: readonly {
      module: string | null;
      action: string;
      rule: string;
      mandatory: boolean;
      reason: string;
    }[],
  ): SodPolicy[] {
    return rows.flatMap((row) =>
      isAction(row.action) && isSodRule(row.rule)
        ? [
            {
              action: row.action,
              module: row.module,
              rule: row.rule,
              mandatory: row.mandatory,
              reason: row.reason,
            },
          ]
        : [],
    );
  }

  /** Platform-layer rules apply to every company, so they are read outside any tenant scope. */
  private async platformPolicyRules(): Promise<PolicyRule[]> {
    const rows = await this.prisma.runAsPlatformOperation(() =>
      this.repository.listPlatformPolicyRulesForPlatform(),
    );
    return this.toPolicyRules(rows);
  }

  private async platformSodPolicies(): Promise<SodPolicy[]> {
    const rows = await this.prisma.runAsPlatformOperation(() =>
      this.repository.listPlatformSodPoliciesForPlatform(),
    );
    return this.toSodPolicies(rows);
  }

  /** The scope for a platform-plane caller acting on one named tenant. */
  platformScopeFor(tenantId: string): TenantScope {
    if (!isPlatformActor(getActor())) {
      throw new ForbiddenException('Platform administrator access is required.');
    }
    return tenantScopeForPlatformOperation(tenantId);
  }

  /** The tenant scope of the current request, when it has one. */
  currentTenantId(): string | undefined {
    const actor = getActor();
    return isTenantActor(actor) ? actor.tenantId : undefined;
  }
}
