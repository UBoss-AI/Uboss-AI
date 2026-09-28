'use client';

import type { ReportChart as ReportChartSpec } from '@uboss/types';

/**
 * A report's picture, drawn from the rows it already returned.
 *
 * ## Why bars, and why no chart library
 *
 * Every chart here answers one of three questions — how are these rows distributed, how big is
 * each of these totals, how long have these been waiting — and bars answer all three better than
 * anything else: readable at a glance, self-labelling, and incapable of implying a trend the data
 * does not contain. A line through a set of counts would do exactly that.
 *
 * No library, because a library would bring a canvas, a tooltip system and a theme of its own to
 * draw what is a list of divs with widths, and would then need keeping in step with the design
 * tokens for ever.
 *
 * ## Nothing here is invented
 *
 * `groupBy` counts rows. `series` reads a number the report itself totalled. `buckets` bins a
 * number the rows already carry. There is no interpolation, no projection, and no silent "other"
 * bucket — when the tail is too long to draw, the count of what is not drawn is stated, so a
 * reader knows the picture is partial rather than believing it is whole.
 */
export function ReportChart({
  spec,
  rows,
  summary,
  truncated,
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

  // Twelve is what fits before the labels collide; past that a chart stops being a glance.
  const shown = spec.kind === 'buckets' ? ordered : ordered.slice(0, 12);
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

  const currency = typeof summary['currency'] === 'string' ? summary['currency'] : null;
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
      <section className="uboss-report-chart" data-testid="report-chart">
        <h3 className="uboss-section-label" style={{ marginTop: 0 }}>
          {spec.title}
        </h3>
        <p className="uboss-muted-3" style={{ margin: 0 }}>
          {`Every figure here is ${show(0)} for the ${ordered.length} `}
          {ordered.length === 1 ? 'row' : 'rows'} in this period, so there is nothing to draw. The
          table below has the rest of what was recorded.
        </p>
      </section>
    );
  }

  return (
    <section className="uboss-report-chart" data-testid="report-chart">
      <h3 className="uboss-section-label" style={{ marginTop: 0 }}>
        {spec.title}
      </h3>

      <ul className="uboss-bars">
        {shown.map((bar) => (
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
              */}
              <span
                className="uboss-bar-fill"
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

      <p className="uboss-muted-3">
        {spec.note === undefined ? null : `${spec.note} `}
        {truncated
          ? `${show(total)} across the rows this report returned`
          : `${show(total)} in total`}
        {hidden > 0
          ? `, of which ${hidden} smaller ${hidden === 1 ? 'group is' : 'groups are'} not drawn`
          : ''}
        {truncated ? ', and the period holds more than the row limit allows' : ''}.
      </p>
    </section>
  );
}

/** The bars themselves, by whichever of the three readings this report declared. */
function barsFor(
  spec: ReportChartSpec,
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
