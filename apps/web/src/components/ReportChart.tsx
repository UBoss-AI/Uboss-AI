'use client';

import { useId } from 'react';

import type { ReportChart as ReportChartSpec } from '@uboss/types';

/**
 * A report's picture, drawn from the rows it already returned.
 *
 * ## One shape per question, not one shape for everything
 *
 * Every report on this screen used to draw the same horizontal bars. Three were the better for it
 * and the rest were not: a cost-per-day chart came out sorted tallest-first, so the days ran out of
 * order and the one thing anybody opens a cost chart for — is it climbing — was unanswerable. Human
 * versus AI was two bars the reader had to divide themselves. Agent health was a single bar of
 * height one. The sameness was not a style; it was eight reports answering their question badly so
 * that one component could stay simple.
 *
 * So the kind is now chosen by the shape of the data:
 *
 *   * **donut** for parts of a whole — objectives by state, exceptions by severity.
 *   * **bars** for a ranking — people, actions, objectives. Sorted, because rank is the point.
 *   * **buckets** for a distribution across bands, kept in band order, empty bands included.
 *   * **line** for days, kept in the order the report returned them, because that order is an axis.
 *   * **share** for a proportion between a few parts — one bar cut up.
 *   * **tally** for an answer that is one number, which four of these reports have.
 *   * **status** for a handful of things that each have a state.
 *
 * ## Colour means something here, and only here
 *
 * The rest of the product is one violet family, and that is right for chrome. A reporting screen is
 * the one place where colour carries data, so the palette is six inks chosen for contrast and for
 * being distinguishable to a colour-blind reader — but a slice is never *only* a colour. Every part
 * carries its label, its count and its percentage as text, so the chart is quick to read for
 * somebody who can see the hues and still readable for somebody who cannot.
 *
 * A single series does not get six colours. Bars are one ink with a sweep across them, because
 * colouring nine people nine different colours implies nine different kinds of person.
 *
 * ## Still no chart library, and still nothing invented
 *
 * A library would bring a canvas, a tooltip system and a theme of its own to draw what is a list of
 * divs, one polyline and one ring, and would then need keeping in step with the design tokens for
 * ever.
 *
 * Every figure drawn here is a row the report returned, a count of those rows, or a number out of
 * the summary the report itself computed. There is no interpolation, no projection and no silent
 * "other" bucket — when a tail is too long to draw, the count of what is not drawn is stated, so a
 * reader knows the picture is partial rather than believing it is whole.
 */
export function ReportChart({
  spec,
  rows,
  summary,
  truncated,
  compact = false,
}: {
  spec: ReportChartSpec;
  rows: Record<string, string>[];
  summary: Record<string, unknown>;

  /**
   * Whether the report hit its row limit.
   *
   * It matters more here than for the table. A reader scrolling a cut-off table can see it end;
   * a chart looks whole whatever it was built from, and one built on the first slice of a larger
   * set would quietly misstate the shape of the company. So the bars stay — they are still counts
   * of real rows — and the sentence underneath stops calling them a total.
   */
  truncated: boolean;

  /**
   * Drawn inside an overview panel rather than above its own report.
   *
   * The panel already carries the question as its heading, so the chart drops its own title; and
   * it is a summary being offered rather than a report being read, so it draws fewer parts and
   * leaves the explanatory sentence to the report itself. Nothing about *what* is drawn changes —
   * a compact chart and the full one are counted from the same rows over the same period.
   */
  compact?: boolean;
}): React.JSX.Element | null {
  const currency = typeof summary['currency'] === 'string' ? summary['currency'] : null;

  if (spec.kind === 'tally') {
    return <Tally spec={spec} rows={rows} summary={summary} compact={compact} />;
  }
  if (spec.kind === 'status') {
    return <StatusStrip spec={spec} rows={rows} compact={compact} />;
  }
  if (spec.kind === 'donut') {
    return <Donut spec={spec} rows={rows} truncated={truncated} compact={compact} />;
  }
  if (spec.kind === 'line') {
    return (
      <Line spec={spec} rows={rows} currency={currency} truncated={truncated} compact={compact} />
    );
  }
  if (spec.kind === 'share') {
    return <Share spec={spec} rows={rows} compact={compact} />;
  }

  return (
    <Bars spec={spec} rows={rows} currency={currency} truncated={truncated} compact={compact} />
  );
}

