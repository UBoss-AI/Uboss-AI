/**
 * AI Provider Profiles and the Model Gateway — Prompt 29.
 *
 * ## The locked rule this file exists to make structural
 *
 * **"Provider names are configuration, not business object identity"** (Technical Architecture
 * §18). A business object — an Objective, an Engine Agent, a Run, a cost ledger entry — names a
 * **logical model profile**, never a provider and never a model. The gateway resolves the profile
 * to a provider and a model at the moment of the call, according to platform configuration that a
 * company workspace cannot see.
 *
 * That is why the vocabulary here is split in two, and why the halves never meet in a column:
 *
 *   * `LOGICAL_MODEL_PROFILES` — the five names business code is allowed to use. Stable, safe to
 *     store, safe to show a company.
 *   * `PROVIDER_KINDS`, `ProviderProfile`, `ProviderModel` — configuration. Platform-plane, and a
 *     tenant-facing response must never carry them.
 *
 * If a provider name ever needs to appear in a company screen, that is a change to approved
 * business behaviour and not something to solve by widening a type here.
 *
 * ## The five profiles are transcribed, not designed
 *
 * `LOGICAL_MODEL_PROFILE_SPEC` reproduces §18's table — profile, typical use, gateway behaviour —
 * word for word in the `gatewayBehaviour` field, because those sentences are the requirement. The
 * machine-readable defaults beside them are this file's reading of those sentences, and each says
 * which phrase it comes from.
 */

// ---------------------------------------------------------------------------
// How a company's AI is supplied
// ---------------------------------------------------------------------------

/**
 * The three provider modes, from UBoss_Final_1 §19 "AI provider management".
 *
 * §19's table has a fourth row, **Auto / Policy Choice** — "user does not pick a vendor on every
 * task; company/UBoss policy chooses the approved logical model profile". It is deliberately *not*
 * a fourth mode here, because it does not answer the question the other three answer (whose
 * account or endpoint is used). It states the behaviour that logical model profiles *are*: nobody
 * picks a vendor per task, ever, in any of the three modes. Modelling it as a mode would have made
 * "policy chooses" opt-out-able, which is the opposite of what it says.
 */
export const PROVIDER_MODES = ['UBossManaged', 'CompanyBYOK', 'CustomEnterprise'] as const;
export type ProviderMode = (typeof PROVIDER_MODES)[number];

export const PROVIDER_MODE_LABELS: Record<ProviderMode, string> = {
  UBossManaged: 'UBoss Managed',
  CompanyBYOK: 'Company BYOK',
  CustomEnterprise: 'Custom Enterprise Provider',
};

/** §19's "customer experience" column, transcribed. */
export const PROVIDER_MODE_DESCRIPTIONS: Record<ProviderMode, string> = {
  UBossManaged:
    'UBoss provider account is used; UBoss meters every company/department/objective/agent/run ' +
    'and applies commercial allowance/budget rules.',
  CompanyBYOK:
    'Customer uses its own approved account/key/connection; UBoss still tracks usage and ' +
    'enforces internal governance/budgets.',
  CustomEnterprise:
    'Customer supplies an approved enterprise endpoint/provider profile; UBoss treats it through ' +
    'the same policy layer.',
};

/**
 * Whether a mode's credentials belong to the company rather than to UBoss.
 *
 * Drives where the secret lives and who may rotate it. In both customer-supplied modes the
 * company holds the credential, and §19's own wording is the reason UBoss still meters it:
 * "UBoss still tracks usage and enforces internal governance/budgets".
 */
export function modeUsesCompanyCredentials(mode: ProviderMode): boolean {
  return mode === 'CompanyBYOK' || mode === 'CustomEnterprise';
}

// ---------------------------------------------------------------------------
// Logical model profiles — the only names business code may use
// ---------------------------------------------------------------------------

