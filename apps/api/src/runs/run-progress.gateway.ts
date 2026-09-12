import { Injectable, Logger } from '@nestjs/common';

import type { RunProgressEvent } from '@uboss/types';

/** A subscriber to one company's run progress. */
export type RunProgressListener = (event: RunProgressEvent) => void;

/**
 * Live run progress.
 *
 * ## Why this is not a socket.io gateway
 *
 * The approved architecture is explicit that "WebSockets carry live updates but never replace
 * durable API state". This class is the *publisher* side of that contract, and it is deliberately
 * transport-free: every event it publishes has already been written to `agent_run_events`, so the
 * socket is a notification that something changed, not the thing that changed.
 *
 * Keeping the transport out has a second benefit that matters more than tidiness. A test that
 * asserts a run reported progress can subscribe to this directly, without a socket server, a
 * client library, or a sleep waiting for a frame to arrive. What is left uncovered is the wire —
 * which belongs in an integration check, not in a state-machine test.
 *
 * ## Per-tenant fan-out
 *
 * Subscription is per company, and an event is only delivered to listeners of the company it
 * belongs to. There is no cross-tenant path here by construction rather than by filtering: a
 * listener is registered against a tenant id and never sees any other list.
 */
@Injectable()
export class RunProgressGateway {
  private readonly logger = new Logger(RunProgressGateway.name);
  private readonly listeners = new Map<string, Set<RunProgressListener>>();

  /**
   * Listen to one company's run progress.
   *
   * @returns The unsubscribe function. Callers must call it: a listener that outlives its
   *   subscriber is a leak, and in a socket gateway it is a write to a closed connection.
   */
  subscribe(tenantId: string, listener: RunProgressListener): () => void {
    const existing = this.listeners.get(tenantId) ?? new Set<RunProgressListener>();
    existing.add(listener);
    this.listeners.set(tenantId, existing);

    return () => {
      const current = this.listeners.get(tenantId);
      if (!current) return;
      current.delete(listener);
      if (current.size === 0) this.listeners.delete(tenantId);
    };
  }

  /**
   * Publish an update to one company's listeners.
   *
   * Never throws. A subscriber that fails — a closed socket, a listener with a bug — must not fail
   * the run that was reporting progress: the run's state is already committed, and losing the
   * animation is the acceptable outcome where losing the work is not.
   */
  publish(tenantId: string, event: RunProgressEvent): void {
    const listeners = this.listeners.get(tenantId);
    if (!listeners) return;

    for (const listener of listeners) {
      try {
        listener(event);
      } catch (caught) {
        this.logger.warn(
          `A run progress listener threw for run ${event.runId}: ${
            caught instanceof Error ? caught.message : String(caught)
          }`,
        );
      }
    }
  }

  /** How many listeners a company has, for diagnostics. */
  listenerCount(tenantId: string): number {
    return this.listeners.get(tenantId)?.size ?? 0;
  }
}