/** The frame every kind sits in: one heading, the drawing, one sentence. */
function Frame({
  title,
  note,
  compact,
  children,
}: {
  title: string;
  note?: string | undefined;
  compact: boolean;
  children: React.ReactNode;
}): React.JSX.Element {
  return (
    <section
      className={compact ? 'uboss-report-chart is-compact' : 'uboss-report-chart'}
      data-testid="report-chart"
    >
      {compact ? null : (
        <h3 className="uboss-section-label" style={{ marginTop: 0 }}>
          {title}
        </h3>
      )}
      {children}
      {compact || note === undefined ? null : (
        <p className="uboss-muted-3" style={{ margin: 0 }}>
          {note}
        </p>
      )}
    </section>
  );
}

// ---------------------------------------------------------------------------
// Donut — parts of one whole
// ---------------------------------------------------------------------------

const RADIUS = 62;
const CIRCUMFERENCE = 2 * Math.PI * RADIUS;

/**
 * Parts of a whole, as a ring with the total in the middle.
 *
 * ## Why a ring rather than more bars
 *
 * "Where are the objectives" is a question about proportion — is most of this finished, or is most
 * of it not started. Bars answer which state has the most in it and leave the reader to add up the
 * rest themselves. The ring answers it at a glance and puts the total, which they would otherwise
 * be adding up, in the hole in the middle.
 *
 * ## Not the dashboard's donut
 *
 * That component is a locked two-slice contract for one screen and stays exactly as it is. This
 * one reads whatever states a report's rows carry, and lives only on Reports.
 *
 * ## The whole is real
 *
 * Every row falls in exactly one slice and the slices are every row, so the centre figure is the
 * row count and the percentages sum to a hundred. When the tail is too long to draw it is gathered
 * into a named "other" slice with its own count — never dropped, because a ring missing a slice is
 * a ring that lies about its own total.
 */
function Donut({
  spec,
  rows,
  truncated,
  compact,
}: {
  spec: Extract<ReportChartSpec, { kind: 'donut' }>;
  rows: Record<string, string>[];
  truncated: boolean;
  compact: boolean;
}): React.JSX.Element | null {
  const counted = groupRows(rows, spec.column).sort(
    (left, right) => right.value - left.value || left.label.localeCompare(right.label),
  );
  if (counted.length === 0) return null;

  const total = counted.reduce((sum, part) => sum + part.value, 0);
  if (total === 0) return null;

  /*
   * Six is the palette, so the sixth slice is everything that did not fit.
   *
   * A seventh ink would have to be borrowed from one already in use, and two slices of one colour
   * on a ring is worse than an honest "5 other states".
   */
  const limit = compact ? 4 : 5;
  const head = counted.slice(0, limit);
  const tail = counted.slice(limit);
  const parts =
    tail.length === 0
      ? head
      : [
          ...head,
          {
            label: `${tail.length} other ${tail.length === 1 ? 'state' : 'states'}`,
            value: tail.reduce((sum, part) => sum + part.value, 0),
          },
        ];

  let travelled = 0;
  const slices = parts.map((part, index) => {
    const length = (part.value / total) * CIRCUMFERENCE;
    const slice = {
      ...part,
      ink: index + 1,
      length,
      offset: -travelled,
      share: percent(part.value, total),
    };
    travelled += length;
    return slice;
  });

  return (
    <Frame title={spec.title} note={spec.note} compact={compact}>
      <div className={compact ? 'uboss-ring-wrap is-compact' : 'uboss-ring-wrap'}>
        <svg
          className="uboss-ring"
          viewBox="0 0 160 160"
          role="img"
          aria-label={`${spec.title}. ${total} in total: ${slices
            .map((slice) => `${slice.label} ${slice.value}, ${slice.share}`)
            .join('; ')}.`}
        >
          {/* The track, so a ring with one small slice still reads as a ring. */}
          <circle className="uboss-ring-track" cx="80" cy="80" r={RADIUS} />
          <g className="uboss-ring-arcs">
            {slices.map((slice) => (
              <circle
                key={slice.label}
                className={`uboss-ring-arc is-ink-${slice.ink}`}
                cx="80"
                cy="80"
                r={RADIUS}
                /*
                 * The true length from the first frame.
                 *
                 * The draw-on is a CSS animation of the *style*, which overrides this while it
                 * runs and lands exactly on it. An arc whose attribute started at zero would be a
                 * chart that told the truth only once it had finished moving — and anything
                 * reading it before then, a test or a screenshot or a browser with animation off,
                 * would read a lie.
                 */
                strokeDasharray={`${round(slice.length)} ${round(CIRCUMFERENCE - slice.length)}`}
                strokeDashoffset={round(slice.offset)}
              />
            ))}
          </g>
          <text className="uboss-ring-total" x="80" y="76">
            {total}
          </text>
          <text className="uboss-ring-caption" x="80" y="95">
            in total
          </text>
        </svg>

        <ul className="uboss-ring-legend">
          {slices.map((slice) => (
            <li key={slice.label}>
              <span className={`uboss-chart-swatch is-ink-${slice.ink}`} aria-hidden="true" />
              <span className="uboss-chart-name" title={slice.label}>
                {slice.label}
              </span>
              <span className="uboss-chart-figure">{slice.share}</span>
              <span className="uboss-muted-3">{slice.value}</span>
            </li>
          ))}
        </ul>
      </div>

      {truncated ? (
        <p className="uboss-muted-3" style={{ margin: 0 }}>
          Counted from the rows this report returned; the period holds more than the row limit
          allows.
        </p>
      ) : null}
    </Frame>
  );
}

