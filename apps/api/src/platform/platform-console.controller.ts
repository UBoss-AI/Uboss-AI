import {
  Body,
  Controller,
  Get,
  NotFoundException,
  Param,
  ParseUUIDPipe,
  Post,
  Put,
  Query,
  UnauthorizedException,
} from '@nestjs/common';

import {
  MASTER_NAV_MODULE,
  PLATFORM_ROLE_KINDS,
  PLATFORM_ROLE_TEMPLATES,
  moduleForMasterNavKey,
} from '@uboss/types';

import { RequirePermission } from '../authorization/authorization.decorators.js';
import { AuthorizationService } from '../authorization/authorization.service.js';
import { PlatformRepository } from '../persistence/platform.repository.js';
import { UserRepository } from '../persistence/user.repository.js';
import { actorUserId } from '../request-context/authenticated-actor.js';
import { getActor } from '../request-context/request-context.js';
import { PlatformOnly } from '../tenancy/tenancy.decorators.js';
import { PlatformAdministrationService } from './platform-administration.service.js';
import { PlatformConsoleService } from './platform-console.service.js';
import {
  CreateFeatureFlagDto,
  CreatePlanDto,
  GrantPlatformRoleDto,
  ResolveServiceAlertDto,
  RevokePlatformRoleDto,
  SetSubscriptionDto,
  UpdateFeatureFlagDto,
  UpdatePlanDto,
  UpdatePlatformSettingDto,
} from './platform.dto.js';

/**
 * The UBoss Master Console API.
 *
 * ## Two guards, and this time the second one bites
 *
 * `@PlatformOnly` establishes that the caller is platform staff at all. `@RequirePermission`
 * then establishes **which part** of the console they may use — and as of Prompt 9 that is a real
 * check rather than a formality, because `platformContext` builds its permissions from the
 * caller's platform-role assignments instead of granting everyone all fifteen modules
 * (ADR-049).
 *
 * The pairing matters: `@PlatformOnly` alone would let a support engineer change a plan price,
 * and `@RequirePermission` alone would let a company admin reach a platform route if the
 * permission happened to be one they held.
 *
 * ## Which permission guards which route, and why
 *
 * | Route group            | Requires                          | Held by                        |
 * | ---------------------- | --------------------------------- | ------------------------------ |
 * | Dashboard, Companies   | `platform-dashboard`/`companies` `View` | every platform role      |
 * | Plans (write)          | `plans:Administer`                | Owner, Admin, Commercial       |
 * | Subscriptions (write)  | `companies:Administer`            | Owner, Admin                   |
 * | Feature flags (write)  | `release:Administer`              | **Owner only**                 |
 * | Platform settings      | `platform-settings:Administer`    | **Owner only**                 |
 * | Platform roles         | `platform-settings:Administer`    | **Owner only**                 |
 * | Service alerts (write) | `system-health:EditDraft`         | Owner, Engineer                |
 * | Security & Audit       | `security:View` / `security:Audit`| Owner, Security (+ read others)|
 *
 * Granting platform roles sits behind `platform-settings:Administer` rather than a permission of
 * its own, deliberately: **only a Platform Owner can create platform staff authority.** Putting
 * it behind `companies:Administer` would have let every Platform Admin appoint an Owner, which
 * would make the distinction between the two roles decorative.
 */
@Controller('platform/console')
@PlatformOnly()
export class PlatformConsoleController {
  constructor(
    private readonly console: PlatformConsoleService,
    private readonly administration: PlatformAdministrationService,
    private readonly platform: PlatformRepository,
    private readonly authorization: AuthorizationService,
    private readonly users: UserRepository,
  ) {}

  // -------------------------------------------------------------------------
  // Who am I, and what may I see
  // -------------------------------------------------------------------------

