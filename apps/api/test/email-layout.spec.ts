import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { renderEmailHtml } from '../src/notifications/email-layout.js';

/**
 * The HTML every email is built from.
 *
 * Each assertion here is a rendering failure somebody would only ever see in a mail client, and
 * none of them would fail a typecheck, a lint or a screenshot. They are cheap to keep and the
 * alternative is finding out from a recipient.
 */
describe('the email layout', () => {
  const rendered = renderEmailHtml({
    preheader: 'Set a password and activate your account.',
    heading: 'You have been invited to Acme & Co',
    paragraphs: ['Asha Verma, an administrator has invited you.'],
    action: { label: 'Set your password', url: 'https://app.example.com/activate?token=abc123' },
    footnote: 'The link can be used once, and it expires.',
  });

  it('carries the action as a real button and the address as copyable text', () => {
    /*
     * Twice, deliberately.
     *
     * Corporate mail gateways rewrite or strip anchors, and a person reading in a client that
     * refuses HTML has only the text. Somebody who cannot press the button must still be able
     * to copy the address, so the URL appears in the button and again underneath it.
     */
    const occurrences = rendered.split('https://app.example.com/activate?token=abc123').length - 1;
    assert.ok(
      occurrences >= 2,
      `the URL should appear as a button and as text, saw ${occurrences}`,
    );
    assert.match(rendered, /Set your password/);
  });

  it('builds the button as a table cell, because Outlook drops padding on an anchor', () => {
    // Without `mso-padding-alt` and the surrounding table the button renders in Outlook as
    // underlined blue text at the left margin — not a button at all.
    assert.match(rendered, /mso-padding-alt/);
    assert.match(rendered, /role="presentation"/);
  });

  it('declares both colour schemes rather than letting a client invert it', () => {
    // iOS Mail and Outlook invert a message that does not say it handles dark mode, and the
    // result is grey text on a slightly different grey.
    assert.match(rendered, /name="color-scheme" content="light dark"/);
    assert.match(rendered, /name="supported-color-schemes"/);
  });

  it('gives the inbox list a preheader instead of the first words of the body', () => {
    assert.match(rendered, /Set a password and activate your account\./);
    assert.match(rendered, /max-height:0/);
  });

  it('loads nothing from anywhere', () => {
    /*
     * No image and no stylesheet.
     *
     * Images are blocked by default in most clients, so a logo is a broken-image icon at the top
     * of the first message somebody ever receives from this product; and Gmail strips `<style>`
     * in several views, which is why every rule here is inline.
     */
    assert.doesNotMatch(rendered, /<img/i);
    assert.doesNotMatch(rendered, /<link/i);
    assert.doesNotMatch(rendered, /<style/i);
  });

  it('escapes a name or a company that contains markup', () => {
    const hostile = renderEmailHtml({
      preheader: 'x',
      heading: 'Welcome to <script>alert(1)</script> & Sons',
      paragraphs: ['Hello "friend" <b>'],
      action: { label: 'Open', url: 'https://example.com/?a=1&b=2' },
    });

    assert.doesNotMatch(hostile, /<script>/);
    assert.match(hostile, /&lt;script&gt;/);
    assert.match(hostile, /&amp; Sons/);
    // The ampersand in a real query string survives as an entity rather than breaking the href.
    assert.match(hostile, /a=1&amp;b=2/);
  });

  it('leaves out the button and the footnote when there is nothing to press or add', () => {
    const plain = renderEmailHtml({
      preheader: 'x',
      heading: 'Nothing to do',
      paragraphs: ['This one is information.'],
    });

    assert.doesNotMatch(plain, /mso-padding-alt/);
    assert.doesNotMatch(plain, /If the button does not work/);
    assert.doesNotMatch(plain, /<hr/);
  });
});
