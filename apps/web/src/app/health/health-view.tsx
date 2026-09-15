import type { HealthResponse } from '@uboss/types';
import { cn } from '@uboss/ui';

/**
 * Outcome of asking apps/api for its health.
 *
 * Modelled as a discriminated union so every state the verification page can be in is explicit
 * rather than inferred from null checks — the same approach later screens use for their
 * loading / empty / error / permission-denied / success states (working rule F).
 */
export type ApiProbe =
  | { kind: 'loading' }
  | { kind: 'reachable'; health: HealthResponse }
  | { kind: 'unreachable'; reason: string }
  | { kind: 'invalid'; reason: string };

export interface HealthViewProps {
  webVersion: string;
  apiBaseUrl: string;
  probe: ApiProbe;
}

/** Status colours are paired with text, never colour-only (locked UI rule). */
const TONE = {
  ok: { fg: 'var(--uboss-success)', bg: 'var(--uboss-success-050)', label: 'Healthy' },
  warn: { fg: 'var(--uboss-warning)', bg: 'var(--uboss-warning-050)', label: 'Degraded' },
  bad: { fg: 'var(--uboss-danger)', bg: 'var(--uboss-danger-050)', label: 'Unreachable' },
  idle: { fg: 'var(--uboss-text-2)', bg: 'var(--uboss-bg-2)', label: 'Checking' },
} as const;

function toneFor(probe: ApiProbe): (typeof TONE)[keyof typeof TONE] {
  switch (probe.kind) {
    case 'reachable':
      return probe.health.status === 'ok' ? TONE.ok : TONE.warn;
    case 'unreachable':
      return TONE.bad;
    case 'invalid':
      return TONE.warn;
    case 'loading':
      return TONE.idle;
  }
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <div
      style={{
        display: 'flex',
        justifyContent: 'space-between',
        gap: 16,
        padding: '8px 0',
        borderBottom: '1px solid var(--uboss-border-2)',
      }}
    >
      <span style={{ color: 'var(--uboss-text-2)' }}>{label}</span>
      <span style={{ fontVariantNumeric: 'tabular-nums', fontWeight: 600 }}>{value}</span>
    </div>
  );
}

/**
 * Minimal verification surface for the bootstrap step. It is not a product screen and will not
 * appear in the shipped navigation; Prompt 2 replaces this styling with the design system.
 */
export function HealthView({ webVersion, apiBaseUrl, probe }: HealthViewProps) {
  const tone = toneFor(probe);

  return (
    <main
      className={cn('uboss-health')}
      style={{ maxWidth: 560, margin: '48px auto', padding: 24 }}
    >
      <h1 style={{ fontSize: 20, fontWeight: 800, letterSpacing: '-0.2px' }}>
        UBoss platform health
      </h1>
      <p style={{ color: 'var(--uboss-text-2)', marginTop: 6 }}>
        Bootstrap verification for the web and API workspaces.
      </p>

      <section
        aria-label="API status"
        style={{
          marginTop: 24,
          background: 'var(--uboss-surface)',
          border: '1px solid var(--uboss-border)',
          borderRadius: 12,
          padding: 20,
        }}
      >
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 12 }}>
          <strong>API</strong>
          <span
            role="status"
            style={{
              background: tone.bg,
              color: tone.fg,
              borderRadius: 20,
              padding: '2px 10px',
              fontSize: 12,
              fontWeight: 700,
            }}
          >
            {tone.label}
          </span>
        </div>

        <Row label="Web build" value={webVersion} />
        <Row label="API base URL" value={apiBaseUrl} />

        {probe.kind === 'reachable' && (
          <>
            <Row label="API service" value={probe.health.service} />
            <Row label="API version" value={probe.health.version} />
            <Row label="API status" value={probe.health.status} />
            <Row label="API uptime" value={`${probe.health.uptimeSeconds}s`} />
          </>
        )}

        {probe.kind === 'loading' && (
          <p style={{ color: 'var(--uboss-text-2)', marginTop: 12 }}>Contacting the API…</p>
        )}

        {probe.kind === 'unreachable' && (
          <p style={{ color: TONE.bad.fg, marginTop: 12 }}>
            Could not reach the API: {probe.reason}. Start it with <code>npm run dev:api</code>.
          </p>
        )}

        {probe.kind === 'invalid' && (
          <p style={{ color: TONE.warn.fg, marginTop: 12 }}>
            The API replied but the body did not match the shared health contract: {probe.reason}.
          </p>
        )}
      </section>
    </main>
  );
}
