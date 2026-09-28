import assert from 'node:assert/strict';
import test from 'node:test';

import { retryJobId } from './bullmq-run-queue.js';

test('retry job IDs are BullMQ-safe and distinct for each attempt', () => {
  const runId = '018f4b34-4da8-7ccc-8ec1-2106c18eaf00';
  const firstRetry = retryJobId(runId, 1);
  const secondRetry = retryJobId(runId, 2);

  assert.equal(firstRetry.includes(':'), false);
  assert.notEqual(firstRetry, secondRetry);
  assert.equal(firstRetry.startsWith('retry-'), true);
});

test('retry job IDs reject invalid attempts and empty run IDs', () => {
  assert.throws(() => retryJobId('', 1), /requires a run id/);
  assert.throws(() => retryJobId('run-id', 0), /positive safe integer/);
  assert.throws(() => retryJobId('run-id', 1.5), /positive safe integer/);
});
