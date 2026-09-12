import { Injectable, Logger } from '@nestjs/common';

import { type CustomProviderConfig, type ProviderKind, type ProviderUsage } from '@uboss/types';

/**
 * What one provider was asked to do, after routing has already chosen it.
 *
 * Distinct from `ModelRequest`: by the time an adapter sees a call, the logical profile has been
 * resolved and the vendor's model identifier is known. That identifier lives here and nowhere
 * else in a request type — it is configuration, and letting it into `ModelRequest` would put a
 * provider's model string into the hands of every caller.
 */
export interface ProviderCall {
  /** The vendor's own model identifier. Platform-plane. */
  providerModelRef: string;
  instruction: string;
  context: string;
  maxTokens: number;
  timeoutMs: number;
  /** For a `Custom` adapter. Null for a first-party one. */
  custom: CustomProviderConfig | null;
  /** Resolved at the moment of use, never earlier, and never logged. */
  credential: string | null;
}

/** What a provider actually returned. */
export interface ProviderResult {
  output: string;
  usage: ProviderUsage;
  /**
   * The provider's own id for this request.
   *
   * `null` when the provider gave none — and **always null for a mock**, which the database
   * enforces: a fabricated request id would let a support ticket be raised against a call that
   * never left the building.
   */
  providerRequestId: string | null;
  /** True only when a real provider actually answered. */
  reachedProvider: boolean;
  latencyMs: number;
}

/**
 * The injection token for the registered adapter list.
 *
 * Declared here rather than in the module, and that is a fix rather than a preference: the
 * service needs the token and the module needs the service, so a token defined in the module
 * closed a cycle that ESM resolved as "cannot access before initialization" at import time.
 */
export const PROVIDER_ADAPTERS = Symbol('PROVIDER_ADAPTERS');

/**
 * One provider, behind one interface.
 *
 * The prompt asks for Claude and OpenAI adapters "behind one interface if credentials are
 * available; otherwise implement adapter code with mocked tests and safe configuration". No
 * credentials have been supplied, so what ships is the interface, the two adapters, and an honest
 * refusal from each when it is called without a key.
 *
 * **The refusal is the design, not a gap.** An adapter that quietly returned plausible text
 * without a provider would produce output indistinguishable from a real answer, and the client's
 * rule is that a live credential-verified integration is never claimed on the strength of adapter
 * code. `MockProviderAdapter` is the one thing that answers without a provider, and every
 * response it produces is stamped `reachedProvider: false` all the way into the database.
 */
export abstract class ProviderAdapter {
  abstract readonly kind: ProviderKind;

  /** Whether this adapter can actually reach a provider right now. */
  abstract readonly canReachProvider: boolean;

  abstract complete(call: ProviderCall): Promise<ProviderResult>;
}

/**
 * The adapter that ships: deterministic, offline, and honest about it.
 *
 * Kept from Prompt 20's `MockModelGateway` rather than replaced, and for the reason recorded
 * there: a fabricated *analysis* becomes a Draft a person must read and approve, so the mock lets
 * the whole pipeline be exercised while `reachedProvider: false` travels with every response. A
 * fabricated *payment* is a different matter, which is why the payout adapter refuses outright.
 *
 * Deterministic on purpose. A mock that varied would make the analysis tests flaky, and a flaky
 * test gets deleted.
 */
@Injectable()
export class MockProviderAdapter extends ProviderAdapter {
  readonly kind: ProviderKind = 'Mock';
  readonly canReachProvider = false;

  private readonly logger = new Logger(MockProviderAdapter.name);