export const LOGICAL_MODEL_PROFILES = [
  'OBJECTIVE_PLANNER',
  'AGENT_STANDARD',
  'AGENT_FAST',
  'EXECUTOR',
  'HIGH_REASONING',
] as const;
export type LogicalModelProfile = (typeof LOGICAL_MODEL_PROFILES)[number];

/**
 * How far the gateway may go to find a working provider.
 *
 * A closed set rather than a free-form policy, because "conservative fallback" has to become
 * something the gateway can act on. The values are this file's reading of §18's behaviour column;
 * the sentences they read are quoted in `LOGICAL_MODEL_PROFILE_SPEC`.
 */
export const FALLBACK_POLICIES = ['NoFallback', 'SameCapabilityOnly', 'AnyApproved'] as const;
export type FallbackPolicy = (typeof FALLBACK_POLICIES)[number];

export const FALLBACK_POLICY_LABELS: Record<FallbackPolicy, string> = {
  NoFallback: 'No fallback — fail and raise an exception',
  SameCapabilityOnly: 'Fall back only to a model of the same declared capability',
  AnyApproved: 'Fall back to any approved model for this profile',
};

export interface LogicalModelProfileSpec {
  profile: LogicalModelProfile;
  /** §18's "Typical use" column, transcribed. */
  typicalUse: string;
  /** §18's "Gateway behavior" column, transcribed. This is the requirement. */
  gatewayBehaviour: string;
  /** This file's reading of the sentence above, with the phrase it comes from. */
  fallbackPolicy: FallbackPolicy;
  /** Whether output must validate against a schema before the caller sees it. */
  schemaConstrained: boolean;
  /** Whether a call on this profile needs an explicit budget or approval guardrail. */
  needsExplicitGuardrail: boolean;
}

/**
 * The five profiles, from Technical Architecture §18.
 *
 * Two readings are worth stating because they are judgements rather than transcription:
 *
 *   * `OBJECTIVE_PLANNER` gets `SameCapabilityOnly` from "conservative fallback", and
 *     `schemaConstrained` from "schema-constrained output". A planner silently answered by a
 *     weaker model would produce a plan a manager then approves, so the conservative reading is
 *     the safe one.
 *   * `HIGH_REASONING` gets `NoFallback` from "explicit budget/approval guardrail". Falling back
 *     would mean the expensive path was approved and a different one ran — the guardrail would be
 *     measuring something that did not happen.
 */
export const LOGICAL_MODEL_PROFILE_SPEC: Record<LogicalModelProfile, LogicalModelProfileSpec> = {
  OBJECTIVE_PLANNER: {
    profile: 'OBJECTIVE_PLANNER',
    typicalUse: 'Objective analysis/workflow draft',
    gatewayBehaviour: 'High reasoning, schema-constrained output, conservative fallback.',
    fallbackPolicy: 'SameCapabilityOnly',
    schemaConstrained: true,
    needsExplicitGuardrail: false,
  },
  AGENT_STANDARD: {
    profile: 'AGENT_STANDARD',
    typicalUse: 'Normal AI work',
    gatewayBehaviour: 'Cost/quality balanced model policy.',
    fallbackPolicy: 'AnyApproved',
    schemaConstrained: false,
    needsExplicitGuardrail: false,
  },
  AGENT_FAST: {
    profile: 'AGENT_FAST',
    typicalUse: 'Low-risk lightweight work',
    gatewayBehaviour: 'Lower latency/cost profile.',
    fallbackPolicy: 'AnyApproved',
    schemaConstrained: false,
    needsExplicitGuardrail: false,
  },
  EXECUTOR: {
    profile: 'EXECUTOR',
    typicalUse: 'Validation/exception reasoning',
    gatewayBehaviour: 'Independent evaluator rules where useful.',
    fallbackPolicy: 'SameCapabilityOnly',
    schemaConstrained: false,
    needsExplicitGuardrail: false,
  },
  HIGH_REASONING: {
    profile: 'HIGH_REASONING',
    typicalUse: 'Approved complex cases',
    gatewayBehaviour: 'Explicit budget/approval guardrail.',
    fallbackPolicy: 'NoFallback',
    schemaConstrained: false,
    needsExplicitGuardrail: true,
  },
};

