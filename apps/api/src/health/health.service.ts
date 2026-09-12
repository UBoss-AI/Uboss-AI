import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

import { Injectable, Logger } from '@nestjs/common';
import type { DependencyHealth, HealthResponse, HealthStatus } from '@uboss/types';

import { PrismaService } from '../persistence/prisma.service.js';

const PACKAGE_NAME = '@uboss/api';
const UNKNOWN_VERSION = '0.0.0-unknown';
const DATABASE_PROBE_TIMEOUT_MS = 2000;

/**
 * Builds the `GET /health` payload.
 *
 * Now that PostgreSQL is the system of record, the endpoint probes it, so `degraded` is
 * genuinely reachable. Redis and BullMQ (Prompt 21) will add their own entries to
 * `dependencies` without changing the existing fields.
 */
@Injectable()
export class HealthService {
  private readonly logger = new Logger(HealthService.name);
  private readonly version: string = HealthService.resolveVersion();

  constructor(private readonly prisma: PrismaService) {}

  async getHealth(): Promise<HealthResponse> {
    const database = await this.probeDatabase();

    // The API process is up, so it is never `down` from its own perspective; a failed
    // dependency degrades it. `down` is reserved for an external probe that cannot reach us.
    const status: HealthStatus = database.status === 'up' ? 'ok' : 'degraded';

    return {
      status,
      service: 'uboss-api',
      version: this.version,
      timestamp: new Date().toISOString(),
      uptimeSeconds: Math.floor(process.uptime()),
      dependencies: [database],
    };
  }

  /**
   * Cheapest possible liveness query, with a timeout so a hung database cannot make the health
   * endpoint hang too — that would take a load balancer's whole health check with it.
   */
  private async probeDatabase(): Promise<DependencyHealth> {
    const startedAt = Date.now();

    try {
      await Promise.race([
        this.prisma.client.$queryRaw`SELECT 1`,
        new Promise((_resolve, reject) => {
          setTimeout(
            () => reject(new Error(`probe exceeded ${DATABASE_PROBE_TIMEOUT_MS}ms`)),
            DATABASE_PROBE_TIMEOUT_MS,
          ).unref();
        }),
      ]);

      return { name: 'postgres', status: 'up', latencyMs: Date.now() - startedAt };
    } catch (error) {
      const reason = HealthService.describeProbeFailure(error);
      this.logger.warn(`Database health probe failed: ${reason}`);
      // The reason is a connectivity summary, never a connection string or credential.
      return { name: 'postgres', status: 'down', latencyMs: Date.now() - startedAt, reason };
    }
  }

  /**
   * Turn a driver error into a short, useful, safe one-line reason.
   *
   * Prisma's raw-query errors arrive as a multi-line block whose first lines are just
   * "Invalid `prisma.$queryRaw()` invocation:" followed by blank lines, which tells an operator
   * nothing. This pulls out the most informative line, prefers an error code when present, and
   * never includes the connection string or credentials.
   */
  private static describeProbeFailure(error: unknown): string {
    if (!(error instanceof Error)) {
      return 'unknown error';
    }

    const code = (error as { code?: unknown }).code;
    const codePrefix = typeof code === 'string' && code.length > 0 ? `${code}: ` : '';

    const informativeLine = error.message
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => line.length > 0 && !line.startsWith('Invalid `prisma.'))
      .at(-1);

    const detail = informativeLine ?? error.name;

    // Cap the length so a verbose driver error cannot bloat a health response.
    const summary = `${codePrefix}${detail}`.slice(0, 200);
    return summary.length > 0 ? summary : 'database unreachable';
  }

  /**
   * Read the running build's version from this app's own package.json.
   *
   * The compiled output lives at a different depth depending on how it was built
   * (`dist/health/` for production, `dist-test/src/health/` for tests), so rather than assuming
   * a fixed number of parent directories this walks up until it finds the package.json that
   * actually belongs to this app. A missing version must never take the health endpoint down,
   * so every failure path falls back to a sentinel.
   */
  private static resolveVersion(): string {
    let current = import.meta.dirname;

    for (let depth = 0; depth < 6; depth += 1) {
      try {
        const raw = readFileSync(join(current, 'package.json'), 'utf8');
        const parsed: unknown = JSON.parse(raw);
        if (typeof parsed === 'object' && parsed !== null) {
          const { name, version } = parsed as { name?: unknown; version?: unknown };
          if (name === PACKAGE_NAME && typeof version === 'string' && version.length > 0) {
            return version;
          }
        }
      } catch {
        // No readable package.json at this level; keep walking up.
      }

      const parent = dirname(current);
      if (parent === current) {
        break;
      }
      current = parent;
    }

    return UNKNOWN_VERSION;
  }
}
