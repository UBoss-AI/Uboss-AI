'use client';

import Link from 'next/link';
import { useCallback, useEffect, useState } from 'react';

import { OBJECTIVE_STATUS_TONES, OBJECTIVE_STATUSES, TIME_UNIT_LABELS } from '@uboss/types';
import {
  AppShell,
  Banner,
  Button,
  Card,
  DataTable,
  FilterSelect,
  Icon,
  PageHeader,
  SearchField,
  StatusBadge,
  type StatusTone,
} from '@uboss/ui';

import {
  ApiError,
  authApi,
  objectivesApi,
  type MeResponse,
  type ObjectiveListRow,
} from '../../lib/api-client';
import { useNotificationBell } from '../../lib/use-notification-bell';
import { useCompanyNavigation } from '../../lib/use-company-navigation';

/** The target, as the reference shows it: a number and its unit, or nothing. */
function targetOf(row: ObjectiveListRow): string {
  if (row.targetCompletionTime === null) return '—';
  const unit = row.timeUnit === null ? '' : ` ${TIME_UNIT_LABELS[row.timeUnit].toLowerCase()}`;
  return `${row.targetCompletionTime}${unit}`;
}

/**
 * Objectives — the reference's `objList()`.
 *
 * Its columns, in its order: Objective (name over its code), Department, Responsible manager,
 * Status, Version, Target, Updated. The toolbar is the reference's too — search, a status filter,
 * a department filter, and Create Objective on the right.
 *
 * ## The version cell is a badge, not a concatenated label
 *
 * The locked rule about counts applies here: `V2 Live` is a badge carrying the version and its
 * liveness, and it is green only when the version is actually live. The reference's fixture always
 * showed a version; a company with nothing published sees its draft's number instead, because
 * showing "V1 Live" for an unpublished draft would be the prototype's fixture leaking into a real
 * screen.
 */
export default function ObjectivesPage() {
  // Prompt 40A (CR-03): the sidebar follows this person's real grants, never a role label.
  const navGroups = useCompanyNavigation();
  const [me, setMe] = useState<MeResponse | null>(null);
  const [rows, setRows] = useState<ObjectiveListRow[] | null>(null);
  const [status, setStatus] = useState('');
  const [search, setSearch] = useState('');
  const [error, setError] = useState<string | null>(null);

  const tenantId = me?.activeWorkspaceId ?? me?.workspaces[0]?.tenantId ?? null;
  const activeWorkspace = me?.workspaces.find((workspace) => workspace.tenantId === tenantId);
  const bell = useNotificationBell(tenantId);

  useEffect(() => {
    authApi
      .me()
      .then(setMe)
      .catch((caught: unknown) =>
        setError(caught instanceof ApiError ? caught.message : 'Could not load your workspaces.'),
      );
  }, []);

  const load = useCallback(() => {
    if (!tenantId) return;
    setError(null);

    void objectivesApi
      .list(tenantId, {
        ...(status === '' ? {} : { status }),
        ...(search.trim() === '' ? {} : { search: search.trim() }),
      })
      .then((result) => setRows(result.objectives))
      .catch((caught: unknown) => {
        setRows([]);
        setError(caught instanceof ApiError ? caught.message : 'Could not load objectives.');
      });
  }, [search, status, tenantId]);

  useEffect(load, [load]);

  return (
    <AppShell
      variant="company"
      workspaceName={activeWorkspace?.tenantName ?? '—'}
      groups={navGroups}
      activeKey="objective"
      onNavigate={() => undefined}
      user={{ name: me?.user.ubossUniqueId ?? 'Signed in', role: 'Objectives' }}
      {...bell.shellProps}
      onSignOut={() => {
        void authApi.logout().finally(() => window.location.assign('/login'));
      }}
    >
      <PageHeader
        title="Objectives"
        description="Find and manage objectives before AI decomposition."
        breadcrumbs={[{ label: 'Objective' }]}
        actions={
          <Link href="/objective/form">
            <Button variant="primary" size="sm">
              <Icon name="plus" size={16} />
              Create Objective
            </Button>
          </Link>
        }
      />

      {error === null ? null : (
        <Banner tone="danger">
          <Icon name="shield" size={16} />
          {error}
        </Banner>
      )}

      <Card>
        <div className="uboss-toolbar">
          <SearchField
            label="Search objectives"
            placeholder="Search objectives"
            value={search}
            onChange={(event) => setSearch(event.target.value)}
          />
          <FilterSelect
            label="Status"
            value={status}
            onChange={setStatus}
            options={[
              { value: '', label: 'All statuses' },
              ...OBJECTIVE_STATUSES.map((value) => ({
                value,
                label: value === 'Active' ? 'Live' : value.replace(/([A-Z])/g, ' $1').trim(),
              })),
            ]}
          />
        </div>

        <DataTable
          caption="Objectives"
          rowKey={(row: ObjectiveListRow) => row.id}
          rows={rows ?? []}
          {...(rows === null ? { loading: true } : {})}
          emptyTitle="No objectives yet"
          emptyDescription="Create an objective to record its business intent on the approved Form 2."
          columns={[
            {
              key: 'objective',
              header: 'Objective',
              render: (row: ObjectiveListRow) => (
                <Link href={`/objective/form?objectiveId=${encodeURIComponent(row.id)}`}>
                  <b>{row.objectiveName}</b>
                  <br />
                  <small className="uboss-muted-3 uboss-mono">{row.code}</small>
                </Link>
              ),
            },
            {
              key: 'department',
              header: 'Department',
              render: (row: ObjectiveListRow) => (
                <span className="uboss-mono uboss-muted-3">{row.departmentId.slice(0, 8)}</span>
              ),
            },
            {
              key: 'responsible',
              header: 'Responsible manager',
              render: (row: ObjectiveListRow) =>
                row.responsibleOwnerUserId === null ? (
                  // Not yet routed. Said plainly rather than shown as a blank cell.
                  <span className="uboss-muted-3">Not yet sent to anyone</span>
                ) : (
                  <span className="uboss-mono uboss-muted-3">
                    {row.responsibleOwnerUserId.slice(0, 8)}
                  </span>
                ),
            },
            {
              key: 'status',
              header: 'Status',
              render: (row: ObjectiveListRow) => (
                <StatusBadge
                  tone={OBJECTIVE_STATUS_TONES[row.status] as StatusTone}
                  status={row.statusLabel}
                />
              ),
            },
            {
              key: 'version',
              header: 'Version',
              render: (row: ObjectiveListRow) => (
                <StatusBadge
                  tone={row.live ? 'success' : 'grey'}
                  status={`V${row.versionNumber}${row.live ? ' Live' : ''}`}
                />
              ),
            },
            {
              key: 'target',
              header: 'Target',
              render: (row: ObjectiveListRow) => targetOf(row),
            },
            {
              key: 'updated',
              header: 'Updated',
              render: (row: ObjectiveListRow) => (
                <span className="uboss-muted">{new Date(row.updatedAt).toLocaleDateString()}</span>
              ),
            },
          ]}
        />
      </Card>
    </AppShell>
  );
}
