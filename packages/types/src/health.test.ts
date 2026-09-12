import assert from 'node:assert/strict';
import { test } from 'node:test';

import { HEALTH_STATUSES, isHealthResponse } from './health.js';

const validResponse = {
  status: 'ok',
  service: 'uboss-api',
  version: '0.1.0',
  timestamp: '2026-09-08T10:00:00.000Z',
  uptimeSeconds: 12,
};

test('HEALTH_STATUSES exposes exactly the three supported states', () => {
  assert.deepEqual([...HEALTH_STATUSES], ['ok', 'degraded', 'down']);
});

test('isHealthResponse accepts a well-formed body', () => {
  assert.equal(isHealthResponse(validResponse), true);
});

test('isHealthResponse accepts every supported status', () => {
  for (const status of HEALTH_STATUSES) {
    assert.equal(isHealthResponse({ ...validResponse, status }), true, `status ${status}`);
  }
});

test('isHealthResponse rejects non-objects', () => {
  for (const value of [null, undefined, 'ok', 42, true, []]) {
    assert.equal(isHealthResponse(value), false, `value ${JSON.stringify(value) ?? 'undefined'}`);
  }
});

test('isHealthResponse rejects an unknown status', () => {
  assert.equal(isHealthResponse({ ...validResponse, status: 'exploded' }), false);
});

test('isHealthResponse rejects a response from a different service', () => {
  assert.equal(isHealthResponse({ ...validResponse, service: 'someone-elses-api' }), false);
});

test('isHealthResponse rejects a body with a missing or mistyped field', () => {
  const { version: _version, ...missingVersion } = validResponse;
  assert.equal(isHealthResponse(missingVersion), false);
  assert.equal(isHealthResponse({ ...validResponse, uptimeSeconds: '12' }), false);
});
