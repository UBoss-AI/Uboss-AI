import { Injectable, Logger } from '@nestjs/common';

import type { LogicalModelProfile } from '@uboss/types';

/**
 * Thrown when a budget control refuses a call before it is made — Prompt 30.
 *
 * A distinct error rather than a generic one, because the run engine turns it into a
 * `BlockedByBudget` run state, which Prompt 27's Executor already knows how to raise as a
 * `BudgetOrTokenLimit` exception. A generic failure would be retried; this must not be.
 */
export class BudgetRefusedError extends Error {
  constructor(
    reason: string,
    /** True when a person could authorise it, false when it is a hard stop. */
    readonly needsApproval: boolean,
  ) {
    super(reason);
    this.name = 'BudgetRefusedError';
  }
}

/**
 * What the caller asks a model to do.
 *
 * Deliberately provider-agnostic: no model name, no temperature, no provider-specific option.
 * Those belong to whichever adapter is wired in, and letting them leak into the request type is
 * how a provider name ends up in a service, a screen and eventually a database column.
 */
export interface ModelRequest {
  /**
   * Which logical model profile answers this call — one of the five in Technical Architecture
   * §18, and **the only thing a caller may say about how the work should be done.**
   *
   * Required rather than defaulted, and that is the point of Prompt 29. A default would let a
   * caller stay silent about whether its work needs a planner or a fast model, and the gateway
   * would have to guess; a guess made once in a helper becomes the routing for half the product.
   * Naming a provider or a model here is impossible by construction — neither is in the type.
   */
  profile: LogicalModelProfile;

  /** What this call is for, e.g. `objective.analysis.detect-human-work`. Used for attribution. */
  purpose: string;
  /** The instruction. */
  instruction: string;
  /** The material to work on. */
  context: string;
  /** A ceiling the caller is willing to spend, in tokens. The gateway must not exceed it. */
  maxTokens: number;
  /** Which company the call is for, so usage is attributable. */
  tenantId: string;

  /**
   * What the spend belongs to, for the budget hierarchy — Prompt 30.
   *
   * All optional, because not every AI call has all four: an Objective analysis has an objective
   * and no run, a builder test has an agent and no objective. Each one that *is* known narrows
   * which budgets the call is checked against, and omitting one silently is the difference
   * between an objective's budget working and being decorative — so callers pass what they have.
   */
  departmentId?: string | undefined;
  objectiveId?: string | undefined;
  engineAgentId?: string | undefined;
  agentRunId?: string | undefined;
}

export interface ModelResponse {
  /** The model's output. */
  output: string;
  /** Tokens actually consumed, as the adapter reports them. */
  promptTokens: number;
  completionTokens: number;
  /**
   * Tokens billed at a provider's cached-input rate, where it reports them separately.
   *
   * Zero rather than null when a provider does not distinguish them — those tokens are counted in
   * `promptTokens` and priced at the full rate, which is the honest reading.
   */
  cachedInputTokens: number;

  /**
   * The provider's own id for this request, when it gave one.
   *
   * The prompt's requirement, and the field a support ticket quotes. **Null for a mock**, which a
   * database CHECK enforces: a fabricated id would let somebody raise a ticket about a call that
   * never left the building.
   */
  providerRequestId: string | null;

  /** What the call cost in integer minor units, priced from a cited pricing version. */
  costMinorUnits: number | null;
  currency: string | null;

  /** True when the profile's preferred model was unavailable and a fallback answered. */
  usedFallback: boolean;

  /** The call record this produced, so a caller can cite it without a second query. */
  callId: string | null;
  /**
   * **Whether a real model produced this.** `false` for every adapter that ships today.
   *
   * Part of the response type rather than an implementation detail, for the same reason
   * `PayoutResult.deliveredRealPayment` is: a screen or a report that presented mock output as a
   * model's judgement would be the fabrication the client's rules forbid. Callers store it.
   */
  producedByRealModel: boolean;
  /**
   * An opaque capability label, e.g. `mock-reasoning-v1`.
   *
   * **Never a provider or model name.** The client's locked rule is that provider names stay
   * behind the Model Gateway; a company reads what the capability was, not who supplied it.
   */
  capability: string;
}

