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
  type PrecedenceResult,
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
  /**
   * One entry per live role assignment, each keeping its OWN actions with its OWN scope.
   *
   * `granted` and `scope` above are summaries — the union of the actions and the widest of the
   * scopes — and they are what a screen reads to decide what to draw. Deciding a request from
   * those two summaries was a privilege-combination defect: an action granted by a narrow role
   * was then exercised at the widest scope any *other* role happened to carry.
   *
   * The seed shows it without any contrivance. Kavya Nair holds Employee (`todo:EditDraft`, own
   * work) and, while standing in as an approver, Approver (`todo:View`/`Comment`, one department).
   * Combining them gave her `EditDraft` across the department, and she could start, block, attach
   * evidence to and submit a task belonging to somebody else — proven in
   * `apps/web/tmp/todo-lifecycle.mjs` before this field existed. Rajiv Mehta carries the same
   * shape in the shipped seed (Head over one department, Approver over two), so this was never
   * specific to a temporary grant.
   *
   * Scope belongs to the assignment that granted the action. `authorize` therefore asks each
   * assignment the whole question — may THIS role do this, here — and allows the request only if
   * one assignment answers yes on its own.
   */
  units: readonly { permissions: PermissionSet; scope: ScopeGrant }[];
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
        units: [{ permissions: PLATFORM_PERMISSIONS, scope: { kind: 'WholeCompany' } }],
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
    const units: { permissions: PermissionSet; scope: ScopeGrant }[] = [];

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
        // This role's actions, kept with this role's scope. An assignment with no resolvable
        // scope grants nothing on a resource, so it contributes no unit rather than a unit that
        // would fall back to somebody else's reach.
        units.push({ permissions: permissions as PermissionSet, scope: assignedScope });
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
      units,
    };
  }

  /**
   * Which navigation entries this person would be refused if they clicked them.
   *
   * Module presence is not the whole answer. A nav item is offered when the person holds a grant
   * on its module, and for almost every screen that is exactly right — but a screen whose landing
   * request names a specific row is also subject to the scope layer, and the scope layer can
   * refuse what the module grant allowed.
   *
   * Performance is the case that found this, and the case that has since been fixed at its root.
   * `GET performance/me` used to ask for a resource identified only by its owner; a
   * department-scoped role cannot place a resource carrying no department, so the request failed
   * closed, and this method's answer was to remove Performance from a Head's sidebar. That hid a
   * section CR-03 grants a Head (`performance: View, Export`) rather than fixing why it was
   * refused. `PerformanceService.viewFor` now checks the self case before the scope layer — the
   * same shape as `profileFor` — so reading one's own record needs the grant and nothing else.
   *
   * This runs the **same** `authorize` call the route runs, rather than restating the rule. A
   * second implementation of "can this person open Performance" would be a second thing to keep
   * in step, and the two would eventually disagree — which is the whole argument the navigation
   * filter already makes about role labels. So the call here has lost its `resource` exactly as
   * the route's did.
   *
   * It stays a list rather than becoming `[]` inline: the mechanism is what matters, and the next
   * screen whose landing request names a row will need it.
   *
   * Presentation only, in both directions: a key listed here is refused by the route as well, and
   * a key missing here is still refused by the route if the engine changes its mind.
   */
  async unavailableNavKeys(context: AuthorizationContext): Promise<string[]> {
    const unavailable: string[] = [];

    // Performance's landing request is the signed-in person's OWN record, which is why it carries
    // no resource: the route does not either.
    const ownPerformance = await this.authorize(context, {
      module: 'performance',
      action: 'View',
    });
    if (!ownPerformance.allowed) unavailable.push('performance');

    return unavailable;
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
      // A platform role carries no company scope to combine, so the summary IS the unit.
      units: [{ permissions: granted, scope: { kind: 'WholeCompany' } }],
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
   * How far a person's reach extends **for one particular permission** — kind and departments.
   *
   * For a list — a roster, a report, a dashboard count — there is no single row to test, so the
   * query is built from a scope rather than decided per row. Taking that scope from the widest
   * role a person holds repeats the combination defect on the read side: a role that grants the
   * module narrowly would have its rows widened by a role that grants a wider scope and not the
   * module. So the answer is the widest scope **among the roles that actually grant this action**,
   * and `null` when no role grants it at all.
   *
   * It returns the departments too, and there is no kind-only variant on purpose: a caller given
   * only the kind has to find the departments somewhere, and the only other place to find them is
   * the reader's employment record.
   *
   * A list is built from a scope rather than decided row by row, so the scope has to carry its
   * own departments. Deriving them from the reader's employment record instead was a same-tenant
   * exposure: somebody granted one department was shown the department they happen to work in.
   * Proven against the running product — a person granted `Head` over Customer Operations was
   * served the whole of Operations, five people including their own Head and Manager, because
   * that is where their employment record sits.
   *
   * The departments come only from the assignments that grant this action, so a wide department
   * grant on a module somebody cannot open contributes nothing. An empty list is nobody, never
   * everybody — a `Department` grant naming no department reaches no rows, which is the
   * fail-closed reading of a misconfiguration.
   */
  reachForPermission(
    context: AuthorizationContext,
    module: ModuleKey,
    action: Action,
  ): { kind: ScopeKind; departmentIds: readonly string[] } | null {
    const reaching = context.units.filter((unit) =>
      (unit.permissions[module] ?? []).includes(action),
    );
    if (reaching.length === 0) {
      return null;
    }

    const kind = widestGrant(reaching.map((unit) => unit.scope))?.kind;
    if (kind === undefined) {
      return null;
    }

    const departmentIds = [
      ...new Set(
        reaching
          .filter((unit) => unit.scope.kind === 'Department' || unit.scope.kind === 'MultipleDepartments')
          .flatMap((unit) => [...(unit.scope.departmentIds ?? [])]),
      ),
    ];

    return { kind, departmentIds };
  }

  /** The refusal for somebody no role reaches — the fail-closed answer, in one place. */
  private noRoleRefusal(): AuthorizationDecision {
    return {
      allowed: false,
      reason: 'no-role-assignment',
      message: 'You have no role in this company yet. Ask an administrator to assign one.',
    };
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
      return this.noRoleRefusal();
    }

    /*
     * Phases 1 and 2, asked **once per role assignment**.
     *
     * Each assignment answers the whole question with its own actions and its own scope, and one
     * assignment has to answer yes on its own. Combining the union of everybody's actions with the
     * widest of everybody's scopes — which is what reading `context.granted` and `context.scope`
     * here used to do — let a narrow role's action be exercised at a wider role's reach. See the
     * note on `units`.
     *
     * A person holding one role is unaffected: their single unit carries exactly the summary this
     * used to read.
     */
    const units =
      context.units.length > 0
        ? context.units
        : [{ permissions: context.granted, scope: context.scope }];

    let refusal: AuthorizationDecision | null = null;
    // A refusal that got as far as the row is more useful than one that stopped at the role, so
    // the message the caller sees is the furthest any of their roles actually reached.
    const rank = (decision: AuthorizationDecision): number =>
      decision.reason === 'out-of-scope' || decision.reason === 'scope-unevaluable' ? 2 : 1;
    const keep = (decision: AuthorizationDecision): void => {
      if (refusal === null || rank(decision) > rank(refusal)) refusal = decision;
    };

    const precedenceFor = (unit: (typeof units)[number]): PrecedenceResult =>
      evaluatePrecedence({
        userType: context.userType,
        module: input.module,
        action: input.action,
        grantedActions: unit.permissions[input.module] ?? [],
        visibleModules: context.visibleModules,
        assignedScope: unit.scope.kind,
        rules: context.rules,
      });

    // ---- The coarse check: no row to test, so one role answering yes settles it. ----
    const resource = input.resource;
    if (!resource) {
      for (const unit of units) {
        const precedence = precedenceFor(unit);
        if (precedence.allowed) return precedence.decision;
        keep(precedence.decision);
      }
      return refusal ?? this.noRoleRefusal();
    }

    // ---- This particular row, against each role's own reach. ----
    let allowedBy: { precedence: PrecedenceResult; detail: string } | null = null;

    for (const unit of units) {
      const precedence = precedenceFor(unit);

      if (!precedence.allowed) {
        keep(precedence.decision);
        continue;
      }

      const scopeOutcome = await isInScopeAsync({
        // The scope the *policy layers* left, not the raw assignment: a layer that narrowed a
        // manager to their own work must actually narrow the row check too, or the narrowing was
        // decorative.
        grant: { ...unit.scope, kind: precedence.effectiveScope },
        resource,
        actorUserId: context.userId,
        tenantId: context.tenantId,
        ...(this.hierarchy === undefined ? {} : { hierarchy: this.hierarchy }),
      });

      if (!scopeOutcome.inScope) {
        keep({
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
        });
        continue;
      }

      allowedBy = { precedence, detail: scopeOutcome.detail };
      break;
    }

    if (allowedBy === null) {
      return refusal ?? this.noRoleRefusal();
    }

    const precedence = allowedBy.precedence;
    const scopeOutcome = { detail: allowedBy.detail };

    // ---- Separation of duties. Last, because it is the most specific. ----
    const sod = checkSeparationOfDuties({
      policies:
        input.additionalSodPolicies === undefined
          ? context.sodPolicies
          : [...context.sodPolicies, ...input.additionalSodPolicies],
      action: input.action,
      module: input.module,
      actorUserId: context.userId,
      resource,
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
        resourceId: resource.id,
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