  /**
   * The caller's platform roles and the navigation they may see.
   *
   * The Master Console renders its sidebar from `navigation` here rather than from a local copy
   * of `MASTER_NAV`, so a module the API would refuse is never offered. That is a **rendering
   * hint, not the enforcement** — the same standing property as the company navigation since
   * Prompt 7 — and every route above carries its own check.
   *
   * No `@RequirePermission`: a platform actor must be able to discover that they hold no roles.
   * Guarding this endpoint with a permission would mean somebody locked out by a missing
   * assignment gets a bare 403 with no way to find out why, which is the worst version of a
   * fail-closed design.
   */
  @Get('me')
  async me(): Promise<unknown> {
    const userId = this.currentUserId();
    const [roles, context] = await Promise.all([
      this.authorization.platformRolesFor(userId),
      this.authorization.platformContext(userId),
    ]);

    const matrix = this.authorization.matrixFor(context);

    return {
      userId,
      roles,
      /** Empty when the caller holds no platform role. The console shows an explanation. */
      matrix,
      navigation: Object.entries(MASTER_NAV_MODULE).map(([navKey, module]) => ({
        navKey,
        module,
        // `View` on the module is what a navigation item needs. An unmapped key would be
        // `undefined` and is hidden by `moduleForMasterNavKey` returning nothing — see its
        // comment on why that fails closed.
        visible: (matrix[module] ?? []).includes('View'),
        actions: matrix[module] ?? [],
      })),
      /** The catalogue, so the console can explain what a role would grant before granting it. */
      roleCatalogue: PLATFORM_ROLE_KINDS.map((kind) => ({
        kind,
        label: PLATFORM_ROLE_TEMPLATES[kind].label,
        summary: PLATFORM_ROLE_TEMPLATES[kind].summary,
        modules: Object.keys(PLATFORM_ROLE_TEMPLATES[kind].permissions),
        administers: Object.entries(PLATFORM_ROLE_TEMPLATES[kind].permissions)
          .filter(([, actions]) => actions.includes('Administer'))
          .map(([module]) => module),
      })),
      ceiling: this.authorization.platformCeiling(),
    };
  }

  // -------------------------------------------------------------------------
  // Dashboard
  // -------------------------------------------------------------------------

  /**
   * Everything the Platform Overview screen needs, in one call.
   *
   * One aggregate rather than eight endpoints, because a dashboard assembled from eight parallel
   * requests shows eight different moments in time — and the panel most likely to be stale is
   * the one an operator is about to act on.
   *
   * Every panel carries a `provenance` field saying whether its numbers are measured, configured
   * or demo. See `PlatformConsoleService` for what is which; the short version is that companies,
   * seats-used and the whole security panel are real, and AI spend and service alerts are seeded.
   */
  @Get('dashboard')
  @RequirePermission({ module: 'platform-dashboard', action: 'View' })
  async dashboard(): Promise<unknown> {
    return this.console.dashboard();
  }

  // -------------------------------------------------------------------------
  // Companies
  // -------------------------------------------------------------------------

  @Get('companies')
  @RequirePermission({ module: 'companies', action: 'View' })
  async companies(): Promise<unknown> {
    return { companies: await this.console.companies() };
  }

  @Get('companies/:tenantId')
  @RequirePermission({ module: 'companies', action: 'View' })
  async companyDetail(@Param('tenantId', new ParseUUIDPipe()) tenantId: string): Promise<unknown> {
    const detail = await this.console.companyDetail(tenantId);
    if (!detail) {
      throw new NotFoundException('No such company.');
    }
    return detail;
  }

  /**
   * Put a company on a plan, or change its terms.
   *
   * `companies:Administer`, which only Owner and Admin hold — a Commercial role can define plans
   * but not decide which company is on one, because that is a customer-facing commitment.
   */
  @Put('companies/:tenantId/subscription')
  @RequirePermission({ module: 'companies', action: 'Administer' })
  async setSubscription(
    @Param('tenantId', new ParseUUIDPipe()) tenantId: string,
    @Body() body: SetSubscriptionDto,
  ): Promise<unknown> {
    const subscription = await this.administration.setSubscription({
      actorUserId: this.currentUserId(),
      tenantId,
      planCode: body.planCode,
      seatsLicensed: body.seatsLicensed,
      state: body.state,
      billingState: body.billingState,
      renewsAt: body.renewsAt === undefined ? undefined : new Date(body.renewsAt),
      aiAllowanceMinor: body.aiAllowanceMinor,
      extraModules: body.extraModules,
      removedModules: body.removedModules,
      pinnedFlag: body.pinnedFlag,
      notes: body.notes,
      reason: body.reason,
    });
    return { id: subscription.id, tenantId, planCode: body.planCode, state: subscription.state };
  }

  // -------------------------------------------------------------------------
  // Create Company — the entry point only
  // -------------------------------------------------------------------------