export function isLogicalModelProfile(value: string): value is LogicalModelProfile {
  return (LOGICAL_MODEL_PROFILES as readonly string[]).includes(value);
}

// ---------------------------------------------------------------------------
// Providers — configuration, never business object identity
// ---------------------------------------------------------------------------

/**
 * The provider kinds with a first-party adapter, plus `Custom` for a customer endpoint.
 *
 * **This union must not reach a tenant-facing response.** It exists so the platform can register
 * an adapter and so a Master Console screen can name what it is configuring. A company reads the
 * logical profile and an opaque capability label instead.
 */
export const PROVIDER_KINDS = ['Anthropic', 'OpenAI', 'Custom', 'Mock'] as const;
export type ProviderKind = (typeof PROVIDER_KINDS)[number];

export const PROVIDER_KIND_LABELS: Record<ProviderKind, string> = {
  Anthropic: 'Anthropic Claude',
  OpenAI: 'OpenAI',
  Custom: 'Custom Enterprise Provider',
  Mock: 'Mock (no provider configured)',
};

/**
 * How a custom enterprise endpoint authenticates.
 *
 * The three the prompt's "auth type" field has to cover for a real enterprise endpoint. Not taken
 * from an approved list — the source documents name the field without enumerating values — so
 * this is the smallest set that is honestly useful, and it is the extension point if the client
 * supplies more. `None` exists because a private VPC endpoint behind network policy is a real
 * deployment, and pretending otherwise would push somebody into inventing a fake token.
 */
export const PROVIDER_AUTH_TYPES = ['BearerToken', 'ApiKeyHeader', 'None'] as const;
export type ProviderAuthType = (typeof PROVIDER_AUTH_TYPES)[number];

export const PROVIDER_AUTH_TYPE_LABELS: Record<ProviderAuthType, string> = {
  BearerToken: 'Bearer token (Authorization header)',
  ApiKeyHeader: 'API key in a named header',
  None: 'None (network-restricted endpoint)',
};

export function authTypeNeedsSecret(authType: ProviderAuthType): boolean {
  return authType !== 'None';
}

/**
 * Provider and model lifecycle, from §18: "Active, Deprecated, Migration Required".
 *
 * The three mean different things to the gateway, and the difference is the point of having three
 * rather than a boolean:
 *
 *   * `Active` — usable for new work.
 *   * `Deprecated` — still answers, but nothing new should be routed to it by default. Existing
 *     configuration keeps working, so a deprecation does not break running Objectives.
 *   * `MigrationRequired` — **refused for new work.** A model whose provider has announced removal
 *     must stop being selected while there is still time to move, not on the day it disappears.
 */
export const PROVIDER_LIFECYCLE_STATES = ['Active', 'Deprecated', 'MigrationRequired'] as const;
export type ProviderLifecycleState = (typeof PROVIDER_LIFECYCLE_STATES)[number];

export const PROVIDER_LIFECYCLE_LABELS: Record<ProviderLifecycleState, string> = {
  Active: 'Active',
  Deprecated: 'Deprecated',
  MigrationRequired: 'Migration required',
};

export const PROVIDER_LIFECYCLE_TONES: Record<ProviderLifecycleState, string> = {
  Active: 'success',
  Deprecated: 'warn',
  MigrationRequired: 'danger',
};

/** Whether new work may be routed to something in this state. */
export function acceptsNewWork(state: ProviderLifecycleState): boolean {
  return state === 'Active';
}

/**
 * Whether a lifecycle move is allowed.
 *
 * Forward only, except that `MigrationRequired` can be walked back to `Deprecated` — because a
 * provider *withdrawing* a removal notice is a real event, and the alternative would be
 * re-registering the model and losing its history. `Active` is not reachable again: a model that
 * needed migrating should be re-approved deliberately rather than by relaxing a state.
 */
