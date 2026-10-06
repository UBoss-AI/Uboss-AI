import DOMPurify from 'isomorphic-dompurify';

/**
 * Formatted text a company wrote, made safe to put back on a page.
 *
 * ## Why this exists at all
 *
 * The client asked for the Vision and Mission to be written with fonts, sizes, colours and lists.
 * That means storing markup, and markup written by one person and rendered in another person's
 * browser is the oldest hole there is: a company administrator could otherwise put a `<script>`,
 * or an `onerror` on a broken image, into a panel that **every employee of that company loads on
 * the first screen they see**. It would run with their session.
 *
 * ## Why a library rather than a regular expression
 *
 * Because hand-written HTML sanitisers are a genre of security bug. The attacks are not the ones
 * that look like attacks — `<img src=x onerror=…>`, `javascript:` behind an entity, `<svg>` with
 * a handler, a tag split across a comment, markup that only becomes markup after the browser has
 * repaired it. DOMPurify parses the document the way a browser does and keeps only what is on
 * the list, which is the difference between removing the attacks somebody thought of and
 * removing everything that is not permitted.
 *
 * ## Sanitised on the way in, and on the way out
 *
 * Here, before it is stored, so the database never holds anything dangerous — and again in the
 * browser before it is drawn, because a row could predate this function or arrive from a restore.
 * Neither side trusts the other, which costs nothing and removes a class of "but the other end
 * already checked" that has caused real incidents.
 */

/**
 * What a Vision or a Mission may contain.
 *
 * Formatting only. No links, no images, no tables: this is a statement of purpose on a dashboard
 * panel, and every tag that is not needed for that is a tag with its own attack surface. `span`
 * is here for colour, size and face, which is what the client asked for.
 */
const ALLOWED_TAGS = [
  'p',
  'br',
  'b',
  'strong',
  'i',
  'em',
  'u',
  's',
  'ul',
  'ol',
  'li',
  'span',
  'div',
  'h3',
  'h4',
  // Only ever pointing at this product's own file store -- see IMAGE_SRC.
  'img',
];

/**
 * `style` is the only attribute, and it is not a free one.
 *
 * DOMPurify removes the script in a style attribute, which is the part it is for. It does **not**
 * remove `position: fixed; top: 0; width: 100vw; height: 100vh` — there is nothing executable in
 * that, and it covers the entire page with whatever the company's administrator wants over it.
 * Nor does it object to `background-image: url(//somewhere)`, which fetches from a third party
 * and tells them who opened the screen.
 *
 * Written as a test first, which is how this was found: the case was in the spec, the spec
 * failed, and the list below is the answer. Five properties, because five is what the toolbar
 * produces and every sixth one is a question nobody has asked yet.
 */
const ALLOWED_ATTR = ['style', 'src', 'alt'];
const ALLOWED_CSS = new Set([
  'color',
  'background-color',
  'font-size',
  'font-family',
  'font-weight',
]);

/**
 * Keep the five properties and drop the rest, on the real node rather than on a string.
 *
 * In a hook because this needs the parsed document: picking style attributes out of HTML with a
 * regular expression is the same mistake as sanitising HTML with one. `addHook` is global to the
 * module's DOMPurify instance and registered once, here, at load.
 */
/**
 * The one place an image may come from: this product's own file store.
 *
 * Allowing `<img>` at all allows a request to be made from every reader's browser, so the
 * question is not whether the tag is safe but where it may point. An arbitrary `src` is a
 * tracking pixel on the first screen every employee of the company opens — it reports who looked
 * and when, to whoever owns that host — and `src="x"` with a handler is the oldest injection
 * there is.
 *
 * So: a relative path, served by this application, in the shape the uploader produces. Relative
 * because an absolute one bakes in whichever host it was written on and breaks when the same row
 * is read from another; `/api` because that is the path the web app proxies to the API in every
 * environment, development and production alike.
 */
const IMAGE_SRC = new RegExp(
  '^/api/tenants/[0-9a-fA-F-]{16,}/files/[0-9a-fA-F-]{16,}/content([?][\\w=&.%-]*)?$',
);

