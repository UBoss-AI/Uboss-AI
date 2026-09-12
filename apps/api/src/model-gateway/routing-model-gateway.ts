import { Injectable, Logger } from '@nestjs/common';

import {
  LOGICAL_MODEL_PROFILE_SPEC,
  routeLogicalProfile,
  usageCostMinorUnits,
  type CustomProviderConfig,
  type LogicalModelProfile,
  type ProviderKind,
  type ProviderUsage,
  type RoutingCandidate,
} from '@uboss/types';

import { SecretsVault } from '../connections/secrets-vault.js';
import { PrismaService } from '../persistence/prisma.service.js';
import { ProviderThrottleService } from '../rate-limits/provider-throttle.service.js';
import { getCorrelationId } from '../request-context/request-context.js';
import {
  tenantScopeForPlatformOperation,
  type TenantScope,
} from '../persistence/tenant-context.js';
import { CostEngineService } from '../cost/cost-engine.service.js';
import {
  BudgetRefusedError,
  ModelGateway,
  type ModelRequest,
  type ModelResponse,
} from './model-gateway.js';
import {
  ProviderAdapter,
  ProviderNotConfiguredError,
  type ProviderCall,
  type ProviderResult,
} from './provider-adapter.js';

/** A resolved route: the model to call and everything needed to call it. */
interface ResolvedRoute {
  providerModelId: string;
  providerProfileId: string;
  providerKind: ProviderKind;
  providerModelRef: string;
  capability: string;
  timeoutMs: number;
  custom: CustomProviderConfig | null;
  secretRef: string | null;
  /** Null for a platform profile. */
  tenantId: string | null;
  /** Prompt 40. Null when the provider's limit for this model was never declared. */
  quotaRequestsPerMinute: number | null;
  pricing: {
    id: string;
    currency: string;
    inputPerMillionMinorUnits: number;
    outputPerMillionMinorUnits: number;
    cachedInputPerMillionMinorUnits: number | null;
  } | null;
  usedFallback: boolean;
}

/**
 * The Model Gateway that ships in the application.
 *
 * ## What it does, in order
 *
 *   1. **Resolve.** The request names a logical profile; `logical_model_routes` says which models
 *      answer it, and `routeLogicalProfile` picks one under that profile's own fallback policy.
 *      A company's own routes take precedence over the platform defaults, so BYOK works without
 *      a second code path.
 *   2. **Call.** The adapter for the chosen profile's kind, with the credential resolved from the
 *      vault *at the moment of use* and never before.
 *   3. **Price.** Against the model's current pricing version, whose id is recorded — so a later
 *      price change cannot restate what this call cost.
 *   4. **Record.** One `model_gateway_calls` row with the provider's own request id and the exact
 *      usage it reported. Append-only. Written for a failure and for an unroutable call too,
 *      because "we could not route OBJECTIVE_PLANNER for two hours" is the most useful thing in
 *      the table.
 *
 * ## What it never does
 *
 * **It never tells a caller which provider answered.** `ModelResponse.capability` is an opaque
 * label; there is no field for a provider or model name, and `PROVIDER_KINDS` does not appear in
 * any tenant-facing type. That is Technical Architecture §18's rule — "provider names are
 * configuration, not business object identity" — kept by construction rather than by discipline.
 *
 * **It never fabricates usage.** If an adapter cannot report token counts, the call is recorded
 * with zeros and no cost rather than with an estimate. An estimate stored where measured usage
 * belongs is the one thing that would make Prompt 30's reconciliation meaningless.
 */
@Injectable()
export class RoutingModelGateway extends ModelGateway {
  private readonly logger = new Logger(RoutingModelGateway.name);

  /**
   * An opaque label for the gateway itself.
   *
   * Deliberately not "whatever is configured": the value is read by screens that ask *what kind
   * of thing is wired in*, and a provider name here would leak straight into a company workspace.
   * The per-call capability is on the response.
   */
  readonly capability = 'uboss-model-gateway-v1';