// ---------------------------------------------------------------------------
// Bars — a ranking, and bands
// ---------------------------------------------------------------------------

function Bars({
  spec,
  rows,
  currency,
  truncated,
  compact,
}: {
  spec: Extract<ReportChartSpec, { kind: 'groupBy' | 'series' | 'buckets' }>;
  rows: Record<string, string>[];
  currency: string | null;
  truncated: boolean;
  compact: boolean;
}): React.JSX.Element | null {
  const bars = barsFor(spec, rows);
  if (bars.length === 0) return null;

  /*
   * Buckets keep the order they were defined in; everything else is sorted tallest first.
   *
   * An aging chart read shortest-to-longest is a shape — the pile-up on the right is the point.
   * Sorting it by height would destroy the only thing it has to say.
   */
  const ordered =
    spec.kind === 'buckets'
      ? bars
      : [...bars].sort(
          (left, right) => right.value - left.value || left.label.localeCompare(right.label),
        );

  /*
   * Twelve is what fits before the labels collide; past that a chart stops being a glance. A panel
   * shows five, because a panel answers "who is carrying the most" and the sixth name is not part
   * of that answer — it is in the report the panel opens.
   */
  const limit = compact ? 5 : 12;
  const shown = spec.kind === 'buckets' ? ordered : ordered.slice(0, limit);
  const hidden = ordered.length - shown.length;
  /*
   * Two numbers, because they answer different questions.
   *
   * `peak` is the real tallest bar and can be zero. `largest` is what widths divide by, so it
   * has a floor of one — which is also why the all-zero case below has to test `peak`: the
   * floor means `largest` is never zero, and the test written against it never fired.
   */
  const peak = Math.max(...shown.map((bar) => bar.value), 0);
  const largest = Math.max(peak, 1);
  const total = ordered.reduce((sum, bar) => sum + bar.value, 0);

  const money = spec.kind === 'series' && spec.format === 'money';
  const show = (value: number): string => (money ? asMoney(value, currency) : String(value));

  /*
   * Every figure is zero, so there is nothing to draw and a sentence is the better answer.
   *
   * This is a real state rather than an empty one: the AI cost report in a company running a
   * local model returns a row per day, each with real token counts and a charge of nothing. A
   * column of empty tracks looks like a chart that failed to load. A line saying so does not.
   *
   * Buckets are excluded on purpose — an aging chart of all zeros means nothing is waiting, and
   * seeing the empty bands is how a reader knows that.
   */
  if (peak === 0 && spec.kind !== 'buckets') {
    return (
      <Frame title={spec.title} compact={compact}>
        <p className="uboss-muted-3" style={{ margin: 0 }}>
          {`Every figure here is ${show(0)} for the ${ordered.length} `}
          {ordered.length === 1 ? 'row' : 'rows'} in this period, so there is nothing to draw.
        </p>
      </Frame>
    );
  }

  return (
    <Frame title={spec.title} compact={compact}>
      <ul className="uboss-bars">
        {shown.map((bar, index) => (
          <li key={bar.label}>
            <span className="uboss-bar-label" title={bar.label}>
              {bar.label}
            </span>
            <span className="uboss-bar-track">
              {/*
                Width against the largest bar, not against the total.

                Against the total, a set of similar values all render as thin stubs and the
                comparison the chart exists for disappears. A zero stays at zero — an empty band
                in an aging chart is a fact worth seeing.

                Bands get warmer as they get longer, and only bands do. On an aging chart the
                position *is* a severity — a week is worse than a day — so the colour carries the
                same fact the axis does. On a ranking it would carry nothing, so a ranking is one
                ink and the length does the talking.
              */}
              <span
                className={
                  spec.kind === 'buckets'
                    ? `uboss-bar-fill is-band-${Math.min(index + 1, 5)}`
                    : 'uboss-bar-fill'
                }
                style={{
                  width:
                    bar.value === 0
                      ? '0'
                      : `${Math.max(2, Math.round((bar.value / largest) * 100))}%`,
                }}
              />
            </span>
            <span className="uboss-bar-value">{show(bar.value)}</span>
          </li>
        ))}
      </ul>

      <p className="uboss-muted-3" style={{ margin: 0 }}>
        {compact || spec.note === undefined ? null : `${spec.note} `}
        {truncated
          ? `${show(total)} across the rows this report returned`
          : `${show(total)} in total`}
        {hidden > 0
          ? `, of which ${hidden} smaller ${hidden === 1 ? 'group is' : 'groups are'} not drawn`
          : ''}
        {truncated ? ', and the period holds more than the row limit allows' : ''}.
      </p>
    </Frame>
  );
}