/**
 * The Model Gateway.
 *
 * ## Why every AI call goes through one seam
 *
 * The client's locked rule is that **provider names live behind the Model Gateway**. That is not
 * only about tidiness: the Master Console owns provider configuration, cost is metered centrally,
 * and a company workspace must never be able to name — or depend on — which provider answered.
 * A service that called a provider SDK directly would break all three at once, and it would be
 * one import, easy to add and hard to notice.
 *
 * So this is the only way to reach a model. Any later prompt adding AI work extends an adapter or
 * adds a purpose; it does not add a second path.
 *
 * ## Prompt 29: the seam now routes
 *
 * `MockModelGateway` remains, and it is still what a unit test wires in. What ships in the
 * application is `RoutingModelGateway`, which resolves the request's `profile` through configured
 * `logical_model_routes`, calls the chosen `ProviderAdapter`, prices the result against an
 * immutable pricing version, and records the call with the provider's own request id.
 *
 * The abstract class did not need to change shape for that, which is the evidence the seam was in
 * the right place: five call sites gained a `profile` and nothing else moved.
 *
 * ## What ships is a mock, and it says so
 *
 * No provider has been configured or approved. `MockModelGateway` is what the module provides, it
 * returns `producedByRealModel: false`, and callers persist that flag next to whatever they store.
 * A real adapter is one class; the analysis pipeline, the cost accounting and the audit trail are
 * provider-agnostic and do not change.
 */
export abstract class ModelGateway {
  /** An opaque label for what is wired in. Never a provider name. */
  abstract readonly capability: string;

  /** Whether a real model is reachable. Read before offering an AI action. */
  abstract readonly usesRealModel: boolean;

  abstract complete(request: ModelRequest): Promise<ModelResponse>;
}

/**
 * The adapter that ships: deterministic, offline, and honest about being a mock.
 *
 * ## Why it produces structured, plausible output rather than refusing
 *
 * This is the opposite call from `UnconfiguredPayoutAdapter`, which refuses outright — and the
 * difference is what the two would cause if misread. A fabricated **payment** makes somebody
 * believe an employee was paid. A fabricated **analysis** produces a draft plan that a person then
 * reads, edits and must approve before anything happens: the human review is already in the path,
 * and the client's rule is that analysis output is always a Draft.
 *
 * So the mock does its job — it lets the whole pipeline, the schema validation, the progress
 * stages and the cancellation be exercised — while `producedByRealModel: false` travels with every
 * response so nothing can present it as a model's judgement.
 *
 * Deterministic on purpose: a mock that varied would make the analysis tests flaky, and a flaky
 * test gets deleted.
 */
@Injectable()
export class MockModelGateway extends ModelGateway {
  readonly capability = 'mock-reasoning-v1';
  readonly usesRealModel = false;

  private readonly logger = new Logger(MockModelGateway.name);

  async complete(request: ModelRequest): Promise<ModelResponse> {
    this.logger.debug(`Mock model call for ${request.purpose} (${request.tenantId}).`);

    // A crude but stable token count, so estimates and ceilings can be exercised without a
    // provider. Four characters per token is the usual rule of thumb.
    const promptTokens = Math.min(
      request.maxTokens,
      Math.ceil((request.instruction.length + request.context.length) / 4),
    );
    const completionTokens = Math.min(request.maxTokens - promptTokens, 120);

    return {
      output: `mock:${request.purpose}`,
      promptTokens,
      completionTokens: Math.max(completionTokens, 0),
      cachedInputTokens: 0,
      // Never invented, for the same reason `producedByRealModel` is never true here.
      providerRequestId: null,
      costMinorUnits: null,
      currency: null,
      usedFallback: false,
      // This adapter records nothing; `RoutingModelGateway` is what writes call records.
      callId: null,
      // Never true. Every caller stores this.
      producedByRealModel: false,
      capability: this.capability,
    };
  }
}
