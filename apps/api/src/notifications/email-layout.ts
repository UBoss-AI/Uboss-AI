/**
 * The one HTML layout every email this product sends is built from.
 *
 * ## Why this exists
 *
 * `OutboundEmail` has carried an optional `html` since the transport was written, and the SMTP
 * adapter has always passed it through — and **nothing ever set it**. Every message the product
 * sent was plain text with a bare URL in the middle of a paragraph. Found by reading a real
 * inbox: an invitation that asks somebody to set their first password looked like a fragment of
 * a log file.
 *
 * ## Why it is written like 2004
 *
 * Tables, inline styles, no stylesheet, no flexbox, no custom font. This is not nostalgia and it
 * is not carelessness — it is the only thing that renders the same in Outlook, Gmail's web
 * client (which strips `<style>` blocks in some views), Apple Mail and every Android client. A
 * modern layout here degrades to an unreadable column in the one client the recipient happens to
 * use, and an invitation nobody can read is an invitation nobody accepts.
 *
 * ## The button, and the link under it
 *
 * The button is a table cell with a background colour, not a styled `<a>`: Outlook ignores
 * padding on inline elements, so the "button" becomes underlined blue text at the left margin.
 * The URL is **also** printed in full underneath. Corporate mail gateways rewrite or strip
 * anchors, images are blocked by default almost everywhere, and a person who cannot press the
 * button must still be able to copy the address. That duplication is deliberate.
 *
 * ## Dark mode
 *
 * `color-scheme` tells a client the message handles both, which stops iOS and Outlook inverting
 * the colours themselves and producing grey text on a slightly different grey. The palette is
 * chosen to read on either ground rather than switching, because a media query is the first
 * thing a mail client drops.
 *
 * ## No logo image
 *
 * A wordmark in text. Images are blocked by default in most clients, so a logo is a broken-image
 * icon at the top of the first email somebody ever receives from this product.
 */

/** The product's own colours, as literals: a mail client cannot read a CSS variable. */
const INK = '#171821';
const MUTED = '#5b5f6e';
const LINE = '#e5e7eb';
const ACCENT = '#6d28d9';
const PAGE = '#f4f5f8';

/**
 * What the product calls itself in a mailbox.
 *
 * Exported because two places say it and they must not disagree: the masthead this file draws,
 * and the sender name on a message sent on somebody's behalf — "Priya Nair (Aarohan Healthcare)
 * via Chief Agent". A reader who sees one name in the From line and another at the top of the
 * message has been given a reason to doubt the message.
 */
export const MAIL_PRODUCT_NAME = 'Chief Agent';

export interface EmailLayoutInput {
  /** The one line at the top, and the one thing the message is about. */
  heading: string;
  /** Sentences before the button. Each becomes its own paragraph. */
  paragraphs: string[];
  /** The action. Omitted for a message that asks for nothing. */
  action?: { label: string; url: string } | undefined;
  /** Small print under the rule — what to do if this was not you, and the like. */
  footnote?: string | undefined;
  /**
   * The grey line a client shows beside the subject in the inbox list.
   *
   * Without one, clients take the first words of the body, which for a message beginning with a
   * name reads as "Asha Verma, You have been invited to…" — the name twice before the point.
   */
  preheader: string;
}

/** Everything that would otherwise let a name or a company close a tag. */
function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

export function renderEmailHtml(input: EmailLayoutInput): string {
  const paragraphs = input.paragraphs
    .map(
      (text) =>
        `<p style="margin:0 0 16px;font-size:15px;line-height:24px;color:${INK};">` +
        `${escapeHtml(text)}</p>`,
    )
    .join('');

  /*
   * The bulletproof button, and the address spelled out below it.
   *
   * `mso-padding-alt` and the nested table are what give Outlook a real box; without them the
   * padding is dropped and the label sits flush against the colour.
   */
  const action =
    input.action === undefined
      ? ''
      : `<table role="presentation" cellpadding="0" cellspacing="0" border="0" style="margin:8px 0 20px;">
      <tr>
        <td align="center" bgcolor="${ACCENT}" style="border-radius:6px;mso-padding-alt:14px 28px;">
          <a href="${escapeHtml(input.action.url)}"
             style="display:inline-block;padding:14px 28px;font-size:15px;font-weight:600;
                    color:#ffffff;text-decoration:none;border-radius:6px;">
            ${escapeHtml(input.action.label)}
          </a>
        </td>
      </tr>
    </table>
    <p style="margin:0 0 4px;font-size:13px;line-height:20px;color:${MUTED};">
      If the button does not work, copy this address into your browser:
    </p>
    <p style="margin:0 0 20px;font-size:13px;line-height:20px;word-break:break-all;">
      <a href="${escapeHtml(input.action.url)}" style="color:${ACCENT};">${escapeHtml(
        input.action.url,
      )}</a>
    </p>`;

  const footnote =
    input.footnote === undefined
      ? ''
      : `<hr style="border:0;border-top:1px solid ${LINE};margin:24px 0 16px;" />
    <p style="margin:0;font-size:13px;line-height:20px;color:${MUTED};">${escapeHtml(
      input.footnote,
    )}</p>`;

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width,initial-scale=1" />
<meta name="color-scheme" content="light dark" />
<meta name="supported-color-schemes" content="light dark" />
<title>${escapeHtml(input.heading)}</title>
</head>
<body style="margin:0;padding:0;background:${PAGE};">
<div style="display:none;max-height:0;overflow:hidden;opacity:0;">${escapeHtml(
    input.preheader,
  )}</div>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0"
       style="background:${PAGE};padding:24px 12px;">
  <tr>
    <td align="center">
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0"
             style="max-width:560px;background:#ffffff;border:1px solid ${LINE};border-radius:10px;">
        <tr>
          <td style="padding:24px 28px 0;">
            <p style="margin:0;font-size:13px;font-weight:700;letter-spacing:0.08em;
                      text-transform:uppercase;color:${ACCENT};">${MAIL_PRODUCT_NAME}</p>
            <p style="margin:2px 0 0;font-size:12px;color:${MUTED};">powered by UBoss AI</p>
          </td>
        </tr>
        <tr>
          <td style="padding:20px 28px 28px;">
            <h1 style="margin:0 0 16px;font-size:20px;line-height:28px;color:${INK};">${escapeHtml(
              input.heading,
            )}</h1>
            ${paragraphs}
            ${action}
            ${footnote}
          </td>
        </tr>
      </table>
      <p style="margin:16px 0 0;font-size:12px;line-height:18px;color:${MUTED};">
        This message was sent by UBoss. Please do not reply to it.
      </p>
    </td>
  </tr>
</table>
</body>
</html>`;
}
