import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { CapabilityStep } from '../lib/api-client';

/**
 * The Access & Permissions step — Prompt 40A (CR-03) §1.
 *
 * What these tests hold is the *shape of the authority*, not the widget:
 *
 *   * a capability the administrator cannot grant is **shown, disabled and explained**, never
 *     hidden — a form that quietly omits an option looks complete and teaches nobody why;
 *   * every toggle is a request the **server** evaluates, and the screen renders the verdict;
 *   * the friendly words and the real grants come from the same response, so they cannot drift.
 */
const step = vi.fn();
const grant = vi.fn();
const revoke = vi.fn();

vi.mock('../lib/api-client', () => ({
  ApiError: class ApiError extends Error {
    // The real one carries a status. Mirrored here so a test cannot construct a refusal the
    // client could never produce.
    constructor(
      message: string,
      readonly statusCode = 500,
    ) {
      super(message);
    }
  },
  capabilitiesApi: {
    step: (...args: unknown[]) => step(...args),
    grant: (...args: unknown[]) => grant(...args),
    revoke: (...args: unknown[]) => revoke(...args),
  },
}));

const { AccessPermissionsStep } = await import('./AccessPermissionsStep');

const STEP: CapabilityStep = {
  defaultForNewEmployee: ['OperateAssignedAgents', 'UseWorkspaceChat'],
  delegationStance:
    'You can grant only what you hold yourself, and never to yourself.',
  tiers: [
    { key: 'Build', label: 'Build', description: 'Designing the work.' },
    { key: 'Operate', label: 'Operate', description: 'Doing the work.' },
  ],
  capabilities: [
    {
      key: 'BuildAgents',
      label: 'Can build agents',
      tier: 'Build',
      help: 'Opens Agent Builder and lets them design an agent.',
      held: false,
      canGrant: true,
      grants: { 'agent-builder': ['View', 'Create', 'EditDraft'] },
    },
    {
      key: 'DefineObjectives',
      label: 'Can define objectives',
      tier: 'Build',
      help: 'Opens Objective Optimization.',
      held: false,
      canGrant: false,
      whyNot: 'You do not hold this yourself, so you cannot grant it.',
      grants: { objective: ['View', 'Create'] },
    },
    {
      key: 'OperateAssignedAgents',
      label: 'Can operate assigned agents',
      tier: 'Operate',
      help: 'Runs the agents shared with them.',
      held: true,
      canGrant: true,
      grants: { agents: ['View', 'Run'] },
    },
  ],
};

beforeEach(() => {
  vi.clearAllMocks();
  step.mockResolvedValue(STEP);
  grant.mockResolvedValue({ granted: true });
  revoke.mockResolvedValue({ revoked: true });
});

describe('AccessPermissionsStep', () => {
  it('names who is being edited', async () => {
    render(
      <AccessPermissionsStep tenantId="tenant-1" userId="user-1" subjectLabel="Anita Prasad" />,
    );

    expect(await screen.findByText('For Anita Prasad')).toBeInTheDocument();
  });

  it('states what a new employee starts with, from the server rather than a local guess', async () => {
    render(
      <AccessPermissionsStep tenantId="tenant-1" userId="user-1" subjectLabel="Anita Prasad" />,
    );

    expect(await screen.findByTestId('access-default')).toHaveTextContent(
      '2 operations capabilities',
    );
  });

  it('groups capabilities under the tiers the server declares', async () => {
    render(
      <AccessPermissionsStep tenantId="tenant-1" userId="user-1" subjectLabel="Anita Prasad" />,
    );

    expect(await screen.findByTestId('access-tier-Build')).toBeInTheDocument();
    expect(screen.getByTestId('access-tier-Operate')).toBeInTheDocument();
  });

  it('shows a capability it cannot grant, disabled, with the reason visible', async () => {
    render(
      <AccessPermissionsStep tenantId="tenant-1" userId="user-1" subjectLabel="Anita Prasad" />,
    );

    const box = await screen.findByTestId('capability-DefineObjectives');
    expect(box).toBeDisabled();
    // Hidden would be worse: the form would look complete while withholding an option.
    expect(box).toBeVisible();
    expect(screen.getByTestId('why-not-DefineObjectives')).toHaveTextContent(
      'You do not hold this yourself',
    );
  });

  it('grants a capability through the server', async () => {
    render(
      <AccessPermissionsStep tenantId="tenant-1" userId="user-1" subjectLabel="Anita Prasad" />,
    );

    await userEvent.click(await screen.findByTestId('capability-BuildAgents'));

    await waitFor(() =>
      expect(grant).toHaveBeenCalledWith('tenant-1', 'user-1', ['BuildAgents']),
    );
  });

  it('revokes one that is already held', async () => {
    render(
      <AccessPermissionsStep tenantId="tenant-1" userId="user-1" subjectLabel="Anita Prasad" />,
    );

    await userEvent.click(await screen.findByTestId('capability-OperateAssignedAgents'));

    await waitFor(() =>
      expect(revoke).toHaveBeenCalledWith('tenant-1', 'user-1', 'OperateAssignedAgents'),
    );
  });

  it("renders the server's refusal verbatim rather than paraphrasing it", async () => {
    const { ApiError } = await import('../lib/api-client');
    grant.mockRejectedValue(
      new ApiError('You cannot grant Can build agents above your own level.', 403),
    );

    render(
      <AccessPermissionsStep tenantId="tenant-1" userId="user-1" subjectLabel="Anita Prasad" />,
    );
    await userEvent.click(await screen.findByTestId('capability-BuildAgents'));

    expect(
      await screen.findByText('You cannot grant Can build agents above your own level.'),
    ).toBeInTheDocument();
  });

  it('discloses the real grants behind the friendly words', async () => {
    render(
      <AccessPermissionsStep tenantId="tenant-1" userId="user-1" subjectLabel="Anita Prasad" />,
    );
    await screen.findByTestId('capability-BuildAgents');

    await userEvent.click(screen.getAllByRole('button', { name: 'What this allows' })[0] as HTMLElement);

    const grants = await screen.findByTestId('grants-BuildAgents');
    expect(grants).toHaveTextContent('agent-builder');
    expect(grants).toHaveTextContent('View, Create, EditDraft');
  });

  it('prints the delegation rule in the server’s own words', async () => {
    render(
      <AccessPermissionsStep tenantId="tenant-1" userId="user-1" subjectLabel="Anita Prasad" />,
    );

    expect(await screen.findByTestId('delegation-stance')).toHaveTextContent(
      'You can grant only what you hold yourself',
    );
  });

  it('says nothing at all when the step cannot be read', async () => {
    const { ApiError } = await import('../lib/api-client');
    step.mockRejectedValue(new ApiError('You may not manage access in this workspace.', 403));

    render(
      <AccessPermissionsStep tenantId="tenant-1" userId="user-1" subjectLabel="Anita Prasad" />,
    );

    // No half-rendered grid of unchecked boxes that would imply nothing is granted.
    expect(
      await screen.findByText('You may not manage access in this workspace.'),
    ).toBeInTheDocument();
    expect(screen.queryByTestId('capability-BuildAgents')).not.toBeInTheDocument();
  });
});
