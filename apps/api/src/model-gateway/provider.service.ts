import {
  BadRequestException,
  ConflictException,
  Inject,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';

import {
  acceptsNewWork,
  customProviderProblems,
  isLogicalModelProfile,
  LOGICAL_MODEL_PROFILE_SPEC,
  LOGICAL_MODEL_PROFILES,
  mayMoveLifecycle,
  PROVIDER_AUTH_TYPES,
  PROVIDER_KINDS,
  PROVIDER_LIFECYCLE_STATES,
  PROVIDER_MODES,
  routeLogicalProfile,
  type CustomProviderConfig,
  type LogicalModelProfile,
  type ProviderAuthType,
  type ProviderKind,
  type ProviderLifecycleState,
  type ProviderMode,
  type ProviderTestResult,
  type RoutingCandidate,
} from '@uboss/types';

import { AuditEventService } from '../audit/audit-event.service.js';
import { SecretsVault } from '../connections/secrets-vault.js';
import { PrismaService } from '../persistence/prisma.service.js';
import {
  tenantScopeForPlatformOperation,
  type TenantScope,
} from '../persistence/tenant-context.js';
import {
  PROVIDER_ADAPTERS,
  ProviderAdapter,
  ProviderNotConfiguredError,
} from './provider-adapter.js';

/** One provider profile as the Master Console shows it. */
export interface ProviderProfileView {
  id: string;
  tenantId: string | null;
  kind: ProviderKind;
  kindLabel: string;
  mode: ProviderMode;
  label: string;
  lifecycle: ProviderLifecycleState;
  enabled: boolean;
  /** Present for a custom endpoint. **Never the secret** — only whether one is stored. */
  custom: {
    baseUrl: string;
    authType: ProviderAuthType;
    authHeaderName: string | null;
    hasSecret: boolean;
    timeoutMs: number;
    usageMapping: { inputPath: string; outputPath: string; cachedInputPath: string | null };
    requestIdPath: string | null;
  } | null;
  /** Whether a registered adapter could actually reach this kind right now. */
  adapterCanReachProvider: boolean;
  lastTest: {
    at: string;
    ok: boolean;
    /** The field that matters: a configuration that validates is not a provider that answered. */
    reachedProvider: boolean;
    detail: string;
  } | null;
  models: ProviderModelView[];
  version: number;
}

export interface ProviderModelView {
  id: string;
  providerModelRef: string;
  capability: string;
  lifecycle: ProviderLifecycleState;
  enabled: boolean;
  lifecycleChangedAt: string | null;
  lifecycleNote: string | null;
  currentPricing: {
    id: string;
    versionNumber: number;
    currency: string;
    inputPerMillionMinorUnits: number;
    outputPerMillionMinorUnits: number;
    cachedInputPerMillionMinorUnits: number | null;
    effectiveFrom: string;
  } | null;
}

/** What one logical profile currently resolves to. */
export interface LogicalProfileView {
  profile: LogicalModelProfile;
  typicalUse: string;
  gatewayBehaviour: string;
  fallbackPolicy: string;
  schemaConstrained: boolean;
  needsExplicitGuardrail: boolean;
  routes: {
    providerModelId: string;
    capability: string;
    preference: number;
    lifecycle: ProviderLifecycleState;
    enabled: boolean;
    /** True when this is what a call would currently be answered by. */
    wouldAnswer: boolean;
  }[];
  /** Why nothing would answer, when nothing would. */
  unroutableReason: string | null;
}

/**
 * Provider and model configuration — the Master Console's half of the Model Gateway.
 *
 * ## Platform-plane, and that is a product rule rather than a filing decision
 *
 * A company workspace does not configure providers. §19's own wording: "employees do not manage
 * provider keys". A company chooses a *mode* under its contract, and where that mode is BYOK or
 * custom it supplies a credential — but which model answers `OBJECTIVE_PLANNER` is UBoss
 * configuration, because the alternative is a company silently routing its planning to something
 * the approved architecture never evaluated.
 *
 * ## What this service will not do
 *
 * **It will not reveal a stored secret.** `ProviderProfileView.custom.hasSecret` is a boolean.
 * The vault's `reveal` is called by the adapter at the moment of a call and by nothing else — a
 * credential that has been shown once is a credential in a browser's memory.
 *
 * **It will not report a successful Test Connection for a mock.** `reachedProvider` is what a
 * screen shows, and it is false for every adapter that ships. Claiming a live
 * credential-verified integration on the strength of adapter code is the specific thing the
 * client's rules forbid.
 */
@Injectable()
export class ProviderService {
  private readonly logger = new Logger(ProviderService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly vault: SecretsVault,
    private readonly auditEvents: AuditEventService,
    @Inject(PROVIDER_ADAPTERS) private readonly adapters: readonly ProviderAdapter[],
  ) {}

  /** The vocabulary a Master Console screen renders against. */
  meta(): unknown {
    return {
      kinds: PROVIDER_KINDS.map((kind) => ({
        kind,
        adapterRegistered: this.adapters.some((adapter) => adapter.kind === kind),
        canReachProvider:
          this.adapters.find((adapter) => adapter.kind === kind)?.canReachProvider ?? false,
      })),
      modes: PROVIDER_MODES,
      authTypes: PROVIDER_AUTH_TYPES,
      lifecycleStates: PROVIDER_LIFECYCLE_STATES,
      profiles: LOGICAL_MODEL_PROFILES.map((profile) => LOGICAL_MODEL_PROFILE_SPEC[profile]),
      note:
        'Provider names are configuration, not business object identity. A business object names ' +
        'a logical model profile; which provider answers it is decided here and never leaves ' +
        'the gateway.',
    };
  }

  /** Every provider profile, platform and company. */
  async listProfiles(): Promise<ProviderProfileView[]> {
    return this.prisma.runAsPlatformOperation(async () => {
      const rows = await this.prisma.client.providerProfile.findMany({
        include: {
          models: {
            include: { pricing: { where: { supersededAt: null }, take: 1 } },
            orderBy: { capability: 'asc' },
          },
        },
        orderBy: [{ tenantId: 'asc' }, { label: 'asc' }],
      });

      return rows.map((row) => this.toProfileView(row));
    });
  }

  /**
   * Register a provider profile.
   *
   * A platform profile is UBoss Managed; a company profile is BYOK or custom. The database refuses
   * the other combinations, and this refuses them earlier with a sentence that says why.
   */
  async createProfile(input: {
    actorUserId: string;
    tenantId: string | null;
    kind: ProviderKind;
    mode: ProviderMode;
    label: string;
    custom?:
      | (Omit<CustomProviderConfig, 'secretRef' | 'modelId'> & { secret?: string | undefined })
      | undefined;
  }): Promise<ProviderProfileView> {
    if (!PROVIDER_KINDS.includes(input.kind)) {
      throw new BadRequestException(`Unknown provider kind: ${input.kind}`);
    }
    if (!PROVIDER_MODES.includes(input.mode)) {
      throw new BadRequestException(`Unknown provider mode: ${input.mode}`);
    }

    if (input.tenantId === null && input.mode !== 'UBossManaged') {
      throw new BadRequestException(
        'A platform profile is UBoss Managed by definition. A company-owned mode on a shared ' +
          "profile would meter one company's account as everybody's default.",
      );
    }
    if (input.tenantId !== null && input.mode === 'UBossManaged') {
      throw new BadRequestException(
        'A company profile cannot be UBoss Managed — that mode uses the UBoss account, which is ' +
          'the platform profile.',
      );
    }

    if (input.kind === 'Custom') {
      if (input.custom === undefined) {
        throw new BadRequestException('A custom enterprise provider needs its endpoint details.');
      }
      const problems = customProviderProblems({
        ...input.custom,
        modelId: 'placeholder',
        // The secret is checked as a plaintext here and stored as a handle below, so the shared
        // validator is told a handle exists exactly when one will.
        secretRef: input.custom.secret === undefined ? null : 'pending',
      });
      if (problems.length > 0) {
        throw new BadRequestException(problems.join(' '));
      }
    } else if (input.custom !== undefined) {
      throw new BadRequestException(
        `${input.kind} has its own endpoint. Storing a second one would leave a value somebody ` +
          'eventually believes is being used.',
      );
    }

    const scope = tenantScopeForPlatformOperation(
      input.tenantId ?? '00000000-0000-4000-8000-000000000000',
    );

    // Stored before the row, so a failure leaves an unreferenced secret rather than a row
    // pointing at a secret that does not exist. The first is inert; the second breaks every call.
    const secretRef =
      input.kind === 'Custom' && input.custom?.secret !== undefined
        ? await this.vault.put(scope, input.custom.secret)
        : null;

    const created = await this.prisma.runAsPlatformOperation(() =>
      this.prisma.client.providerProfile.create({
        data: {
          kind: input.kind,
          mode: input.mode,
          label: input.label,
          createdByUserId: input.actorUserId,
          ...(input.tenantId === null ? {} : { tenantId: input.tenantId }),
          ...(input.kind === 'Custom' && input.custom !== undefined
            ? {
                baseUrl: input.custom.baseUrl,
                authType: input.custom.authType,
                authHeaderName: input.custom.authHeaderName,
                timeoutMs: input.custom.timeoutMs,
                usageInputPath: input.custom.usageMapping.inputPath,
                usageOutputPath: input.custom.usageMapping.outputPath,
                usageCachedInputPath: input.custom.usageMapping.cachedInputPath,
                requestIdPath: input.custom.requestIdPath,
                ...(secretRef === null ? {} : { secretRef }),
              }
            : {}),
        },
        include: { models: { include: { pricing: { where: { supersededAt: null }, take: 1 } } } },
      }),
    );

    await this.audit(input.tenantId, {
      action: 'providers.profile_registered',
      resourceId: created.id,
      actorUserId: input.actorUserId,
      summary: `Registered the ${input.kind} provider profile "${input.label}" (${input.mode}).`,
      metadata: { kind: input.kind, mode: input.mode, isPlatform: input.tenantId === null },
    });

    return this.toProfileView(created);
  }

  /** Add a model to a profile. */
  async addModel(input: {
    actorUserId: string;
    providerProfileId: string;
    providerModelRef: string;
    capability: string;
    /** Prompt 40. Null or absent means UBoss throttles reactively instead. */
    quotaRequestsPerMinute?: number | undefined;
    pricing?:
      | {
          currency: string;
          inputPerMillionMinorUnits: number;
          outputPerMillionMinorUnits: number;
          cachedInputPerMillionMinorUnits: number | null;
        }
      | undefined;
  }): Promise<ProviderModelView> {
    return this.prisma.runAsPlatformOperation(async () => {
      const profile = await this.prisma.client.providerProfile.findUnique({
        where: { id: input.providerProfileId },
      });
      if (profile === null) throw new NotFoundException('No such provider profile.');

      const model = await this.prisma.client.providerModel.create({
        data: {
          providerProfileId: profile.id,
          providerModelRef: input.providerModelRef,
          capability: input.capability,
          ...(input.quotaRequestsPerMinute === undefined
            ? {}
            : { quotaRequestsPerMinute: input.quotaRequestsPerMinute }),
          // The trigger requires this to match; setting it from the profile rather than from the
          // caller means a caller cannot get it wrong.
          ...(profile.tenantId === null ? {} : { tenantId: profile.tenantId }),
        },
      });

      if (input.pricing !== undefined) {
        await this.prisma.client.pricingVersionRow.create({
          data: {
            providerModelId: model.id,
            versionNumber: 1,
            currency: input.pricing.currency,
            inputPerMillionMinorUnits: input.pricing.inputPerMillionMinorUnits,
            outputPerMillionMinorUnits: input.pricing.outputPerMillionMinorUnits,
            cachedInputPerMillionMinorUnits: input.pricing.cachedInputPerMillionMinorUnits,
            effectiveFrom: new Date(),
            createdByUserId: input.actorUserId,
            ...(profile.tenantId === null ? {} : { tenantId: profile.tenantId }),
          },
        });
      }

      await this.audit(profile.tenantId, {
        action: 'providers.model_registered',
        resourceId: model.id,
        actorUserId: input.actorUserId,
        summary: `Registered a model with capability "${input.capability}".`,
        metadata: { capability: input.capability, pricingSupplied: input.pricing !== undefined },
      });

      const withPricing = await this.prisma.client.providerModel.findUniqueOrThrow({
        where: { id: model.id },
        include: { pricing: { where: { supersededAt: null }, take: 1 } },
      });
      return this.toModelView(withPricing);
    });
  }

  /**
   * Publish a new price for a model.
   *
   * Supersedes rather than edits. The existing version is stamped `supersededAt` and a new one is
   * written — because a gateway call cites the version that priced it, and editing that version
   * would retroactively restate what a Run cost. A database trigger refuses the edit, so this is
   * the only way.
   */
  async publishPricing(input: {
    actorUserId: string;
    providerModelId: string;
    currency: string;
    inputPerMillionMinorUnits: number;
    outputPerMillionMinorUnits: number;
    cachedInputPerMillionMinorUnits: number | null;
    effectiveFrom?: Date | undefined;
  }): Promise<ProviderModelView> {
    return this.prisma.runAsPlatformOperation(async () => {
      const model = await this.prisma.client.providerModel.findUnique({
        where: { id: input.providerModelId },
      });
      if (model === null) throw new NotFoundException('No such provider model.');

      const current = await this.prisma.client.pricingVersionRow.findFirst({
        where: { providerModelId: model.id, supersededAt: null },
        orderBy: { versionNumber: 'desc' },
      });

      const now = new Date();

      // Superseded first: the partial unique index allows exactly one current version, so the new
      // row cannot be written while the old one is still current. That ordering is enforced by the
      // database rather than trusted here.
      if (current !== null) {
        await this.prisma.client.pricingVersionRow.update({
          where: { id: current.id },
          data: { supersededAt: now },
        });
      }

      const created = await this.prisma.client.pricingVersionRow.create({
        data: {
          providerModelId: model.id,
          versionNumber: (current?.versionNumber ?? 0) + 1,
          currency: input.currency,
          inputPerMillionMinorUnits: input.inputPerMillionMinorUnits,
          outputPerMillionMinorUnits: input.outputPerMillionMinorUnits,
          cachedInputPerMillionMinorUnits: input.cachedInputPerMillionMinorUnits,
          effectiveFrom: input.effectiveFrom ?? now,
          createdByUserId: input.actorUserId,
          ...(model.tenantId === null ? {} : { tenantId: model.tenantId }),
        },
      });

      await this.audit(model.tenantId, {
        action: 'providers.pricing_published',
        resourceId: created.id,
        actorUserId: input.actorUserId,
        summary:
          `Published pricing version ${created.versionNumber}. The previous version stays ` +
          'readable as what priced the calls that cited it.',
        metadata: {
          versionNumber: created.versionNumber,
          currency: input.currency,
          supersededVersion: current?.versionNumber ?? 0,
        },
      });

      const withPricing = await this.prisma.client.providerModel.findUniqueOrThrow({
        where: { id: model.id },
        include: { pricing: { where: { supersededAt: null }, take: 1 } },
      });
      return this.toModelView(withPricing);
    });
  }

  /**
   * Move a model through its lifecycle.
   *
   * `MigrationRequired` is the state that does work: `routeLogicalProfile` refuses to route new
   * work to it, so marking a model here stops it being selected while there is still time to move
   * — rather than on the day the provider removes it.
   */
  async setModelLifecycle(input: {
    actorUserId: string;
    providerModelId: string;
    lifecycle: ProviderLifecycleState;
    note: string;
  }): Promise<ProviderModelView> {
    if (!PROVIDER_LIFECYCLE_STATES.includes(input.lifecycle)) {
      throw new BadRequestException(`Unknown lifecycle state: ${input.lifecycle}`);
    }

    return this.prisma.runAsPlatformOperation(async () => {
      const model = await this.prisma.client.providerModel.findUnique({
        where: { id: input.providerModelId },
      });
      if (model === null) throw new NotFoundException('No such provider model.');

      const from = model.lifecycle as ProviderLifecycleState;
      if (!mayMoveLifecycle(from, input.lifecycle)) {
        throw new ConflictException(
          `A model cannot move from ${from} to ${input.lifecycle}. A model that needed migrating ` +
            'is re-approved deliberately, not by relaxing a state.',
        );
      }

      const updated = await this.prisma.client.providerModel.update({
        where: { id: model.id },
        data: {
          lifecycle: input.lifecycle,
          lifecycleChangedAt: new Date(),
          lifecycleNote: input.note,
          version: { increment: 1 },
        },
        include: { pricing: { where: { supersededAt: null }, take: 1 } },
      });

      await this.audit(model.tenantId, {
        action: 'providers.model_lifecycle_changed',
        resourceId: model.id,
        actorUserId: input.actorUserId,
        resourceVersion: updated.version,
        summary: `Model moved from ${from} to ${input.lifecycle}: ${input.note}`,
        metadata: {
          from,
          to: input.lifecycle,
          acceptsNewWork: acceptsNewWork(input.lifecycle),
        },
      });

      return this.toModelView(updated);
    });
  }

  /** Point a logical profile at a model, at a given preference. */
  async setRoute(input: {
    actorUserId: string;
    tenantId: string | null;
    profile: string;
    providerModelId: string;
    preference: number;
  }): Promise<LogicalProfileView> {
    if (!isLogicalModelProfile(input.profile)) {
      throw new BadRequestException(
        `${input.profile} is not one of the five logical model profiles.`,
      );
    }

    await this.prisma.runAsPlatformOperation(async () => {
      const model = await this.prisma.client.providerModel.findUnique({
        where: { id: input.providerModelId },
      });
      if (model === null) throw new NotFoundException('No such provider model.');

      if (model.tenantId !== input.tenantId) {
        throw new BadRequestException(
          input.tenantId === null
            ? 'A platform route cannot point at a company model — it would be routable for every ' +
                'other company.'
            : "A company route must point at that company's own model.",
        );
      }

      await this.prisma.client.logicalModelRoute.create({
        data: {
          profile: input.profile,
          providerModelId: input.providerModelId,
          preference: input.preference,
          ...(input.tenantId === null ? {} : { tenantId: input.tenantId }),
        },
      });

      await this.audit(input.tenantId, {
        action: 'providers.route_set',
        resourceId: input.providerModelId,
        actorUserId: input.actorUserId,
        summary: `${input.profile} may now be answered at preference ${input.preference}.`,
        metadata: { profile: input.profile, preference: input.preference },
      });
    });

    return this.viewProfile(input.profile, input.tenantId);
  }

  /** What one logical profile currently resolves to, and why. */
  async viewProfile(
    profile: LogicalModelProfile,
    tenantId: string | null,
  ): Promise<LogicalProfileView> {
    const spec = LOGICAL_MODEL_PROFILE_SPEC[profile];

    return this.prisma.runAsPlatformOperation(async () => {
      const companyRows =
        tenantId === null
          ? []
          : await this.prisma.client.logicalModelRoute.findMany({
              where: { tenantId, profile },
              include: { model: { include: { profile: true } } },
              orderBy: { preference: 'asc' },
            });

      const rows =
        companyRows.length > 0
          ? companyRows
          : await this.prisma.client.logicalModelRoute.findMany({
              where: { tenantId: null, profile },
              include: { model: { include: { profile: true } } },
              orderBy: { preference: 'asc' },
            });

      const candidates: RoutingCandidate[] = rows.map((row) => ({
        providerModelId: row.providerModelId,
        preference: row.preference,
        lifecycle: row.model.lifecycle as ProviderLifecycleState,
        capability: row.model.capability,
        enabled: row.enabled && row.model.enabled && row.model.profile.enabled,
      }));

      const outcome = routeLogicalProfile({ profile, candidates });
      const answering = outcome.routed ? outcome.candidate.providerModelId : null;

      return {
        profile,
        typicalUse: spec.typicalUse,
        gatewayBehaviour: spec.gatewayBehaviour,
        fallbackPolicy: spec.fallbackPolicy,
        schemaConstrained: spec.schemaConstrained,
        needsExplicitGuardrail: spec.needsExplicitGuardrail,
        routes: candidates.map((entry) => ({
          providerModelId: entry.providerModelId,
          capability: entry.capability,
          preference: entry.preference,
          lifecycle: entry.lifecycle,
          enabled: entry.enabled,
          wouldAnswer: entry.providerModelId === answering,
        })),
        unroutableReason: outcome.routed ? null : outcome.reason,
      };
    });
  }

  /** Every logical profile, for the Master Console's routing screen. */
  async listProfilesRouting(tenantId: string | null): Promise<LogicalProfileView[]> {
    const views: LogicalProfileView[] = [];
    for (const profile of LOGICAL_MODEL_PROFILES) {
      views.push(await this.viewProfile(profile, tenantId));
    }
    return views;
  }

  /**
   * Test Connection.
   *
   * **`reachedProvider` is the whole point of this method.** It sends a deliberately tiny call and
   * reports whether a provider actually answered — not whether the configuration parses. For every
   * adapter that ships today the answer is false, and the result says so in words a platform
   * operator will read rather than leaving them to infer it from a green tick.
   *
   * The result is stored on the profile, so a screen shows when it was last tested and what
   * happened, and a database CHECK requires all three fields together: "it was tested" and "a
   * provider answered" must never be separable.
   */
  async testConnection(input: {
    actorUserId: string;
    providerProfileId: string;
  }): Promise<ProviderTestResult> {
    const profile = await this.prisma.runAsPlatformOperation(() =>
      this.prisma.client.providerProfile.findUnique({
        where: { id: input.providerProfileId },
        include: { models: { take: 1, orderBy: { capability: 'asc' } } },
      }),
    );
    if (profile === null) throw new NotFoundException('No such provider profile.');

    const adapter = this.adapters.find((entry) => entry.kind === profile.kind);
    const model = profile.models[0];

    let result: ProviderTestResult;

    if (adapter === undefined) {
      result = {
        ok: false,
        reachedProvider: false,
        providerRequestId: null,
        latencyMs: null,
        detail: `No adapter is registered for ${profile.kind}.`,
      };
    } else if (model === undefined) {
      result = {
        ok: false,
        reachedProvider: false,
        providerRequestId: null,
        latencyMs: null,
        detail:
          'This profile has no model registered, so there is nothing to call. Add a model first.',
      };
    } else {
      const credential =
        profile.secretRef === null
          ? null
          : await this.vault.reveal(
              tenantScopeForPlatformOperation(
                profile.tenantId ?? '00000000-0000-4000-8000-000000000000',
              ),
              profile.secretRef,
            );

      try {
        const outcome = await adapter.complete({
          providerModelRef: model.providerModelRef,
          instruction: 'Reply with the single word OK.',
          context: 'Connection test.',
          // Deliberately tiny: a test that spent real money would be a test people avoid running.
          maxTokens: 16,
          timeoutMs: Math.min(profile.timeoutMs ?? 15_000, 15_000),
          custom: null,
          credential,
        });

        result = {
          ok: true,
          reachedProvider: outcome.reachedProvider,
          providerRequestId: outcome.providerRequestId,
          latencyMs: outcome.latencyMs,
          detail: outcome.reachedProvider
            ? `The provider answered in ${outcome.latencyMs}ms.`
            : 'The adapter answered without contacting a provider. This is the mock adapter: ' +
              'the configuration is usable, but nothing has been verified against a real ' +
              'provider.',
        };
      } catch (cause) {
        result = {
          ok: false,
          reachedProvider: false,
          providerRequestId: null,
          latencyMs: null,
          detail:
            cause instanceof ProviderNotConfiguredError
              ? cause.message
              : cause instanceof Error
                ? cause.message
                : 'The provider call failed.',
        };
      }
    }

    await this.prisma.runAsPlatformOperation(() =>
      this.prisma.client.providerProfile.update({
        where: { id: profile.id },
        data: {
          lastTestedAt: new Date(),
          lastTestOk: result.ok,
          lastTestReachedProvider: result.reachedProvider,
          lastTestDetail: result.detail.slice(0, 1000),
          version: { increment: 1 },
        },
      }),
    );

    await this.audit(profile.tenantId, {
      action: 'providers.connection_tested',
      resourceId: profile.id,
      actorUserId: input.actorUserId,
      summary: `Test Connection on "${profile.label}": ${result.detail}`,
      metadata: {
        ok: result.ok,
        // Recorded separately from `ok` on purpose. The trail must be able to answer "has this
        // ever actually talked to a provider" years later.
        reachedProvider: result.reachedProvider,
        kind: profile.kind,
      },
    });

    return result;
  }

  // -------------------------------------------------------------------------
  // Internals
  // -------------------------------------------------------------------------

  private async audit(
    tenantId: string | null,
    event: {
      action: string;
      resourceId: string;
      actorUserId: string;
      summary: string;
      resourceVersion?: number | undefined;
      metadata: Record<string, string | number | boolean>;
    },
  ): Promise<void> {
    // A platform-plane change has no tenant to attribute it to. Recorded against the platform
    // trail rather than invented against an arbitrary company.
    if (tenantId === null) {
      this.logger.log(`[platform] ${event.action}: ${event.summary}`);
      return;
    }

    // **In its own tenant transaction, deliberately.** `audit_events` has an RLS policy requiring
    // the tenant scope to be declared, and every caller here runs inside
    // `runAsPlatformOperation` — where no tenant scope is set, so the insert is refused. That is
    // the policy working: a platform-plane transaction must not be able to write into a company's
    // trail without saying which company. Declaring the scope is how it says so.
    await this.prisma.runInTenantTransaction({ tenantId } as TenantScope, () =>
      this.auditEvents.appendWithinCurrentScope(tenantId, {
        action: event.action,
        resourceType: 'provider-profile',
        resourceId: event.resourceId,
        actorUserId: event.actorUserId,
        summary: event.summary,
        ...(event.resourceVersion === undefined ? {} : { resourceVersion: event.resourceVersion }),
        metadata: event.metadata,
      }),
    );
  }

  private toProfileView(row: {
    id: string;
    tenantId: string | null;
    kind: string;
    mode: string;
    label: string;
    lifecycle: string;
    enabled: boolean;
    baseUrl: string | null;
    authType: string | null;
    authHeaderName: string | null;
    secretRef: string | null;
    timeoutMs: number | null;
    usageInputPath: string | null;
    usageOutputPath: string | null;
    usageCachedInputPath: string | null;
    requestIdPath: string | null;
    lastTestedAt: Date | null;
    lastTestOk: boolean | null;
    lastTestReachedProvider: boolean | null;
    lastTestDetail: string | null;
    version: number;
    models?:
      | {
          id: string;
          providerModelRef: string;
          capability: string;
          lifecycle: string;
          enabled: boolean;
          lifecycleChangedAt: Date | null;
          lifecycleNote: string | null;
          pricing?: unknown[] | undefined;
        }[]
      | undefined;
  }): ProviderProfileView {
    const kind = row.kind as ProviderKind;

    return {
      id: row.id,
      tenantId: row.tenantId,
      kind,
      kindLabel: row.label,
      mode: row.mode as ProviderMode,
      label: row.label,
      lifecycle: row.lifecycle as ProviderLifecycleState,
      enabled: row.enabled,
      custom:
        row.baseUrl === null || row.authType === null
          ? null
          : {
              baseUrl: row.baseUrl,
              authType: row.authType as ProviderAuthType,
              authHeaderName: row.authHeaderName,
              // Whether one is stored, never the value. A credential shown once is a credential
              // in a browser's memory.
              hasSecret: row.secretRef !== null,
              timeoutMs: row.timeoutMs ?? 0,
              usageMapping: {
                inputPath: row.usageInputPath ?? '',
                outputPath: row.usageOutputPath ?? '',
                cachedInputPath: row.usageCachedInputPath,
              },
              requestIdPath: row.requestIdPath,
            },
      adapterCanReachProvider:
        this.adapters.find((adapter) => adapter.kind === kind)?.canReachProvider ?? false,
      lastTest:
        row.lastTestedAt === null || row.lastTestOk === null || row.lastTestReachedProvider === null
          ? null
          : {
              at: row.lastTestedAt.toISOString(),
              ok: row.lastTestOk,
              reachedProvider: row.lastTestReachedProvider,
              detail: row.lastTestDetail ?? '',
            },
      models: (row.models ?? []).map((model) => this.toModelView(model)),
      version: row.version,
    };
  }

  private toModelView(row: {
    id: string;
    providerModelRef: string;
    capability: string;
    lifecycle: string;
    enabled: boolean;
    lifecycleChangedAt: Date | null;
    lifecycleNote: string | null;
    pricing?: unknown[] | undefined;
  }): ProviderModelView {
    const pricing = (row.pricing ?? [])[0] as
      | {
          id: string;
          versionNumber: number;
          currency: string;
          inputPerMillionMinorUnits: number;
          outputPerMillionMinorUnits: number;
          cachedInputPerMillionMinorUnits: number | null;
          effectiveFrom: Date;
        }
      | undefined;

    return {
      id: row.id,
      providerModelRef: row.providerModelRef,
      capability: row.capability,
      lifecycle: row.lifecycle as ProviderLifecycleState,
      enabled: row.enabled,
      lifecycleChangedAt: row.lifecycleChangedAt?.toISOString() ?? null,
      lifecycleNote: row.lifecycleNote,
      currentPricing:
        pricing === undefined
          ? null
          : {
              id: pricing.id,
              versionNumber: pricing.versionNumber,
              currency: pricing.currency,
              inputPerMillionMinorUnits: pricing.inputPerMillionMinorUnits,
              outputPerMillionMinorUnits: pricing.outputPerMillionMinorUnits,
              cachedInputPerMillionMinorUnits: pricing.cachedInputPerMillionMinorUnits,
              effectiveFrom: pricing.effectiveFrom.toISOString(),
            },
    };
  }
}