  /**
   * What the Create Company screen needs to open, and **not** a provisioning endpoint.
   *
   * The client's instruction for this prompt was explicit: do not implement the provisioning
   * wizard until the next prompt. So this returns the defaults and the constraints the entry
   * screen shows — the plan list, the default plan, the locked "no public signup" rule and the
   * five step names — and there is deliberately **no POST here at all**.
   *
   * Shipping a half-wired provisioning endpoint would be the worst option: `TenantProvisioningService`
   * already exists and works, so a `POST` would be a few lines and would quietly become the real
   * provisioning path without the wizard's plan selection, entitlement choices, budget or
   * security steps ever being built. The absence is the point, and `readiness` below states it
   * rather than leaving the screen to imply it.
   */
  @Get('create-company/prerequisites')
  @RequirePermission({ module: 'create-company', action: 'View' })
  async createCompanyPrerequisites(): Promise<unknown> {
    const [plans, settings] = await Promise.all([
      this.platform.listPlans(),
      this.platform.listSettings(),
    ]);

    const setting = (key: string) => settings.find((row) => row.key === key)?.value ?? null;

    return {
      steps: ['Company & Admin', 'Plan & Modules', 'AI & Skills', 'Budget & Security', 'Review'],
      plans: plans.map((plan) => ({
        code: plan.code,
        name: plan.name,
        tier: plan.tier,
        seatLimit: plan.seatLimit,
        entitledModules: plan.entitledModules,
        priceMinor: plan.priceMinor,
        currency: plan.currency,
      })),
      defaults: {
        planCode: setting('provisioning.default_plan_code'),
        timezone: setting('provisioning.default_timezone'),
        currency: setting('provisioning.default_currency'),
      },
      constraints: {
        companyCreation: setting('governance.company_creation'),
        // Restated on the entry screen because it is a locked client requirement and the screen
        // is where somebody would otherwise look for a self-service option.
        note:
          'There is no public company signup. A company is created here, and its first ' +
          'administrator receives an activation invitation rather than a password.',
      },
      readiness: {
        wizardImplemented: false,
        note:
          'The five-step provisioning wizard is the next prompt. This endpoint intentionally ' +
          'has no POST: provisioning exists as a service but must not become reachable without ' +
          'the plan, entitlement, budget and security steps the wizard is responsible for.',
      },
    };
  }

  // -------------------------------------------------------------------------
  // Plans & Entitlements
  // -------------------------------------------------------------------------

  @Get('plans')
  @RequirePermission({ module: 'plans', action: 'View' })
  async plans(@Query('includeRetired') includeRetired?: string): Promise<unknown> {
    const [plans, counts] = await Promise.all([
      this.platform.listPlans({ includeRetired: includeRetired === 'true' }),
      this.platform.subscriberCounts(),
    ]);

    return {
      plans: plans.map((plan) => ({
        id: plan.id,
        code: plan.code,
        tier: plan.tier,
        name: plan.name,
        description: plan.description,
        seatLimit: plan.seatLimit,
        entitledModules: plan.entitledModules,
        aiAllowanceMinor: plan.aiAllowanceMinor,
        priceMinor: plan.priceMinor,
        currency: plan.currency,
        active: plan.active,
        sortOrder: plan.sortOrder,
        /** Companies on this plan. A plan with subscribers cannot be retired. */
        subscribers: counts[plan.id] ?? 0,
      })),
    };
  }

  @Post('plans')
  @RequirePermission({ module: 'plans', action: 'Administer' })
  async createPlan(@Body() body: CreatePlanDto): Promise<unknown> {
    const plan = await this.administration.createPlan({
      actorUserId: this.currentUserId(),
      code: body.code,
      tier: body.tier,
      name: body.name,
      description: body.description,
      seatLimit: body.seatLimit,
      entitledModules: body.entitledModules,
      aiAllowanceMinor: body.aiAllowanceMinor,
      priceMinor: body.priceMinor,
      currency: body.currency,
      sortOrder: body.sortOrder,
    });
    return { id: plan.id, code: plan.code };
  }

  @Put('plans/:planId')
  @RequirePermission({ module: 'plans', action: 'Administer' })
  async updatePlan(
    @Param('planId', new ParseUUIDPipe()) planId: string,
    @Body() body: UpdatePlanDto,
  ): Promise<unknown> {
    const plan = await this.administration.updatePlan({
      actorUserId: this.currentUserId(),
      planId,
      name: body.name,
      description: body.description,
      seatLimit: body.seatLimit,
      entitledModules: body.entitledModules,
      aiAllowanceMinor: body.aiAllowanceMinor,
      priceMinor: body.priceMinor,
      active: body.active,
      sortOrder: body.sortOrder,
    });
    return { id: plan.id, code: plan.code, active: plan.active, version: plan.version };
  }

  // -------------------------------------------------------------------------
  // Release & Feature Control
  // -------------------------------------------------------------------------

