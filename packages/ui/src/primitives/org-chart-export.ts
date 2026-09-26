/**
 * Turning the chart on screen into a file somebody can send.
 *
 * ## Why this is not five lines
 *
 * An `<svg>` in a document is not a self-contained picture. It inherits colour from CSS custom
 * properties that exist only on `:root`, it loads its avatars from another origin, and it draws its
 * text in a font the document fetched. Serialise it naively and you get a grey, faceless,
 * wrong-typeface chart — or, more often, a browser security error when the canvas is read back.
 *
 * So this does three things before rasterising, and each one is a failure that would otherwise be
 * silent:
 *
 *   1. **Resolves every colour.** `var(--uboss-border)` means nothing outside the document, so the
 *      computed value of every paint property is copied onto the clone. Without it the export is
 *      black-on-transparent.
 *   2. **Inlines the photographs.** They are served by the API on another origin. An image from
 *      another origin taints the canvas, and `toBlob` then throws a SecurityError — the export
 *      fails at the last step, after everything else has worked. Each photo is fetched and
 *      embedded; one that cannot be is removed, and the silhouette the chart already draws
 *      underneath shows through.
 *   3. **Embeds the typeface.** A rasteriser has no access to the document's fonts, so text falls
 *      back to whatever the platform supplies and the export does not match the screen. The font
 *      is read back out of the browser's own cache and embedded as a face the SVG carries with it.
 *
 * ## What it does when a step cannot be done
 *
 * It carries on and produces the chart anyway. A missing photo becomes a silhouette; an
 * unavailable font becomes the system sans-serif. Neither is worth refusing an export over — but
 * both are reported, so the caller can say so rather than letting somebody wonder why the file
 * looks different from the screen.
 */

/** Paint and type properties that must survive leaving the document. */
const CARRIED = [
  'fill',
  'fill-opacity',
  'stroke',
  'stroke-width',
  'stroke-opacity',
  'stroke-dasharray',
  'stroke-linecap',
  'stroke-linejoin',
  'opacity',
  'stop-color',
  'stop-opacity',
  'flood-color',
  'flood-opacity',
  'font-family',
  'font-size',
  'font-weight',
  'letter-spacing',
  'text-anchor',
] as const;

export interface ChartExportResult {
  /** True when every photograph on the chart made it into the file. */
  photosEmbedded: boolean;
  /** True when the chart's own typeface made it into the file. */
  fontEmbedded: boolean;
}

/**
 * Copy the computed value of every paint property from the live tree onto the clone.
 *
 * Walked in parallel rather than by selector: the two trees have identical shape because one is a
 * clone of the other, and `clipPath` ids make selectors ambiguous anyway.
 */
function resolvePaint(live: SVGSVGElement, clone: SVGSVGElement): void {
  const from = [live, ...Array.from(live.querySelectorAll('*'))];
  const to = [clone, ...Array.from(clone.querySelectorAll('*'))];

  for (let i = 0; i < from.length && i < to.length; i += 1) {
    const source = from[i];
    const target = to[i];
    if (source === undefined || target === undefined) continue;

    const computed = getComputedStyle(source);
    for (const property of CARRIED) {
      const value = computed.getPropertyValue(property);
      // `none` and the empty string are meaningful defaults already; writing them as attributes
      // would override a presentation attribute the element legitimately carries.
      if (value !== '' && value !== 'normal') target.setAttribute(property, value);
    }
  }
}

/** One photograph, as a data URI, or null when it cannot be had. */
async function inlineOne(url: string): Promise<string | null> {
  try {
    const response = await fetch(url, { credentials: 'include' });
    if (!response.ok) return null;
    const blob = await response.blob();
    return await new Promise<string | null>((resolve) => {
      const reader = new FileReader();
      reader.onload = () => resolve(typeof reader.result === 'string' ? reader.result : null);
      reader.onerror = () => resolve(null);
      reader.readAsDataURL(blob);
    });
  } catch {
    return null;
  }
}

/**
 * Replace every cross-origin image with an embedded copy, and drop the ones that cannot be.
 *
 * Dropping is safe here and only here: this chart always draws a silhouette underneath the
 * photograph, so removing the image reveals it rather than leaving a hole.
 */
