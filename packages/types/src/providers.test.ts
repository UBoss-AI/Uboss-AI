import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  acceptsNewWork,
  authTypeNeedsSecret,
  customProviderProblems,
  emptyProviderUsage,
  FALLBACK_POLICIES,
  isLogicalModelProfile,
  LOGICAL_MODEL_PROFILE_SPEC,
  LOGICAL_MODEL_PROFILES,
  MAX_PROVIDER_TIMEOUT_MS,
  mayMoveLifecycle,
  MIN_PROVIDER_TIMEOUT_MS,
  modeUsesCompanyCredentials,
  PROVIDER_AUTH_TYPES,
  PROVIDER_KINDS,
  PROVIDER_LIFECYCLE_STATES,
  PROVIDER_MODE_DESCRIPTIONS,
  PROVIDER_MODE_LABELS,
  PROVIDER_MODES,
  routeLogicalProfile,
  usageCostMinorUnits,
  type CustomProviderConfig,
  type LogicalModelProfile,
  type RoutingCandidate,
} from './providers.js';

const candidate = (overrides: Partial<RoutingCandidate> = {}): RoutingCandidate => ({
  providerModelId: 'model-a',
  preference: 0,
  lifecycle: 'Active',
  capability: 'high-reasoning-v1',
  enabled: true,
  ...overrides,
});

describe('provider modes', () => {
  it('labels and describes all three', () => {
    for (const mode of PROVIDER_MODES) {
      assert.equal(typeof PROVIDER_MODE_LABELS[mode], 'string');
      assert.ok(PROVIDER_MODE_DESCRIPTIONS[mode].length > 20);
    }
  });

  it('does not model Auto / Policy Choice as a fourth mode', () => {
    // Section 19 lists it, but it answers a different question — it states that policy always
    // chooses the profile, in every mode. As a mode it would have been opt-out-able.
    assert.equal(PROVIDER_MODES.length, 3);
    assert.ok(!(PROVIDER_MODES as readonly string[]).includes('Auto'));
  });

  it('knows which modes put the credential in the company hands', () => {
    assert.equal(modeUsesCompanyCredentials('CompanyBYOK'), true);
    assert.equal(modeUsesCompanyCredentials('CustomEnterprise'), true);
    assert.equal(modeUsesCompanyCredentials('UBossManaged'), false);
  });
});

describe('logical model profiles', () => {
  it('has exactly the five the architecture names', () => {
    assert.deepEqual(
      [...LOGICAL_MODEL_PROFILES],
      ['OBJECTIVE_PLANNER', 'AGENT_STANDARD', 'AGENT_FAST', 'EXECUTOR', 'HIGH_REASONING'],
    );
  });

  it('carries the transcribed use and gateway behaviour for each', () => {
    for (const profile of LOGICAL_MODEL_PROFILES) {
      const spec = LOGICAL_MODEL_PROFILE_SPEC[profile];
      assert.equal(spec.profile, profile);
      assert.ok(spec.typicalUse.length > 0, `${profile} has no typical use`);
      assert.ok(spec.gatewayBehaviour.endsWith('.'), `${profile} behaviour is not a sentence`);
      assert.ok((FALLBACK_POLICIES as readonly string[]).includes(spec.fallbackPolicy));
    }
  });

  it('reads the planner as schema-constrained with conservative fallback', () => {
    const spec = LOGICAL_MODEL_PROFILE_SPEC.OBJECTIVE_PLANNER;
    assert.equal(spec.schemaConstrained, true);
    assert.equal(spec.fallbackPolicy, 'SameCapabilityOnly');
    assert.match(spec.gatewayBehaviour, /conservative fallback/);
  });

  it('reads high reasoning as guardrailed and un-substitutable', () => {
    const spec = LOGICAL_MODEL_PROFILE_SPEC.HIGH_REASONING;
    assert.equal(spec.needsExplicitGuardrail, true);
    assert.equal(spec.fallbackPolicy, 'NoFallback');
  });

  it('recognises only real profiles', () => {
    assert.equal(isLogicalModelProfile('AGENT_FAST'), true);
    assert.equal(isLogicalModelProfile('AGENT_TURBO'), false);
    // A provider name must never be usable where a profile is expected.
    assert.equal(isLogicalModelProfile('Anthropic'), false);
  });

  it('keeps provider kinds and logical profiles disjoint', () => {
    // The locked rule made structural: nothing can be both a profile business code may store and
    // a provider name that must stay behind the gateway.
    for (const kind of PROVIDER_KINDS) {
      assert.equal(isLogicalModelProfile(kind), false);
    }
    for (const profile of LOGICAL_MODEL_PROFILES) {
      assert.ok(!(PROVIDER_KINDS as readonly string[]).includes(profile));
    }
  });
});

