import DOMPurify from 'dompurify';

/**
 * The same policy the API enforces, applied again in the browser.
 *
 * The server sanitises before it stores, so nothing dangerous should ever reach this. "Should"
 * is the word doing the work: a row written before the server knew how to sanitise, a restore
 * from an old backup, a future endpoint that forgets — each of those puts markup on the screen
 * that nobody filtered, and the screen it lands on is the first one every employee opens.
 *
 * Checking twice costs a parse and removes an entire class of "but the other end already did it".
 *
 * **The two lists must stay in step.** Their counterpart is `apps/api/src/organization/rich-text.ts`
 * and the test beside it. A tag allowed here but not there is a tag nothing can save; a tag
 * allowed there but not here is formatting that silently disappears when it is drawn.
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
 * The one place an image may come from, kept identical to the API's rule.
 *
 * An arbitrary `src` is a request made from every reader's browser: a tracking pixel on the
 * first screen every employee opens, reporting who looked and when to whoever owns that host.
 * Relative, because an absolute path bakes in the host it was written on; `/api`, because that is
 * what the web app proxies to the API in every environment.
 */
const IMAGE_SRC = new RegExp(
  '^/api/tenants/[0-9a-fA-F-]{16,}/files/[0-9a-fA-F-]{16,}/content([?][\\w=&.%-]*)?$',
);

const ALLOWED_CSS = new Set([
  'color',
  'background-color',
  'font-size',
  'font-family',
  'font-weight',
]);

/** Only what the hook touches. */
interface StyledNode {
  readonly tagName?: string;
  getAttribute(name: string): string | null;
  setAttribute(name: string, value: string): void;
  removeAttribute(name: string): void;
  remove(): void;
}

let hooked = false;

/**
 * Keep five style properties and drop everything else.
 *
 * DOMPurify removes the script in a style attribute, which is what it is for. It does not object
 * to `position: fixed; width: 100vw; height: 100vh`, which covers the page, or to
 * `background-image: url(//somewhere)`, which fetches from a third party and reports who opened
 * the screen. Neither contains anything executable; both are still somebody else's decision
 * about what a reader sees.
 */
function ensureHook(): void {
  if (hooked) return;
  hooked = true;
  DOMPurify.addHook('afterSanitizeAttributes', (node) => {
    const element = node as unknown as StyledNode;
    if (typeof element.getAttribute !== 'function') return;

    // Removed whole rather than stripped of its src: an image with nothing to show draws the
    // browser's broken-image icon in the middle of a company's Mission, and carries no words.
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
        if (value.includes('url(') || value.includes('expression(')) return false;
        return ALLOWED_CSS.has(name);
      });

    if (kept.length === 0) {
      element.removeAttribute('style');
      return;
    }
    element.setAttribute('style', kept.join('; '));
  });
}

/** Formatted text, with everything that is not formatting taken out. */
export function sanitiseRichText(html: string): string {
  ensureHook();
  return String(
    DOMPurify.sanitize(html, {
      ALLOWED_TAGS: [...ALLOWED_TAGS],
      ALLOWED_ATTR: ['style', 'src', 'alt'],
      ALLOW_DATA_ATTR: false,
      ALLOW_ARIA_ATTR: false,
      KEEP_CONTENT: true,
    }),
  );
}

/** Whether a value holds any words at all, once the tags are off. */
export function hasWords(html: string | null | undefined): boolean {
  if (html === undefined || html === null) return false;
  return (
    html
      .replace(/<[^>]*>/g, ' ')
      .replace(/&nbsp;/gi, ' ')
      .trim() !== ''
  );
}