// ---------------------------------------------------------------------------
// Line — days
// ---------------------------------------------------------------------------

/**
 * A total per day, drawn along the axis the rows already have.
 *
 * ## Why this one may be a line when the others may not
 *
 * A line between two points asserts that the space between them is real and ordered. Between
 * "Approved" and "Rejected" it is neither, which is why no other chart here is a line. Between the
 * 23rd and the 24th it is both — and a reader looking at spend wants exactly the thing a line
 * carries and bars do not: the direction.
 *
 * ## The curve is a curve, and says nothing extra
 *
 * The path is smoothed through the points with a fixed tension, which makes a fourteen-day line
 * readable instead of jagged. It never overshoots a point's own value: the control points are
 * clamped to the segment, so the curve cannot bulge above a peak and invent a higher day than the
 * report returned. Every point it passes through is a real total.
 *
 * ## Gaps are not filled
 *
 * A day on which nothing was spent is a day the report did not return, and the line joins the days
 * it did. It does not invent a zero, because "no AI work happened" and "AI work happened and cost
 * nothing" are different facts and the report knows which is which. The caption says how many days
 * carried spend, so a sparse line cannot be read as a dense one.
 */
function Line({
  spec,
  rows,
  currency,
  truncated,
  compact,
}: {
  spec: Extract<ReportChartSpec, { kind: 'line' }>;
  rows: Record<string, string>[];
  currency: string | null;
  truncated: boolean;
  compact: boolean;
}): React.JSX.Element | null {
  // Unique per instance: two charts on the overview would otherwise share one gradient id, and the
  // second would silently paint itself with the first one's stops.
  const gradientId = useId();

  const points = rows
    .map((row) => ({
      label: String(row[spec.labelColumn] ?? '').trim(),
      value: Number(row[spec.valueColumn]),
    }))
    .filter((point) => Number.isFinite(point.value));

  if (points.length === 0) return null;

  const money = spec.format === 'money';
  const show = (value: number): string => (money ? asMoney(value, currency) : String(value));

  const values = points.map((point) => point.value);
  const peak = Math.max(...values);
  const total = values.reduce((sum, value) => sum + value, 0);
  const first = points[0];
  const last = points[points.length - 1];
  if (first === undefined || last === undefined) return null;

  /*
   * One point is not a line, and drawing it as one would be a straight horizontal stroke implying
   * a period of unchanging spend that was never measured. A single day is stated as a single day.
   */
  if (points.length === 1) {
    return (
      <Frame title={spec.title} note={spec.note} compact={compact}>
        <p className="uboss-chart-single">
          <strong>{show(first.value)}</strong>
          <span className="uboss-muted-3">{` on ${first.label} — the only day in this period with anything to show.`}</span>
        </p>
      </Frame>
    );
  }

  /*
   * The box is wide because the chart scales to the card, and the card is wide.
   *
   * The SVG keeps its aspect ratio, so the viewBox is not a size — it is the shape the chart will
   * be at any width. At 600×180 a full-width card drew a chart 350 pixels tall, most of it empty
   * sky above a flat line. Days want a wide, shallow box; a panel is narrower, so its box is less
   * extreme or the chart would be a slot.
   */
  const width = compact ? 640 : 1100;
  const height = compact ? 150 : 200;
  const padX = 8;
  const padY = 14;
  // A floor of one keeps a period of all-zero days on the baseline rather than dividing by nought.
  const ceiling = Math.max(peak, 1);
  const stepX = (width - padX * 2) / (points.length - 1);
  const floor = height - padY;

  const plotted = points.map((point, index) => ({
    ...point,
    x: padX + index * stepX,
    y: floor - (point.value / ceiling) * (height - padY * 2),
  }));

  const path = smoothPath(plotted);
  const area = `${path} L ${round(width - padX)},${floor} L ${round(padX)},${floor} Z`;
  const highest = plotted.reduce((worst, point) => (point.value > worst.value ? point : worst));
  const end = plotted[plotted.length - 1];

  return (
    <Frame title={spec.title} note={spec.note} compact={compact}>
      <svg
        className="uboss-line"
        viewBox={`0 0 ${width} ${height}`}
        role="img"
        /*
         * The whole answer, in words.
         *
         * A path is nothing at all to a screen reader, and the figures under it are the summary
         * rather than the shape. This says what the shape is: how many days, what it started and
         * ended at, and where the worst day was.
         */
        aria-label={`${spec.title}. ${points.length} days, ${show(first.value)} on ${first.label} to ${show(last.value)} on ${last.label}. The highest was ${show(peak)} on ${highest.label}.`}
      >
        <defs>
          <linearGradient id={`${gradientId}-wash`} x1="0" y1="0" x2="0" y2="1">
            <stop className="uboss-line-wash-top" offset="0%" />
            <stop className="uboss-line-wash-bottom" offset="100%" />
          </linearGradient>
          <linearGradient id={`${gradientId}-ink`} x1="0" y1="0" x2="1" y2="0">
            <stop className="uboss-line-ink-start" offset="0%" />
            <stop className="uboss-line-ink-end" offset="100%" />
          </linearGradient>
        </defs>

        {/* Three faint rules, so a rise can be judged against something rather than felt. */}
        {[0.25, 0.5, 0.75].map((at) => (
          <line
            key={at}
            className="uboss-line-grid"
            x1={padX}
            x2={width - padX}
            y1={round(floor - at * (height - padY * 2))}
            y2={round(floor - at * (height - padY * 2))}
          />
        ))}

        <path className="uboss-line-area" d={area} fill={`url(#${gradientId}-wash)`} />
        <path className="uboss-line-path" d={path} stroke={`url(#${gradientId}-ink)`} />

        {/*
          Two points are marked and the rest are not.

          Marking every day turns a fortnight into a row of dots. The highest day is the one being
          looked for, and the last is where the eye goes for "and now?" — so those two get a
          handle and nothing else does.
        */}
        {highest !== end ? (
          <circle className="uboss-line-peak" cx={round(highest.x)} cy={round(highest.y)} r={3.5} />
        ) : null}
        <circle
          className="uboss-line-dot"
          cx={round(end?.x ?? 0)}
          cy={round(end?.y ?? 0)}
          r={4.5}
        />
      </svg>

      <p className="uboss-line-axis">
        <span>{first.label}</span>
        <span>{last.label}</span>
      </p>

      <p className="uboss-muted-3" style={{ margin: 0 }}>
        {`${show(total)} over ${points.length} days, highest ${show(peak)} on ${highest.label}`}
        {truncated ? ', and the period holds more than the row limit allows' : ''}.
      </p>
    </Frame>
  );
}

