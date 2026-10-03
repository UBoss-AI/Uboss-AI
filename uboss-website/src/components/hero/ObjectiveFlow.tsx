import { Bot, ShieldAlert, Target, UserCheck, Users, Wallet } from 'lucide-react';

import './objective-flow.css';

/**
 * The product's own flow, in the product's own notation.
 *
 * ## Why this replaced the field of dots
 *
 * The hero used to carry an abstract network — points and links, moving slowly. It looked well
 * enough and it said nothing: it could have sat behind any software in the world. This says what
 * the headline above it claims, which is the whole reason a hero has a picture at all.
 *
 * ## It follows the reference's *craft*, not its content
 *
 * The reference runs eight cards — Researcher, Writer, Coder, Designer, a Quality Gate that
 * checks, and Shipped. Those are somebody else's generic agents, and one of them describes a
 * product this is not: a **Quality Gate that checks every piece** is an automated check, and the
 * whole claim here is that a **person** decides.
 *
 * What the reference does get right, and what this now copies, is the craft: every card carries
 * its own colour, an icon and a numbered badge, and light **streams** along the connectors rather
 * than one dot crawling. Those are what make a diagram look alive instead of drawn.
 *
 * So the shapes and words are the product's — `ANALYSIS_NODE_KINDS` in the shared types, and the
 * shape each kind is always drawn as:
 *
 *   * **Goal** — the objective somebody wrote
 *   * **Human** — work a person owns
 *   * **Ai** — work an agent runs
 *   * **Approval** — the gate, where the run stops for a person
 *
 * A reader who later opens the product meets the same four in the workflow canvas.
 *
 * ## The pause is still the point
 *
 * Everything streams; one thing stops. Work reaches the gate and **holds** before a person's mark
 * lands and it moves on. Speeding the rest up made that hold louder, not quieter — it is now the
 * only still moment in a picture that is otherwise always moving.
 */

/** Four sparks a path, staggered, so a connector always has something on it. */
const SPARKS = [0, 1, 2, 3];

export function ObjectiveFlow(): React.JSX.Element {
  return (
    <div className="oflow" aria-hidden="true">
      <svg className="oflow__svg" viewBox="0 0 520 620" fill="none">
        <defs>
          {/*
            One gradient for the connectors, fading at both ends.

            A line of constant opacity between two nodes reads as a pipe. Fading it where it meets
            each node makes the nodes the objects and the lines the relationship, which is the way
            round this diagram needs.
          */}
          <linearGradient id="oflow-link" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor="#a78bfa" stopOpacity="0.06" />
            <stop offset="50%" stopColor="#a78bfa" stopOpacity="0.55" />
            <stop offset="100%" stopColor="#a78bfa" stopOpacity="0.06" />
          </linearGradient>
        </defs>

        {/* Goal down to the split */}
        <path className="oflow__link" d="M260 96 L260 150" />

        {/* The split: one branch to the people side, one to the agent side */}
        <path className="oflow__link" d="M260 150 C 260 190, 140 180, 140 226" />
        <path className="oflow__link" d="M260 150 C 260 190, 380 180, 380 226" />

        {/* Each branch on to its second step */}
        <path className="oflow__link" d="M140 300 L140 350" />
        <path className="oflow__link" d="M380 300 L380 350" />

        {/* Both converge on the gate */}
        <path className="oflow__link" d="M140 424 C 140 470, 260 460, 260 496" />
        <path className="oflow__link" d="M380 424 C 380 470, 260 460, 260 496" />

        {/* Out of the gate, once somebody has signed it */}
        <path className="oflow__link oflow__link--out" d="M260 570 L260 606" />

        {/*
          Sent back.

          Not decoration: a rejected approval returns the work in this product, and it is recorded
          against the person's score. Dashed and to one side, because it is the exception rather
          than the path.
        */}
        <path className="oflow__return" d="M330 545 C 452 545, 452 268, 420 254" />

        {/*
          The stream.

          Four per branch rather than one, each a beat behind the last — a single dot crawling down
          a line reads as a loading indicator. With four the connector is never empty and the eye
          reads flow rather than a lone traveller.
        */}
        {SPARKS.map((i) => (
          <circle
            key={`l${i}`}
            className="oflow__spark oflow__spark--left"
            r="3.4"
            style={{ animationDelay: `${i * 0.9}s` }}
          />
        ))}
        {SPARKS.map((i) => (
          <circle
            key={`r${i}`}
            className="oflow__spark oflow__spark--right"
            r="3.4"
            style={{ animationDelay: `${i * 0.9 + 0.35}s` }}
          />
        ))}
        {SPARKS.slice(0, 2).map((i) => (
          <circle
            key={`o${i}`}
            className="oflow__spark oflow__spark--out"
            r="3.6"
            style={{ animationDelay: `${i * 1.8}s` }}
          />
        ))}
      </svg>

      <ol className="oflow__nodes">
        <li
          className="onode onode--goal"
          style={{ ['--x' as string]: '50%', ['--y' as string]: '60px' }}
        >
          <span className="onode__num">01</span>
          <span className="onode__icon">
            <Target size={16} strokeWidth={1.9} />
          </span>
          <span className="onode__text">
            <span className="onode__title">Objective</span>
            <span className="onode__sub">what the business needs</span>
          </span>
        </li>

        <li
          className="onode onode--human"
          style={{ ['--x' as string]: '27%', ['--y' as string]: '263px' }}
        >
          <span className="onode__num">02</span>
          <span className="onode__icon">
            <Users size={16} strokeWidth={1.9} />
          </span>
          <span className="onode__text">
            <span className="onode__title">Your people</span>
            <span className="onode__sub">the work they own</span>
          </span>
        </li>

        <li
          className="onode onode--ai"
          style={{ ['--x' as string]: '73%', ['--y' as string]: '263px' }}
        >
          <span className="onode__num">03</span>
          <span className="onode__icon">
            <Bot size={16} strokeWidth={1.9} />
          </span>
          <span className="onode__text">
            <span className="onode__title">Engine Agents</span>
            <span className="onode__sub">governed skills, bounded</span>
          </span>
        </li>

        <li
          className="onode onode--watch"
          style={{ ['--x' as string]: '27%', ['--y' as string]: '387px' }}
        >
          <span className="onode__num">04</span>
          <span className="onode__icon">
            <ShieldAlert size={16} strokeWidth={1.9} />
          </span>
          <span className="onode__text">
            <span className="onode__title">Executor</span>
            <span className="onode__sub">raises exceptions</span>
          </span>
        </li>

        <li
          className="onode onode--budget"
          style={{ ['--x' as string]: '73%', ['--y' as string]: '387px' }}
        >
          <span className="onode__num">05</span>
          <span className="onode__icon">
            <Wallet size={16} strokeWidth={1.9} />
          </span>
          <span className="onode__text">
            <span className="onode__title">Budget held</span>
            <span className="onode__sub">reserved before it runs</span>
          </span>
        </li>

        {/* The gate. The flow stops here, and it is the only node that is a different colour. */}
        <li
          className="onode onode--gate"
          style={{ ['--x' as string]: '50%', ['--y' as string]: '533px' }}
        >
          <span className="onode__num">06</span>
          <span className="onode__icon">
            <UserCheck size={16} strokeWidth={1.9} />
          </span>
          <span className="onode__text">
            <span className="onode__title">A person approves</span>
            <span className="onode__sub">nobody approves their own</span>
          </span>
          <span className="onode__stamp" />
        </li>
      </ol>

      <span className="oflow__return-label">sent back if refused</span>
    </div>
  );
}
