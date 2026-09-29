'use client';

import { cn } from '../lib/class-names';
import { Icon, type IconName } from './Icon';

/**
 * A run's state, and the one rule this component exists to hold: **motion means work**.
 *
 * There are thirteen real run states and they are not three kinds of the same thing. Some mean a
 * machine is doing something right now; some mean the run is sitting still waiting for a person;
 * some mean it is over. If everything non-terminal animated, a run that has been waiting three
 * days for an approval would look busy, and the one thing an operator needs from this screen is
 * to know which runs are moving and which are stuck.
 *
 * So the indicator animates for `Running` and `Retrying` and for nothing else. Waiting is still.
 * Blocked is still. Queued is still — a queued run is not working, it is waiting for a worker, and
 * an animation there would say the opposite.
 *
 * The state is never inferred, softened or grouped for display: whatever the server says is what
 * is shown, including the four `Blocked*` states, which name what is wrong rather than reporting a
 * generic failure. A state this component does not recognise is rendered as itself rather than
 * being mapped to something familiar — a run in an unexpected state is exactly when a made-up
 * label does the most damage.
 */
export interface RunStateProps {
  /** The state exactly as the server reported it. */
  state: string;
  /** The server's own label, when it sends one. */
  label?: string;
  className?: string;
}

/** The two states in which a machine is doing something at this moment. */
const WORKING = new Set(['Running', 'Retrying']);

/** Waiting on a person. Still, on purpose. */
const WAITING = new Set(['WaitingForHumanInput', 'WaitingForApproval']);

/** Over. Nothing further happens. */
const TERMINAL = new Set(['Completed', 'Failed', 'Cancelled']);

/** Stopped by something that has to be fixed elsewhere. */
const BLOCKED = new Set([
  'BlockedByBudget',
  'BlockedByConnection',
  'BlockedByPermission',
  'BlockedByProvider',
]);

const FALLBACK_LABELS: Record<string, string> = {
  Queued: 'Queued',
  Reserved: 'Reserved',
  Running: 'Running',
  WaitingForHumanInput: 'Waiting for human input',
  WaitingForApproval: 'Waiting for approval',
  Retrying: 'Retrying',
  Completed: 'Completed',
  Failed: 'Failed',
  Cancelled: 'Cancelled',
  BlockedByBudget: 'Blocked by budget',
  BlockedByConnection: 'Blocked by connection',
  BlockedByPermission: 'Blocked by permission',
  BlockedByProvider: 'Blocked by provider',
};

const ICONS: Record<string, IconName> = {
  working: 'bolt',
  waiting: 'clock',
  blocked: 'shield',
  done: 'check',
  failed: 'alert',
  queued: 'list',
};

function kindOf(state: string): 'working' | 'waiting' | 'blocked' | 'done' | 'failed' | 'queued' {
  if (WORKING.has(state)) return 'working';
  if (WAITING.has(state)) return 'waiting';
  if (BLOCKED.has(state)) return 'blocked';
  if (state === 'Completed') return 'done';
  if (state === 'Failed' || state === 'Cancelled') return 'failed';
  return 'queued';
}

export function RunState({ state, label, className }: RunStateProps) {
  const kind = kindOf(state);
  const shown = label ?? FALLBACK_LABELS[state] ?? state;

  return (
    <span
      className={cn('uboss-run-state', `uboss-run-state--${kind}`, className)}
      // The state in words, so it never depends on the dot moving or on its colour.
      data-state={state}
    >
      <span
        className={cn('uboss-run-dot', kind === 'working' && 'uboss-run-dot--working')}
        aria-hidden="true"
      />
      <Icon name={ICONS[kind] ?? 'list'} size={13} />
      {shown}
      {TERMINAL.has(state) ? null : (
        /*
         * Said out loud for a screen reader, because "waiting" and "working" look similar and
         * sound identical otherwise — and the difference is whether anyone needs to do something.
         */
        <span className="uboss-sr-only">
          {kind === 'working'
            ? ' — in progress'
            : kind === 'waiting'
              ? ' — waiting, no machine work in progress'
              : ' — not running'}
        </span>
      )}
    </span>
  );
}