describe('lifecycle', () => {
  it('accepts new work only when Active', () => {
    assert.equal(acceptsNewWork('Active'), true);
    assert.equal(acceptsNewWork('Deprecated'), false);
    assert.equal(acceptsNewWork('MigrationRequired'), false);
  });

  it('moves forward, and back only from MigrationRequired to Deprecated', () => {
    assert.equal(mayMoveLifecycle('Active', 'Deprecated'), true);
    assert.equal(mayMoveLifecycle('Active', 'MigrationRequired'), true);
    assert.equal(mayMoveLifecycle('Deprecated', 'MigrationRequired'), true);
    // A withdrawn removal notice is a real event.
    assert.equal(mayMoveLifecycle('MigrationRequired', 'Deprecated'), true);
    // But nothing walks back to Active by relaxing a state.
    assert.equal(mayMoveLifecycle('Deprecated', 'Active'), false);
    assert.equal(mayMoveLifecycle('MigrationRequired', 'Active'), false);
  });

  it('treats a move to the same state as a no-op rather than an error', () => {
    for (const state of PROVIDER_LIFECYCLE_STATES) {
      assert.equal(mayMoveLifecycle(state, state), true);
    }
  });
});

describe('routing', () => {
  it('routes to the most preferred active candidate', () => {
    const outcome = routeLogicalProfile({
      profile: 'AGENT_STANDARD',
      candidates: [
        candidate({ providerModelId: 'second', preference: 1 }),
        candidate({ providerModelId: 'first', preference: 0 }),
      ],
    });
    assert.equal(outcome.routed, true);
    if (outcome.routed) {
      assert.equal(outcome.candidate.providerModelId, 'first');
      assert.equal(outcome.usedFallback, false);
    }
  });

  it('refuses when nothing is configured', () => {
    const outcome = routeLogicalProfile({ profile: 'EXECUTOR', candidates: [] });
    assert.equal(outcome.routed, false);
    assert.match(outcome.reason, /No model is configured/);
  });

  it('never routes new work to a model requiring migration', () => {
    // The entire purpose of that state.
    const outcome = routeLogicalProfile({
      profile: 'AGENT_STANDARD',
      candidates: [candidate({ lifecycle: 'MigrationRequired' })],
    });
    assert.equal(outcome.routed, false);
  });

  it('skips a deprecated model when an active one exists', () => {
    const outcome = routeLogicalProfile({
      profile: 'AGENT_STANDARD',
      candidates: [
        candidate({ providerModelId: 'old', preference: 0, lifecycle: 'Deprecated' }),
        candidate({ providerModelId: 'new', preference: 1 }),
      ],
    });
    assert.equal(outcome.routed, true);
    if (outcome.routed) {
      assert.equal(outcome.candidate.providerModelId, 'new');
      // It is a fallback: the preferred candidate was not the one used.
      assert.equal(outcome.usedFallback, true);
    }
  });

  it('refuses to substitute a model on HIGH_REASONING', () => {
    // A silent substitution would mean the approved budget guardrail measured a call that never
    // happened.
    const outcome = routeLogicalProfile({
      profile: 'HIGH_REASONING',
      candidates: [
        candidate({ providerModelId: 'primary', preference: 0, lifecycle: 'Deprecated' }),
        candidate({ providerModelId: 'other', preference: 1 }),
      ],
    });
    assert.equal(outcome.routed, false);
    assert.match(outcome.reason, /does not permit fallback/);
    assert.match(outcome.reason, /guardrail/);
  });

  it('falls back on the planner only to the same capability', () => {
    const cheaper = routeLogicalProfile({
      profile: 'OBJECTIVE_PLANNER',
      candidates: [
        candidate({ providerModelId: 'primary', preference: 0, lifecycle: 'Deprecated' }),
        candidate({ providerModelId: 'cheap', preference: 1, capability: 'fast-v1' }),
      ],
    });
    assert.equal(cheaper.routed, false);
    assert.match(cheaper.reason, /same capability/);

    const equivalent = routeLogicalProfile({
      profile: 'OBJECTIVE_PLANNER',
      candidates: [
        candidate({ providerModelId: 'primary', preference: 0, lifecycle: 'Deprecated' }),
        candidate({ providerModelId: 'peer', preference: 1, capability: 'high-reasoning-v1' }),
      ],
    });
    assert.equal(equivalent.routed, true);
    if (equivalent.routed) assert.equal(equivalent.usedFallback, true);
  });

  it('lets AGENT_STANDARD fall back to any approved model', () => {
    const outcome = routeLogicalProfile({
      profile: 'AGENT_STANDARD',
      candidates: [
        candidate({ providerModelId: 'primary', preference: 0, enabled: false }),
        candidate({ providerModelId: 'anything', preference: 1, capability: 'fast-v1' }),
      ],
    });
    assert.equal(outcome.routed, true);
  });

  it('excludes a candidate that already failed this attempt', () => {
    const outcome = routeLogicalProfile({
      profile: 'AGENT_STANDARD',
      candidates: [
        candidate({ providerModelId: 'first', preference: 0 }),
        candidate({ providerModelId: 'second', preference: 1 }),
      ],
      exclude: ['first'],
    });
    assert.equal(outcome.routed, true);
    if (outcome.routed) assert.equal(outcome.candidate.providerModelId, 'second');
  });

  it('refuses once every candidate has failed', () => {
    const outcome = routeLogicalProfile({
      profile: 'AGENT_STANDARD',
      candidates: [candidate({ providerModelId: 'only' })],
      exclude: ['only'],
    });
    assert.equal(outcome.routed, false);
    assert.match(outcome.reason, /already failed/);
  });

  it('ignores a disabled candidate entirely', () => {
    const outcome = routeLogicalProfile({
      profile: 'AGENT_FAST',
      candidates: [candidate({ enabled: false })],
    });
    assert.equal(outcome.routed, false);
  });
});