  constructor(
    private readonly prisma: PrismaService,
    private readonly vault: SecretsVault,
    private readonly adapters: readonly ProviderAdapter[],
    /**
     * The Token/Cost Engine — Prompt 30.
     *
     * Optional, and absent only in tests that exercise routing alone. When it is present every
     * call through this gateway is checked, reserved, settled and released without any caller
     * knowing: that is the point of putting the flow here rather than in five call sites, and it
     * is why the locked rule that all AI goes through one seam is worth having.
     */
    private readonly cost?: CostEngineService | undefined,
    /**
     * Provider quota-aware throttling and adaptive backoff — Prompt 40.
     *
     * Optional for the same reason `cost` is: routing tests construct the gateway alone. When it
     * is absent the gateway behaves exactly as it did before this prompt, which is the right
     * fallback — an absent throttle means no throttling, never a refusal.
     */
    private readonly throttle?: ProviderThrottleService | undefined,
  ) {
    super();
  }

  /**
   * Whether any registered adapter can actually reach a provider.
   *
   * False in every environment today, and read before offering an AI action so a screen can say
   * "this will produce mock output" rather than discovering it afterwards.
   */
  get usesRealModel(): boolean {
    return this.adapters.some((adapter) => adapter.canReachProvider);
  }

  async complete(request: ModelRequest): Promise<ModelResponse> {
    const tried: string[] = [];

    // ---- Section 20: Check -> Estimate -> Reserve, before anything is sent ----
    //
    // Reserved *before* the provider call and released after, which is the whole point: two
    // agents racing for the last of a budget serialise on the wallet row, and the second sees
    // the first one's hold. Doing this after the call would meter spend that had already
    // happened.
    const reservation = await this.reserveFor(request);
    if (reservation !== null && !reservation.allowed) {
      await this.recordBlockedByBudget(request, reservation.reason);
      throw new BudgetRefusedError(reservation.reason, reservation.needsApproval);
    }

    // One retry across candidates: a provider that is down should not consume the whole request
    // budget in retries, and the profile's fallback policy already decides whether moving on is
    // permitted at all.
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const resolution = await this.resolve(request, tried);

      if (resolution === null) {
        return this.recordUnroutable(request, tried);
      }

      // ---- Prompt 40: is this model allowed to be called right now? ----
      //
      // Checked here rather than inside `callAdapter` so a throttled model counts as *tried* and
      // the loop moves on to the profile's fallback. Waiting out a cooldown while a second
      // configured model sits idle would turn a provider's rate limit into our latency.
      if (this.throttle !== undefined) {
        const gate = await this.throttle.mayCall({
          providerModelId: resolution.providerModelId,
          quotaRequestsPerMinute: resolution.quotaRequestsPerMinute,
        });
        if (!gate.proceed) {
          tried.push(resolution.providerModelId);
          this.logger.debug(
            `${request.profile} skipped model ${resolution.providerModelId}: ${gate.reason}`,
          );
          // Recorded, like any other reason a model did not answer. A throttled call that left no
          // row would make "why was this run slow" unanswerable from the gateway table.
          await this.recordFailure(request, resolution, gate.reason);
          continue;
        }
      }

      try {
        const result = await this.callAdapter(resolution, request);
        const response = await this.recordSuccess(request, resolution, result);
        // The model answered, so whatever it was doing before is over. Cleared fully rather than
        // decayed: a decaying counter keeps throttling a provider that has recovered.
        this.throttle?.recordSuccess(resolution.providerModelId);

        // ---- Settle: charge the actual, release the rest ----
        if (reservation !== null && reservation.reservationId !== null && this.cost) {
          await this.cost.settle({
            scope: { tenantId: request.tenantId } as TenantScope,
            reservationId: reservation.reservationId,
            // What the provider actually cost. Zero when nothing priced it, which is honest —
            // the usage is still recorded on the gateway call.
            actualMinor: response.costMinorUnits ?? 0,
            ...(response.callId === null ? {} : { modelGatewayCallId: response.callId }),
            tokens: {
              inputTokens: response.promptTokens,
              outputTokens: response.completionTokens,
              cachedInputTokens: response.cachedInputTokens,
            },
          });
        }

        return response;
      } catch (cause) {
        tried.push(resolution.providerModelId);

        const detail =
          cause instanceof ProviderNotConfiguredError
            ? cause.message
            : cause instanceof Error
              ? cause.message
              : 'The provider call failed.';

        this.logger.warn(
          `${request.profile} call failed on model ${resolution.providerModelId}: ${detail}`,
        );

        // ---- Prompt 40: learn the provider's limit from its refusal ----
        //
        // The adapter's message is all there is to classify from — there is no structured failure
        // reason on this path — so a rate-limit or timeout signature in the text is treated as
        // retryable and everything else is not. Coarse, and deliberately so: the cost of guessing
        // wrong in the retryable direction is one extra cooldown, and in the other direction it is
        // a tight retry loop against a provider that is asking us to stop.
        this.throttle?.recordFailure({
          providerModelId: resolution.providerModelId,
          reason: classifyProviderFailure(detail),
        });

        // Recorded now, so a failed attempt is visible even if the retry succeeds. Two rows for
        // one logical call is correct: two calls were made.
        await this.recordFailure(request, resolution, detail);
      }
    }

