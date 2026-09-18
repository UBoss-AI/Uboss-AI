import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import type { Response } from 'express';

import { EmployeePhotoController } from '../src/organization/employee-photo.controller.js';
import type { EmployeePhotoService } from '../src/organization/employee-photo.service.js';
import {
  createRequestContext,
  runWithRequestContext,
} from '../src/request-context/request-context.js';
import type { TenantContextService } from '../src/tenancy/tenant-context.service.js';

/*
 * How the photo route replies, which is a different question from what the service returns.
 *
 * The service was always right. The route returned the service's Buffer, and a Buffer is an
 * object, so Nest replied through `res.json` — the endpoint answered
 * `{"type":"Buffer","data":[137,80,78,71,...]}` with a `Content-Type: image/png` header on it. No
 * avatar in the product had ever rendered; Chrome refused the body as an opaque response
 * (ERR_BLOCKED_BY_ORB) and it looked like a permissions problem. A 518KB photo also arrived as
 * 1.9MB, because every byte travelled as decimal digits.
 *
 * The CR-03 suite could not have caught this: it calls the service directly, sixty tests of it,
 * and every one passed throughout. So this test goes at the layer that was broken — what the
 * handler does with the response object — and needs no database, no HTTP and no browser to do it.
 */

/** The first bytes of a real PNG, so "is this an image" is answerable. */
const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
const BYTES = Buffer.from([...PNG_SIGNATURE, 1, 2, 3, 4, 5]);

/** An express response that records what was done to it, and refuses what must not be. */
function recordingResponse(): {
  response: Response;
  headers: Record<string, string>;
  ended: () => unknown;
} {
  const headers: Record<string, string> = {};
  let ended: unknown;
  const response = {
    setHeader(name: string, value: string) {
      headers[name.toLowerCase()] = value;
      return this;
    },
    end(body?: unknown) {
      ended = body;
      return this;
    },
    // The two that produced the defect. A pass through either is the bug coming back.
    json() {
      throw new Error('json() serialises the buffer — the route must write bytes');
    },
    send() {
      throw new Error('send() must not be used for image bytes');
    },
  } as unknown as Response;
  return { response, headers, ended: () => ended };
}

function controllerReturning(bytes: Buffer, contentType: string): EmployeePhotoController {
  const photos = {
    content: async () => ({ bytes, contentType }),
  } as unknown as EmployeePhotoService;
  const tenantContext = {
    requireScope: () => ({ tenantId: '00000000-0000-0000-0000-000000000001' }),
  } as unknown as TenantContextService;
  return new EmployeePhotoController(photos, tenantContext);
}

const asMember = async <T>(work: () => Promise<T>): Promise<T> =>
  // A whole context rather than withActor(): that one replaces the actor on an existing context
  // and there is none outside a request, which is the point of it refusing to invent one.
  runWithRequestContext(
    createRequestContext('test', {
      kind: 'user',
      userId: '00000000-0000-0000-0000-0000000000aa',
    } as never),
    work,
  );

describe('the photo content route', () => {
  it('writes the image bytes to the response instead of returning them', async () => {
    const controller = controllerReturning(BYTES, 'image/png');
    const { response, ended } = recordingResponse();

    const returned = await asMember(() => controller.content('u', response));

    // Returning anything is what made Nest serialise it. The handler owns the response now.
    assert.equal(returned, undefined);

    const body = ended();
    assert.ok(Buffer.isBuffer(body), 'the response body is not a Buffer');
    assert.deepEqual(body, BYTES);
    // The bytes themselves, not a description of them.
    assert.deepEqual([...(body as Buffer).subarray(0, 8)], PNG_SIGNATURE);
  });

  it('sends exactly the stored content type, with nothing appended to it', async () => {
    const controller = controllerReturning(BYTES, 'image/png');
    const { response, headers } = recordingResponse();

    await asMember(() => controller.content('u', response));

    // `image/png; charset=utf-8` is what appeared while the body was JSON, and a charset on a
    // binary type is both meaningless and a hint that something is re-encoding the response.
    assert.equal(headers['content-type'], 'image/png');
  });

  it('lets the application embed it, and keeps the caching private', async () => {
    const controller = controllerReturning(BYTES, 'image/webp');
    const { response, headers } = recordingResponse();

    await asMember(() => controller.content('u', response));

    /*
     * helmet() sets `same-origin` across the API, and the web app is served from a different
     * origin, so every avatar was refused with ERR_BLOCKED_BY_RESPONSE.NotSameOrigin.
     * `same-site` admits the application and still refuses a third-party page.
     */
    assert.equal(headers['cross-origin-resource-policy'], 'same-site');
    assert.equal(headers['cache-control'], 'private, max-age=300');
    assert.equal(headers['content-type'], 'image/webp');
  });
});
