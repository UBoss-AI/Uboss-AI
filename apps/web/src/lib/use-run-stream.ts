'use client';

import { useEffect, useRef, useState } from 'react';

import type { RunProgressEvent } from '@uboss/types';

import { runsApi } from './api-client';

/**
 * Live run progress, as the engine reports it.
 *
 * ## What this is, and what it is not
 *
 * It is a **notification channel**. Every event here was written to the run's own history before
 * it was published, so nothing on screen depends on having received one: a client that was closed,
 * reconnecting, or opened late has missed nothing it cannot read back. That is deliberate, and it
 * is why this hook holds only what it has seen rather than pretending to hold the truth.
 *
 * ## Why `EventSource` and not a socket
 *
 * Nothing is sent upward. The browser subscribes and listens; every instruction goes through an
 * ordinary request. `EventSource` also reconnects by itself when a connection drops — a socket
 * needs reconnection logic somebody has to write and nobody tests, and a workflow that waits on a
 * person waits for hours, which is long enough for every connection in the path to be recycled.
 *
 * ## Why the latest event per run rather than a list
 *
 * A canvas asks "what is this node doing **now**". Keeping every event would grow without bound
 * on a long workflow and answer a question nobody is asking — the full history is a page of its
 * own, read from the record rather than from a stream.
 */
export interface RunStreamState {
  /** The latest event seen for each run, by run id. */
  byRun: Map<string, RunProgressEvent>;
  /**
   * The latest event for each **assigned step**, by `aiWorkAssignmentId`.
   *
   * This is what a workflow canvas reads: the assignment names the graph node, so a node can ask
   * what is happening to it without knowing which run is doing the work. Runs that belong to no
   * step — a scheduler tick, somebody testing an agent — appear in `byRun` only.
   */
  byAssignment: Map<string, RunProgressEvent>;
  /** Whether the stream is currently connected. */
  live: boolean;
}

export interface RunStreamOptions {
  /**
   * Read what is already unfinished before listening.
   *
   * Off by default, because most callers use this as a signal to reload something of their own
   * and a second request would be work nobody reads. On for a screen that draws the runs
   * themselves: the stream publishes *changes*, so a run that has been running for two minutes
   * made its last change two minutes ago, and a screen opened now would show nothing at all until
   * it next moved.
   */
  seedFromRecord?: boolean;
}

export function useRunStream(
  tenantId: string | null,
  options: RunStreamOptions = {},
): RunStreamState {
  const { seedFromRecord = false } = options;
  const [state, setState] = useState<RunStreamState>(() => ({
    byRun: new Map(),
    byAssignment: new Map(),
    live: false,
  }));

  /*
   * The maps are mutated in a ref and copied into state on each event.
   *
   * Replacing a Map on every event is what makes React notice; keeping the live one in a ref is
   * what stops a burst of events from each rebuilding the previous copy. A workflow with several
   * parallel branches reports from all of them at once, and that burst is the normal case rather
   * than the exception.
   */
  const runs = useRef(new Map<string, RunProgressEvent>());
  const assignments = useRef(new Map<string, RunProgressEvent>());

  useEffect(() => {
    if (tenantId === null) return;

    runs.current = new Map();
    assignments.current = new Map();

    /*
     * The record first, where the caller asked for it.
     *
     * Deliberately not awaited before the stream opens: a change that lands while this request is
     * in flight must not be missed, and it will not be — an event always wins, because `record`
     * only fills in a run the stream has not spoken about yet. The other order would have a gap.
     */
    if (seedFromRecord) {
      void runsApi
        .unfinished(tenantId)
        .then((result) => {
          let added = false;
          for (const event of result.runs) {
            if (runs.current.has(event.runId)) continue;
            runs.current.set(event.runId, event);
            if (event.aiWorkAssignmentId !== null) {
              assignments.current.set(event.aiWorkAssignmentId, event);
            }
            added = true;
          }
          if (!added) return;
          setState((previous) => ({
            ...previous,
            byRun: new Map(runs.current),
            byAssignment: new Map(assignments.current),
          }));
        })
        /*
         * A seed that will not load leaves the screen on the stream alone, which is the state it
         * was in before this existed. Reporting it would be an error message about a convenience,
         * on a screen whose own data loaded fine.
         */
        .catch(() => undefined);
    }

    const source = new EventSource(
      `/api/tenants/${encodeURIComponent(tenantId)}/runs/stream`,
      // The cookie is the session, and `EventSource` omits credentials unless told otherwise.
      { withCredentials: true },
    );

    const onProgress = (message: MessageEvent<string>) => {
      let event: RunProgressEvent;
      try {
        event = JSON.parse(message.data) as RunProgressEvent;
      } catch {
        // A frame that does not parse is dropped rather than thrown. This channel is a
        // convenience over a record that is already durable, and it must never be able to break
        // the screen it is decorating.
        return;
      }

      runs.current.set(event.runId, event);
      if (event.aiWorkAssignmentId !== null) {
        assignments.current.set(event.aiWorkAssignmentId, event);
      }

      setState({
        byRun: new Map(runs.current),
        byAssignment: new Map(assignments.current),
        live: true,
      });
    };

    source.addEventListener('run-progress', onProgress as EventListener);
    source.addEventListener('open', () => setState((previous) => ({ ...previous, live: true })));

    /*
     * An error is not fatal and is not reported to the person.
     *
     * `EventSource` reconnects on its own, and the common cause is a laptop lid or a proxy
     * recycling an idle connection. What the screen shows is `live: false`, so a canvas can say
     * "not live" rather than silently showing stale state as though it were current.
     */
    source.addEventListener('error', () => setState((previous) => ({ ...previous, live: false })));

    return () => {
      source.removeEventListener('run-progress', onProgress as EventListener);
      source.close();
    };
  }, [seedFromRecord, tenantId]);

  return state;
}