/**
 * A smooth path through every point, which never rises above one.
 *
 * Each segment's control points sit a third of the way along it horizontally and at the height of
 * the point they belong to — so the curve leaves and arrives flat, and is bounded by the two values
 * it joins. A cardinal spline would look marginally softer and would overshoot a peak, drawing a
 * day more expensive than any day that happened.
 */
function smoothPath(points: { x: number; y: number }[]): string {
  const start = points[0];
  if (start === undefined) return '';

  let path = `M ${round(start.x)},${round(start.y)}`;
  for (let index = 1; index < points.length; index += 1) {
    const from = points[index - 1];
    const to = points[index];
    if (from === undefined || to === undefined) continue;
    const reach = (to.x - from.x) / 3;
    path += ` C ${round(from.x + reach)},${round(from.y)} ${round(to.x - reach)},${round(to.y)} ${round(to.x)},${round(to.y)}`;
  }
  return path;
}

// ---------------------------------------------------------------------------
// Share — one bar, cut up
// ---------------------------------------------------------------------------

/**
 * One bar, cut into the parts that make it up.
 *
 * The percentages are a real division of the parts drawn, and the legend prints the count beside
 * each one so the reader is never left with a percentage of an unstated whole. A part of nought is
 * kept in the legend and drawn as nothing: "the agents finished none of it" is the answer somebody
 * came for, and dropping the row would leave them unable to tell it from a chart that failed.
 */
