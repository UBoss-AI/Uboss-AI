import { AnimatePresence, motion } from 'motion/react';
import { useRef } from 'react';

import { cn } from '../lib/class-names';
import { stagger, transition } from '../motion/motion';
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
  /*
   * How many rows were there when this panel opened.
   *
   * The ones present at the start are a list arriving, so they stagger. A row that turns up later
   * is a stage that has just begun, and it should appear at once — staggering it by its position
   * would add a fifth of a second of apparent lag to the very moment the panel exists to report.
   */
  const atFirstRender = useRef(items.length);

  return (
    <ol
      className={cn('uboss-stepper', className)}
      aria-label={label}
      style={{ listStyle: 'none', margin: 0, padding: 0 }}
    >
      {items.map((item, index) => {
        const isLast = index === items.length - 1;

        return (
          <motion.li
            key={item.id}
            /*
             * `--live` marks the analysis case, and only it.
             *
             * This component is on five screens. Four of them are wizards and timelines where
             * "done" is a success and green says so correctly; one is a durable job in flight,
             * where seven green discs read as a completed form rather than as a machine working.
             * The accent treatment and the reading sweep are scoped to this class so changing how
             * a run looks cannot quietly restyle Create Company.
             */
            className={cn('uboss-step', STATE_CLASS[item.state], live && 'uboss-step--live')}
            /*
             * The list arrives in order, once.
             *
             * `stagger` is capped, so a long list reveals inside the signature budget rather than
             * turning into a wait. This is an entrance and nothing else: it says the panel has
             * opened, never that a stage has progressed.
             */
            initial={{ opacity: 0, y: -6, scale: 0.98 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            transition={{
              ...transition('panel', 'enter'),
              delay: index < atFirstRender.current ? stagger(index, atFirstRender.current) : 0,
            }}
          >
            {!isLast ? <span className="uboss-step-line" aria-hidden="true" /> : null}
            <span className="uboss-step-marker">
              {/*
                The marker changes shape when the **server** says the stage changed.

                Keyed on the state so the outgoing number leaves and the tick arrives, rather than
                one swapping for the other between frames. What is animated is the change itself;
                nothing here decides when the change happens, and no timer advances a stage — the
                only source of that is the run the screen is polling. An animation that walked
                through the stages on its own would keep ticking them off while a job was stuck,
                which is a progress indicator that lies.
              */}
              <AnimatePresence initial={false} mode="wait">
                <motion.span
                  key={item.state}
                  initial={{ opacity: 0, scale: 0.6 }}
                  animate={{ opacity: 1, scale: 1 }}
                  exit={{ opacity: 0, scale: 0.6 }}
                  transition={transition('small', 'emphasized')}
                  style={{ display: 'inline-flex', alignItems: 'center', justifyContent: 'center' }}
                >
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
                </motion.span>
              </AnimatePresence>
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
          </motion.li>
        );
      })}
    </ol>
  );
}
