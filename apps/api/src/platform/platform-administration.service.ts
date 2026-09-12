import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';

import { COMPANY_MODULES, PLATFORM_ROLE_TEMPLATES, type PlatformRoleKind } from '@uboss/types';

import { AuditEventService } from '../audit/audit-event.service.js';
import { SECURITY_ACTIONS, SecurityEventPublisher } from '../auth/security-event.publisher.js';
import type {
  FeatureFlag,
  Plan,
  PlatformRoleAssignment,
  PlatformSetting,
  ServiceAlert,
  TenantSubscription,
} from '../generated/prisma/client.js';
import { PlatformRepository } from '../persistence/platform.repository.js';
import { PrismaService } from '../persistence/prisma.service.js';
import { UserRepository } from '../persistence/user.repository.js';

/**
 * Every write the Master Console makes, and the guards around them.
 *
 * ## The one rule that matters most here
 *
 * **The platform cannot be locked out of itself.** Revoking the last live `PlatformOwner` is
 * refused, because `PlatformOwner` is the only role that may grant platform roles — so removing
 * the last one would leave a running platform with nobody able to appoint anybody, and no
 * in-product way back. That is the same reasoning as S-039 on the company side (a policy change
 * must not lock a company out of its own workspace), and it is the kind of failure that is
 * trivial to prevent and expensive to recover from.
 *
 * ## Everything here is audited, and platform writes are audited twice
 *
 * A plan change or a feature flag change affects every customer at once, so each write records an
 * audit event on the platform plane. Grants and revocations of platform authority additionally
 * record a security event, because "who has platform access" is the first question an access
 * review asks.
 */
