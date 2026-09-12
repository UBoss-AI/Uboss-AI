import { isHealthResponse } from '@uboss/types';

import { HealthView, type ApiProbe } from './health-view';

// Always probe at request time. Prerendering this page at build time would either bake in a
// stale result or fail the build whenever the API happens to be down.
export const dynamic = 'force-dynamic';

const WEB_VERSION = '0.1.0';
const DEFAULT_API_BASE_URL = 'http://localhost:4000';

async function probeApi(apiBaseUrl: string): Promise<ApiProbe> {
  try {
    const response = await fetch(`${apiBaseUrl}/health`, {
      cache: 'no-store',
      signal: AbortSignal.timeout(3000),
    });

    if (!response.ok) {
      return { kind: 'unreachable', reason: `HTTP ${response.status}` };
    }

    const body: unknown = await response.json();
    if (!isHealthResponse(body)) {
      return { kind: 'invalid', reason: 'unrecognised response shape' };
    }

    return { kind: 'reachable', health: body };
  } catch (error) {
    const reason = error instanceof Error ? error.message : 'unknown error';
    return { kind: 'unreachable', reason };
  }
}

export default async function HealthPage() {
  const apiBaseUrl = process.env['NEXT_PUBLIC_API_BASE_URL'] ?? DEFAULT_API_BASE_URL;
  const probe = await probeApi(apiBaseUrl);

  return <HealthView webVersion={WEB_VERSION} apiBaseUrl={apiBaseUrl} probe={probe} />;
}