  async complete(call: ProviderCall): Promise<ProviderResult> {
    this.logger.debug(`Mock provider call against ${call.providerModelRef}.`);

    // Four characters per token is the usual rule of thumb. Crude but stable, so estimates and
    // ceilings can be exercised without a provider.
    const inputTokens = Math.min(
      call.maxTokens,
      Math.ceil((call.instruction.length + call.context.length) / 4),
    );
    const outputTokens = Math.max(Math.min(call.maxTokens - inputTokens, 120), 0);

    return {
      output: `mock:${call.providerModelRef}`,
      usage: { inputTokens, outputTokens, cachedInputTokens: 0 },
      // Never invented. The database refuses a request id on a call that did not reach a
      // provider, so this could not lie even if it wanted to.
      providerRequestId: null,
      reachedProvider: false,
      latencyMs: 0,
    };
  }
}

/**
 * Thrown when an adapter is configured but has no credential to use.
 *
 * A distinct error rather than a generic one, because the gateway turns it into an `Unroutable`
 * call record and a `ProviderOrToolUnavailable` exception — which is a different conversation from
 * "the provider answered badly".
 */
export class ProviderNotConfiguredError extends Error {
  constructor(kind: ProviderKind, detail: string) {
    super(`${kind} is registered but not usable: ${detail}`);
    this.name = 'ProviderNotConfiguredError';
  }
}

/**
 * Anthropic Claude.
 *
 * ## What is real here and what is not
 *
 * The request shape, the response parsing and the usage extraction are written against
 * Anthropic's Messages API — `/v1/messages`, `x-api-key`, `anthropic-version`, and
 * `usage.input_tokens` / `usage.output_tokens` / `usage.cache_read_input_tokens`. The request id
 * is read from the response's `id`.
 *
 * **No credential has been supplied and no call has ever been made.** So `canReachProvider` is
 * false, `complete` refuses, and nothing in this codebase claims a verified Anthropic
 * integration. When a key arrives, this class is the only thing that changes: the routing, the
 * pricing, the call record and every business object above it are provider-agnostic already.
 */
@Injectable()
export class AnthropicProviderAdapter extends ProviderAdapter {
  readonly kind: ProviderKind = 'Anthropic';

  /**
   * False, and it is not a placeholder for "we did not finish".
   *
   * It reports whether a credential is present. With one, the code below runs; without one,
   * refusing is the only honest answer, because the alternative is output that looks like a
   * model's judgement and is not.
   */
  get canReachProvider(): boolean {
    return (process.env['ANTHROPIC_API_KEY'] ?? '') !== '';
  }

  async complete(call: ProviderCall): Promise<ProviderResult> {
    const key = call.credential ?? process.env['ANTHROPIC_API_KEY'] ?? '';
    if (key === '') {
      throw new ProviderNotConfiguredError(
        'Anthropic',
        'no API key is configured for this provider profile. The adapter is implemented; it has ' +
          'never been run against the provider.',
      );
    }

    return callJsonProvider({
      kind: 'Anthropic',
      url: 'https://api.anthropic.com/v1/messages',
      timeoutMs: call.timeoutMs,
      headers: {
        'x-api-key': key,
        'anthropic-version': '2023-06-01',
        'content-type': 'application/json',
      },
      body: {
        model: call.providerModelRef,
        max_tokens: call.maxTokens,
        system: call.instruction,
        messages: [{ role: 'user', content: call.context }],
      },
      readOutput: (payload) => {
        const content = (payload as { content?: { type?: string; text?: string }[] }).content ?? [];
        return content
          .filter((part) => part.type === 'text')
          .map((part) => part.text ?? '')
          .join('');
      },
      readUsage: (payload) => {
        const usage =
          (
            payload as {
              usage?: {
                input_tokens?: number;
                output_tokens?: number;
                cache_read_input_tokens?: number;
              };
            }
          ).usage ?? {};
        return {
          inputTokens: usage.input_tokens ?? 0,
          outputTokens: usage.output_tokens ?? 0,
          cachedInputTokens: usage.cache_read_input_tokens ?? 0,
        };
      },
      readRequestId: (payload) => (payload as { id?: string }).id ?? null,
    });
  }
}

