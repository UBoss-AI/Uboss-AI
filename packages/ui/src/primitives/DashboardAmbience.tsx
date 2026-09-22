'use client';

/**
 * The Dashboard's atmosphere — decoration, and nothing else.
 *
 * ## What it is
 *
 * A layer behind the whole Dashboard workspace, not behind the donut card. In Light it is three
 * very slow lavender and cyan orbs over a faint grid; in Dark the same layer becomes a deep navy
 * field with a neural constellation across it. The theme switch changes the atmosphere of the
 * entire canvas, which is the point — an ambience confined to a card-sized rectangle reads as a
 * decorated widget rather than as an environment.
 *
 * ## Why the layout is computed, not random
 *
 * The field is generated from a deterministic hash of each node's index, so the same nodes land in
 * the same places on every render. A random layout would re-roll on every React re-render — a
 * poll, a hover, a theme change — and the network would visibly jump behind the data somebody was
 * reading. That is also why this component takes no props that vary: nothing about it depends on
 * state, so nothing about it can move when state changes.
 *
 * ## What it must never do
 *
 * It is `aria-hidden` and `pointer-events: none`. It adds no information, reports no measurement
 * and represents no data — a network diagram behind a dashboard is exactly the kind of thing
 * somebody could mistake for telemetry, so it is drawn from arithmetic and says nothing. It sits
 * in its own stacking context behind the content and cannot cover a control.
 *
 * Under `prefers-reduced-motion` the whole composition stays and only the movement goes: the orbs
 * freeze where they are and the nodes stop pulsing. The identity is not the animation.
 */

/** The field's own coordinate space. Scaled to the canvas by `preserveAspectRatio="slice"`. */
const WIDTH = 1200;
const HEIGHT = 620;
const COLUMNS = 13;
const ROWS = 7;

/**
 * A stable pseudo-random number for index `i`.
 *
 * The usual sine-hash: deterministic, cheap, and good enough to look unplanned. Deliberately not
 * `Math.random()` — see above.
 */
function noise(i: number): number {
  const value = Math.sin(i * 127.1 + i * i * 0.0311) * 43758.5453;
  return value - Math.floor(value);
}

interface Node {
  x: number;
  y: number;
  i: number;
}

function buildField(): { nodes: Node[]; links: { a: Node; b: Node; hot: boolean; cyan: boolean }[] } {
  const nodes: Node[] = [];
  for (let row = 0; row < ROWS; row += 1) {
    for (let column = 0; column < COLUMNS; column += 1) {
      const i = row * COLUMNS + column;
      nodes.push({
        // Jittered off the grid so it reads as a network rather than as graph paper.
        x: (column + 0.5) * (WIDTH / COLUMNS) + (noise(i) - 0.5) * 54,
        y: (row + 0.5) * (HEIGHT / ROWS) + (noise(i + 91) - 0.5) * 44,
        i,
      });
    }
  }

  const links: { a: Node; b: Node; hot: boolean; cyan: boolean }[] = [];
  for (let row = 0; row < ROWS; row += 1) {
    for (let column = 0; column < COLUMNS; column += 1) {
      const a = nodes[row * COLUMNS + column] as Node;
      const right = column < COLUMNS - 1 ? nodes[row * COLUMNS + column + 1] : undefined;
      const down = row < ROWS - 1 ? nodes[(row + 1) * COLUMNS + column] : undefined;
      // Only some diagonals, or the field becomes a mesh and stops reading as connections.
      const diagonal =
        row < ROWS - 1 && column < COLUMNS - 1 && noise(a.i + 7) > 0.62
          ? nodes[(row + 1) * COLUMNS + column + 1]
          : undefined;

      [right, down, diagonal].forEach((b, k) => {
        if (b === undefined) return;
        // A tenth of the links carry energy. Every link glowing is a screensaver.
        const hot = noise(a.i * 3 + k) > 0.9;
        links.push({ a, b, hot, cyan: hot && noise(a.i + k + 5) > 0.5 });
      });
    }
  }

  return { nodes, links };
}

/** Computed once for the module, not per render: the layout is a constant, so it is one. */
const FIELD = buildField();

export function DashboardAmbience() {
  return (
    <div className="uboss-dash-amb" aria-hidden="true">
      {/* Light: three slow orbs and a faint grid. Hidden in Dark by the stylesheet. */}
      <span className="uboss-amb-orb uboss-amb-orb--1" />
      <span className="uboss-amb-orb uboss-amb-orb--2" />
      <span className="uboss-amb-orb uboss-amb-orb--3" />

      {/* Dark: the constellation. Hidden in Light by the stylesheet. */}
      <div className="uboss-amb-neural">
        <svg
          className="uboss-nn"
          viewBox={`0 0 ${WIDTH} ${HEIGHT}`}
          preserveAspectRatio="xMidYMid slice"
          aria-hidden="true"
          focusable="false"
        >
          <g>
            {FIELD.links.map(({ a, b, hot, cyan }, index) => (
              <line
                key={`l${a.i}-${b.i}-${index}`}
                className={`uboss-nn-line${hot ? ' uboss-nn-line--hot' : ''}${cyan ? ' uboss-nn-line--cyan' : ''}`}
                x1={a.x.toFixed(1)}
                y1={a.y.toFixed(1)}
                x2={b.x.toFixed(1)}
                y2={b.y.toFixed(1)}
              />
            ))}
          </g>
          <g>
            {FIELD.nodes.map((node) => {
              // Under a third of the nodes breathe, and they start at staggered moments so the
              // field never beats in unison.
              const live = noise(node.i + 31) > 0.7;
              const violet = live && noise(node.i + 53) > 0.5;
              return (
                <circle
                  key={`n${node.i}`}
                  className={[
                    'uboss-nn-dot',
                    live ? 'uboss-nn-dot--live' : '',
                    live ? (violet ? 'uboss-nn-dot--violet' : 'uboss-nn-dot--cyan') : '',
                  ]
                    .filter(Boolean)
                    .join(' ')}
                  cx={node.x.toFixed(1)}
                  cy={node.y.toFixed(1)}
                  r={2}
                  style={{ ['--uboss-nn-delay' as string]: `${(noise(node.i + 17) * 5.5).toFixed(2)}s` }}
                />
              );
            })}
          </g>
        </svg>
      </div>

      {/*
        A quiet zone over the middle, so the field is thinnest exactly where the donut and its
        numbers sit. Atmosphere behind data has to get out of the way of the data.
      */}
      <div className="uboss-amb-veil" />

      {/*
        One slow ring behind the donut.

        The only motion on this screen that sits near the numbers, and the reason it is allowed to
        is that it carries none: it says "this workspace is live" without implying a count, a rate
        or a direction. A spinner would imply work in progress that may not exist; a ring that
        breathes every seven seconds implies only presence.

        Removed outright under `prefers-reduced-motion` rather than frozen — held still it is just
        a circle drawn round the donut, which reads as a boundary.
      */}
      <div className="uboss-amb-pulse" />
    </div>
  );
}