  @Get('feature-flags')
  @RequirePermission({ module: 'release', action: 'View' })
  async featureFlags(): Promise<unknown> {
    const flags = await this.platform.listFeatureFlags();
    return {
      flags: flags.map((flag) => ({
        id: flag.id,
        key: flag.key,
        description: flag.description,
        stage: flag.stage,
        state: flag.state,
        audience: flag.audience,
        rolloutPercent: flag.rolloutPercent,
        enabledCompanies: flag.enabledTenantIds.length,
        rationale: flag.rationale,
        updatedAt: flag.updatedAt,
        version: flag.version,
      })),
    };
  }

  /** `release:Administer` — Platform Owner only. A flag changes every customer at once. */
  @Post('feature-flags')
  @RequirePermission({ module: 'release', action: 'Administer' })
  async createFeatureFlag(@Body() body: CreateFeatureFlagDto): Promise<unknown> {
    const flag = await this.administration.createFeatureFlag({
      actorUserId: this.currentUserId(),
      key: body.key,
      description: body.description,
      audience: body.audience,
      rationale: body.rationale,
    });
    return { id: flag.id, key: flag.key, stage: flag.stage, state: flag.state };
  }

  @Put('feature-flags/:key')
  @RequirePermission({ module: 'release', action: 'Administer' })
  async updateFeatureFlag(
    @Param('key') key: string,
    @Body() body: UpdateFeatureFlagDto,
  ): Promise<unknown> {
    const flag = await this.administration.updateFeatureFlag({
      actorUserId: this.currentUserId(),
      key,
      stage: body.stage,
      state: body.state,
      audience: body.audience,
      rolloutPercent: body.rolloutPercent,
      enabledTenantIds: body.enabledTenantIds,
      rationale: body.rationale,
      reason: body.reason,
    });
    return {
      key: flag.key,
      stage: flag.stage,
      state: flag.state,
      rolloutPercent: flag.rolloutPercent,
      version: flag.version,
    };
  }

  // -------------------------------------------------------------------------
  // Platform Settings
  // -------------------------------------------------------------------------

  /**
   * Every global setting, grouped as the reference's two cards.
   *
   * Read at `platform-settings:View`, which every platform role holds — an operator should be
   * able to *see* how the platform is configured even when they cannot change it. Writing is
   * Owner-only.
   */
  @Get('settings')
  @RequirePermission({ module: 'platform-settings', action: 'View' })
  async settings(): Promise<unknown> {
    const settings = await this.platform.listSettings();
    return {
      settings: settings.map((setting) => ({
        key: setting.key,
        value: setting.value,
        description: setting.description,
        section: setting.section,
        /** A locked setting is shown and refused on write — it is a rule, not a preference. */
        locked: setting.locked,
        updatedAt: setting.updatedAt,
        version: setting.version,
      })),
      sections: [...new Set(settings.map((setting) => setting.section))],
    };
  }

  @Put('settings/:key')
  @RequirePermission({ module: 'platform-settings', action: 'Administer' })
  async updateSetting(
    @Param('key') key: string,
    @Body() body: UpdatePlatformSettingDto,
  ): Promise<unknown> {
    const setting = await this.administration.updateSetting({
      actorUserId: this.currentUserId(),
      key,
      value: body.value,
      reason: body.reason,
    });
    return { key: setting.key, value: setting.value, version: setting.version };
  }

  // -------------------------------------------------------------------------
  // Platform roles — Owner only
  // -------------------------------------------------------------------------

  /**
   * Who holds platform authority. The access review.
   *
   * Behind `security:Audit`, not `platform-settings:Administer`: reviewing who has access is a
   * security function and a Platform Security reviewer must be able to do it without being able
   * to change anything. Granting is a different permission entirely.
   */
  @Get('platform-roles')
  @RequirePermission({ module: 'security', action: 'Audit' })
  async platformRoles(): Promise<unknown> {
    const [holders, actors] = await Promise.all([
      this.platform.platformRoleHolders(),
      this.users.listPlatformActorsForPlatform(),
    ]);

    const now = Date.now();
    const held = new Set(holders.map((holder) => holder.userId));

    return {
      assignments: holders.map((holder) => ({
        id: holder.id,
        userId: holder.userId,
        ubossUniqueId: holder.user.ubossUniqueId,
        role: holder.role,
        label: PLATFORM_ROLE_TEMPLATES[holder.role].label,
        justification: holder.justification,
        expiresAt: holder.expiresAt,
        /** Expiry is evaluated on read, so an expired grant is reported as no longer effective. */
        effective: holder.expiresAt === null || holder.expiresAt.getTime() > now,
        grantedByUserId: holder.grantedByUserId,
        /** A backfilled grant has no granting human. Surfaced so a review can narrow it. */
        backfilled: holder.grantedByUserId === null,
        createdAt: holder.createdAt,
      })),
      /**
       * Platform actors with **no** platform role.
       *
       * The most useful row on an access review, and the one a list of assignments cannot show:
       * these accounts are platform staff who currently reach nothing, which is either correct
       * (an offboarding half-done) or a person locked out and about to raise a ticket.
       */
      platformActorsWithoutRoles: actors
        .filter((actor) => !held.has(actor.id))
        .map((actor) => ({
          userId: actor.id,
          ubossUniqueId: actor.ubossUniqueId,
          displayName: actor.displayName,
        })),
    };
  }