export function mayMoveLifecycle(
  from: ProviderLifecycleState,
  to: ProviderLifecycleState,
): boolean {
  if (from === to) return true;
  if (from === 'Active') return to === 'Deprecated' || to === 'MigrationRequired';
  if (from === 'Deprecated') return to === 'MigrationRequired';
  return to === 'Deprecated';
}

// ---------------------------------------------------------------------------
// Pricing
// ---------------------------------------------------------------------------

/**
 * One immutable pricing version for one model.
 *
 * **Versioned rather than edited**, for the same reason a published Objective version is
 * immutable: a ledger entry cites the pricing version that priced it, so a price change cannot
 * retroactively restate what a Run cost. Prompt 30 builds the ledger on top of this; this prompt
 * owns the prices and the arithmetic.
 *
 * Prices are **per million tokens, in integer minor units** — the money rule everywhere in this
 * codebase. Per million rather than per token because a per-token price in minor units rounds to
 * zero for every model in existence.
 */
export interface PricingVersion {
  id: string;
  providerModelId: string;
  /** Monotonic per model. */
  versionNumber: number;
  currency: string;
  inputPerMillionMinorUnits: number;
  outputPerMillionMinorUnits: number;
  /**
   * Cached input, where the provider bills it separately. `null` means "this provider does not
   * price cached input differently", which is not the same as zero — zero would silently make
   * cached tokens free.
   */
  cachedInputPerMillionMinorUnits: number | null;
  effectiveFrom: string;
  /** Null while this is the current version. */
  supersededAt: string | null;
}

/** Exactly what a provider reported it used. */
export interface ProviderUsage {
  inputTokens: number;
  outputTokens: number;
  /** Tokens billed at the cached rate, where the provider reports them separately. */
  cachedInputTokens: number;
}

export function emptyProviderUsage(): ProviderUsage {
  return { inputTokens: 0, outputTokens: 0, cachedInputTokens: 0 };
}

/**
 * What a call cost, in integer minor units.
 *
 * Rounded **up**, once, at the end. Two consequences worth stating:
 *
 *   * Up rather than nearest, so a long run of small calls cannot bill less in total than it
 *     actually consumed. Under-billing a customer's own allowance is not a kindness — it lets a
 *     budget be exceeded while the ledger says otherwise.
 *   * Once, at the end, rather than per component: rounding each of three components would add up
 *     to three minor units of drift on a call that cost almost nothing.
 *
 * Cached input falls back to the full input price when the model does not price it separately,
 * which is the honest reading of `null` — those tokens were still billed, just not at a discount.
 */
export function usageCostMinorUnits(input: {
  usage: ProviderUsage;
  pricing: Pick<
    PricingVersion,
    'inputPerMillionMinorUnits' | 'outputPerMillionMinorUnits' | 'cachedInputPerMillionMinorUnits'
  >;
}): number {
  const cachedRate =
    input.pricing.cachedInputPerMillionMinorUnits ?? input.pricing.inputPerMillionMinorUnits;

  const exact =
    (input.usage.inputTokens * input.pricing.inputPerMillionMinorUnits +
      input.usage.outputTokens * input.pricing.outputPerMillionMinorUnits +
      input.usage.cachedInputTokens * cachedRate) /
    1_000_000;

  return Math.ceil(exact);
}

// ---------------------------------------------------------------------------
// Routing
// ---------------------------------------------------------------------------

/** One candidate a logical profile may be answered by, in preference order. */
export interface RoutingCandidate {
  providerModelId: string;
  /** Lower is preferred. */
  preference: number;
  lifecycle: ProviderLifecycleState;
  /** An opaque capability label. **Never a provider or model name.** */
  capability: string;
  enabled: boolean;
}

export type RoutingOutcome =
  | { routed: true; candidate: RoutingCandidate; usedFallback: boolean; reason: string }
  | { routed: false; reason: string };