function Share({
  spec,
  rows,
  compact,
}: {
  spec: Extract<ReportChartSpec, { kind: 'share' }>;
  rows: Record<string, string>[];
  compact: boolean;
}): React.JSX.Element | null {
  const parts = rows
    .map((row) => {
      const raw = String(row[spec.labelColumn] ?? '').trim();
      return {
        label: raw === '' || raw === '—' ? 'Not set' : raw,
        value: Number(row[spec.valueColumn]),
      };
    })
    .filter((part) => Number.isFinite(part.value) && part.value >= 0);

  if (parts.length === 0) return null;

  const total = parts.reduce((sum, part) => sum + part.value, 0);

  if (total === 0) {
    return (
      <Frame title={spec.title} note={spec.note} compact={compact}>
        <p className="uboss-muted-3" style={{ margin: 0 }}>
          Nothing was finished in this period, so there is no split to show.
        </p>
      </Frame>
    );
  }

  return (
    <Frame title={spec.title} note={spec.note} compact={compact}>
      <div
        className="uboss-share"
        role="img"
        aria-label={parts
          .map((part) => `${part.label}: ${part.value}, ${percent(part.value, total)}`)
          .join('. ')}
      >
        {parts.map((part, index) => (
          <span
            key={part.label}
            className={`uboss-share-part is-ink-${Math.min(index + 1, 6)}`}
            style={{ width: `${(part.value / total) * 100}%` }}
          />
        ))}
      </div>

      <ul className="uboss-chart-legend">
        {parts.map((part, index) => (
          <li key={part.label}>
            <span
              className={`uboss-chart-swatch is-ink-${Math.min(index + 1, 6)}`}
              aria-hidden="true"
            />
            <span className="uboss-chart-name">{part.label}</span>
            <span className="uboss-chart-figure">{percent(part.value, total)}</span>
            <span className="uboss-muted-3">{part.value}</span>
          </li>
        ))}
      </ul>
    </Frame>
  );
}

// ---------------------------------------------------------------------------
// Tally — the answer is one number
// ---------------------------------------------------------------------------

/**
 * One number, at the size of the answer it is.
 *
 * Four of these reports return a handful of rows or a single one, and a bar chart of a single row
 * is a picture of the word "one" occupying a quarter of the screen. The count is the rows the
 * report returned; the second line is a figure out of the report's own summary. Neither is computed
 * here.
 */