  @Post('platform-roles')
  @RequirePermission({ module: 'platform-settings', action: 'Administer' })
  async grantPlatformRole(@Body() body: GrantPlatformRoleDto): Promise<unknown> {
    const assignment = await this.administration.grantPlatformRole({
      actorUserId: this.currentUserId(),
      userId: body.userId,
      role: body.role,
      justification: body.justification,
      expiresAt: body.expiresAt === undefined ? undefined : new Date(body.expiresAt),
    });
    return { id: assignment.id, userId: assignment.userId, role: assignment.role };
  }

  @Post('platform-roles/:assignmentId/revoke')
  @RequirePermission({ module: 'platform-settings', action: 'Administer' })
  async revokePlatformRole(
    @Param('assignmentId', new ParseUUIDPipe()) assignmentId: string,
    @Body() body: RevokePlatformRoleDto,
  ): Promise<unknown> {
    const assignment = await this.administration.revokePlatformRole({
      actorUserId: this.currentUserId(),
      assignmentId,
      reason: body.reason,
    });
    return { id: assignment.id, revokedAt: assignment.revokedAt };
  }

  // -------------------------------------------------------------------------
  // System Health / service alerts
  // -------------------------------------------------------------------------

  @Get('service-alerts')
  @RequirePermission({ module: 'system-health', action: 'View' })
  async serviceAlerts(@Query('openOnly') openOnly?: string): Promise<unknown> {
    const alerts = await this.platform.listServiceAlerts({ openOnly: openOnly !== 'false' });
    return {
      alerts: alerts.map((alert) => ({
        id: alert.id,
        service: alert.service,
        severity: alert.severity,
        state: alert.state,
        summary: alert.summary,
        detail: alert.detail,
        affectedTenantId: alert.affectedTenantId,
        openedAt: alert.openedAt,
        acknowledgedAt: alert.acknowledgedAt,
        resolvedAt: alert.resolvedAt,
      })),
      provenance: 'demo',
      note:
        'Real table, seeded rows. The health checks that write alerts are the System Health ' +
        'module’s work — nothing here is measured yet.',
    };
  }

  @Post('service-alerts/:alertId/acknowledge')
  @RequirePermission({ module: 'system-health', action: 'EditDraft' })
  async acknowledgeAlert(@Param('alertId', new ParseUUIDPipe()) alertId: string): Promise<unknown> {
    const alert = await this.administration.acknowledgeServiceAlert({
      actorUserId: this.currentUserId(),
      alertId,
    });
    return { id: alert.id, state: alert.state, acknowledgedAt: alert.acknowledgedAt };
  }

  @Post('service-alerts/:alertId/resolve')
  @RequirePermission({ module: 'system-health', action: 'EditDraft' })
  async resolveAlert(
    @Param('alertId', new ParseUUIDPipe()) alertId: string,
    @Body() body: ResolveServiceAlertDto,
  ): Promise<unknown> {
    const alert = await this.administration.resolveServiceAlert({
      actorUserId: this.currentUserId(),
      alertId,
      resolution: body.resolution,
    });
    return { id: alert.id, state: alert.state, resolvedAt: alert.resolvedAt };
  }

  // -------------------------------------------------------------------------
  // Module shells — declared, permission-scoped, and honest about being empty
  // -------------------------------------------------------------------------