async function inlinePhotos(clone: SVGSVGElement): Promise<boolean> {
  const images = Array.from(clone.querySelectorAll('image'));
  if (images.length === 0) return true;

  let complete = true;
  await Promise.all(
    images.map(async (image) => {
      const href = image.getAttribute('href') ?? image.getAttribute('xlink:href');
      if (href === null || href.startsWith('data:')) return;

      const inlined = await inlineOne(href);
      if (inlined === null) {
        complete = false;
        image.remove();
        return;
      }
      image.setAttribute('href', inlined);
      image.removeAttribute('xlink:href');
    }),
  );
  return complete;
}

/**
 * The chart's typeface, as `@font-face` rules the file carries with it.
 *
 * ## Why the stylesheet is fetched rather than read
 *
 * The product imports Inter from a font service, and a stylesheet from another origin refuses to
 * expose its rules to script — `cssRules` throws. So the rules cannot be read out of the document
 * at all, which is what the first two attempts at this did, finding nothing and falling back to
 * the platform font every time without saying why.
 *
 * What *is* readable is the `@import` rule's own address. That address is fetched, which the font
 * service does allow, and the `@font-face` blocks are parsed out of the text. Nothing is
 * hard-coded: change the import in the stylesheet and this follows it.
 *
 * ## Why only the Latin slice
 *
 * A web font is delivered as a dozen or more slices, one per script, so a page downloads only
 * what it renders. Embedding all of them would add megabytes to a PNG for glyphs a name does not
 * contain.
 *
 * ## Why a failure here is not a failure
 *
 * The font service may be unreachable, or the export may be running offline. Both end with the
 * text drawn in the platform's own sans-serif, which is legible and slightly different — so the
 * export still happens and the caller is told what changed.
 */
async function embedFont(clone: SVGSVGElement, family: string): Promise<boolean> {
  try {
    const sources = await fontSources(family);
    if (sources.length === 0) return false;

    const rules: string[] = [];
    for (const source of sources) {
      const response = await fetch(source.url).catch(() => null);
      if (response === null || !response.ok) continue;
      const data = await asDataUri(await response.blob());
      if (data === null) continue;
      rules.push(
        `@font-face{font-family:'${family}';font-style:normal;font-weight:${source.weight};` +
          `src:url(${data});}`,
      );
    }
    if (rules.length === 0) return false;

    const style = document.createElementNS('http://www.w3.org/2000/svg', 'style');
    style.textContent = rules.join('');
    clone.insertBefore(style, clone.firstChild);
    return true;
  } catch {
    return false;
  }
}

/** Every stylesheet this document imports by address, however deeply nested. */
function importedStylesheetUrls(): string[] {
  const urls: string[] = [];

  const walk = (sheet: CSSStyleSheet, depth: number): void => {
    if (depth > 4) return;
    let rules: CSSRuleList;
    try {
      rules = sheet.cssRules;
    } catch {
      return;
    }
    for (const rule of Array.from(rules)) {
      const imported = rule as CSSImportRule;
      if (typeof imported.href === 'string' && imported.href !== '') {
        urls.push(new URL(imported.href, sheet.href ?? window.location.href).toString());
      }
      if (imported.styleSheet != null) walk(imported.styleSheet, depth + 1);
    }
  };

  for (const sheet of Array.from(document.styleSheets)) walk(sheet, 0);
  return urls;
}

/** The font files this document uses for a family, at the weights the chart draws. */
async function fontSources(family: string): Promise<{ url: string; weight: string }[]> {
  const WEIGHTS = ['400', '500', '600', '700'];
  const found: { url: string; weight: string }[] = [];
  const seen = new Set<string>();

  for (const sheetUrl of importedStylesheetUrls()) {
    const response = await fetch(sheetUrl).catch(() => null);
    if (response === null || !response.ok) continue;
    const css = await response.text().catch(() => '');
    if (!css.includes(family)) continue;

    for (const block of css.split('@font-face')) {
      const declared = FAMILY.exec(block)?.[1]?.replace(QUOTES, '').trim();
      if (declared !== family) continue;

      const weight = WEIGHT.exec(block)?.[1]?.trim() ?? '400';
      if (!WEIGHTS.includes(weight) || seen.has(weight)) continue;

      /*
       * The slice covering Basic Latin, which is the one a name is drawn from. The service
       * writes this range as `U+0-00ff` or `U+0000-00FF` depending on the subset, so both are
       * accepted rather than matching one spelling.
       */
      const range = RANGE.exec(block)?.[1] ?? '';
      if (range !== '' && !/U\+0{1,4}-/i.test(range)) continue;

      const url = SOURCE.exec(block)?.[1];
      if (url === undefined) continue;

      seen.add(weight);
      found.push({ url: new URL(url, sheetUrl).toString(), weight });
    }
  }

  return found;
}

