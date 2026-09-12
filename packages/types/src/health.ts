/**
 * Health contract shared by apps/api (producer) and apps/web (consumer).
 *
 * Scope note: this is still the only contract defined so far. Tenant, identity, membership,
 * Objective, Engine Agent and Executor Agent contracts arrive in their own prompts so that
 * each one lands together with its migration, validation and tests.
 */

/** Overall serviceability of the API process. */
export const HEALTH_STATUSES = ['ok', 'degraded', 'down'] as const;

export type HealthStatus = (typeof HEALTH_STATUSES)[number];

/** Reachability of one downstream dependency. */
export const DEPENDENCY_STATUSES = ['up', 'down'] as const;

export type DependencyStatus = (typeof DEPENDENCY_STATUSES)[number];

export interface DependencyHealth {
  /** Dependency name, e.g. `'postgres'`. */
  name: string;
  status: DependencyStatus;
  /** How long the probe took, in milliseconds. */
  latencyMs: number;
  /**
   * Why the probe failed, when it did. A connectivity message only — never a connection
   * string, credential or secret.
   */
  reason?: string;
}

/** Response body of `GET /health`. Deliberately free of tenant or actor data — this endpoint is unauthenticated. */
export interface HealthResponse {
  /** Aggregate status of the API process. */
  status: HealthStatus;
  /** Logical service name, so a reverse proxy hitting the wrong upstream is obvious. */
  service: 'uboss-api';
  /** Version of the running API build, sourced from its package.json. */
  version: string;
  /** Server clock as an ISO-8601 UTC timestamp. */
  timestamp: string;
  /** Whole seconds the process has been running. */
  uptimeSeconds: number;
  /**
   * Per-dependency probe results. Added at Prompt 3 alongside PostgreSQL; treated as optional
   * so a client built against the earlier contract keeps working.
   */
  dependencies?: DependencyHealth[];
}

function isDependencyHealth(value: unknown): value is DependencyHealth {
  if (typeof value !== 'object' || value === null) {
    return false;
  }
  const candidate = value as Partial<Record<keyof DependencyHealth, unknown>>;
  return (
    typeof candidate.name === 'string' &&
    typeof candidate.status === 'string' &&
    (DEPENDENCY_STATUSES as readonly string[]).includes(candidate.status) &&
    typeof candidate.latencyMs === 'number' &&
    (candidate.reason === undefined || typeof candidate.reason === 'string')
  );
}

/**
 * Runtime narrowing for an unknown value received over the wire.
 * The web app must never assume the API returned a well-formed body.
 */
export function isHealthResponse(value: unknown): value is HealthResponse {
  if (typeof value !== 'object' || value === null) {
    return false;
  }
  const candidate = value as Partial<Record<keyof HealthResponse, unknown>>;

  if (candidate.dependencies !== undefined) {
    if (!Array.isArray(candidate.dependencies)) {
      return false;
    }
    if (!candidate.dependencies.every(isDependencyHealth)) {
      return false;
    }
  }

  return (
    typeof candidate.status === 'string' &&
    (HEALTH_STATUSES as readonly string[]).includes(candidate.status) &&
    candidate.service === 'uboss-api' &&
    typeof candidate.version === 'string' &&
    typeof candidate.timestamp === 'string' &&
    typeof candidate.uptimeSeconds === 'number'
  );
}