describe('pricing', () => {
  const pricing = {
    inputPerMillionMinorUnits: 300_000,
    outputPerMillionMinorUnits: 1_500_000,
    cachedInputPerMillionMinorUnits: 30_000,
  };

  it('costs nothing for no usage', () => {
    assert.equal(usageCostMinorUnits({ usage: emptyProviderUsage(), pricing }), 0);
  });

  it('prices input, output and cached input at their own rates', () => {
    const cost = usageCostMinorUnits({
      usage: { inputTokens: 1_000_000, outputTokens: 1_000_000, cachedInputTokens: 1_000_000 },
      pricing,
    });
    assert.equal(cost, 300_000 + 1_500_000 + 30_000);
  });

  it('rounds up, so a run of small calls cannot under-bill', () => {
    // One token of input at 300000 per million is 0.3 minor units.
    const cost = usageCostMinorUnits({
      usage: { inputTokens: 1, outputTokens: 0, cachedInputTokens: 0 },
      pricing,
    });
    assert.equal(cost, 1);
  });

  it('rounds once at the end rather than per component', () => {
    // Per-component rounding would give 3; the exact total is 2.1, so 3 either way here — the
    // assertion that matters is that it is not 3 by accumulation for a larger case.
    const cost = usageCostMinorUnits({
      usage: { inputTokens: 3, outputTokens: 1, cachedInputTokens: 3 },
      pricing,
    });
    // 0.9 + 1.5 + 0.09 = 2.49 → 3. Three separate ceilings would have given 1 + 2 + 1 = 4.
    assert.equal(cost, 3);
  });

  it('bills cached tokens at the full input rate when the model does not discount them', () => {
    // `null` means "not priced separately", which is not the same as free.
    const cost = usageCostMinorUnits({
      usage: { inputTokens: 0, outputTokens: 0, cachedInputTokens: 1_000_000 },
      pricing: { ...pricing, cachedInputPerMillionMinorUnits: null },
    });
    assert.equal(cost, 300_000);
  });
});