/** Only what this hook touches. The API has no DOM lib, and it does not need one for four calls. */
interface StyledNode {
  readonly tagName?: string;
  getAttribute(name: string): string | null;
  setAttribute(name: string, value: string): void;
  removeAttribute(name: string): void;
  remove(): void;
}

DOMPurify.addHook('afterSanitizeAttributes', (node) => {
  const element = node as unknown as StyledNode;
  if (typeof element.getAttribute !== 'function') return;

  /*
   * An image pointing anywhere else is removed whole, not stripped of its `src`.
   *
   * Taking the attribute off would leave an `<img>` with nothing to show, which draws the
   * browser's broken-image icon in the middle of a company's Mission. There is nothing to keep:
   * unlike a `<script>` wrapped around a sentence, an image carries no words.
   */
  if ((element.tagName ?? '').toLowerCase() === 'img') {
    const src = element.getAttribute('src');
    if (src === null || !IMAGE_SRC.test(src)) {
      element.remove();
      return;
    }
  }

  const style = element.getAttribute('style');
  if (style === null) return;

  const kept = style
    .split(';')
    .map((rule) => rule.trim())
    .filter((rule) => rule !== '')
    .filter((rule) => {
      const name = rule.slice(0, rule.indexOf(':')).trim().toLowerCase();
      const value = rule.slice(rule.indexOf(':') + 1).toLowerCase();
      // A permitted property whose value fetches something is still a value that fetches
      // something: `font-family: url(...)` is not a font.
      if (value.includes('url(') || value.includes('expression(')) return false;
      return ALLOWED_CSS.has(name);
    });

  if (kept.length === 0) {
    element.removeAttribute('style');
    return;
  }
  element.setAttribute('style', kept.join('; '));
});

/** The configuration, in one place so the write path and the test read the same thing. */
export const RICH_TEXT_POLICY = {
  ALLOWED_TAGS,
  ALLOWED_ATTR,
  ALLOW_DATA_ATTR: false,
  ALLOW_ARIA_ATTR: false,
  // Keep the text of anything removed. Stripping a `<script>` should not also delete the sentence
  // somebody wrote around it.
  KEEP_CONTENT: true,
  /*
   * No `USE_PROFILES`.
   *
   * It was here, and it quietly cancelled the list above: given a profile, DOMPurify uses that
   * profile's tags and ignores `ALLOWED_TAGS` entirely. The result allowed `<img>`, `<form>` and
   * `<a>` — the handlers came off them, which is what a profile is for, but the tags stayed.
   * `<img src=x onerror=…>` came back as `<img src="x">`, which is a request to somebody else's
   * server drawn on the first screen of every employee in the company.
   *
   * Found by the spec, not by reading: the two cases failed and the config was the reason.
   */
} as const;

/**
 * Strip everything that is not formatting, and return what is left.
 *
 * An empty or blank result comes back as `null`, which is how the product already says "not set":
 * markup that contains no words is not a Vision, and storing `<p></p>` would show an empty panel
 * instead of the "no Vision recorded yet" the strip is written to show.
 */
export function sanitiseRichText(value: string | undefined | null): string | null {
  if (value === undefined || value === null) return null;

  const cleaned = DOMPurify.sanitize(value, {
    ...RICH_TEXT_POLICY,
    ALLOWED_TAGS: [...ALLOWED_TAGS],
    ALLOWED_ATTR: [...ALLOWED_ATTR],
  });

  // `sanitize` with these options returns a string; the cast is only for the overloaded type.
  const html = String(cleaned);
  return plainTextOf(html).trim() === '' ? null : html;
}

/**
 * The words, without the markup.
 *
 * Used for the length limit, because the limit a person can perceive is a limit on what they
 * wrote — not on how many bytes their colour choices cost. A Vision of forty words is forty words
 * whether it is plain or set in three faces.
 */
export function plainTextOf(html: string): string {
  return html
    .replace(/<br\s*\/?>/gi, ' ')
    .replace(/<\/(p|div|li|h3|h4)>/gi, ' ')
    .replace(/<[^>]*>/g, '')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
    .replace(/\s+/g, ' ');
}
