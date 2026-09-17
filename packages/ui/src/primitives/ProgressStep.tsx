import { cn } from '../lib/class-names';
import { Icon } from './Icon';

export type StepState = 'done' | 'running' | 'todo' | 'blocked';

export interface ProgressStepItem {
  id: string;
  label: string;
  /** Secondary line, e.g. who owns the step or when it completed. */
  sub?: string;
  state: StepState;
}

export interface ProgressStepProps {
  items: ProgressStepItem[];
  /** Accessible name for the list. */
  label: string;
  /**
   * Does a `running` step mean work is actually in flight?
   *
   * The distinction is not cosmetic. A wizard marks its current step `running` to say "you are
   * here", and a ring that pulses for ever beside a form waiting for typing is motion with
   * nothing behind it. An analysis run marks a stage `running` because a job really is working,
   * and there an ongoing indicator is the truth — it is the only thing on screen saying the wait
   * is progress rather than a hang.
   *
   * So the caller says which it is, and the default is the quiet one: something that merely marks
   * position animates once and stops.
   */
  live?: boolean;
  className?: string;
}

const STATE_CLASS: Record<StepState, string> = {
  done: 'uboss-step--done',
  running: 'uboss-step--running',
  todo: 'uboss-step--todo',
  blocked: 'uboss-step--blocked',
};

/** Text equivalent so progress is never conveyed by shape or colour alone. */
const STATE_LABEL: Record<StepState, string> = {
  done: 'Completed',
  running: 'In progress',
  todo: 'Not started',
  blocked: 'Blocked',
};

/**
 * Vertical progress stepper used for long-running work such as Objective analysis.
 *
 * It reports real progress only — never a fabricated completion. Each step carries a text
 * state for assistive technology.
 *
 * Pass `live` when a `running` step reflects work genuinely in flight; see the prop.
 */
export function ProgressStep({ items, label, live = false, className }: ProgressStepProps) {
  return (
    <ol
      className={cn('uboss-stepper', className)}
      aria-label={label}
      style={{ listStyle: 'none', margin: 0, padding: 0 }}
    >
      {items.map((item, index) => {
        const isLast = index === items.length - 1;

        return (
          <li key={item.id} className={cn('uboss-step', STATE_CLASS[item.state])}>
            {!isLast ? <span className="uboss-step-line" aria-hidden="true" /> : null}
            <span className="uboss-step-marker">
              {item.state === 'done' ? (
                <Icon name="check" size={13} />
              ) : item.state === 'blocked' ? (
                <Icon name="pause" size={12} />
              ) : (
                <>
                  {item.state === 'running' ? (
                    <span
                      className={cn('uboss-step-pulse', live && 'uboss-step-pulse--live')}
                      aria-hidden="true"
                    />
                  ) : null}
                  {index + 1}
                </>
              )}
            </span>
            <span>
              <span className="uboss-step-label">{item.label}</span>
              <span className="uboss-sr-only"> — {STATE_LABEL[item.state]}</span>
              {item.sub ? (
                <>
                  <br />
                  <span className="uboss-step-sub">{item.sub}</span>
                </>
              ) : null}
            </span>
          </li>
        );
      })}
    </ol>
  );
}