describe('custom provider configuration', () => {
  const complete: CustomProviderConfig = {
    baseUrl: 'https://ai.internal.example/v1/chat',
    modelId: 'enterprise-reasoning-1',
    authType: 'BearerToken',
    secretRef: 'vault://abc',
    authHeaderName: null,
    timeoutMs: 30_000,
    usageMapping: {
      inputPath: 'usage.input_tokens',
      outputPath: 'usage.output_tokens',
      cachedInputPath: null,
    },
    requestIdPath: 'id',
  };

  it('accepts a complete configuration', () => {
    assert.deepEqual(customProviderProblems(complete), []);
  });

  it('reports every problem at once rather than the first', () => {
    const problems = customProviderProblems({});
    assert.ok(problems.length >= 5, `expected several problems, got ${problems.length}`);
  });

  it('refuses a plain-http endpoint', () => {
    const problems = customProviderProblems({
      ...complete,
      baseUrl: 'http://ai.internal.example/v1',
    });
    assert.equal(problems.length, 1);
    assert.match(problems[0] ?? '', /must be https/);
  });

  it('requires a secret for every auth type that uses one', () => {
    for (const authType of PROVIDER_AUTH_TYPES) {
      const problems = customProviderProblems({ ...complete, authType, secretRef: null });
      const needsOne = authTypeNeedsSecret(authType);
      assert.equal(
        problems.some((problem) => /needs a stored secret/.test(problem)),
        needsOne,
        `${authType} secret requirement is wrong`,
      );
    }
  });

  it('requires the header name for a header-based key', () => {
    const problems = customProviderProblems({
      ...complete,
      authType: 'ApiKeyHeader',
      authHeaderName: '',
    });
    assert.ok(problems.some((problem) => /header name/.test(problem)));
  });

  it('refuses a stored secret that nothing will use', () => {
    // A credential nothing reads is a credential nobody rotates.
    const problems = customProviderProblems({
      ...complete,
      authType: 'None',
      secretRef: 'vault://orphan',
    });
    assert.ok(problems.some((problem) => /must not carry a secret/.test(problem)));
  });

  it('requires a usage mapping, because a guessed cost must not be recorded as measured', () => {
    const problems = customProviderProblems({
      ...complete,
      usageMapping: { inputPath: '', outputPath: '', cachedInputPath: null },
    });
    assert.ok(problems.some((problem) => /usage mapping is required/.test(problem)));
  });

  it('bounds the timeout at both ends', () => {
    assert.ok(
      customProviderProblems({ ...complete, timeoutMs: MIN_PROVIDER_TIMEOUT_MS - 1 }).length === 1,
    );
    assert.ok(
      customProviderProblems({ ...complete, timeoutMs: MAX_PROVIDER_TIMEOUT_MS + 1 }).length === 1,
    );
    assert.deepEqual(
      customProviderProblems({ ...complete, timeoutMs: MIN_PROVIDER_TIMEOUT_MS }),
      [],
    );
  });
});

describe('the locked rule', () => {
  it('gives every profile a spec, so no call can route on an unknown profile', () => {
    const specified = Object.keys(LOGICAL_MODEL_PROFILE_SPEC) as LogicalModelProfile[];
    assert.equal(specified.length, LOGICAL_MODEL_PROFILES.length);
    for (const profile of LOGICAL_MODEL_PROFILES) {
      assert.ok(LOGICAL_MODEL_PROFILE_SPEC[profile] !== undefined);
    }
  });

  it('never names a provider in a routing reason', () => {
    // The reasons are shown to company users when a call cannot be routed, so they must not leak
    // which vendor was unavailable.
    const outcomes = LOGICAL_MODEL_PROFILES.map((profile) =>
      routeLogicalProfile({ profile, candidates: [] }),
    );
    for (const outcome of outcomes) {
      for (const kind of PROVIDER_KINDS) {
        if (kind === 'Custom' || kind === 'Mock') continue;
        assert.ok(!outcome.reason.includes(kind), `a routing reason named ${kind}`);
      }
    }
  });
});
