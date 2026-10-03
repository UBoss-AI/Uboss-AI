import { ShieldCheck } from 'lucide-react';

import './approval-gate.css';

/**
 * Work arriving at a decision, stopping, and being let through.
 *
 * ## What it replaces, and why the icon was not enough
 *
 * The panel said **HUMAN AUTHORITY — autonomy, with boundaries** beside a still shield in a
 * rounded square. The words carry the product's central claim and the picture carried none of it:
 * a shield is a stock symbol for "secure", and secure is not what that section is about. It is
 * about work *stopping* where a person has to decide.
 *
 * So the picture now does what the sentence says. A piece of work travels in, reaches the gate,
 * **holds** — the pause is the whole point and it is the longest beat in the loop — a person's mark
 * lands, and only then does it continue. Nothing is claimed that the product does not do: this is
 * `approval_request` in the software, and the hold is real.
 *
 * ## Why not a second 3D canvas
 *
 * The hero already runs one. A second WebGL context on the same page costs another few megabytes
 * of context and another animation loop, for a composition that is four elements moving along one
 * line — which CSS does natively, at a fraction of the cost, and which keeps working when WebGL
 * is unavailable.
 *
 * ## Reduced motion
 *
 * The loop stops and the composition rests in its *resolved* state: the work through, the mark
 * shown. A still frame of something mid-journey would read as broken, and the resting state is
 * the one that makes the point anyway.
 */
export function ApprovalGate(): React.JSX.Element {
  return (
    <div className="gate" aria-hidden="true">
      {/*
        The orbits, turning.

        They were two static rings — decoration that read as an unfinished diagram. Turning slowly
        in opposite directions they give the panel the depth it was drawn for, and the difference
        in their speeds is what stops the pair reading as one rigid object.
      */}
      <div className="gate__orbit" />
      <div className="gate__orbit gate__orbit--second" />

      {/* The line the work travels along. It passes behind the gate rather than stopping at it. */}
      <div className="gate__track">
        <span className="gate__rail" />
        <span className="gate__work" />
      </div>

      <div className="gate__card">
        <ShieldCheck size={62} strokeWidth={1} />
        {/*
          The mark a person leaves, arriving only once the work has waited.

          Timed against the same loop as the token: it appears at the moment the token is held and
          fades as the token moves on, so the sequence reads as cause and effect rather than as two
          things animating near each other.
        */}
        <span className="gate__stamp" />
      </div>

      <span className="gate__tag">
        <span /> HUMAN AUTHORITY
      </span>
      <span className="gate__caption">WORK WAITS HERE FOR A PERSON.</span>
    </div>
  );
}
