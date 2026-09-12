'use client';

import { useState } from 'react';

import {
  AppShell,
  Button,
  Card,
  CardBody,
  CardHeader,
  DataTable,
  MASTER_NAV,
  MetricCard,
  PageHeader,
  SecurityMetric,
  StatusBadge,
} from '@uboss/ui';

import { authApi } from '../../../lib/api-client';

interface CompanyRow {
  id: string;
  name: string;
  plan: string;
  status: string;
  seats: string;
}

const COMPANIES: CompanyRow[] = [
  { id: 'C-1001', name: 'SPM Medicare', plan: 'Enterprise', status: 'Active', seats: '148 / 200' },
  { id: 'C-1002', name: 'Northwind Devices', plan: 'Growth', status: 'Active', seats: '54 / 75' },
  {
    id: 'C-1003',
    name: 'Aster Diagnostics',
    plan: 'Growth',
    status: 'Suspended',
    seats: '31 / 75',
  },
  {
    id: 'C-1004',
    name: 'Kavya Life Sciences',
    plan: 'Pilot',
    status: 'Pending',
    seats: '0 / 25',
  },
];

/**
 * UBoss Master Console shell preview.
 *
 * The Master Console is a separate platform control plane: it keeps its own dark treatment and
 * its own operational KPI dashboard, and it does NOT display a tenant workspace name. The
 * two-slice donut rule constrains the Company Workspace Dashboard only.
 */
export default function MasterShellPreview() {
  const [activeKey, setActiveKey] = useState('dashboard');

  return (
    <AppShell
      variant="master"
      groups={MASTER_NAV}
      activeKey={activeKey}
      onNavigate={setActiveKey}
      user={{ name: 'Dibyanshu Patra', role: 'Platform Admin' }}
      // The reference's top bar and sidebar footer both carry a sign-out control, so the
      // preview shows them. It performs a real sign-out and returns to the login screen.
      onSignOut={() => {
        void authApi.logout().finally(() => window.location.assign('/login'));
      }}
      scopeLabel="Platform Admin · All companies & platform"
      hasNotifications
    >
      {activeKey === 'dashboard' ? (
        <>
          <PageHeader
            title="Platform overview"
            description="Provisioning, commercial and operational health across all customer companies."
          />

          <div
            className="uboss-grid"
            style={{ gridTemplateColumns: 'repeat(auto-fit,minmax(200px,1fr))' }}
          >
            <MetricCard label="Active companies" value={42} delta="+3 this month" trend="up" />
            <MetricCard label="Pending provisioning" value={2} />
            <MetricCard label="Engine Agent runs (24h)" value="8,412" delta="+6%" trend="up" />
            <MetricCard label="Open incidents" value={1} delta="-2 this week" trend="down" />
          </div>

          <div className="uboss-section-label">Security posture</div>
          <div
            className="uboss-grid"
            style={{ gridTemplateColumns: 'repeat(auto-fit,minmax(240px,1fr))' }}
          >
            <SecurityMetric
              label="MFA enrolment"
              value="92%"
              level="ok"
              detail="Policy: required"
            />
            <SecurityMetric
              label="Secrets past rotation"
              value={1}
              level="attention"
              icon="key"
              detail="gmail-oauth · 40 days"
            />
            <SecurityMetric
              label="Failed logins (24h)"
              value={41}
              level="critical"
              detail="Throttling engaged on 3 accounts"
            />
          </div>
        </>
      ) : activeKey === 'companies' ? (
        <>
          <PageHeader
            title="Companies"
            description="Every customer company is provisioned here. There is no public company signup."
            breadcrumbs={[
              { label: 'Platform', onSelect: () => setActiveKey('dashboard') },
              { label: 'Companies' },
            ]}
            actions={
              <Button variant="primary" icon="plus">
                Create Company
              </Button>
            }
          />

          <Card>
            <DataTable
              caption="Customer companies"
              rowKey={(row) => row.id}
              rows={COMPANIES}
              columns={[
                {
                  key: 'name',
                  header: 'Company',
                  render: (row) => (
                    <>
                      <b>{row.name}</b>
                      <br />
                      <small className="uboss-muted-3 uboss-mono">{row.id}</small>
                    </>
                  ),
                },
                { key: 'plan', header: 'Plan', render: (row) => row.plan },
                {
                  key: 'status',
                  header: 'Status',
                  render: (row) => <StatusBadge status={row.status} />,
                },
                { key: 'seats', header: 'Seats', render: (row) => row.seats, numeric: true },
              ]}
              onRowSelect={() => undefined}
            />
          </Card>
        </>
      ) : (
        <>
          <PageHeader
            title={
              MASTER_NAV.flatMap((group) => group.items).find((item) => item.key === activeKey)
                ?.label ?? 'Module'
            }
            description="Shell preview only. This module is built in a later prompt."
            breadcrumbs={[
              { label: 'Platform', onSelect: () => setActiveKey('dashboard') },
              { label: 'Module' },
            ]}
            actions={
              <Button variant="navy" onClick={() => setActiveKey('dashboard')}>
                Back to Dashboard
              </Button>
            }
          />
          <Card>
            <CardHeader title="Not built yet" />
            <CardBody>
              <p className="uboss-muted">
                Navigation is mock at Prompt 2, but every route still offers a way back.
              </p>
            </CardBody>
          </Card>
        </>
      )}
    </AppShell>
  );
}