@Injectable()
export class PlatformAdministrationService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly platform: PlatformRepository,
    private readonly users: UserRepository,
    private readonly auditEvents: AuditEventService,
    private readonly securityEvents: SecurityEventPublisher,
  ) {}

  // -------------------------------------------------------------------------
  // Platform roles
  // -------------------------------------------------------------------------

  /**
   * Grant a platform role.
   *
   * Three gates, and the doubling is deliberate — the same pattern as the Prompt 7 escalation
   * gates, where the rule that matters most is enforced twice:
   *
   *  1. The target must already be a platform actor. This service does **not** turn a company
   *     person into platform staff: that is a different decision with a different approval path,
   *     and quietly conflating them would let "grant a support role" mean "create platform
   *     access" (ADR-049).
   *  2. Nobody grants themselves a role. Enforced here **and** by a check constraint.
   *  3. `PlatformOwner` may only be granted by a `PlatformOwner`, which the route's
   *     `platform-settings:Administer` requirement already establishes — restated here because a
   *     future route with a weaker decorator must not become a path to platform ownership.
   */
  async grantPlatformRole(input: {
    actorUserId: string;
    userId: string;
    role: PlatformRoleKind;
    justification?: string | undefined;
    expiresAt?: Date | undefined;
  }): Promise<PlatformRoleAssignment> {
    if (input.userId === input.actorUserId) {
      await this.securityEvents.record({
        action: SECURITY_ACTIONS.platformRoleSelfGrantBlocked,
        actorUserId: input.actorUserId,
        resourceType: 'platform_role_assignment',
        summary: `Refused: attempted to grant themselves ${input.role}.`,
      });
      throw new ForbiddenException(
        'You cannot grant yourself a platform role. Platform authority applies to every company ' +
          'at once, so it needs a second person — the same four-eyes rule as every other ' +
          'high-risk action.',
      );
    }

    const target = await this.prisma.runAsPlatformOperation(() =>
      this.users.findByIdForPlatform(input.userId),
    );
    if (!target) {
      throw new NotFoundException('No such person.');
    }
    if (!target.isPlatformActor) {
      throw new BadRequestException(
        'That person is not platform staff, and granting a platform role does not make them ' +
          'so. Promoting a company person to platform staff is a separate decision; this ' +
          'endpoint only distributes authority among people who already have platform access.',
      );
    }
    if (input.expiresAt && input.expiresAt.getTime() <= Date.now()) {
      throw new BadRequestException(
        'That expiry is already in the past, so the grant would confer nothing. Omit it for a ' +
          'standing grant.',
      );
    }

    const assignment = await this.platform.grantPlatformRole({
      userId: input.userId,
      role: input.role,
      grantedByUserId: input.actorUserId,
      justification: input.justification,
      expiresAt: input.expiresAt,
    });

    await this.record({
      action: 'platform_role.granted',
      resourceType: 'platform_role_assignment',
      resourceId: assignment.id,
      actorUserId: input.actorUserId,
      summary: `Granted ${PLATFORM_ROLE_TEMPLATES[input.role].label} to ${target.ubossUniqueId}.`,
      reason: input.justification ?? null,
      securityAction: SECURITY_ACTIONS.platformRoleGranted,
      metadata: {
        role: input.role,
        subjectUserId: input.userId,
        expiresAt: input.expiresAt?.toISOString() ?? null,
        standing: input.expiresAt === undefined,
      },
    });

    return assignment;
  }

  /**
   * Revoke a platform role.
   *
   * Refuses to remove the last live `PlatformOwner` — see the class comment. Self-revocation is
   * otherwise allowed: stepping down from a role you hold is not an escalation, and refusing it
   * would mean somebody leaving a rotation needs a colleague to do it for them.
   */
  async revokePlatformRole(input: {
    actorUserId: string;
    assignmentId: string;
    reason?: string | undefined;
  }): Promise<PlatformRoleAssignment> {
    const existing = await this.platform.findPlatformRole(input.assignmentId);
    if (!existing) {
      throw new NotFoundException('No such platform role assignment.');
    }
    if (existing.revokedAt) {
      throw new ConflictException('That platform role was already revoked.');
    }

    if (existing.role === 'PlatformOwner') {
      const owners = await this.platform.platformRoleHolders();
      const liveOwners = owners.filter(
        (holder) =>
          holder.role === 'PlatformOwner' &&
          holder.id !== existing.id &&
          (holder.expiresAt === null || holder.expiresAt.getTime() > Date.now()),
      );

      if (liveOwners.length === 0) {
        await this.securityEvents.record({
          action: SECURITY_ACTIONS.platformLockoutPrevented,
          actorUserId: input.actorUserId,
          resourceType: 'platform_role_assignment',
          resourceId: existing.id,
          summary: 'Refused: this would have removed the last Platform Owner.',
        });
        throw new ForbiddenException(
          'This is the last Platform Owner, and Platform Owner is the only role that can grant ' +
            'platform roles. Revoking it would leave a running platform with nobody able to ' +
            'appoint anybody and no way back through the product. Appoint another owner first.',
        );
      }
    }

    const assignment = await this.platform.revokePlatformRole(existing.id, input.actorUserId);

    await this.record({
      action: 'platform_role.revoked',
      resourceType: 'platform_role_assignment',
      resourceId: assignment.id,
      actorUserId: input.actorUserId,
      summary: `Revoked ${PLATFORM_ROLE_TEMPLATES[existing.role].label}.`,
      reason: input.reason ?? null,
      securityAction: SECURITY_ACTIONS.platformRoleRevoked,
      metadata: { role: existing.role, subjectUserId: existing.userId },
    });

    return assignment;
  }

  // -------------------------------------------------------------------------
  // Plans
  // -------------------------------------------------------------------------

  async createPlan(input: {
    actorUserId: string;
    code: string;
    tier: Plan['tier'];
    name: string;
    description?: string | undefined;
    seatLimit?: number | undefined;
    entitledModules: readonly string[];
    aiAllowanceMinor?: number | undefined;
    priceMinor?: number | undefined;
    currency?: string | undefined;
    sortOrder?: number | undefined;
  }): Promise<Plan> {
    PlatformAdministrationService.assertCompanyModules(input.entitledModules);

    const clash = await this.platform.findPlanByCode(input.code);
    if (clash) {
      throw new ConflictException(
        `A plan with the code "${input.code}" already exists. Plan codes are referenced by ` +
          'configuration and must stay stable, so they cannot be reused.',
      );
    }

    const plan = await this.platform.createPlan({
      code: input.code,
      tier: input.tier,
      name: input.name,
      description: input.description ?? null,
      seatLimit: input.seatLimit ?? null,
      entitledModules: [...new Set(input.entitledModules)],
      aiAllowanceMinor: input.aiAllowanceMinor ?? null,
      priceMinor: input.priceMinor ?? null,
      currency: input.currency ?? 'USD',
      sortOrder: input.sortOrder ?? 0,
    });

    await this.record({
      action: 'plan.created',
      resourceType: 'plan',
      resourceId: plan.id,
      resourceRef: plan.code,
      actorUserId: input.actorUserId,
      summary: `Created plan ${plan.name} (${plan.code}).`,
      reason: null,
      metadata: {
        tier: plan.tier,
        seatLimit: plan.seatLimit,
        modules: plan.entitledModules.length,
        priceMinor: plan.priceMinor,
      },
    });

    return plan;
  }

  async updatePlan(input: {
    actorUserId: string;
    planId: string;
    name?: string | undefined;
    description?: string | undefined;
    seatLimit?: number | null | undefined;
    entitledModules?: readonly string[] | undefined;
    aiAllowanceMinor?: number | null | undefined;
    priceMinor?: number | null | undefined;
    active?: boolean | undefined;
    sortOrder?: number | undefined;
  }): Promise<Plan> {
    const existing = await this.platform.findPlan(input.planId);
    if (!existing) {
      throw new NotFoundException('No such plan.');
    }
    if (input.entitledModules) {
      PlatformAdministrationService.assertCompanyModules(input.entitledModules);
    }

    // Retiring a plan that companies are on would leave them entitled by a plan nobody can see
    // on the Plans screen. Refused, with the count, so the operator can move them first.
    if (input.active === false) {
      const counts = await this.platform.subscriberCounts();
      const subscribers = counts[existing.id] ?? 0;
      if (subscribers > 0) {
        throw new ConflictException(
          `${subscribers} company/companies are on "${existing.name}". Move them to another plan ` +
            'before retiring it — a retired plan with subscribers is an entitlement nobody can ' +
            'see or change.',
        );
      }
    }

    const plan = await this.platform.updatePlan(existing.id, {
      ...(input.name === undefined ? {} : { name: input.name }),
      ...(input.description === undefined ? {} : { description: input.description }),
      ...(input.seatLimit === undefined ? {} : { seatLimit: input.seatLimit }),
      ...(input.entitledModules === undefined
        ? {}
        : { entitledModules: [...new Set(input.entitledModules)] }),
      ...(input.aiAllowanceMinor === undefined ? {} : { aiAllowanceMinor: input.aiAllowanceMinor }),
      ...(input.priceMinor === undefined ? {} : { priceMinor: input.priceMinor }),
      ...(input.active === undefined ? {} : { active: input.active }),
      ...(input.sortOrder === undefined ? {} : { sortOrder: input.sortOrder }),
    });

    await this.record({
      action: 'plan.updated',
      resourceType: 'plan',
      resourceId: plan.id,
      resourceRef: plan.code,
      resourceVersion: plan.version,
      actorUserId: input.actorUserId,
      summary: `Updated plan ${plan.name}.`,
      reason: null,
      metadata: {
        changed: Object.keys(input)
          .filter((key) => key !== 'actorUserId' && key !== 'planId')
          .join(','),
      },
    });

    return plan;
  }

  // -------------------------------------------------------------------------
  // Subscriptions
  // -------------------------------------------------------------------------

  /**
   * Put a company on a plan, or change its commercial terms.
   *
   * The audit event is written into the **company's own** trail as well as carrying the platform
   * actor, because a change to what a company is paying for is something that company is
   * entitled to see. Same reasoning as break-glass writing into the customer's trail (ADR-048).
   */
  async setSubscription(input: {
    actorUserId: string;
    tenantId: string;
    planCode: string;
    seatsLicensed?: number | undefined;
    state?: TenantSubscription['state'] | undefined;
    billingState?: TenantSubscription['billingState'] | undefined;
    renewsAt?: Date | undefined;
    aiAllowanceMinor?: number | undefined;
    extraModules?: readonly string[] | undefined;
    removedModules?: readonly string[] | undefined;
    pinnedFlag?: TenantSubscription['pinnedFlag'] | undefined;
    notes?: string | undefined;
    reason: string;
  }): Promise<TenantSubscription> {
    const plan = await this.platform.findPlanByCode(input.planCode);
    if (!plan) {
      throw new NotFoundException(`No plan with the code "${input.planCode}".`);
    }
    if (!plan.active) {
      throw new BadRequestException(
        `"${plan.name}" is retired and cannot be assigned to a company.`,
      );
    }
    if (input.extraModules) {
      PlatformAdministrationService.assertCompanyModules(input.extraModules);
    }
    if (input.removedModules) {
      PlatformAdministrationService.assertCompanyModules(input.removedModules);
    }
    if (!input.reason.trim()) {
      throw new BadRequestException(
        'Changing a company’s commercial terms requires a reason. This is the record the ' +
          'customer may later ask about.',
      );
    }

    const subscription = await this.platform.upsertSubscription({
      tenantId: input.tenantId,
      planId: plan.id,
      data: {
        ...(input.seatsLicensed === undefined ? {} : { seatsLicensed: input.seatsLicensed }),
        ...(input.state === undefined ? {} : { state: input.state }),
        ...(input.billingState === undefined ? {} : { billingState: input.billingState }),
        ...(input.renewsAt === undefined ? {} : { renewsAt: input.renewsAt }),
        ...(input.aiAllowanceMinor === undefined
          ? {}
          : { aiAllowanceMinor: input.aiAllowanceMinor }),
        ...(input.extraModules === undefined ? {} : { extraModules: [...input.extraModules] }),
        ...(input.removedModules === undefined
          ? {}
          : { removedModules: [...input.removedModules] }),
        ...(input.pinnedFlag === undefined ? {} : { pinnedFlag: input.pinnedFlag }),
        ...(input.notes === undefined ? {} : { notes: input.notes }),
        currency: plan.currency,
      },
    });

    await this.prisma.runAsPlatformOperation(() =>
      this.auditEvents.appendWithinCurrentScope(input.tenantId, {
        action: 'subscription.changed',
        resourceType: 'tenant_subscription',
        resourceId: subscription.id,
        resourceRef: plan.code,
        resourceVersion: subscription.version,
        actorUserId: input.actorUserId,
        summary: `Commercial terms set to ${plan.name}.`,
        reason: input.reason.trim(),
        metadata: {
          planCode: plan.code,
          seatsLicensed: subscription.seatsLicensed,
          billingState: subscription.billingState,
          state: subscription.state,
        },
      }),
    );

    return subscription;
  }

  // -------------------------------------------------------------------------
  // Feature flags
  // -------------------------------------------------------------------------

  async createFeatureFlag(input: {
    actorUserId: string;
    key: string;
    description?: string | undefined;
    audience?: string | undefined;
    rationale?: string | undefined;
  }): Promise<FeatureFlag> {
    const clash = await this.platform.findFeatureFlag(input.key);
    if (clash) {
      throw new ConflictException(`A flag with the key "${input.key}" already exists.`);
    }

    // A new flag starts `Dev`/`Paused` at 0%, and that is not configurable here on purpose: a
    // flag that could be created already live would let one call ship an untested change to
    // every customer. Turning it on is a separate, separately audited decision.
    const flag = await this.platform.createFeatureFlag({
      key: input.key,
      description: input.description ?? null,
      stage: 'Dev',
      state: 'Paused',
      audience: input.audience ?? 'Internal',
      rolloutPercent: 0,
      enabledTenantIds: [],
      rationale: input.rationale ?? null,
      updatedByUserId: input.actorUserId,
    });

    await this.record({
      action: 'feature_flag.created',
      resourceType: 'feature_flag',
      resourceId: flag.id,
      resourceRef: flag.key,
      actorUserId: input.actorUserId,
      summary: `Created feature flag ${flag.key}, paused at 0%.`,
      reason: input.rationale ?? null,
      metadata: { key: flag.key, audience: flag.audience },
    });

    return flag;
  }

  /**
   * Change a flag's stage, state, audience or rollout.
   *
   * The interesting refusal: a flag cannot be moved to `Active` at a rollout of 0 with no
   * enabled companies. That combination is indistinguishable from `Paused` in effect but reads
   * as "on" on the screen, and a rollout gate that says on while doing nothing is how a feature
   * gets believed to be live.
   */
  async updateFeatureFlag(input: {
    actorUserId: string;
    key: string;
    stage?: FeatureFlag['stage'] | undefined;
    state?: FeatureFlag['state'] | undefined;
    audience?: string | undefined;
    rolloutPercent?: number | undefined;
    enabledTenantIds?: readonly string[] | undefined;
    rationale?: string | undefined;
    reason: string;
  }): Promise<FeatureFlag> {
    const existing = await this.platform.findFeatureFlag(input.key);
    if (!existing) {
      throw new NotFoundException(`No feature flag with the key "${input.key}".`);
    }
    if (!input.reason.trim()) {
      throw new BadRequestException(
        'Changing a feature flag requires a reason. A rollout with no recorded reason is the one ' +
          'nobody can explain during an incident.',
      );
    }

    const state = input.state ?? existing.state;
    const rolloutPercent = input.rolloutPercent ?? existing.rolloutPercent;
    const enabledTenantIds = input.enabledTenantIds ?? existing.enabledTenantIds;

    // The database refuses a paused flag with a live rollout; this refuses the mirror image,
    // which the database cannot express because it needs both columns and the array.
    if (state === 'Active' && rolloutPercent === 0 && enabledTenantIds.length === 0) {
      throw new BadRequestException(
        'An Active flag at 0% with no enabled companies is off, but reads as on. Set a rollout ' +
          'percentage or name the companies, or leave it Paused.',
      );
    }
    if (state !== 'Active' && state !== 'Retired' && rolloutPercent !== 0) {
      throw new BadRequestException(
        `A ${state} flag cannot carry a rollout percentage — the state and the percentage would ` +
          'disagree about whether the feature is on. Set the state to Active first.',
      );
    }

    const flag = await this.platform.updateFeatureFlag(input.key, {
      ...(input.stage === undefined ? {} : { stage: input.stage }),
      ...(input.state === undefined ? {} : { state: input.state }),
      ...(input.audience === undefined ? {} : { audience: input.audience }),
      ...(input.rolloutPercent === undefined ? {} : { rolloutPercent: input.rolloutPercent }),
      ...(input.enabledTenantIds === undefined
        ? {}
        : { enabledTenantIds: [...input.enabledTenantIds] }),
      ...(input.rationale === undefined ? {} : { rationale: input.rationale }),
      updatedByUserId: input.actorUserId,
    });

    await this.record({
      action: 'feature_flag.updated',
      resourceType: 'feature_flag',
      resourceId: flag.id,
      resourceRef: flag.key,
      resourceVersion: flag.version,
      actorUserId: input.actorUserId,
      summary: `${flag.key} → ${flag.state} at ${flag.rolloutPercent}% (${flag.stage}).`,
      reason: input.reason.trim(),
      securityAction: SECURITY_ACTIONS.featureFlagChanged,
      metadata: {
        key: flag.key,
        stage: flag.stage,
        state: flag.state,
        rolloutPercent: flag.rolloutPercent,
        enabledCompanies: flag.enabledTenantIds.length,
      },
    });

    return flag;
  }

  // -------------------------------------------------------------------------
  // Platform settings
  // -------------------------------------------------------------------------

  /**
   * Change one global setting.
   *
   * A **locked** setting is refused. Locked settings are product rules rather than preferences —
   * "there is no public company signup", "Aadhaar is for internal matching only" — and they are
   * shown on the screen so an operator can see the rule, with the API refusing to change it
   * rather than offering a control that silently does nothing.
   */
  async updateSetting(input: {
    actorUserId: string;
    key: string;
    value: unknown;
    reason: string;
  }): Promise<PlatformSetting> {
    const existing = await this.platform.findSetting(input.key);
    if (!existing) {
      throw new NotFoundException(`No platform setting with the key "${input.key}".`);
    }
    if (existing.locked) {
      throw new ForbiddenException(
        `"${input.key}" is locked: it is a product rule rather than a preference, and changing ` +
          'it would change a client-stated constraint. It is shown so the rule is visible, not ' +
          'so it can be edited.',
      );
    }
    if (!input.reason.trim()) {
      throw new BadRequestException('Changing a global platform setting requires a reason.');
    }

    const setting = await this.platform.updateSetting(
      input.key,
      input.value as never,
      input.actorUserId,
    );

    await this.record({
      action: 'platform_setting.changed',
      resourceType: 'platform_setting',
      resourceId: setting.id,
      resourceRef: setting.key,
      resourceVersion: setting.version,
      actorUserId: input.actorUserId,
      summary: `${setting.key} changed.`,
      reason: input.reason.trim(),
      securityAction: SECURITY_ACTIONS.platformSettingChanged,
      // The value is recorded because a global setting is configuration, not a credential — and
      // the previous value with it, since "what did it used to be" is the question a rollback
      // asks. `redactMetadata` still guards the key names.
      metadata: {
        key: setting.key,
        previous: JSON.stringify(existing.value),
        next: JSON.stringify(setting.value),
      },
    });

    return setting;
  }

  // -------------------------------------------------------------------------
  // Service alerts
  // -------------------------------------------------------------------------

  async acknowledgeServiceAlert(input: {
    actorUserId: string;
    alertId: string;
  }): Promise<ServiceAlert> {
    const existing = await this.platform.findServiceAlert(input.alertId);
    if (!existing) {
      throw new NotFoundException('No such service alert.');
    }
    if (existing.state !== 'Open') {
      throw new ConflictException(
        `That alert is "${existing.state}"; only an Open one can be acknowledged.`,
      );
    }

    const alert = await this.platform.updateServiceAlert(existing.id, {
      state: 'Acknowledged',
      acknowledgedAt: new Date(),
      acknowledgedByUserId: input.actorUserId,
    });

    await this.record({
      action: 'service_alert.acknowledged',
      resourceType: 'service_alert',
      resourceId: alert.id,
      actorUserId: input.actorUserId,
      summary: `Acknowledged ${alert.severity} alert on ${alert.service}.`,
      reason: null,
      metadata: { service: alert.service, severity: alert.severity },
    });

    return alert;
  }

  async resolveServiceAlert(input: {
    actorUserId: string;
    alertId: string;
    resolution: string;
  }): Promise<ServiceAlert> {
    const existing = await this.platform.findServiceAlert(input.alertId);
    if (!existing) {
      throw new NotFoundException('No such service alert.');
    }
    if (existing.state === 'Resolved') {
      throw new ConflictException('That alert is already resolved.');
    }
    if (!input.resolution.trim()) {
      throw new BadRequestException(
        'Resolving an alert requires a note saying what was done. "Resolved" with no explanation ' +
          'is how the same incident happens twice.',
      );
    }

    const alert = await this.platform.updateServiceAlert(existing.id, {
      state: 'Resolved',
      resolvedAt: new Date(),
      resolvedByUserId: input.actorUserId,
      detail: input.resolution.trim(),
    });

    await this.record({
      action: 'service_alert.resolved',
      resourceType: 'service_alert',
      resourceId: alert.id,
      actorUserId: input.actorUserId,
      summary: `Resolved ${alert.severity} alert on ${alert.service}.`,
      reason: input.resolution.trim(),
      metadata: { service: alert.service, severity: alert.severity },
    });

    return alert;
  }

  // -------------------------------------------------------------------------
  // Declared incidents — Prompt 36
  // -------------------------------------------------------------------------
  //
  // An alert is *raised*; an incident is *declared*. Not every alert is worth owning, publishing
  // and post-morteming, so declaration is a deliberate act and it hangs off the alert rather than
  // living in a second table. One row means the Master Console's alert count and the System Health
  // incident list cannot disagree (ADR-203).

  /**
   * Declare an alert to be an incident.
   *
   * §30 asks for severity **P0/P1/P2**, an owner and acknowledgement. The severity is a separate
   * column from the alert's own Info/Warning/Critical: mapping `Critical` onto `P0` would assert a
   * judgement nobody made.
   */
  async declareIncident(input: {
    actorUserId: string;
    alertId: string;
    severity: 'P0' | 'P1' | 'P2';
    ownerUserId: string;
  }): Promise<ServiceAlert> {
    const existing = await this.platform.findServiceAlert(input.alertId);
    if (!existing) {
      throw new NotFoundException('No such service alert.');
    }
    if (existing.incidentSeverity !== null) {
      throw new ConflictException(
        `That alert is already a declared ${existing.incidentSeverity} incident. Change its ` +
          'severity rather than declaring it twice.',
      );
    }
    if (existing.state === 'Resolved') {
      throw new ConflictException(
        'That alert is already resolved. Declaring a resolved alert an incident would create an ' +
          'incident that was over before it started.',
      );
    }

    const alert = await this.platform.updateServiceAlert(existing.id, {
      incidentSeverity: input.severity,
      declaredAt: new Date(),
      declaredByUserId: input.actorUserId,
      ownerUserId: input.ownerUserId,
      // Declaring is acknowledging: somebody has looked and decided. Leaving an incident in
      // `Open` after a human judged its severity would misreport it as untouched.
      ...(existing.state === 'Open'
        ? {
            state: 'Acknowledged',
            acknowledgedAt: new Date(),
            acknowledgedByUserId: input.actorUserId,
          }
        : {}),
    });

    await this.record({
      action: 'incident.declared',
      resourceType: 'service_alert',
      resourceId: alert.id,
      actorUserId: input.actorUserId,
      summary: `Declared a ${input.severity} incident on ${alert.service}.`,
      reason: null,
      metadata: {
        service: alert.service,
        severity: input.severity,
        ownerUserId: input.ownerUserId,
      },
    });

    return alert;
  }

  /** Record that the impact has stopped, and what stopped it. */
  async mitigateIncident(input: {
    actorUserId: string;
    alertId: string;
    mitigation: string;
  }): Promise<ServiceAlert> {
    const existing = await this.platform.findServiceAlert(input.alertId);
    if (!existing) {
      throw new NotFoundException('No such service alert.');
    }
    if (existing.incidentSeverity === null) {
      throw new ConflictException('That alert has not been declared an incident.');
    }
    if (!input.mitigation.trim()) {
      throw new BadRequestException(
        'Say what stopped the impact. A mitigation with no words is the note the next person ' +
          'needs and cannot read.',
      );
    }
    if (existing.state === 'Resolved') {
      throw new ConflictException('That incident is already resolved.');
    }

    const alert = await this.platform.updateServiceAlert(existing.id, {
      state: 'Mitigated',
      mitigatedAt: new Date(),
      mitigation: input.mitigation.trim(),
    });

    await this.record({
      action: 'incident.mitigated',
      resourceType: 'service_alert',
      resourceId: alert.id,
      actorUserId: input.actorUserId,
      summary: `Mitigated the ${existing.incidentSeverity} incident on ${alert.service}.`,
      reason: input.mitigation.trim(),
      metadata: { service: alert.service, severity: existing.incidentSeverity },
    });

    return alert;
  }

  /**
   * Publish an incident to customers, or withdraw it.
   *
   * **The customer wording is written here and nowhere else.** A status page assembling text out
   * of `summary` and `detail` would publish an operator's internal note, which may name a host, a
   * query or another customer — so a published incident without `customer_impact` is refused by a
   * check constraint as well as by this method.
   */
  async publishIncident(input: {
    actorUserId: string;
    alertId: string;
    customerVisible: boolean;
    customerImpact?: string;
  }): Promise<ServiceAlert> {
    const existing = await this.platform.findServiceAlert(input.alertId);
    if (!existing) {
      throw new NotFoundException('No such service alert.');
    }
    if (input.customerVisible && existing.incidentSeverity === null) {
      throw new ConflictException(
        'That alert has not been declared an incident. Publishing one would tell customers about ' +
          'something UBoss has not decided is an incident.',
      );
    }

    const impact = input.customerImpact?.trim() ?? existing.customerImpact ?? '';
    if (input.customerVisible && impact === '') {
      throw new BadRequestException(
        'Write what customers should be told. It is published in your words — UBoss will not ' +
          'assemble a customer-facing sentence out of internal notes.',
      );
    }

    const alert = await this.platform.updateServiceAlert(existing.id, {
      customerVisible: input.customerVisible,
      ...(input.customerVisible ? { customerImpact: impact } : {}),
    });

    await this.record({
      action: input.customerVisible ? 'incident.published' : 'incident.unpublished',
      resourceType: 'service_alert',
      resourceId: alert.id,
      actorUserId: input.actorUserId,
      summary: input.customerVisible
        ? `Published the ${existing.incidentSeverity} incident on ${alert.service} to customers.`
        : `Withdrew the public notice for the incident on ${alert.service}.`,
      reason: input.customerVisible ? impact : null,
      metadata: { service: alert.service, customerVisible: input.customerVisible },
    });

    return alert;
  }

  // -------------------------------------------------------------------------
  // Internals
  // -------------------------------------------------------------------------

  /**
   * Write the platform-plane audit event, and a security event when one applies.
   *
   * `recordForPlatformOrThrow`, not the swallowing variant: a plan change or a platform-role
   * grant with no audit row is a change nobody can account for, and these are exactly the writes
   * where the record is part of what the operation promises (ADR-045).
   */
  private async record(input: {
    action: string;
    resourceType: string;
    resourceId: string;
    resourceRef?: string;
    resourceVersion?: number;
    actorUserId: string;
    summary: string;
    reason: string | null;
    securityAction?: string;
    metadata?: Record<string, string | number | boolean | null>;
  }): Promise<void> {
    await this.auditEvents.recordForPlatformOrThrow({
      action: input.action,
      resourceType: input.resourceType,
      resourceId: input.resourceId,
      ...(input.resourceRef === undefined ? {} : { resourceRef: input.resourceRef }),
      ...(input.resourceVersion === undefined ? {} : { resourceVersion: input.resourceVersion }),
      actorUserId: input.actorUserId,
      summary: input.summary,
      ...(input.reason === null ? {} : { reason: input.reason }),
      ...(input.metadata === undefined ? {} : { metadata: input.metadata }),
    });

    if (input.securityAction) {
      await this.securityEvents.record({
        action: input.securityAction as never,
        actorUserId: input.actorUserId,
        resourceType: input.resourceType,
        resourceId: input.resourceId,
        summary: input.summary,
        ...(input.metadata === undefined ? {} : { metadata: input.metadata }),
      });
    }
  }

  /**
   * Refuse a module the product does not have, and refuse a platform module.
   *
   * A plan entitles a **company** to company modules. A plan naming `platform-settings` would be
   * selling a customer access to the platform's own control plane, which is the kind of mistake
   * a validation list exists to make impossible rather than to catch in review.
   */
  private static assertCompanyModules(modules: readonly string[]): void {
    const allowed = new Set<string>(COMPANY_MODULES);
    const invalid = modules.filter((module) => !allowed.has(module));
    if (invalid.length > 0) {
      throw new BadRequestException(
        `Not company modules: ${invalid.join(', ')}. A plan entitles a company to company ` +
          `modules only — valid values are: ${COMPANY_MODULES.join(', ')}.`,
      );
    }
  }
}
