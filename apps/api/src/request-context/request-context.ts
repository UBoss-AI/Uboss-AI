import { AsyncLocalStorage } from 'node:async_hooks';
import { randomUUID } from 'node:crypto';

import { ANONYMOUS_ACTOR, type AuthenticatedActor } from './authenticated-actor.js';

/**
 * Per-request state that every layer can read without it being threaded through signatures.
 *
 * Mutable only through `withActor`, which replaces the whole context rather than mutating it,
 * so a handler cannot quietly escalate its own actor mid-request.
 */
export interface RequestContext {
  /** Ties logs, audit rows and error reports for one request together. */
  readonly correlationId: string;
  readonly actor: AuthenticatedActor;
  /** When the request entered the process, for duration logging. */
  readonly startedAt: number;
}

const storage = new AsyncLocalStorage<RequestContext>();

export function createRequestContext(
  correlationId: string = randomUUID(),
  actor: AuthenticatedActor = ANONYMOUS_ACTOR,
): RequestContext {
  return { correlationId, actor, startedAt: Date.now() };
}

/** Run `work` with `context` as the ambient request context. */
export function runWithRequestContext<T>(context: RequestContext, work: () => T): T {
  return storage.run(context, work);
}

/**
 * The ambient request context, or `undefined` outside a request — a scheduled job, a migration,
 * a seed or a unit test. Callers that require one should use `requireRequestContext`.
 */
export function getRequestContext(): RequestContext | undefined {
  return storage.getStore();
}

export function requireRequestContext(): RequestContext {
  const context = storage.getStore();
  if (!context) {
    throw new Error(
      'No request context is active. This code path must run inside an HTTP request, or be ' +
        'given an explicit context via runWithRequestContext().',
    );
  }
  return context;
}

/** The current actor, defaulting to anonymous outside a request. */
export function getActor(): AuthenticatedActor {
  return storage.getStore()?.actor ?? ANONYMOUS_ACTOR;
}

/** Correlation id of the current request, or `undefined` outside one. */
export function getCorrelationId(): string | undefined {
  return storage.getStore()?.correlationId;
}

/**
 * Replace the actor on the ambient context for the duration of `work`.
 *
 * Used once per request, by the guard, after it has verified the actor. It is not a general
 * escalation tool: the replacement is scoped to the callback and never leaks outward.
 */
export function withActor<T>(actor: AuthenticatedActor, work: () => T): T {
  const current = requireRequestContext();
  return storage.run({ ...current, actor }, work);
}