/**
 * OpenAI.
 *
 * Written against the Chat Completions shape — `/v1/chat/completions`, a bearer token, and
 * `usage.prompt_tokens` / `usage.completion_tokens`, with cached input read from
 * `usage.prompt_tokens_details.cached_tokens` where present. The request id is the response `id`.
 *
 * The same honesty applies as for Anthropic: implemented, never run, refuses without a key.
 */
@Injectable()
export class OpenAiProviderAdapter extends ProviderAdapter {
  readonly kind: ProviderKind = 'OpenAI';

  get canReachProvider(): boolean {
    return (process.env['OPENAI_API_KEY'] ?? '') !== '';
  }

  async complete(call: ProviderCall): Promise<ProviderResult> {
    const key = call.credential ?? process.env['OPENAI_API_KEY'] ?? '';
    if (key === '') {
      throw new ProviderNotConfiguredError(
        'OpenAI',
        'no API key is configured for this provider profile. The adapter is implemented; it has ' +
          'never been run against the provider.',
      );
    }

    return callJsonProvider({
      kind: 'OpenAI',
      url: 'https://api.openai.com/v1/chat/completions',
      timeoutMs: call.timeoutMs,
      headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json' },
      body: {
        model: call.providerModelRef,
        max_completion_tokens: call.maxTokens,
        messages: [
          { role: 'system', content: call.instruction },
          { role: 'user', content: call.context },
        ],
      },
      readOutput: (payload) => {
        const choices =
          (payload as { choices?: { message?: { content?: string } }[] }).choices ?? [];
        return choices[0]?.message?.content ?? '';
      },
      readUsage: (payload) => {
        const usage =
          (
            payload as {
              usage?: {
                prompt_tokens?: number;
                completion_tokens?: number;
                prompt_tokens_details?: { cached_tokens?: number };
              };
            }
          ).usage ?? {};
        return {
          inputTokens: usage.prompt_tokens ?? 0,
          outputTokens: usage.completion_tokens ?? 0,
          cachedInputTokens: usage.prompt_tokens_details?.cached_tokens ?? 0,
        };
      },
      readRequestId: (payload) => (payload as { id?: string }).id ?? null,
    });
  }
}

/**
 * A Custom Enterprise Provider.
 *
 * Everything about the call comes from the profile's stored configuration rather than from code:
 * endpoint, auth style, timeout, and — the part that matters most — **where in the response the
 * token counts live**. Without that mapping the gateway would have to estimate what it just
 * spent, and an estimate recorded as measured usage is exactly the fabrication the client's rules
 * forbid. Both the shared type and a database CHECK require it.
 */
@Injectable()
export class CustomProviderAdapter extends ProviderAdapter {
  readonly kind: ProviderKind = 'Custom';

  /**
   * False, and this is a correction rather than an omission.
   *
   * It first returned `true`, reasoning that a custom profile carries its own endpoint so
   * reachability is a property of the row. That reasoning is right and the answer was still
   * wrong: `ModelGateway.usesRealModel` is the union across adapters, and a screen reads it to
   * decide whether to warn that output will be mocked. A `true` here made an installation with
   * no provider configured at all claim it could reach one.
   *
   * So this reports what it can know from this process — nothing — and whether a *particular*
   * custom endpoint answers is what `testConnection` establishes, per profile, by calling it.
   */
  readonly canReachProvider = false;

