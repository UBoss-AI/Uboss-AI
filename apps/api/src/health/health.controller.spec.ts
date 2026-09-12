import assert from 'node:assert/strict';
import { beforeEach, describe, it } from 'node:test';

import { Test } from '@nestjs/testing';
import { isHealthResponse } from '@uboss/types';

import { PrismaService } from '../persistence/prisma.service.js';
import { HealthController } from './health.controller.js';
import { HealthService } from './health.service.js';

/**
 * Unit tests for the health endpoint.
 *
 * `PrismaService` is replaced with a stub so these stay unit tests: they must not need a running
 * database, and they must be able to exercise the failure path, which a real healthy database
 * cannot produce on demand. The real database is covered by the integration suite.
 */
function createStubPrisma(behaviour: 'up' | 'down' | 'hang'): PrismaService {
  const queryRaw = async (): Promise<unknown[]> => {
    if (behaviour === 'down') {
      throw new Error('connection refused');
    }
    if (behaviour === 'hang') {
      // Longer than the service's probe timeout, so the timeout path is exercised.
      await new Promise((resolve) => setTimeout(resolve, 5000).unref());
    }
    return [{ '1': 1 }];
  };

  return { client: { $queryRaw: queryRaw } } as unknown as PrismaService;
}

async function buildController(behaviour: 'up' | 'down' | 'hang'): Promise<HealthController> {
  const moduleRef = await Test.createTestingModule({
    controllers: [HealthController],
    providers: [HealthService, { provide: PrismaService, useValue: createStubPrisma(behaviour) }],
  }).compile();

  return moduleRef.get(HealthController);
}

describe('HealthController', () => {
  let controller: HealthController;

  beforeEach(async () => {
    controller = await buildController('up');
  });

  it('resolves through Nest dependency injection', () => {
    assert.ok(controller instanceof HealthController);
  });

  it('returns a body matching the shared HealthResponse contract', async () => {
    assert.equal(isHealthResponse(await controller.getHealth()), true);
  });

  it('reports ok for the uboss-api service when the database is reachable', async () => {
    const body = await controller.getHealth();
    assert.equal(body.status, 'ok');
    assert.equal(body.service, 'uboss-api');
  });

  it('reports the version from the api package.json rather than the fallback', async () => {
    assert.equal((await controller.getHealth()).version, '0.1.0');
  });

  it('returns an ISO-8601 timestamp and a non-negative integer uptime', async () => {
    const body = await controller.getHealth();
    assert.equal(body.timestamp, new Date(body.timestamp).toISOString());
    assert.ok(body.uptimeSeconds >= 0);
    assert.equal(Number.isInteger(body.uptimeSeconds), true);
  });

  it('reports the database dependency as up, with a latency reading', async () => {
    const body = await controller.getHealth();
    const database = body.dependencies?.find((dependency) => dependency.name === 'postgres');

    assert.ok(database);
    assert.equal(database.status, 'up');
    assert.ok(database.latencyMs >= 0);
  });

  it('degrades rather than claiming health when the database is unreachable', async () => {
    const degraded = await buildController('down');
    const body = await degraded.getHealth();

    assert.equal(body.status, 'degraded');
    const database = body.dependencies?.find((dependency) => dependency.name === 'postgres');
    assert.equal(database?.status, 'down');
    assert.match(database?.reason ?? '', /connection refused/);
  });

  it('times out a hung database probe instead of hanging the endpoint', async () => {
    const hung = await buildController('hang');

    const startedAt = Date.now();
    const body = await hung.getHealth();
    const elapsed = Date.now() - startedAt;

    assert.equal(body.status, 'degraded');
    // Must return on its own timeout, well before the 5s stub would resolve.
    assert.ok(elapsed < 4000, `health endpoint took ${elapsed}ms`);
  });

  it('does not leak tenant, actor or configuration detail', async () => {
    // The health endpoint is unauthenticated, so its response must stay to the known contract.
    assert.deepEqual(Object.keys(await controller.getHealth()).sort(), [
      'dependencies',
      'service',
      'status',
      'timestamp',
      'uptimeSeconds',
      'version',
    ]);
  });

  it('never includes a connection string or credential in a failure reason', async () => {
    const degraded = await buildController('down');
    const body = await degraded.getHealth();

    const serialised = JSON.stringify(body);
    assert.ok(!serialised.includes('postgresql://'));
    assert.ok(!serialised.toLowerCase().includes('password'));
  });
});