  /**
   * The modules this prompt ships as shells, and what each is waiting for.
   *
   * A single endpoint rather than seven empty ones. It exists so a shell screen renders
   * something true — which module, which permission guards it, what it needs before it can be
   * built — instead of the reference's "wired and permission-scoped, full tables in the next
   * delivery batch", which tells a reader nothing about *why*.
   *
   * `system-health` and `release` are absent because they are built, and `credits` and `billing`
   * are here despite having real columns behind them because neither has a metering or payment
   * integration, so the screens would be showing seeded figures as if they were operational.
   */
  @Get('module-status')
  @RequirePermission({ module: 'platform-dashboard', action: 'View' })
  moduleStatus(): unknown {
    return {
      modules: [
        {
          navKey: 'billing',
          module: moduleForMasterNavKey('billing'),
          title: 'Billing & Payments',
          state: 'shell',
          blockedOn:
            'No payment provider is connected. Invoices, dunning and payment state need a ' +
            'provider integration and a webhook path before a screen here can be anything but ' +
            'a mock.',
          available:
            'Billing state per company, set by hand, on the Companies and Company Detail screens.',
        },
        {
          navKey: 'credits',
          module: moduleForMasterNavKey('credits'),
          title: 'AI Usage & Allowance',
          state: 'live',
          // Prompts 30 and 31 built this. What remains blocked is narrower and worth stating
          // precisely: the numbers are real but small, because no provider has ever been
          // called — every gateway call is answered by the mock adapter at zero cost.
          blockedOn:
            'Usage is metered for real, but no provider credential has been supplied, so every ' +
            'call costs nothing and the figures stay at zero until one is. Revenue reporting ' +
            'across companies is not built: this is per-company allowance and history.',
          available:
            'Per-company allowance, used, reserved and remaining; the immutable cost ledger; ' +
            'credit requests with Finance approval, adjustment and rejection; credit grants ' +
            'with effective dates and expiry; reallocation; monthly reset and carry-forward; ' +
            'plan change, payment-failure revocation and negative-balance policy.',
        },
        {
          navKey: 'providers',
          module: moduleForMasterNavKey('providers'),
          title: 'Providers & Models',
          state: 'live',
          // Prompt 29 built this. What remains blocked is narrower and worth stating precisely:
          // adapters exist for Anthropic and OpenAI and have never been run, because no
          // credential has been supplied. Provider *health* in the sense of live latency and
          // error rates needs real calls to measure.
          blockedOn:
            'No provider credential has been supplied, so the Anthropic and OpenAI adapters are ' +
            'implemented but have never reached a provider. Live health and error rates need ' +
            'real calls; every gateway call today records producedByRealModel = false.',
          available:
            'Provider profiles and modes, models and their capabilities, logical model profile ' +
            'routing with fallback policy, immutable pricing versions, provider/model lifecycle, ' +
            'Test Connection, and the recorded call history with provider request IDs.',
        },
        {
          navKey: 'skills',
          module: moduleForMasterNavKey('skills'),
          title: 'Skill Catalog',
          state: 'shell',
          blockedOn:
            'Skills have no model yet. Note that a Skill Catalog is not the Templates Library, ' +
            'which is explicitly out of scope for this baseline.',
          available: null,
        },
        {
          navKey: 'testing',
          module: moduleForMasterNavKey('testing'),
          title: 'Testing & Evaluation',
          state: 'shell',
          blockedOn:
            'Eval suites need Engine Agents to evaluate. Nothing runs yet, so a pass rate would ' +
            'be a number with no subject.',
          available: null,
        },
        {
          navKey: 'support',
          module: moduleForMasterNavKey('support'),
          title: 'Support & Operations',
          state: 'shell',
          blockedOn:
            'No ticket model. The one support capability that IS built is break-glass recovery, ' +
            'which has its own audited endpoints.',
          available: 'Break-glass request, approval and revocation, at /platform/break-glass.',
        },
        {
          navKey: 'dev-ops',
          module: moduleForMasterNavKey('dev-ops'),
          title: 'Development & Operations',
          state: 'shell',
          blockedOn:
            'Environments, builds and deployments are external systems with no integration ' +
            'yet. The reference prototype shows 22 subsections here; none of them have a data ' +
            'source.',
          available: null,
          note:
            'Not in the client’s Prompt 9 module list, but present in the locked navigation. ' +
            'Shipped as a shell so the navigation has no dead end.',
        },
      ],
    };
  }

  private currentUserId(): string {
    const userId = actorUserId(getActor());
    if (!userId) {
      // Unreachable behind `@PlatformOnly`. It throws rather than defaulting because every write
      // here is attributed to a named person, and an unattributed platform change is worse than
      // a failed request.
      throw new UnauthorizedException('The Master Console requires an identified platform actor.');
    }
    return userId;
  }
}