  async complete(call: ProviderCall): Promise<ProviderResult> {
    if (call.custom === null) {
      throw new ProviderNotConfiguredError(
        'Custom',
        'the profile carries no endpoint configuration.',
      );
    }

    const config = call.custom;
    const headers: Record<string, string> = { 'content-type': 'application/json' };

    if (config.authType === 'BearerToken') {
      if (call.credential === null) {
        throw new ProviderNotConfiguredError('Custom', 'the stored secret could not be resolved.');
      }
      headers['authorization'] = `Bearer ${call.credential}`;
    } else if (config.authType === 'ApiKeyHeader') {
      if (call.credential === null || config.authHeaderName === null) {
        throw new ProviderNotConfiguredError(
          'Custom',
          'the API key header or its secret is missing.',
        );
      }
      headers[config.authHeaderName.toLowerCase()] = call.credential;
    }

    return callJsonProvider({
      kind: 'Custom',
      url: config.baseUrl,
      timeoutMs: config.timeoutMs,
      headers,
      body: {
        model: config.modelId,
        max_tokens: call.maxTokens,
        instruction: call.instruction,
        input: call.context,
      },
      readOutput: (payload) =>
        typeof (payload as { output?: unknown }).output === 'string'
          ? (payload as { output: string }).output
          : JSON.stringify(payload),
      readUsage: (payload) => ({
        inputTokens: readNumberAtPath(payload, config.usageMapping.inputPath) ?? 0,
        outputTokens: readNumberAtPath(payload, config.usageMapping.outputPath) ?? 0,
        cachedInputTokens:
          config.usageMapping.cachedInputPath === null
            ? 0
            : (readNumberAtPath(payload, config.usageMapping.cachedInputPath) ?? 0),
      }),
      readRequestId: (payload) =>
        config.requestIdPath === null
          ? null
          : (readStringAtPath(payload, config.requestIdPath) ?? null),
    });
  }
}

// ---------------------------------------------------------------------------
// Shared HTTP plumbing
// ---------------------------------------------------------------------------

/**
 * One JSON provider call, with a timeout that is actually enforced.
 *
 * `AbortSignal.timeout` rather than a `Promise.race`: a race leaves the request running and its
 * socket open, so a provider that hangs would leak a connection per call until something else
 * broke. The timeout is the configured one, which is why the configuration requires it.
 *
 * Errors are deliberately summarised rather than passed through. A provider's raw error body can
 * echo the request — including, for a misconfigured custom endpoint, the credential — so what
 * escapes here is a status code and a short note.
 */
async function callJsonProvider(input: {
  kind: ProviderKind;
  url: string;
  timeoutMs: number;
  headers: Record<string, string>;
  body: unknown;
  readOutput: (payload: unknown) => string;
  readUsage: (payload: unknown) => ProviderUsage;
  readRequestId: (payload: unknown) => string | null;
}): Promise<ProviderResult> {
  const startedAt = Date.now();

  let response: Response;
  try {
    response = await fetch(input.url, {
      method: 'POST',
      headers: input.headers,
      body: JSON.stringify(input.body),
      signal: AbortSignal.timeout(input.timeoutMs),
    });
  } catch (cause) {
    const timedOut = cause instanceof Error && cause.name === 'TimeoutError';
    // The cause is attached but never interpolated into the message: a fetch failure can carry
    // the request, and for a misconfigured custom endpoint the request carries the credential.
    throw new Error(
      timedOut
        ? `The provider did not answer within ${input.timeoutMs}ms.`
        : 'The provider could not be reached.',
      { cause },
    );
  }

  if (!response.ok) {
    // Status only. The body may quote the request back, credential included.
    throw new Error(`The provider answered ${response.status}.`);
  }

  let payload: unknown;
  try {
    payload = await response.json();
  } catch {
    throw new Error('The provider answered with something that is not JSON.');
  }

  return {
    output: input.readOutput(payload),
    usage: input.readUsage(payload),
    providerRequestId: input.readRequestId(payload),
    reachedProvider: true,
    latencyMs: Date.now() - startedAt,
  };
}

/** Read a dotted path, e.g. `usage.input_tokens`. Returns undefined rather than throwing. */
function readAtPath(payload: unknown, path: string): unknown {
  let current: unknown = payload;
  for (const segment of path.split('.')) {
    if (current === null || typeof current !== 'object') return undefined;
    current = (current as Record<string, unknown>)[segment];
  }
  return current;
}

function readNumberAtPath(payload: unknown, path: string): number | undefined {
  const value = readAtPath(payload, path);
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function readStringAtPath(payload: unknown, path: string): string | undefined {
  const value = readAtPath(payload, path);
  return typeof value === 'string' && value !== '' ? value : undefined;
}
