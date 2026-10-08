import { cn } from '../lib/class-names';

export interface ProgressRingProps {
  /** How many steps of the work are finished. */
  completed: number;
  /** How many there are in total. Zero draws an empty ring rather than dividing by it. */
  total: number;
  /**
   * Whether work is genuinely in flight.
   *
   * It drives the turning halo, and that is the whole reason it is a separate prop rather than
   * `completed < total`: a run that was cancelled at stage three is also three of seven, and a
   * ring that kept turning would say something is still happening when nothing is.
   */
  live?: boolean;
  /** Under the percentage, e.g. `3 of 7`. The exact counts, for somebody who wants them. */
  caption?: string;
  /** What the ring is measuring, for anybody not looking at the screen. */
  label: string;
  /** Outer diameter in pixels. */
  size?: number;
  className?: string;
}

/**
 * A percentage, drawn.
 *
 * ## Why there is a percentage at all
 *
 * The analysis screen reported `3 of 7` and a list of seven stage names, and the comment beside
 * it argued a percentage would be invented because "the run reports stages and not fractions".
 * That is true of *time* — stage five is not five sevenths of the wait — and it is not true of
 * progress: three stages of seven finished is three sevenths of the work done, and it is the one
 * number somebody glancing at a long job actually wants.
 *
 * So the number here is exactly `completed / total`, and the caption keeps the counts beside it
 * so nobody has to trust the rounding.
 *
 * ## Why it is a ring and not a bar
 *
 * A bar puts the number somewhere else. A ring holds its own number in the middle, which means
 * one thing to look at instead of two, and it reads at a glance from across a desk — which is how
 * this screen is actually used while a seven-stage job runs.
 *
 * ## The motion
 *
 * The arc grows over `--uboss-motion-signature`, the token whose own comment names this gesture:
 * "donut draw, workflow reveal, brand moments". The halo behind it turns on
 * `--uboss-motion-ambient-ring` while work is in flight, and stops when it is not. Neither is a
 * new duration — a loop that invents its own timing is how a product ends up with four speeds of
 * the same idea.
 */
export function ProgressRing({
  completed,
  total,
  live = false,
  caption,
  label,
  size = 112,
  className,
}: ProgressRingProps) {
  const safeTotal = Math.max(0, total);
  const done = Math.min(Math.max(0, completed), safeTotal);
  const fraction = safeTotal === 0 ? 0 : done / safeTotal;
  const percent = Math.round(fraction * 100);

  /*
   * Thin enough to read as a dial rather than a doughnut.
   *
   * At 0.075 of the diameter the track was heavier than the number inside it, and the eye went to
   * the grey ring instead of the figure it exists to annotate.
   */
  const stroke = Math.max(5, Math.round(size * 0.055));

  /*
   * Inset by a **whole** stroke, not half of one.
   *
   * A stroke is centred on the path, so a radius of `(size - stroke) / 2` puts the outer half of
   * it exactly on the viewBox edge. The browser then clips that half at the top, bottom, left and
   * right — the four points where the circle meets the boundary — and a ring that should be round
   * comes out looking like a flattened octagon with its sides shaved off.
   *
   * A whole stroke leaves the outer edge half a stroke clear of the boundary, which also gives
   * the round line cap room at the end of the arc.
   */
  const radius = (size - stroke * 2) / 2;
  const circumference = 2 * Math.PI * radius;

  return (
    <div
      className={cn('uboss-ring', live && 'uboss-ring--live', className)}
      style={{ width: size, height: size }}
      role="progressbar"
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={percent}
      aria-label={label}
      /* The counts as well as the percentage, because "43%" of an unknown is not a progress report. */
      aria-valuetext={caption === undefined ? `${percent}%` : `${percent}% — ${caption}`}
    >
      <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`} aria-hidden="true">
        {/* Rotated so the arc starts at the top, where people read a dial from. */}
        <g transform={`rotate(-90 ${size / 2} ${size / 2})`}>
          <circle
            className="uboss-ring-track"
            cx={size / 2}
            cy={size / 2}
            r={radius}
            strokeWidth={stroke}
            fill="none"
          />
          <circle
            className="uboss-ring-halo"
            cx={size / 2}
            cy={size / 2}
            r={radius}
            strokeWidth={stroke}
            fill="none"
            strokeLinecap="round"
            strokeDasharray={`${circumference * 0.18} ${circumference}`}
          />
          <circle
            className="uboss-ring-fill"
            cx={size / 2}
            cy={size / 2}
            r={radius}
            strokeWidth={stroke}
            fill="none"
            strokeLinecap="round"
            strokeDasharray={circumference}
            strokeDashoffset={circumference * (1 - fraction)}
          />
        </g>
      </svg>

      <div className="uboss-ring-centre">
        <span className="uboss-ring-percent">
          {percent}
          <small>%</small>
        </span>
        {caption === undefined ? null : <span className="uboss-ring-caption">{caption}</span>}
      </div>
    </div>
  );
}