function Tally({
  spec,
  rows,
  summary,
  compact,
}: {
  spec: Extract<ReportChartSpec, { kind: 'tally' }>;
  rows: Record<string, string>[];
  summary: Record<string, unknown>;
  compact: boolean;
}): React.JSX.Element {
  const count = rows.length;
  const detailValue =
    spec.detail === undefined ? undefined : formatDetail(summary[spec.detail.key]);

  /*
   * Coloured only when the report said what counts as a concern.
   *
   * A number the product has no opinion about must not be painted as though it had one — a colour
   * on a figure is a judgement, and an invented threshold is an invented judgement.
   */
  const concerning = spec.concernAt !== undefined && count >= spec.concernAt;

  return (
    <Frame title={spec.title} note={spec.note} compact={compact}>
      <p className={concerning ? 'uboss-tally is-concern' : 'uboss-tally'}>
        <span className="uboss-tally-figure">{count}</span>
        <span className="uboss-tally-unit">{count === 1 ? spec.unit : `${spec.unit}s`}</span>
      </p>

      {spec.detail === undefined || detailValue === undefined ? null : (
        <p className="uboss-tally-detail">
          <span className="uboss-muted-3">{`${spec.detail.label}: `}</span>
          {detailValue}
        </p>
      )}

      {count === 0 ? (
        <p className="uboss-muted-3" style={{ margin: 0 }}>
          Nothing in this period, which is the answer rather than an empty chart.
        </p>
      ) : null}
    </Frame>
  );
}

// ---------------------------------------------------------------------------
// Status — a handful of things, each with a state
// ---------------------------------------------------------------------------

/**
 * A chip per row, coloured by what the row says about itself.
 *
 * Three states and no score: anything with a failure is bad, anything that never ran is unproven,
 * everything else is well. "Unproven" is deliberately not "well" — an agent nobody has used is the
 * finding half this report exists for, and a green chip would hide it.
 */
function StatusStrip({
  spec,
  rows,
  compact,
}: {
  spec: Extract<ReportChartSpec, { kind: 'status' }>;
  rows: Record<string, string>[];
  compact: boolean;
}): React.JSX.Element | null {
  if (rows.length === 0) return null;

  const limit = compact ? 4 : 16;
  const chips = rows.slice(0, limit).map((row) => {
    const runs = Number(row[spec.totalColumn]);
    const failed = Number(row[spec.failedColumn]);
    const total = Number.isFinite(runs) ? runs : 0;
    const bad = Number.isFinite(failed) ? failed : 0;
    return {
      label: String(row[spec.labelColumn] ?? '—'),
      tone: bad > 0 ? 'is-bad' : total === 0 ? 'is-unproven' : 'is-well',
      said:
        bad > 0
          ? `${bad} of ${total} failed`
          : total === 0
            ? `no ${spec.unit}s yet`
            : `${total} ${total === 1 ? spec.unit : `${spec.unit}s`}, all well`,
    };
  });
  const hidden = rows.length - chips.length;

  return (
    <Frame title={spec.title} note={spec.note} compact={compact}>
      <ul className="uboss-statuses">
        {chips.map((chip) => (
          <li key={chip.label} className={`uboss-status-chip ${chip.tone}`}>
            <span className="uboss-status-dot" aria-hidden="true" />
            <span className="uboss-status-name" title={chip.label}>
              {chip.label}
            </span>
            <span className="uboss-status-said">{chip.said}</span>
          </li>
        ))}
      </ul>

      {hidden > 0 ? (
        <p className="uboss-muted-3" style={{ margin: 0 }}>
          {`and ${hidden} more in the full report`}
        </p>
      ) : null}
    </Frame>
  );
}

// ---------------------------------------------------------------------------
// The readings
// ---------------------------------------------------------------------------

/** The bars themselves, by whichever of the three bar readings this report declared. */
function barsFor(
  spec: Extract<ReportChartSpec, { kind: 'groupBy' | 'series' | 'buckets' }>,
  rows: Record<string, string>[],
): { label: string; value: number }[] {
  if (spec.kind === 'groupBy') return groupRows(rows, spec.column);
  if (spec.kind === 'series') return seriesRows(rows, spec.labelColumn, spec.valueColumn);
  return bucketRows(rows, spec.column, spec.edges, spec.unit);
}

