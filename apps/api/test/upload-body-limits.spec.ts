import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, it } from 'node:test';

/**
 * Every route that receives a file gets a body limit big enough to receive one.
 *
 * ## The failure this exists to catch
 *
 * The product sends uploads as base64 inside a JSON body, and `main.ts` keeps the global JSON
 * limit at 1 MB so that no unauthenticated route will buffer a third of a gigabyte. The larger
 * limit was applied by matching one path — `/tenants/:id/files` — because that was the only
 * upload when the rule was written.
 *
 * Four more arrived later and none of them matched. Each was capped at 1 MB of JSON, which is
 * about **750 KB of actual file** once base64's third is taken off, and the refusal came from the
 * body parser before any handler ran — so the product could not even say the file was too large.
 * The employee photo route was the clearest case: its own policy allows 2 MB, and every photo
 * between 750 KB and that ceiling was rejected before the policy could permit it. It surfaced as
 * "upload does not work".
 *
 * ## Why this reads `main.ts`
 *
 * The claim is about a routing table in one file — which paths are handed which parser — and
 * that is a fact about the source, not about a running server. A request-level test would need
 * the whole application and a file big enough to exceed a megabyte, and would still only cover
 * the one route it happened to send.
 *
 * So this asserts the far narrower thing that actually went wrong: **a controller that accepts
 * base64 has a matching entry in the limits table.** Add a fifth upload without one and this
 * fails, naming it.
 */
describe('upload routes are not capped at the ordinary body limit', () => {
  const API = path.join(process.cwd(), 'src');
  const MAIN = readFileSync(path.join(API, 'main.ts'), 'utf8');

  /**
   * Each upload route the product serves, and a path it must match.
   *
   * Written out rather than derived from the controllers: the point of the table in `main.ts` is
   * that it is a deliberate list, and a test that derived the same list from the same source
   * would agree with itself however wrong both were.
   */
  const UPLOADS: readonly { what: string; path: string; atLeastMb: number }[] = [
    { what: 'a knowledge document', path: '/tenants/t1/files', atLeastMb: 300 },
    {
      what: "an objective's workbook",
      path: '/tenants/t1/objectives/o1/workbook/parse',
      atLeastMb: 20,
    },
    {
      // The same file, uploaded before the objective exists. A separate route, so a separate
      // entry: the id-bearing pattern above does not match a path with no id in it, and the
      // consequence of missing it is the one this whole file is about.
      what: 'a workbook uploaded onto a new objective',
      path: '/tenants/t1/objectives/workbook/parse',
      atLeastMb: 20,
    },
    { what: 'the bulk people workbook', path: '/tenants/t1/access/bulk/validate', atLeastMb: 20 },
    {
      what: 'the hierarchy workbook',
      path: '/tenants/t1/access/bulk/hierarchy/validate',
      atLeastMb: 20,
    },
    {
      what: "an agent's job method",
      path: '/tenants/t1/job-methods/a1/import-workbook',
      atLeastMb: 20,
    },
    { what: 'an employee photo', path: '/tenants/t1/photos/u1', atLeastMb: 3 },
    {
      what: 'a picture for the company Vision or Mission',
      path: '/tenants/t1/organization/company-images',
      atLeastMb: 3,
    },
  ];

  /** The patterns `main.ts` declares, read back out of it with their limits. */
  const limitsFor = (): { pattern: RegExp; mb: number }[] => {
    const number = (name: string): number => {
      const found = MAIN.match(new RegExp(`const ${name} = json\\(\\{ limit: '(\\d+)mb' \\}\\)`));
      assert.ok(found, `${name} is no longer declared the way this test reads it`);
      return Number(found[1]);
    };

    const uploadMb = number('uploadJson');
    const workbookMb = number('workbookJson');

    const out: { pattern: RegExp; mb: number }[] = [];
    const single = MAIN.match(/const UPLOAD_PATHS = (\/.+\/);/);
    assert.ok(single, 'UPLOAD_PATHS is no longer a single regular expression');
    out.push({ pattern: new RegExp(single[1]!.slice(1, -1)), mb: uploadMb });

    const block = MAIN.match(/const WORKBOOK_PATHS = \[([\s\S]*?)\];/);
    assert.ok(block, 'WORKBOOK_PATHS is no longer an array of regular expressions');
    for (const line of block[1]!.split('\n')) {
      const found = line.match(/^\s*(\/.+\/),\s*$/);
      if (found) out.push({ pattern: new RegExp(found[1]!.slice(1, -1)), mb: workbookMb });
    }
    return out;
  };

  it('reads the limits table it claims to be checking', () => {
    const limits = limitsFor();
    assert.ok(limits.length >= 5, `only ${limits.length} patterns found in main.ts`);
  });

  for (const upload of UPLOADS) {
    it(`gives ${upload.what} room for a real file`, () => {
      const matched = limitsFor().filter((entry) => entry.pattern.test(upload.path));

      assert.ok(
        matched.length > 0,
        `${upload.path} matches no entry in main.ts, so it is capped at the ordinary 1 MB — ` +
          'about 750 KB of file once base64 is accounted for, refused by the body parser before ' +
          'any handler can explain why.',
      );

      const best = Math.max(...matched.map((entry) => entry.mb));
      assert.ok(
        best >= upload.atLeastMb,
        `${upload.path} is limited to ${best} MB, below the ${upload.atLeastMb} MB this route needs.`,
      );
    });
  }

  it('leaves everything else on the ordinary limit', () => {
    // The whole point of the table is that it is narrow. A pattern loose enough to catch every
    // upload by accident would also hand a large body to routes nobody meant.
    const ordinary = ['/auth/sign-in', '/tenants/t1/objectives', '/tenants/t1/chat/conversations'];
    for (const route of ordinary) {
      const matched = limitsFor().filter((entry) => entry.pattern.test(route));
      assert.deepEqual(matched, [], `${route} is being handed a large body limit`);
    }
  });
});