/**
 * Which candidate answers this logical profile.
 *
 * The rules, in order:
 *
 *   1. Disabled candidates and anything in `MigrationRequired` are out — the latter is the whole
 *      purpose of that state.
 *   2. The most preferred remaining candidate wins.
 *   3. **Anything after the first is a fallback, and the profile's policy decides whether that is
 *      allowed.** `NoFallback` refuses rather than quietly routing elsewhere, because on
 *      `HIGH_REASONING` a silent substitution would mean the guardrail measured a call that never
 *      happened.
 *   4. `SameCapabilityOnly` requires the fallback to declare the same capability as the primary.
 *      A planner answered by a cheaper model produces a plan a manager then approves, which is
 *      exactly the case §18's "conservative fallback" is about.
 *
 * Refusing is a real outcome, not a failure to handle: `EXECUTOR` finding nothing is a
 * `ProviderOrToolUnavailable` exception, which Prompt 27 already knows how to raise.
 */
export function routeLogicalProfile(input: {
  profile: LogicalModelProfile;
  candidates: readonly RoutingCandidate[];
  /** Candidates already tried and failed this attempt, by `providerModelId`. */
  exclude?: readonly string[] | undefined;
}): RoutingOutcome {
  const spec = LOGICAL_MODEL_PROFILE_SPEC[input.profile];
  const excluded = new Set(input.exclude ?? []);

  const ordered = [...input.candidates]
    .filter((candidate) => candidate.enabled)
    .sort((a, b) => a.preference - b.preference);

  if (ordered.length === 0) {
    return {
      routed: false,
      reason: `No model is configured for ${input.profile}.`,
    };
  }

  const primary = ordered[0] as RoutingCandidate;

  const usable = ordered.filter(
    (candidate) => acceptsNewWork(candidate.lifecycle) && !excluded.has(candidate.providerModelId),
  );

  if (usable.length === 0) {
    return {
      routed: false,
      reason:
        `Every model configured for ${input.profile} is unavailable — disabled, requiring ` +
        'migration, or already failed on this attempt.',
    };
  }

  const chosen = usable[0] as RoutingCandidate;
  const isPrimary = chosen.providerModelId === primary.providerModelId;

  if (isPrimary) {
    return {
      routed: true,
      candidate: chosen,
      usedFallback: false,
      reason: `Routed ${input.profile} to its preferred model.`,
    };
  }

  if (spec.fallbackPolicy === 'NoFallback') {
    return {
      routed: false,
      reason:
        `${input.profile} does not permit fallback (${spec.gatewayBehaviour}) and its preferred ` +
        'model is unavailable. Substituting a different model would mean the guardrail measured ' +
        'a call that did not happen.',
    };
  }

  if (spec.fallbackPolicy === 'SameCapabilityOnly' && chosen.capability !== primary.capability) {
    return {
      routed: false,
      reason:
        `${input.profile} may only fall back to a model of the same capability ` +
        `(${spec.gatewayBehaviour}) and none is available.`,
    };
  }

  return {
    routed: true,
    candidate: chosen,
    usedFallback: true,
    reason: `Routed ${input.profile} to a fallback model under its ${spec.fallbackPolicy} policy.`,
  };
}

// ---------------------------------------------------------------------------
// Custom adapter configuration
// ---------------------------------------------------------------------------

/**
 * What a Custom Enterprise Provider needs before it can be called.
 *
 * The prompt's field list, and every one of them is required for a reason a missing value would
 * cause: no endpoint means nothing to call, no model id means the endpoint cannot know what to
 * run, no timeout means a hung provider holds a connection until something else times out first.
 */
export interface CustomProviderConfig {
  baseUrl: string;
  modelId: string;
  authType: ProviderAuthType;
  /** A `SecretsVault` handle. **Never a credential.** Null only when `authType` is `None`. */
  secretRef: string | null;
  /** For `ApiKeyHeader`. */
  authHeaderName: string | null;
  timeoutMs: number;
  /** Where in the provider's response the token counts live, so usage is not guessed. */
  usageMapping: { inputPath: string; outputPath: string; cachedInputPath: string | null };
  /** Where the provider's own request id lives, so a support ticket can quote it. */
  requestIdPath: string | null;
}