/**
 * Count the rows that share a value.
 *
 * Blank and em-dash cells are their own group rather than being dropped: "not yet decided" is a
 * real state and often the biggest one, and a chart that quietly omitted it would show a company
 * doing better than it is.
 */
function groupRows(
  rows: Record<string, string>[],
  column: string,
): { label: string; value: number }[] {
  const counts = new Map<string, number>();
  for (const row of rows) {
    const raw = String(row[column] ?? '').trim();
    const label = raw === '' || raw === '—' ? 'Not set' : raw;
    counts.set(label, (counts.get(label) ?? 0) + 1);
  }
  return [...counts.entries()].map(([label, value]) => ({ label, value }));
}

/**
 * One bar per row, reading a number the report already totalled.
 *
 * A row whose value is not a number is left out rather than counted as zero — a missing figure
 * and a figure of nought are different answers, and only one of them belongs in a chart.
 */
function seriesRows(
  rows: Record<string, string>[],
  labelColumn: string,
  valueColumn: string,
): { label: string; value: number }[] {
  return rows
    .map((row) => {
      const raw = String(row[labelColumn] ?? '').trim();
      return {
        label: raw === '' || raw === '—' ? 'Not set' : raw,
        value: Number(row[valueColumn]),
      };
    })
    .filter((bar) => Number.isFinite(bar.value));
}

/**
 * Bin a number the rows carry — how many waited a day, three days, a week.
 *
 * Empty bands are kept. "Nothing has waited more than a fortnight" is the answer somebody opened
 * an approvals report hoping for, and dropping the band would leave them unable to tell that from
 * a chart that simply does not draw it.
 */
function bucketRows(
  rows: Record<string, string>[],
  column: string,
  edges: number[],
  unit: string,
): { label: string; value: number }[] {
  const bands = [...edges].sort((left, right) => left - right);
  const first = bands[0];
  if (first === undefined) return [];

  const counts: number[] = bands.map(() => 0).concat(0);
  let counted = 0;
  for (const row of rows) {
    const value = Number(row[column]);
    if (!Number.isFinite(value)) continue;
    counted += 1;
    let index = 0;
    while (index < bands.length && value >= (bands[index] ?? 0)) index += 1;
    counts[index] = (counts[index] ?? 0) + 1;
  }
  if (counted === 0) return [];

  const plural = (n: number): string => (n === 1 ? unit : `${unit}s`);
  return counts.map((value, index) => {
    const lower = bands[index - 1];
    const upper = bands[index];
    if (index === 0) return { label: `under ${first} ${plural(first)}`, value };
    if (upper === undefined || lower === undefined) {
      return { label: `${lower ?? 0} ${plural(lower ?? 0)} or more`, value };
    }
    return { label: `${lower}–${upper} ${plural(2)}`, value };
  });
}

/** Minor units as money, with the company's currency when the report knew it. */
function asMoney(minor: number, currency: string | null): string {
  const amount = (minor / 100).toFixed(2);
  return currency === null ? amount : `${currency} ${amount}`;
}

/** A whole percentage, never a fraction of one — the precision would be false. */
function percent(value: number, total: number): string {
  return `${Math.round((value / total) * 100)}%`;
}

/** Two decimal places at most, so a coordinate does not carry seventeen digits into the markup. */
function round(value: number): number {
  return Math.round(value * 100) / 100;
}

/**
 * A summary figure as a line of text.
 *
 * Timestamps arrive as ISO strings and a tally is a glance, so the date is shown and the time is
 * not. Anything that is not a timestamp is printed as it came — the summary is the report's own
 * words, and reformatting a figure whose meaning is unknown here is how a number changes.
 */
function formatDetail(value: unknown): string | undefined {
  if (value === undefined || value === null || value === '' || value === '—') return undefined;
  const text = String(value);
  const asDate = /^\d{4}-\d{2}-\d{2}T/.exec(text);
  if (asDate === null) return text;
  return new Date(text).toLocaleDateString(undefined, {
    day: 'numeric',
    month: 'short',
    year: 'numeric',
  });
}
