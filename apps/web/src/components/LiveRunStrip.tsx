'use client';

import {
  BLOCK_OWNER,
  isRunBlocked,
  isRunFinished,
  RUN_STATE_LABELS,
  type BlockedRunState,
  type RunProgressEvent,
} from '@uboss/types';

import './live-run-strip.css';

export interface LiveRunStripProps {
  /** Every run the stream has reported, newest event per run. */
  events: readonly RunProgressEvent[];
  /** Agent names by engine agent id. A run whose agent is not in the map names the agent's id. */
  agentNames: ReadonlyMap<string, string>;
  /** Whether the stream is connected. Shown, never hidden — see the note on the indicator. */
  live: boolean;
  /** Opens the agent a lane belongs to. Omitted where there is nowhere to go. */
  onOpenAgent?: ((engineAgentId: string) => void) | undefined;
}

/**
 * Everything running right now, in one place.
 *
 * ## Why this exists beside the workflow canvas
 *
 * The canvas answers "where in this plan is the work". This answers a different question —
 * "what is my company's AI doing at this moment" — and the answer is usually several things at
 * once, belonging to different agents and different objectives, with no graph joining them. Drawn
 * as a graph they would be a row of disconnected boxes; drawn as lanes they are what they are.
 *
 * ## Why a finished run stays for a moment
 *
 * Because the thing somebody is watching for is the ending. A lane that vanished on completion
 * would mean the one frame you were waiting for is the one you never see, and the run history
 * below would be the only evidence it ever ran. Finished lanes are kept, marked as finished, and
 * fall off when the list is rebuilt on the next visit.
 *
 * ## Nothing here is on a timer
 *
 * Every lane comes from an event the engine published after writing the run's state to its own
 * history. A lane that is moving is a run the database agrees is moving. There is no interval
 * advancing a bar, and a run that reports no percentage is drawn without one rather than with a
 * number this component made up.
 */
export function LiveRunStrip({ events, agentNames, live, onOpenAgent }: LiveRunStripProps) {
  /*
   * Newest first, so a burst of parallel runs does not reorder itself under somebody's cursor as
   * each one reports. The `at` timestamps come from one process, so comparing them as strings is
   * comparing them as instants.
   */
  const lanes = [...events].sort((a, b) => b.at.localeCompare(a.at));

  if (lanes.length === 0) return null;

  return (
    <div className="lrs">
      <div className="lrs__head">
        <span className="lrs__title">Working now</span>
        {/*
          The state of the channel, said out loud.

          A strip that has lost its stream looks exactly like a strip where nothing has changed,
          and somebody watching a run they just started deserves to know which of the two they
          are looking at.
        */}
        <span className={`lrs__live${live ? ' lrs__live--on' : ''}`}>
          {live ? 'Live' : 'Not live — reload to reconnect'}
        </span>
      </div>

      <ul className="lrs__lanes">
        {lanes.map((event) => {
          const finished = isRunFinished(event.state);
          const blocked = isRunBlocked(event.state);
          // Moving means moving. Queued, Reserved, Running and Retrying are the states in which
          // the engine is actually carrying this run forward; a blocked or finished one is not.
          const moving = !finished && !blocked;
          const name = agentNames.get(event.engineAgentId) ?? event.engineAgentId;

          return (
            <li
              key={event.runId}
              className={`lrs__lane lrs__lane--${event.state.toLowerCase()}${
                moving ? ' lrs__lane--moving' : ''
              }`}
              onClick={
                onOpenAgent === undefined ? undefined : () => onOpenAgent(event.engineAgentId)
              }
              style={onOpenAgent === undefined ? undefined : { cursor: 'pointer' }}
            >
              <span className="lrs__who">
                <span className="lrs__dot" aria-hidden="true" />
                <span className="lrs__name">{name}</span>
                <span className="lrs__state">{RUN_STATE_LABELS[event.state]}</span>
                {event.attempt > 1 ? (
                  // Said plainly. A run on its third attempt that looks like a first attempt is a
                  // run whose trouble nobody notices until it dead-letters.
                  <span className="lrs__attempt">attempt {event.attempt}</span>
                ) : null}
              </span>

              {/*
                The track, and the light on it.

                The light exists only while the run is moving, so a still track is a run that is
                not going anywhere — which is the honest picture of a blocked or finished one.
              */}
              <span className="lrs__track">
                {moving ? (
                  <>
                    <span className="lrs__spark" />
                    <span className="lrs__spark lrs__spark--b" />
                    <span className="lrs__spark lrs__spark--c" />
                  </>
                ) : null}
                {/*
                  The fill, only where the engine reported a fraction.

                  `percent` is null whenever the work cannot say honestly how far along it is, and
                  in that case there is no bar at all — the moving light already says it is
                  working, and a bar would be the one claim the null exists to withhold.
                */}
                {event.percent === null ? null : (
                  <span className="lrs__fill" style={{ width: `${event.percent}%` }} />
                )}
              </span>

              <span className="lrs__said">
                {event.percent === null ? '' : `${event.percent}% · `}
                {event.message}
                {blocked ? ` — ${BLOCK_OWNER[event.state as BlockedRunState]}` : ''}
              </span>
            </li>
          );
        })}
      </ul>
    </div>
  );
}
