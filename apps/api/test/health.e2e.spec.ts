import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';

import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { isHealthResponse } from '@uboss/types';
import request from 'supertest';

import { HealthModule } from '../src/health/health.module.js';
import { PersistenceModule } from '../src/persistence/persistence.module.js';
import { PrismaService } from '../src/persistence/prisma.service.js';
import { TEST_DATABASE_URL } from './support/test-database.js';

/**
 * HTTP-level test of the health endpoint.
 *
 * Uses the real `PrismaService` against the test database, so this proves the endpoint reports
 * a genuinely reachable dependency rather than a stubbed one. The unit spec covers the failure
 * and timeout paths.
 */
describe('GET /health (e2e)', () => {
  let app: INestApplication;
  let prisma: PrismaService;

  before(async () => {
    prisma = new PrismaService(TEST_DATABASE_URL);

    // PersistenceModule is included so PrismaService is in the graph and can be overridden to
    // point at the test database instead of the development one.
    const moduleRef = await Test.createTestingModule({
      imports: [PersistenceModule, HealthModule],
    })
      .overrideProvider(PrismaService)
      .useValue(prisma)
      .compile();

    app = moduleRef.createNestApplication();
    await app.init();
  });

  after(async () => {
    await app.close();
    await prisma.unsafeRootClient.$disconnect();
  });

  it('responds 200 with a valid health contract', async () => {
    const response = await request(app.getHttpServer()).get('/health').expect(200);

    assert.equal(isHealthResponse(response.body), true);
    assert.equal(response.body.service, 'uboss-api');
    assert.equal(response.body.status, 'ok');
  });

  it('reports the database dependency as reachable', async () => {
    const response = await request(app.getHttpServer()).get('/health').expect(200);

    const database = response.body.dependencies?.find(
      (dependency: { name: string }) => dependency.name === 'postgres',
    );
    assert.ok(database, 'the health response must include the postgres dependency');
    assert.equal(database.status, 'up');
  });

  it('returns JSON', async () => {
    const response = await request(app.getHttpServer()).get('/health');

    assert.match(response.headers['content-type'] ?? '', /application\/json/);
  });

  it('returns 404 for an unknown route', async () => {
    await request(app.getHttpServer()).get('/not-a-route').expect(404);
  });
});