/** The narrowest sane timeout window. Outside it, say so rather than accepting the number. */
export const MIN_PROVIDER_TIMEOUT_MS = 1_000;
export const MAX_PROVIDER_TIMEOUT_MS = 600_000;

/**
 * Whether a custom provider configuration is complete enough to call.
 *
 * Returns every problem rather than the first, because a Master Console form should show all of
 * them at once — and because a caller fixing one at a time against a server that answers one at a
 * time is the worst configuration experience there is.
 */
export function customProviderProblems(config: Partial<CustomProviderConfig>): string[] {
  const problems: string[] = [];

  if (!config.baseUrl || config.baseUrl.trim() === '') {
    problems.push('A base URL or endpoint is required.');
  } else if (!/^https:\/\//i.test(config.baseUrl)) {
    // Refused rather than warned: a provider call carries the company's own data and, in BYOK,
    // its credential. Plain HTTP would put both on the wire.
    problems.push('The endpoint must be https. A provider call carries company data.');
  }

  if (!config.modelId || config.modelId.trim() === '') {
    problems.push('A model ID is required — the endpoint cannot know what to run without one.');
  }

  if (config.authType === undefined) {
    problems.push('An auth type is required.');
  } else {
    if (authTypeNeedsSecret(config.authType) && (config.secretRef ?? null) === null) {
      problems.push(`${PROVIDER_AUTH_TYPE_LABELS[config.authType]} needs a stored secret.`);
    }
    if (config.authType === 'ApiKeyHeader' && (config.authHeaderName ?? '') === '') {
      problems.push('An API key header needs the header name.');
    }
    if (config.authType === 'None' && (config.secretRef ?? null) !== null) {
      problems.push(
        'Auth type None must not carry a secret. A stored credential nothing uses is a ' +
          'credential nobody rotates.',
      );
    }
  }

  if (config.timeoutMs === undefined) {
    problems.push('A timeout is required — a hung provider must not hold a connection open.');
  } else if (
    config.timeoutMs < MIN_PROVIDER_TIMEOUT_MS ||
    config.timeoutMs > MAX_PROVIDER_TIMEOUT_MS
  ) {
    problems.push(
      `The timeout must be between ${MIN_PROVIDER_TIMEOUT_MS}ms and ${MAX_PROVIDER_TIMEOUT_MS}ms.`,
    );
  }

  if (
    config.usageMapping === undefined ||
    config.usageMapping.inputPath.trim() === '' ||
    config.usageMapping.outputPath.trim() === ''
  ) {
    // Without this the gateway would have to estimate what it just spent, and an estimate
    // recorded as actual usage is the fabrication the client's rules forbid.
    problems.push(
      'A usage mapping is required for input and output tokens. Without it the actual cost ' +
        'would have to be guessed and recorded as if measured.',
    );
  }

  return problems;
}

// ---------------------------------------------------------------------------
// Test Connection
// ---------------------------------------------------------------------------

/**
 * The result of a *Test Connection* against a provider profile.
 *
 * `reachedProvider` is the field that matters and the reason this type exists rather than a
 * boolean. **A configuration that validates is not a provider that answered**, and the client's
 * rule is that a live credential-verified integration is never claimed on the strength of
 * implemented adapter code. Every screen shows this flag; no screen says "connected" without it.
 */
export interface ProviderTestResult {
  ok: boolean;
  /** True only when a real provider actually responded. */
  reachedProvider: boolean;
  /** The provider's own request id, when it gave one. */
  providerRequestId: string | null;
  latencyMs: number | null;
  /** Safe to show a platform operator. Never a credential, never a raw provider error body. */
  detail: string;
}