    // Nothing answered, so nothing was spent. The hold is given back rather than left to
    // expire — a company should not be short of budget because a provider was down.
    await this.releaseFor(request, reservation, 'No model could answer, so nothing was spent.');
    return this.recordUnroutable(request, tried);
  }

  /** Estimate and reserve, when a cost engine is wired in. */
  private async reserveFor(request: ModelRequest): Promise<{
    allowed: boolean;
    needsApproval: boolean;
    reason: string;
    reservationId: string | null;
  } | null> {
    if (!this.cost) return null;

    const scope = { tenantId: request.tenantId } as TenantScope;

    const estimate = await this.cost.estimate({
      scope,
      logicalProfile: request.profile,
      maxTokens: request.maxTokens,
    });

    const context = {
      scope,
      logicalProfile: request.profile,
      purpose: request.purpose,
      ...(request.departmentId === undefined ? {} : { departmentId: request.departmentId }),
      ...(request.objectiveId === undefined ? {} : { objectiveId: request.objectiveId }),
      ...(request.engineAgentId === undefined ? {} : { engineAgentId: request.engineAgentId }),
      ...(request.agentRunId === undefined ? {} : { agentRunId: request.agentRunId }),
    };

    const outcome = await this.cost.reserve(context, {
      estimateMinor: estimate.estimateMinor,
      currency: estimate.currency,
    });

    if (!outcome.reserved) {
      return {
        allowed: false,
        needsApproval: false,
        reason: outcome.outcome.reason,
        reservationId: null,
      };
    }

    // **An approval threshold is not a refusal here.** Section 20 puts it before "higher-cost
    // execution", and the decision belongs to a person through the Approval Engine — not to this
    // gateway, which has no way to ask one. The reservation stands and the caller is told.
    return {
      allowed: true,
      needsApproval: outcome.outcome.decision === 'NeedsApproval',
      reason: outcome.outcome.reason,
      reservationId: outcome.reservation.id,
    };
  }

  private async releaseFor(
    request: ModelRequest,
    reservation: { reservationId: string | null } | null,
    reason: string,
  ): Promise<void> {
    if (!this.cost || reservation === null || reservation.reservationId === null) return;
    await this.cost.release({
      scope: { tenantId: request.tenantId } as TenantScope,
      reservationId: reservation.reservationId,
      reason,
    });
  }

  /** Record that a call never happened because a budget refused it. */
  private async recordBlockedByBudget(request: ModelRequest, reason: string): Promise<void> {
    await this.prisma.runAsPlatformOperation(() =>
      this.prisma.client.modelGatewayCall.create({
        data: {
          tenantId: request.tenantId,
          // Prompt 39: stage four of the correlation chain. Read from the ambient context rather
          // than threaded through `ModelRequest`, for the reason in the file that added it.
          correlationId: getCorrelationId() ?? null,
          profile: request.profile,
          purpose: request.purpose,
          capability: 'none',
          outcome: 'Unroutable',
          detail: `Refused by a budget control: ${reason}`.slice(0, 2000),
          producedByRealModel: false,
        },
      }),
    );
  }

  // -------------------------------------------------------------------------
  // Resolution
  // -------------------------------------------------------------------------

  /**
   * Which model answers this profile for this company.
   *
   * A company's own routes win outright when it has any — not merged with the platform defaults.
   * Merging would mean a company that configured BYOK for its planner would silently keep the
   * platform model as a fallback, which is the opposite of what choosing BYOK means.
   */
  private async resolve(
    request: ModelRequest,
    exclude: readonly string[],
  ): Promise<ResolvedRoute | null> {
    return this.prisma.runAsPlatformOperation(async () => {
      const companyRoutes = await this.prisma.client.logicalModelRoute.findMany({
        where: { tenantId: request.tenantId, profile: request.profile },
        include: { model: { include: { profile: true } } },
        orderBy: { preference: 'asc' },
      });

      const rows =
        companyRoutes.length > 0
          ? companyRoutes
          : await this.prisma.client.logicalModelRoute.findMany({
              where: { tenantId: null, profile: request.profile },
              include: { model: { include: { profile: true } } },
              orderBy: { preference: 'asc' },
            });

      if (rows.length === 0) return null;

      const candidates: RoutingCandidate[] = rows.map((row) => ({
        providerModelId: row.providerModelId,
        preference: row.preference,
        lifecycle: row.model.lifecycle as RoutingCandidate['lifecycle'],
        capability: row.model.capability,
        // A route is only usable if the route, the model and its profile are all enabled. Three
        // switches rather than one, because disabling a whole provider profile has to be one
        // action rather than a sweep through its models.
        enabled: row.enabled && row.model.enabled && row.model.profile.enabled,
      }));

      const outcome = routeLogicalProfile({
        profile: request.profile,
        candidates,
        exclude,
      });

      if (!outcome.routed) {
        this.logger.debug(`${request.profile} is unroutable: ${outcome.reason}`);
        return null;
      }

      const row = rows.find((entry) => entry.providerModelId === outcome.candidate.providerModelId);
      if (row === undefined) return null;

      const pricing = await this.prisma.client.pricingVersionRow.findFirst({
        where: { providerModelId: row.providerModelId, supersededAt: null },
      });

      const profile = row.model.profile;

      return {
        providerModelId: row.providerModelId,
        providerProfileId: profile.id,
        providerKind: profile.kind as ProviderKind,
        providerModelRef: row.model.providerModelRef,
        capability: row.model.capability,
        timeoutMs: profile.timeoutMs ?? 60_000,
        custom: this.customConfigOf(profile),
        secretRef: profile.secretRef,
        tenantId: profile.tenantId,
        quotaRequestsPerMinute: row.model.quotaRequestsPerMinute,
        pricing:
          pricing === null
            ? null
            : {
                id: pricing.id,
                currency: pricing.currency,
                inputPerMillionMinorUnits: pricing.inputPerMillionMinorUnits,
                outputPerMillionMinorUnits: pricing.outputPerMillionMinorUnits,
                cachedInputPerMillionMinorUnits: pricing.cachedInputPerMillionMinorUnits,
              },
        usedFallback: outcome.usedFallback,
      };
    });
  }

  private customConfigOf(profile: {
    kind: string;
    baseUrl: string | null;
    authType: string | null;
    authHeaderName: string | null;
    secretRef: string | null;
    timeoutMs: number | null;
    usageInputPath: string | null;
    usageOutputPath: string | null;
    usageCachedInputPath: string | null;
    requestIdPath: string | null;
  }): CustomProviderConfig | null {
    if (profile.kind !== 'Custom') return null;
    if (profile.baseUrl === null || profile.authType === null) return null;

    return {
      baseUrl: profile.baseUrl,
      // The model id travels on the `ProviderCall` rather than here, because one custom profile
      // can carry several models.
      modelId: '',
      authType: profile.authType as CustomProviderConfig['authType'],
      secretRef: profile.secretRef,
      authHeaderName: profile.authHeaderName,
      timeoutMs: profile.timeoutMs ?? 60_000,
      usageMapping: {
        inputPath: profile.usageInputPath ?? '',
        outputPath: profile.usageOutputPath ?? '',
        cachedInputPath: profile.usageCachedInputPath,
      },
      requestIdPath: profile.requestIdPath,
    };
  }

  // -------------------------------------------------------------------------
  // The call
  // -------------------------------------------------------------------------

  private async callAdapter(route: ResolvedRoute, request: ModelRequest): Promise<ProviderResult> {
    const adapter = this.adapters.find((entry) => entry.kind === route.providerKind);
    if (adapter === undefined) {
      throw new ProviderNotConfiguredError(
        route.providerKind,
        'no adapter is registered for this provider kind.',
      );
    }

    // Resolved at the moment of use and held only for the duration of the call. Never logged,
    // never returned, never put on the route object that other code can see.
    const credential =
      route.secretRef === null
        ? null
        : await this.vault.reveal(
            tenantScopeForPlatformOperation(route.tenantId ?? request.tenantId),
            route.secretRef,
          );

    const call: ProviderCall = {
      providerModelRef: route.providerModelRef,
      instruction: request.instruction,
      context: request.context,
      maxTokens: request.maxTokens,
      timeoutMs: route.timeoutMs,
      custom: route.custom === null ? null : { ...route.custom, modelId: route.providerModelRef },
      credential,
    };

    return adapter.complete(call);
  }

  // -------------------------------------------------------------------------
  // Recording
  // -------------------------------------------------------------------------

  private async recordSuccess(
    request: ModelRequest,
    route: ResolvedRoute,
    result: ProviderResult,
  ): Promise<ModelResponse> {
    const cost =
      route.pricing === null
        ? null
        : usageCostMinorUnits({ usage: result.usage, pricing: route.pricing });

    const call = await this.prisma.runAsPlatformOperation(() =>
      this.prisma.client.modelGatewayCall.create({
        data: {
          tenantId: request.tenantId,
          // Prompt 39: stage four of the correlation chain. Read from the ambient context rather
          // than threaded through `ModelRequest`, for the reason in the file that added it.
          correlationId: getCorrelationId() ?? null,
          profile: request.profile,
          purpose: request.purpose,
          providerProfileId: route.providerProfileId,
          providerModelId: route.providerModelId,
          capability: route.capability,
          usedFallback: route.usedFallback,
          inputTokens: result.usage.inputTokens,
          outputTokens: result.usage.outputTokens,
          cachedInputTokens: result.usage.cachedInputTokens,
          producedByRealModel: result.reachedProvider,
          outcome: 'Succeeded',
          latencyMs: result.latencyMs,
          // A request id is only ever stored for a call that actually reached a provider. The
          // database refuses the other combination.
          ...(result.reachedProvider && result.providerRequestId !== null
            ? { providerRequestId: result.providerRequestId }
            : {}),
          ...(route.pricing === null || cost === null
            ? {}
            : {
                pricingVersionId: route.pricing.id,
                costMinorUnits: cost,
                currency: route.pricing.currency,
              }),
        },
      }),
    );

    return {
      output: result.output,
      promptTokens: result.usage.inputTokens,
      completionTokens: result.usage.outputTokens,
      cachedInputTokens: result.usage.cachedInputTokens,
      providerRequestId: result.providerRequestId,
      costMinorUnits: cost,
      currency: route.pricing?.currency ?? null,
      usedFallback: route.usedFallback,
      callId: call.id,
      producedByRealModel: result.reachedProvider,
      capability: route.capability,
    };
  }

  private async recordFailure(
    request: ModelRequest,
    route: ResolvedRoute,
    detail: string,
  ): Promise<void> {
    await this.prisma.runAsPlatformOperation(() =>
      this.prisma.client.modelGatewayCall.create({
        data: {
          tenantId: request.tenantId,
          // Prompt 39: stage four of the correlation chain. Read from the ambient context rather
          // than threaded through `ModelRequest`, for the reason in the file that added it.
          correlationId: getCorrelationId() ?? null,
          profile: request.profile,
          purpose: request.purpose,
          providerProfileId: route.providerProfileId,
          providerModelId: route.providerModelId,
          capability: route.capability,
          usedFallback: route.usedFallback,
          outcome: 'Failed',
          detail: detail.slice(0, 2000),
          producedByRealModel: false,
        },
      }),
    );
  }

  /**
   * Record that nothing could answer, and say so rather than returning something plausible.
   *
   * Throwing rather than returning empty output: a caller that got `''` back would treat it as an
   * answer. The run engine turns this into a `ProviderOrToolUnavailable` block, which Prompt 27's
   * Executor already knows how to raise as an exception — and which is honest about the fact that
   * no model was reached.
   */
  private async recordUnroutable(request: ModelRequest, tried: readonly string[]): Promise<never> {
    const spec = LOGICAL_MODEL_PROFILE_SPEC[request.profile];
    const detail =
      tried.length === 0
        ? `No model is configured for ${request.profile}.`
        : `Every model configured for ${request.profile} failed or is unavailable ` +
          `(${spec.fallbackPolicy}).`;

    await this.prisma.runAsPlatformOperation(() =>
      this.prisma.client.modelGatewayCall.create({
        data: {
          tenantId: request.tenantId,
          // Prompt 39: stage four of the correlation chain. Read from the ambient context rather
          // than threaded through `ModelRequest`, for the reason in the file that added it.
          correlationId: getCorrelationId() ?? null,
          profile: request.profile,
          purpose: request.purpose,
          // Deliberately no model: a database CHECK requires an unroutable call to name none, so
          // routing failures cannot be mistaken for a provider's fault in the statistics.
          capability: 'none',
          outcome: 'Unroutable',
          detail,
          producedByRealModel: false,
        },
      }),
    );

    throw new ProviderNotConfiguredError(
      'Custom',
      `${detail} The call was recorded so the gap is visible rather than silent.`,
    );
  }

  /** Usage as the shared type expresses it, for a caller that needs to price something itself. */
  static usageOf(response: ModelResponse): ProviderUsage {
    return {
      inputTokens: response.promptTokens,
      outputTokens: response.completionTokens,
      cachedInputTokens: response.cachedInputTokens,
    };
  }

  /** Whether a logical profile needs an explicit budget or approval guardrail before it is used. */
  static needsGuardrail(profile: LogicalModelProfile): boolean {
    return LOGICAL_MODEL_PROFILE_SPEC[profile].needsExplicitGuardrail;
  }
}

/**
 * Map an adapter's error text onto one of `RETRYABLE_PROVIDER_REASONS`.
 *
 * A string match, because that is genuinely all the information available: the adapters throw
 * `Error`, not a typed failure. Stated as a limitation rather than dressed up — a structured
 * reason on `ProviderAdapter` would be better and is a change to four adapters that this prompt
 * did not need to make.
 *
 * Anything unrecognised is **not** retryable. A rejected prompt or a refused credential will be
 * refused identically next time, so backing off from it spends a customer's wait to reach the same
 * answer; treating the unknown as retryable would make that the default.
 */
function classifyProviderFailure(detail: string): string {
  const text = detail.toLowerCase();
  if (text.includes('429') || text.includes('rate limit') || text.includes('too many requests')) {
    return 'RateLimited';
  }
  if (text.includes('timeout') || text.includes('timed out') || text.includes('etimedout')) {
    return 'Timeout';
  }
  if (text.includes('503') || text.includes('unavailable') || text.includes('econnrefused')) {
    return 'Unavailable';
  }
  if (text.includes('500') || text.includes('502') || text.includes('504')) {
    return 'ServerError';
  }
  return 'NotRetryable';
}