const FAMILY = /font-family:\s*([^;}]+)/i;
const WEIGHT = /font-weight:\s*([^;}]+)/i;
const RANGE = /unicode-range:\s*([^;}]+)/i;
const SOURCE = /url\(\s*["']?([^"')]+)["']?\s*\)/i;
const QUOTES = /["']/g;

function asDataUri(blob: Blob): Promise<string | null> {
  return new Promise((resolve) => {
    const reader = new FileReader();
    reader.onload = () => resolve(typeof reader.result === 'string' ? reader.result : null);
    reader.onerror = () => resolve(null);
    reader.readAsDataURL(blob);
  });
}

/**
 * Export the chart as a PNG and hand it to the browser as a download.
 *
 * Twice the drawn size, because the usual destination is a slide or a printed page and a chart
 * captured at screen resolution looks soft on both.
 */
export async function exportChartAsPng(
  svg: SVGSVGElement,
  options: { fileName: string; background: string; scale?: number },
): Promise<ChartExportResult> {
  const width = Number(svg.getAttribute('width'));
  const height = Number(svg.getAttribute('height'));
  if (!width || !height) throw new Error('The chart has no size to export.');

  const clone = svg.cloneNode(true) as SVGSVGElement;
  clone.setAttribute('xmlns', 'http://www.w3.org/2000/svg');
  clone.setAttribute('xmlns:xlink', 'http://www.w3.org/1999/xlink');

  resolvePaint(svg, clone);

  /*
   * An opaque background.
   *
   * An SVG has none, so a transparent PNG dropped onto a dark slide shows dark text on dark. The
   * colour is the surface the chart is actually sitting on, so the file matches the screen in
   * whichever theme it was exported from.
   */
  const backdrop = document.createElementNS('http://www.w3.org/2000/svg', 'rect');
  backdrop.setAttribute('x', '0');
  backdrop.setAttribute('y', '0');
  backdrop.setAttribute('width', String(width));
  backdrop.setAttribute('height', String(height));
  backdrop.setAttribute('fill', background(options.background));
  clone.insertBefore(backdrop, clone.firstChild);

  const photosEmbedded = await inlinePhotos(clone);
  const fontEmbedded = await embedFont(clone, 'Inter');

  const markup = new XMLSerializer().serializeToString(clone);
  /*
   * A blob URL rather than a `data:` URI.
   *
   * A real company's chart serialises to hundreds of kilobytes once the photographs are embedded,
   * and a `data:` URI that long is refused by the browser — the image simply never loads, with no
   * error to catch.
   */
  const svgUrl = URL.createObjectURL(new Blob([markup], { type: 'image/svg+xml;charset=utf-8' }));

  try {
    const image = await loadImage(svgUrl);
    const scale = options.scale ?? 2;
    const canvas = document.createElement('canvas');
    canvas.width = Math.round(width * scale);
    canvas.height = Math.round(height * scale);

    const context = canvas.getContext('2d');
    if (context === null) throw new Error('This browser cannot draw the chart to an image.');
    context.drawImage(image, 0, 0, canvas.width, canvas.height);

    const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, 'image/png'));
    if (blob === null) throw new Error('The chart could not be turned into an image.');

    download(blob, options.fileName);
    return { photosEmbedded, fontEmbedded };
  } finally {
    URL.revokeObjectURL(svgUrl);
  }
}

/** A colour that is definitely opaque: a transparent surface would export as a transparent PNG. */
function background(colour: string): string {
  const trimmed = colour.trim();
  if (trimmed === '' || trimmed === 'transparent' || trimmed.startsWith('rgba(0, 0, 0, 0)')) {
    return '#ffffff';
  }
  return trimmed;
}

function loadImage(url: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const image = new Image();
    image.onload = () => resolve(image);
    image.onerror = () => reject(new Error('The chart could not be rendered for export.'));
    image.src = url;
  });
}

function download(blob: Blob, fileName: string): void {
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = fileName;
  document.body.appendChild(link);
  link.click();
  link.remove();
  // Revoked on the next tick: revoking synchronously can cancel the download in some browsers.
  setTimeout(() => URL.revokeObjectURL(url), 0);
}
