import type { HealthResponse } from '@uboss/types';
import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import { HealthView } from './health-view';

const health: HealthResponse = {
  status: 'ok',
  service: 'uboss-api',
  version: '0.1.0',
  timestamp: '2026-09-08T10:00:00.000Z',
  uptimeSeconds: 42,
};

const baseProps = { webVersion: '0.1.0', apiBaseUrl: 'http://localhost:4000' };

describe('HealthView', () => {
  it('renders the success state with the API details', () => {
    render(<HealthView {...baseProps} probe={{ kind: 'reachable', health }} />);

    expect(screen.getByRole('heading', { name: 'UBoss platform health' })).toBeInTheDocument();
    expect(screen.getByRole('status')).toHaveTextContent('Healthy');
    expect(screen.getByText('uboss-api')).toBeInTheDocument();
    expect(screen.getByText('42s')).toBeInTheDocument();
  });

  it('renders a degraded state without claiming health', () => {
    render(
      <HealthView
        {...baseProps}
        probe={{ kind: 'reachable', health: { ...health, status: 'degraded' } }}
      />,
    );

    expect(screen.getByRole('status')).toHaveTextContent('Degraded');
  });

  it('renders the loading state', () => {
    render(<HealthView {...baseProps} probe={{ kind: 'loading' }} />);

    expect(screen.getByRole('status')).toHaveTextContent('Checking');
    expect(screen.getByText('Contacting the API…')).toBeInTheDocument();
  });

  it('renders the error state with a recovery hint', () => {
    render(<HealthView {...baseProps} probe={{ kind: 'unreachable', reason: 'ECONNREFUSED' }} />);

    expect(screen.getByRole('status')).toHaveTextContent('Unreachable');
    expect(screen.getByText(/ECONNREFUSED/)).toBeInTheDocument();
    expect(screen.getByText('npm run dev:api')).toBeInTheDocument();
  });

  it('renders the contract-mismatch state when the API replies with an unexpected body', () => {
    render(
      <HealthView
        {...baseProps}
        probe={{ kind: 'invalid', reason: 'unrecognised response shape' }}
      />,
    );

    expect(screen.getByText(/did not match the shared health contract/)).toBeInTheDocument();
  });

  it('always shows the configured API base URL so misconfiguration is visible', () => {
    render(<HealthView {...baseProps} probe={{ kind: 'unreachable', reason: 'timeout' }} />);

    expect(screen.getByText('http://localhost:4000')).toBeInTheDocument();
  });

  it('conveys status with text, not colour alone', () => {
    // Locked UI rule: status is never colour-only.
    render(<HealthView {...baseProps} probe={{ kind: 'reachable', health }} />);

    expect(screen.getByRole('status').textContent?.trim()).not.toBe('');
  });
});
